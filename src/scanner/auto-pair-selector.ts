#!/usr/bin/env npx tsx
/**
 * Automatic Pair Selection System
 *
 * 7-stage pipeline that scans the crypto market, tests all possible pair
 * combinations, and selects the most stable trading pairs using walk-forward analysis.
 *
 * Pipeline:
 *   Stage 1: Universe (OKX top N by volume)
 *   Stage 2: Data Fetch (3yr 1h candles, SQLite cached)
 *   Stage 3: Correlation Matrix (filter by threshold)
 *   Stage 4: Cointegration Filter (Engle-Granger test)
 *   Stage 5: Quick Backtest (5 presets via runClassicFast)
 *   Stage 6: Walk-Forward Deep Analysis (150 rounds × 6 periods)
 *   Stage 7: Final Selection (top N by compositeScore)
 *
 * Usage:
 *   npx tsx src/scanner/auto-pair-selector.ts --universe 50 --top 5
 *   npx tsx src/scanner/auto-pair-selector.ts --universe 30 --rounds 50 --top 3 --apply
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as ccxt from 'ccxt';
import { buildCorrelationMatrix, tagSectors, getSector, type PairCorrelation } from './correlation.js';
import { testCointegration, ols, type CointegrationResult } from './cointegration.js';
import { fetchMultipleSymbols } from '../backtest/historical-fetcher.js';
import {
  runWalkForwardAnalysis,
  type WalkForwardConfig,
  type WalkForwardResult,
} from '../backtest/walk-forward-analysis.js';
import {
  mulberry32,
  generateClassicParams,
  runClassicFast,
  computeQuickMetrics,
  progressBar,
  CLASSIC_PARAM_SPACE,
  type OptimizerConfig,
  type ZScoreParamSpace,
} from '../backtest/zscore-optimizer.js';

// ─── Types ───

interface AutoSelectConfig {
  universeSize: number;
  minDailyVolume: number;
  minDataMonths: number;
  correlationThreshold: number;
  cointegrationPValue: number;
  halfLifeRange: [number, number];
  quickBacktestPresets: number;
  walkForwardRounds: number;
  walkForwardPeriods: number;
  dataYears: number;
  topN: number;
  topCandidatesForWF: number;
  autoApply: boolean;
  seed: number;
  jsonOutput: boolean;
  timeframe: '1h' | '4h';
  capitalPerLeg: number;
  leverage: number;
  feeRate: number;
}

interface CoinInfo {
  symbol: string;       // "BTC/USDT:USDT"
  base: string;         // "BTC"
  dailyVolume: number;  // USD
}

interface PairCandidate {
  pair: string;
  symbolA: string;
  symbolB: string;
  stage: 'correlation' | 'cointegration' | 'quickBacktest' | 'walkForward';
  correlation: number;
  sectorA: string;
  sectorB: string;
  cointegration?: {
    beta: number;
    pValue: number;
    halfLife: number;
  };
  quickBacktest?: {
    bestPnl: number;
    bestWinRate: number;
    bestSharpe: number;
    presetsProfitable: number;
  };
  walkForward?: {
    compositeScore: number;
    avgSharpe: number;
    minSharpe: number;
    profitablePeriodsRatio: number;
    avgPnl: number;
    totalPnl: number;
    recommendedParams: Record<string, number>;
  };
}

interface StageStats {
  totalInput: number;
  passing: number;
  elapsed: number;
}

interface AutoSelectResult {
  timestamp: string;
  config: AutoSelectConfig;
  universe: {
    totalMarketsScanned: number;
    qualified: number;
    coins: string[];
  };
  stages: {
    correlation: StageStats & { totalPairs: number };
    cointegration: StageStats;
    quickBacktest: StageStats;
    walkForward: StageStats;
  };
  rankings: PairCandidate[];
  selected: PairCandidate[];
  dangerZone: PairCandidate[];
  totalElapsed: number;
}

// ─── Defaults ───

const DEFAULT_CONFIG: AutoSelectConfig = {
  universeSize: 50,
  minDailyVolume: 10_000_000,
  minDataMonths: 12,
  correlationThreshold: 0.60,
  cointegrationPValue: 0.30,
  halfLifeRange: [2, 336],
  quickBacktestPresets: 5,
  walkForwardRounds: 150,
  walkForwardPeriods: 6,
  dataYears: 3,
  topN: 5,
  topCandidatesForWF: 15,
  autoApply: false,
  seed: 42,
  jsonOutput: false,
  timeframe: '1h',
  capitalPerLeg: 25,
  leverage: 10,
  feeRate: 0.0006,
};

// ─── Stage 1: Universe Discovery ───

async function fetchUniverse(config: AutoSelectConfig): Promise<CoinInfo[]> {
  const exchange = new ccxt.okx({ enableRateLimit: true });

  try {
    await exchange.loadMarkets();

    // Get all USDT-SWAP perpetual futures
    const swapMarkets = Object.values(exchange.markets).filter(
      (m) => m.active && m.swap && m.settle === 'USDT' && m.quote === 'USDT',
    );

    console.log(`  📊 Found ${swapMarkets.length} active USDT-SWAP markets`);

    // Fetch all tickers in one call for volume data
    const tickers = await exchange.fetchTickers(swapMarkets.map(m => m.symbol));

    const coins: CoinInfo[] = [];
    for (const market of swapMarkets) {
      const ticker = tickers[market.symbol];
      if (!ticker) continue;

      // OKX swap tickers: quoteVolume is often undefined
      // Use baseVolume (contracts) × last price, or volCcy24h × last for USD estimate
      const last = ticker.last ?? ticker.close ?? 0;
      const volCcy = parseFloat((ticker.info as any)?.volCcy24h ?? '0');
      const dailyVolume = volCcy > 0 ? volCcy * last : (ticker.baseVolume ?? 0) * last;
      if (dailyVolume < config.minDailyVolume) continue;

      coins.push({
        symbol: market.symbol,
        base: market.base!,
        dailyVolume,
      });
    }

    // Sort by volume descending, take top N
    coins.sort((a, b) => b.dailyVolume - a.dailyVolume);
    return coins.slice(0, config.universeSize);
  } finally {
    await exchange.close();
  }
}

// ─── Stage 2: Data Fetch ───

async function fetchAllPriceData(
  coins: CoinInfo[],
  config: AutoSelectConfig,
): Promise<Map<string, number[]>> {
  const symbols = coins.map(c => c.base);
  const minBars = config.minDataMonths * 730; // ~730 hourly bars per month

  console.log(`  📡 Fetching ${config.dataYears}yr ${config.timeframe} data for ${symbols.length} coins...`);
  console.log(`  ℹ️  Cached data loads instantly; new data may take a while.\n`);

  const priceData = await fetchMultipleSymbols(symbols, {
    years: config.dataYears,
    timeframe: config.timeframe,
  });

  // Filter out coins with insufficient data
  const filtered = new Map<string, number[]>();
  for (const [symbol, prices] of priceData) {
    if (prices.length >= minBars) {
      filtered.set(symbol, prices);
    } else {
      console.log(`  ⚠️  ${symbol}: only ${prices.length} bars (need ${minBars}), skipping`);
    }
  }

  return filtered;
}

// ─── Stage 3: Correlation ───

function runCorrelationStage(
  priceData: Map<string, number[]>,
  config: AutoSelectConfig,
): PairCandidate[] {
  const pairs = buildCorrelationMatrix(priceData, config.correlationThreshold);
  const tagged = tagSectors(pairs);

  return tagged.map(p => ({
    pair: `${p.symbolA}/${p.symbolB}`,
    symbolA: p.symbolA,
    symbolB: p.symbolB,
    stage: 'correlation' as const,
    correlation: p.correlation,
    sectorA: p.sectorA ?? getSector(p.symbolA),
    sectorB: p.sectorB ?? getSector(p.symbolB),
  }));
}

// ─── Stage 4: Cointegration ───

function runCointegrationStage(
  candidates: PairCandidate[],
  priceData: Map<string, number[]>,
  config: AutoSelectConfig,
): PairCandidate[] {
  const enriched: PairCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const pricesA = priceData.get(c.symbolA);
    const pricesB = priceData.get(c.symbolB);
    if (!pricesA || !pricesB) continue;

    if ((i + 1) % 20 === 0 || i === candidates.length - 1) {
      process.stdout.write(`\r  ⚡ Testing: ${i + 1}/${candidates.length} pairs`);
    }

    try {
      const result = testCointegration(
        pricesA, pricesB,
        c.symbolA, c.symbolB,
        config.cointegrationPValue,
      );

      // Enrichment stage: compute cointegration stats for ALL correlated pairs.
      // Crypto pairs are often highly correlated but not strictly cointegrated
      // (ADF test fails, half-life = Infinity). Instead of filtering them out,
      // pass all to quick backtest and let profitability be the real gate.
      // Cointegration stats are used for ranking, not hard gating.
      enriched.push({
        ...c,
        stage: 'cointegration',
        cointegration: {
          beta: result.beta,
          pValue: result.pValue,
          halfLife: isFinite(result.halfLife) ? result.halfLife : 999,
        },
      });
    } catch {
      // Still include pairs that fail cointegration test with default stats
      enriched.push({
        ...c,
        stage: 'cointegration',
        cointegration: { beta: 1, pValue: 0.99, halfLife: 999 },
      });
    }
  }

  console.log(''); // newline after progress
  // Sort by pValue ascending (best cointegration first), then halfLife
  enriched.sort((a, b) => {
    const pDiff = (a.cointegration?.pValue ?? 1) - (b.cointegration?.pValue ?? 1);
    if (Math.abs(pDiff) > 0.01) return pDiff;
    return (a.cointegration?.halfLife ?? Infinity) - (b.cointegration?.halfLife ?? Infinity);
  });
  return enriched;
}

// ─── Stage 5: Quick Backtest ───

function runQuickBacktestStage(
  candidates: PairCandidate[],
  priceData: Map<string, number[]>,
  config: AutoSelectConfig,
): PairCandidate[] {
  const rng = mulberry32(config.seed);
  const optiConfig: OptimizerConfig = {
    rounds: config.quickBacktestPresets,
    strategyType: 'classic',
    capitalPerLeg: config.capitalPerLeg,
    leverage: config.leverage,
    feeRate: config.feeRate,
    inSampleRatio: 0.5,
    topN: 5,
  };

  // Generate random presets
  const presets: Record<string, number>[] = [];
  for (let i = 0; i < config.quickBacktestPresets; i++) {
    const p = generateClassicParams(CLASSIC_PARAM_SPACE, rng);
    if (p) presets.push(p);
  }

  // Add 3 hardcoded sensible defaults
  presets.push(
    { entryZ: 3.2, exitZ: 0.9, stopLossZ: 4.6, window: 333, safeZoneBuffer: 0.7, gracePeriodBars: 10, cooldownBars: 44 },
    { entryZ: 2.8, exitZ: 0.5, stopLossZ: 4.5, window: 200, safeZoneBuffer: 0.5, gracePeriodBars: 8, cooldownBars: 30 },
    { entryZ: 3.4, exitZ: 1.3, stopLossZ: 4.7, window: 367, safeZoneBuffer: 0.4, gracePeriodBars: 11, cooldownBars: 60 },
  );

  const passing: PairCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const pricesA = priceData.get(c.symbolA);
    const pricesB = priceData.get(c.symbolB);
    if (!pricesA || !pricesB) continue;

    process.stdout.write(`\r  ⚡ Backtesting: ${i + 1}/${candidates.length} pairs | Passing: ${passing.length}`);

    try {
      // Compute spread using cointegration beta
      const n = Math.min(pricesA.length, pricesB.length);
      const logA = pricesA.slice(-n).map(Math.log);
      const logB = pricesB.slice(-n).map(Math.log);

      // Use OLS hedge ratio from first 50%
      const halfN = Math.floor(n * 0.5);
      const { beta } = ols(logB.slice(0, halfN), logA.slice(0, halfN));

      const spread: number[] = [];
      for (let j = 0; j < n; j++) {
        spread.push(logA[j] - beta * logB[j]);
      }

      let bestPnl = -Infinity;
      let bestWinRate = 0;
      let bestSharpe = -Infinity;
      let presetsProfitable = 0;

      for (const params of presets) {
        const trades = runClassicFast(spread, params, optiConfig);
        if (trades.length === 0) continue;

        const metrics = computeQuickMetrics(trades);
        if (metrics.totalPnl > 0) presetsProfitable++;

        if (metrics.sharpeRatio > bestSharpe) {
          bestSharpe = metrics.sharpeRatio;
          bestPnl = metrics.totalPnl;
          bestWinRate = metrics.winRate;
        }
      }

      if (bestPnl > 0 && bestWinRate > 0.45) {
        passing.push({
          ...c,
          stage: 'quickBacktest',
          quickBacktest: { bestPnl, bestWinRate, bestSharpe, presetsProfitable },
        });
      }
    } catch {
      // Skip failed backtests
    }
  }

  console.log(''); // newline after progress
  passing.sort((a, b) => (b.quickBacktest?.bestSharpe ?? 0) - (a.quickBacktest?.bestSharpe ?? 0));

  // Take top candidates for walk-forward
  return passing.slice(0, config.topCandidatesForWF);
}

// ─── Stage 6: Walk-Forward Deep Analysis ───

function runWalkForwardStage(
  candidates: PairCandidate[],
  priceData: Map<string, number[]>,
  config: AutoSelectConfig,
): PairCandidate[] {
  const results: PairCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const pricesA = priceData.get(c.symbolA);
    const pricesB = priceData.get(c.symbolB);
    if (!pricesA || !pricesB) continue;

    const n = Math.min(pricesA.length, pricesB.length);

    console.log(`\n  [${i + 1}/${candidates.length}] ${c.pair} (${n.toLocaleString()} bars, corr=${c.correlation.toFixed(3)}, pVal=${c.cointegration?.pValue})`);

    try {
      const wfConfig: WalkForwardConfig = {
        pair: c.pair,
        years: config.dataYears,
        periods: config.walkForwardPeriods,
        rounds: config.walkForwardRounds,
        timeframe: config.timeframe,
        capitalPerLeg: config.capitalPerLeg,
        leverage: config.leverage,
        feeRate: config.feeRate,
        warmupBars: 500,
        topN: 5,
        jsonOutput: false,
        seed: config.seed,
      };

      const wfResult = runWalkForwardAnalysis(
        pricesA.slice(-n),
        pricesB.slice(-n),
        c.pair,
        wfConfig,
      );

      if (wfResult.top.length > 0) {
        const top = wfResult.top[0];
        results.push({
          ...c,
          stage: 'walkForward',
          walkForward: {
            compositeScore: top.stability.compositeScore,
            avgSharpe: top.stability.avgSharpe,
            minSharpe: top.stability.minSharpe,
            profitablePeriodsRatio: top.stability.profitablePeriodsRatio,
            avgPnl: top.stability.avgPnl,
            totalPnl: top.stability.totalPnlAllPeriods,
            recommendedParams: top.params,
          },
        });

        console.log(`  ✅ compositeScore=${top.stability.compositeScore.toFixed(2)}, avgPnl=$${top.stability.avgPnl.toFixed(2)}, profitable=${top.stability.profitablePeriodsRatio.toFixed(0)}/${config.walkForwardPeriods}`);
      } else {
        console.log(`  ❌ No valid walk-forward results`);
      }
    } catch (e) {
      console.log(`  ❌ Walk-forward failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  results.sort((a, b) => (b.walkForward?.compositeScore ?? 0) - (a.walkForward?.compositeScore ?? 0));
  return results;
}

// ─── Stage 7: Selection & Danger Zone ───

function selectAndRank(
  candidates: PairCandidate[],
  config: AutoSelectConfig,
): { selected: PairCandidate[]; dangerZone: PairCandidate[] } {
  const sorted = [...candidates].sort(
    (a, b) => (b.walkForward?.compositeScore ?? 0) - (a.walkForward?.compositeScore ?? 0),
  );

  const selected = sorted.slice(0, config.topN);

  // Danger zone: profitable but unstable
  const scores = sorted.map(c => c.walkForward?.compositeScore ?? 0);
  const medianScore = scores.length > 0
    ? scores.sort((a, b) => a - b)[Math.floor(scores.length / 2)]
    : 0;

  const dangerZone = sorted.filter(c => {
    const wf = c.walkForward;
    if (!wf) return false;
    return (
      wf.totalPnl > 0 &&
      wf.compositeScore < medianScore &&
      wf.profitablePeriodsRatio < 0.67
    );
  }).slice(0, 5);

  return { selected, dangerZone };
}

// ─── Auto-Apply to Config ───

function applyToConfig(selected: PairCandidate[], configPath: string): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    // Start fresh if config doesn't exist
  }

  const targetPairs = selected.map(p => p.pair);
  existing.targetPairs = targetPairs;

  // Apply recommended params from the top pair
  if (selected.length > 0 && selected[0].walkForward?.recommendedParams) {
    const params = selected[0].walkForward.recommendedParams;
    existing.entryZScore = params.entryZ;
    existing.exitZScore = params.exitZ;
    existing.stopLossZScore = params.stopLossZ;
    existing.lookbackPeriods = params.window;
    existing.safeZoneBuffer = params.safeZoneBuffer;
    existing.gracePeriodBars = params.gracePeriodBars;
    existing.cooldownBars = params.cooldownBars;
  }

  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');
  console.log(`\n  💾 Config written to ${configPath}`);
  console.log(`     targetPairs: ${JSON.stringify(targetPairs)}`);
}

// ─── Report Formatting ───

function formatAutoSelectReport(result: AutoSelectResult): string {
  const lines: string[] = [];
  const { config: cfg, universe, stages, rankings, selected, dangerZone } = result;

  // ── Header ──
  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════════════════════╗');
  lines.push('║          AUTOMATIC PAIR SELECTION REPORT                                    ║');
  lines.push('╚══════════════════════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`  Timestamp:     ${result.timestamp}`);
  lines.push(`  Universe:      Top ${cfg.universeSize} coins by daily volume (min $${(cfg.minDailyVolume / 1e6).toFixed(0)}M)`);
  lines.push(`  Data:          ${cfg.dataYears} year(s) of ${cfg.timeframe} candles`);
  lines.push(`  Correlation:   ≥ ${cfg.correlationThreshold.toFixed(2)}`);
  lines.push(`  Cointegration: p-value < ${cfg.cointegrationPValue}`);
  lines.push(`  Half-Life:     ${cfg.halfLifeRange[0]}–${cfg.halfLifeRange[1]} bars`);
  lines.push(`  Walk-Forward:  ${cfg.walkForwardRounds} rounds × ${cfg.walkForwardPeriods} periods`);
  lines.push(`  Leverage:      ${cfg.leverage}x | Capital: $${cfg.capitalPerLeg}/leg`);
  lines.push(`  Seed:          ${cfg.seed}`);
  lines.push(`  Total Elapsed: ${result.totalElapsed.toFixed(1)}s`);

  // ── Funnel ──
  lines.push('');
  lines.push('  ═══ SELECTION FUNNEL ═══');
  lines.push('');

  const totalPossible = universe.qualified * (universe.qualified - 1) / 2;
  const funnelSteps = [
    { label: 'Coins scanned', count: universe.qualified, elapsed: '' },
    { label: 'Possible pairs', count: totalPossible, elapsed: '' },
    { label: 'Correlated', count: stages.correlation.passing, elapsed: `${stages.correlation.elapsed.toFixed(1)}s` },
    { label: 'Cointegrated', count: stages.cointegration.passing, elapsed: `${stages.cointegration.elapsed.toFixed(1)}s` },
    { label: 'Backtest pass', count: stages.quickBacktest.passing, elapsed: `${stages.quickBacktest.elapsed.toFixed(1)}s` },
    { label: 'Walk-Forward', count: stages.walkForward.passing, elapsed: `${stages.walkForward.elapsed.toFixed(1)}s` },
    { label: 'Selected', count: selected.length, elapsed: '' },
  ];

  const maxCount = Math.max(...funnelSteps.map(s => s.count));
  const barWidth = 40;

  for (const step of funnelSteps) {
    const w = Math.max(1, Math.round((step.count / maxCount) * barWidth));
    const bar = '█'.repeat(w) + '░'.repeat(barWidth - w);
    const timeStr = step.elapsed ? ` (${step.elapsed})` : '';
    lines.push(`    ${step.label.padEnd(16)} ${bar} ${String(step.count).padStart(6)}${timeStr}`);
  }

  // ── Rankings Table ──
  if (rankings.length > 0) {
    lines.push('');
    lines.push('  ═══ RANKINGS (All Walk-Forward Candidates) ═══');
    lines.push('');
    lines.push('    # | Pair               | Sector      |  Corr | pValue |   HalfL | CompScore | AvgShp | MinShp | Prof | AvgPnL');
    lines.push('  ' + '─'.repeat(120));

    for (let i = 0; i < rankings.length; i++) {
      const r = rankings[i];
      const wf = r.walkForward!;
      const coint = r.cointegration!;
      const prefix = i < selected.length ? '🏆' : '  ';
      const sector = `${r.sectorA}/${r.sectorB}`;
      const profStr = `${(wf.profitablePeriodsRatio * cfg.walkForwardPeriods).toFixed(0)}/${cfg.walkForwardPeriods}`;

      lines.push(
        `  ${prefix}${String(i + 1).padStart(2)} | ${r.pair.padEnd(18)} | ${sector.padEnd(11)} | ${r.correlation.toFixed(3)} | ${coint.pValue.toFixed(2).padStart(6)} | ${coint.halfLife.toFixed(1).padStart(7)} | ${wf.compositeScore.toFixed(2).padStart(9)} | ${wf.avgSharpe.toFixed(1).padStart(6)} | ${wf.minSharpe.toFixed(1).padStart(6)} | ${profStr.padStart(4)} | $${wf.avgPnl.toFixed(2).padStart(8)}`
      );
    }
    lines.push('  ' + '─'.repeat(120));
  }

  // ── Selected Pairs Detail ──
  if (selected.length > 0) {
    lines.push('');
    lines.push('  ═══ 🏆 SELECTED PAIRS (Recommended Config) ═══');

    for (let i = 0; i < selected.length; i++) {
      const s = selected[i];
      const wf = s.walkForward!;
      const coint = s.cointegration!;
      const params = wf.recommendedParams;

      lines.push('');
      lines.push(`  #${i + 1} ${s.pair} (${s.sectorA}/${s.sectorB})`);
      lines.push(`     Correlation: ${s.correlation.toFixed(4)} | p-value: ${coint.pValue} | Half-Life: ${coint.halfLife.toFixed(1)} bars`);
      lines.push(`     Composite Score:     ${wf.compositeScore.toFixed(2)}`);
      lines.push(`     Avg Sharpe:          ${wf.avgSharpe.toFixed(2)} (min: ${wf.minSharpe.toFixed(2)})`);
      lines.push(`     Profitable Periods:  ${(wf.profitablePeriodsRatio * cfg.walkForwardPeriods).toFixed(0)}/${cfg.walkForwardPeriods}`);
      lines.push(`     Avg PnL/Period:      $${wf.avgPnl.toFixed(2)}`);
      lines.push(`     Total PnL:           $${wf.totalPnl.toFixed(2)}`);
      lines.push(`     Recommended Params:`);
      lines.push(`       entryZ: ${params.entryZ?.toFixed(1)}  exitZ: ${params.exitZ?.toFixed(1)}  SLZ: ${params.stopLossZ?.toFixed(1)}  window: ${params.window}`);
      lines.push(`       buffer: ${params.safeZoneBuffer?.toFixed(1)}  grace: ${params.gracePeriodBars}  cooldown: ${params.cooldownBars}`);
    }
  }

  // ── Danger Zone ──
  if (dangerZone.length > 0) {
    lines.push('');
    lines.push('  ═══ ⚠️ DANGER ZONE (Profitable but Unstable) ═══');
    lines.push('');
    lines.push('    # | Pair               | TotalPnL  | Prof | CompScore | AvgShp | MinShp');
    lines.push('  ' + '─'.repeat(80));

    for (let i = 0; i < dangerZone.length; i++) {
      const d = dangerZone[i];
      const wf = d.walkForward!;
      const profStr = `${(wf.profitablePeriodsRatio * cfg.walkForwardPeriods).toFixed(0)}/${cfg.walkForwardPeriods}`;
      lines.push(
        `    ${String(i + 1).padStart(2)} | ${d.pair.padEnd(18)} | $${wf.totalPnl.toFixed(2).padStart(8)} | ${profStr.padStart(4)} | ${wf.compositeScore.toFixed(2).padStart(9)} | ${wf.avgSharpe.toFixed(1).padStart(6)} | ${wf.minSharpe.toFixed(1).padStart(6)}`
      );
    }
  }

  // ── Quick Copy Config ──
  if (selected.length > 0) {
    lines.push('');
    lines.push('  ═══ QUICK COPY (for config.json) ═══');
    lines.push('');
    lines.push(`  "targetPairs": ${JSON.stringify(selected.map(s => s.pair))}`);

    const topParams = selected[0].walkForward?.recommendedParams;
    if (topParams) {
      lines.push(`  "entryZScore": ${topParams.entryZ}`);
      lines.push(`  "exitZScore": ${topParams.exitZ}`);
      lines.push(`  "stopLossZScore": ${topParams.stopLossZ}`);
      lines.push(`  "lookbackPeriods": ${topParams.window}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ─── Main Orchestrator ───

async function runAutoSelect(config: AutoSelectConfig): Promise<AutoSelectResult> {
  const t0 = Date.now();

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║     Automatic Pair Selection System                             ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Universe:     Top ${config.universeSize} coins (min $${(config.minDailyVolume / 1e6).toFixed(0)}M daily volume)`);
  console.log(`  Data:         ${config.dataYears} year(s) of ${config.timeframe} candles`);
  console.log(`  Correlation:  ≥ ${config.correlationThreshold}`);
  console.log(`  Coint pValue: < ${config.cointegrationPValue}`);
  console.log(`  Half-Life:    ${config.halfLifeRange[0]}–${config.halfLifeRange[1]} bars`);
  console.log(`  WF Analysis:  ${config.walkForwardRounds} rounds × ${config.walkForwardPeriods} periods`);
  console.log(`  Top N:        ${config.topN}`);
  console.log(`  Auto-Apply:   ${config.autoApply ? 'YES' : 'NO'}`);
  console.log(`  Seed:         ${config.seed}`);
  console.log('');

  // ── Stage 1: Universe ──
  console.log('━━━ Stage 1/7: Universe Discovery ━━━');
  const t1 = Date.now();
  const coins = await fetchUniverse(config);
  const t1e = (Date.now() - t1) / 1000;
  console.log(`  ✅ ${coins.length} coins qualified (${t1e.toFixed(1)}s)`);

  if (coins.length > 0) {
    const topCoins = coins.slice(0, 10).map(c => c.base).join(', ');
    console.log(`  📋 Top 10: ${topCoins}`);
  }
  console.log('');

  // ── Stage 2: Data Fetch ──
  console.log('━━━ Stage 2/7: Historical Data Fetch ━━━');
  const t2 = Date.now();
  const priceData = await fetchAllPriceData(coins, config);
  const t2e = (Date.now() - t2) / 1000;
  console.log(`\n  ✅ ${priceData.size} coins with sufficient data (${t2e.toFixed(1)}s)`);
  console.log('');

  // ── Stage 3: Correlation ──
  console.log('━━━ Stage 3/7: Correlation Matrix ━━━');
  const t3 = Date.now();
  const totalPossiblePairs = priceData.size * (priceData.size - 1) / 2;
  console.log(`  📊 Testing ${totalPossiblePairs} pair combinations...`);
  const correlated = runCorrelationStage(priceData, config);
  const t3e = (Date.now() - t3) / 1000;
  console.log(`  ✅ ${correlated.length} pairs above correlation ${config.correlationThreshold} (${t3e.toFixed(1)}s)`);
  console.log('');

  if (correlated.length === 0) {
    console.log('  ⚠️  No correlated pairs found. Try lowering --correlation threshold.');
    return buildEarlyExitResult(config, coins, priceData.size, totalPossiblePairs, {
      correlation: { totalInput: priceData.size, totalPairs: totalPossiblePairs, passing: 0, elapsed: t3e },
    });
  }

  // ── Stage 4: Cointegration Enrichment ──
  console.log('━━━ Stage 4/7: Cointegration Analysis ━━━');
  const t4 = Date.now();
  const cointegrated = runCointegrationStage(correlated, priceData, config);
  const t4e = (Date.now() - t4) / 1000;
  const strictCoint = cointegrated.filter(c => (c.cointegration?.pValue ?? 1) <= config.cointegrationPValue);
  console.log(`  ✅ ${cointegrated.length} pairs analyzed (${strictCoint.length} strictly cointegrated) (${t4e.toFixed(1)}s)`);
  console.log('');

  // ── Stage 5: Quick Backtest ──
  console.log('━━━ Stage 5/7: Quick Backtest Screening ━━━');
  const t5 = Date.now();
  const backtested = runQuickBacktestStage(cointegrated, priceData, config);
  const t5e = (Date.now() - t5) / 1000;
  console.log(`  ✅ ${backtested.length} pairs pass backtest screening (${t5e.toFixed(1)}s)`);
  console.log('');

  if (backtested.length === 0) {
    console.log('  ⚠️  No pairs passed backtest screening. Market conditions may be unfavorable.');
    return buildEarlyExitResult(config, coins, priceData.size, totalPossiblePairs, {
      correlation: { totalInput: priceData.size, totalPairs: totalPossiblePairs, passing: correlated.length, elapsed: t3e },
      cointegration: { totalInput: correlated.length, passing: cointegrated.length, elapsed: t4e },
      quickBacktest: { totalInput: cointegrated.length, passing: 0, elapsed: t5e },
    });
  }

  // ── Stage 6: Walk-Forward ──
  console.log('━━━ Stage 6/7: Walk-Forward Deep Analysis ━━━');
  console.log(`  🔬 Analyzing ${backtested.length} pairs (${config.walkForwardRounds} rounds × ${config.walkForwardPeriods} periods each)`);
  const t6 = Date.now();
  const wfResults = runWalkForwardStage(backtested, priceData, config);
  const t6e = (Date.now() - t6) / 1000;
  console.log(`\n  ✅ ${wfResults.length} pairs analyzed (${t6e.toFixed(1)}s)`);
  console.log('');

  // ── Stage 7: Selection ──
  console.log('━━━ Stage 7/7: Final Selection ━━━');
  const { selected, dangerZone } = selectAndRank(wfResults, config);
  console.log(`  🏆 Selected ${selected.length} pairs`);
  if (dangerZone.length > 0) {
    console.log(`  ⚠️  ${dangerZone.length} pairs in danger zone`);
  }

  const totalElapsed = (Date.now() - t0) / 1000;

  const result: AutoSelectResult = {
    timestamp: new Date().toISOString(),
    config,
    universe: {
      totalMarketsScanned: coins.length,
      qualified: priceData.size,
      coins: Array.from(priceData.keys()),
    },
    stages: {
      correlation: { totalInput: priceData.size, totalPairs: totalPossiblePairs, passing: correlated.length, elapsed: t3e },
      cointegration: { totalInput: correlated.length, passing: cointegrated.length, elapsed: t4e },
      quickBacktest: { totalInput: cointegrated.length, passing: backtested.length, elapsed: t5e },
      walkForward: { totalInput: backtested.length, passing: wfResults.length, elapsed: t6e },
    },
    rankings: wfResults,
    selected,
    dangerZone,
    totalElapsed,
  };

  return result;
}

// ─── Helper: Result when pipeline exits early, preserving partial stage stats ───

function buildEarlyExitResult(
  config: AutoSelectConfig,
  coins: CoinInfo[],
  qualifiedCoins: number,
  totalPossiblePairs: number,
  partialStages: Partial<AutoSelectResult['stages']>,
): AutoSelectResult {
  const defaultStage = { totalInput: 0, passing: 0, elapsed: 0 };
  const elapsed = Object.values(partialStages).reduce((sum, s) => sum + (s?.elapsed ?? 0), 0);
  return {
    timestamp: new Date().toISOString(),
    config,
    universe: { totalMarketsScanned: coins.length, qualified: qualifiedCoins, coins: [] },
    stages: {
      correlation: { totalInput: qualifiedCoins, totalPairs: totalPossiblePairs, passing: 0, ...defaultStage, ...partialStages.correlation },
      cointegration: { ...defaultStage, ...partialStages.cointegration },
      quickBacktest: { ...defaultStage, ...partialStages.quickBacktest },
      walkForward: { ...defaultStage, ...partialStages.walkForward },
    },
    rankings: [],
    selected: [],
    dangerZone: [],
    totalElapsed: elapsed,
  };
}

// ─── CLI Entry Point ───

async function runFromCli(): Promise<void> {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_CONFIG };

  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--universe': case '-u':
        config.universeSize = parseInt(next); i++; break;
      case '--top':
        config.topN = parseInt(next); i++; break;
      case '--rounds': case '-n':
        config.walkForwardRounds = parseInt(next); i++; break;
      case '--periods':
        config.walkForwardPeriods = parseInt(next); i++; break;
      case '--years': case '-y':
        config.dataYears = parseInt(next); i++; break;
      case '--timeframe': case '-t':
        config.timeframe = next as '1h' | '4h'; i++; break;
      case '--min-volume':
        config.minDailyVolume = parseFloat(next); i++; break;
      case '--correlation':
        config.correlationThreshold = parseFloat(next); i++; break;
      case '--cointegration':
        config.cointegrationPValue = parseFloat(next); i++; break;
      case '--half-life-min':
        config.halfLifeRange[0] = parseInt(next); i++; break;
      case '--half-life-max':
        config.halfLifeRange[1] = parseInt(next); i++; break;
      case '--presets':
        config.quickBacktestPresets = parseInt(next); i++; break;
      case '--wf-candidates':
        config.topCandidatesForWF = parseInt(next); i++; break;
      case '--seed':
        config.seed = parseInt(next); i++; break;
      case '--capital':
        config.capitalPerLeg = parseFloat(next); i++; break;
      case '--leverage':
        config.leverage = parseFloat(next); i++; break;
      case '--apply':
        config.autoApply = true; break;
      case '--json':
        config.jsonOutput = true; break;
      case '--help': case '-h':
        printHelp(); process.exit(0);
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  try {
    const result = await runAutoSelect(config);

    if (config.jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatAutoSelectReport(result));
    }

    if (config.autoApply && result.selected.length > 0) {
      applyToConfig(result.selected, './config.json');
    }

    console.log('\n✅ Auto-selection complete.');
  } catch (err) {
    console.error('\n❌ Auto-selection failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
Automatic Pair Selection System

Usage:
  npx tsx src/scanner/auto-pair-selector.ts [options]

Options:
  --universe, -u <N>     Max coins to scan (default: 50)
  --top <N>              Final selection count (default: 5)
  --rounds, -n <N>       Walk-forward rounds per pair (default: 150)
  --periods <N>          Walk-forward sub-periods (default: 6)
  --years, -y <N>        Years of historical data (default: 3)
  --timeframe, -t <tf>   Candle timeframe: 1h or 4h (default: 1h)
  --min-volume <N>       Min daily volume in USD (default: 10000000)
  --correlation <N>      Min correlation threshold (default: 0.60)
  --cointegration <N>    Max cointegration p-value (default: 0.10)
  --half-life-min <N>    Min half-life in bars (default: 2)
  --half-life-max <N>    Max half-life in bars (default: 336)
  --presets <N>          Quick backtest presets (default: 5)
  --wf-candidates <N>    Max pairs for walk-forward (default: 15)
  --seed <N>             Random seed (default: 42)
  --capital <N>          Capital per leg in USD (default: 25)
  --leverage <N>         Leverage multiplier (default: 10)
  --apply                Auto-write selected pairs to config.json
  --json                 Output results as JSON
  --help, -h             Show this help

Examples:
  npx tsx src/scanner/auto-pair-selector.ts                          # Full scan
  npx tsx src/scanner/auto-pair-selector.ts --universe 30 --top 3    # Smaller scan
  npx tsx src/scanner/auto-pair-selector.ts --apply                  # Auto-update config
  npx tsx src/scanner/auto-pair-selector.ts --json > results.json    # Export JSON
`);
}

// ─── Entry guard ───

const isMainModule = process.argv[1]?.includes('auto-pair-selector');
if (isMainModule) {
  runFromCli();
}

export { runAutoSelect, type AutoSelectConfig, type AutoSelectResult, type PairCandidate };
