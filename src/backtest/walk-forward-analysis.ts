#!/usr/bin/env npx tsx
/**
 * Walk-Forward Stability Analysis
 *
 * Splits 3 years of historical data into 6 sub-periods (~6 months each),
 * runs parameter sweeps on each period independently, and ranks parameter sets
 * by cross-period stability — not just raw performance.
 *
 * The goal: find the signal filters that work CONSISTENTLY, not just the ones
 * that happened to be the best in one lucky period.
 *
 * Usage:
 *   npx tsx src/backtest/walk-forward-analysis.ts --pair ETH/XRP --years 3 --periods 6 --rounds 300
 */

import { ols } from '../scanner/cointegration.js';
import {
  mulberry32,
  generateClassicParams,
  runClassicFast,
  computeQuickMetrics,
  pearsonCorrelation,
  progressBar,
  CLASSIC_PARAM_SPACE,
  type ZScoreParamSpace,
  type OptimizerConfig,
  type QuickTrade,
} from './zscore-optimizer.js';
import type { HistoricalFetchConfig } from './historical-fetcher.js';

// ─── Types ───

export interface WalkForwardConfig {
  pair: string;
  years: number;
  periods: number;
  rounds: number;
  timeframe: '1h' | '4h' | '1d';
  capitalPerLeg: number;
  leverage: number;
  feeRate: number;
  warmupBars: number;
  seed?: number;
  topN: number;
  jsonOutput: boolean;
}

export interface TimePeriod {
  index: number;
  label: string;
  startBar: number;    // inclusive (with warmup)
  endBar: number;      // exclusive
  dataStartBar: number; // where scoring begins (after warmup)
  bars: number;        // scoring bars only
}

export interface PeriodResult {
  periodIndex: number;
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  avgBarsHeld: number;
}

export interface StabilityMetrics {
  sharpeStability: number;
  winRateConsistency: number;
  profitablePeriodsRatio: number;
  drawdownConsistency: number;
  avgSharpe: number;
  minSharpe: number;
  maxSharpe: number;
  avgPnl: number;
  totalPnlAllPeriods: number;
  compositeScore: number;
}

export interface WalkForwardRound {
  rank: number;
  params: Record<string, number>;
  periodResults: PeriodResult[];
  stability: StabilityMetrics;
}

export interface ParamSensitivityAnalysis {
  paramCorrelations: Record<string, number>;
  optimalRanges: Record<string, { min: number; max: number; mean: number; median: number }>;
}

export interface WalkForwardResult {
  pair: string;
  dataPoints: number;
  totalBars: number;
  periods: TimePeriod[];
  totalRounds: number;
  validRounds: number;
  elapsed: number;
  rounds: WalkForwardRound[];
  top: WalkForwardRound[];
  paramSensitivity: ParamSensitivityAnalysis;
  dangerZone: WalkForwardRound[];
}

// ─── Constants ───

const DEFAULT_WF_CONFIG: WalkForwardConfig = {
  pair: 'ETH/XRP',
  years: 3,
  periods: 6,
  rounds: 300,
  timeframe: '1h',
  capitalPerLeg: 25,
  leverage: 10,
  feeRate: 0.0006,
  warmupBars: 500,
  topN: 20,
  jsonOutput: false,
};

// ─── Data Splitting ───

export function splitIntoPeriods(
  totalBars: number,
  numPeriods: number,
  warmupBars: number,
  timeframe: '1h' | '4h' | '1d' = '1h',
): TimePeriod[] {
  const periodLength = Math.floor(totalBars / numPeriods);
  const hoursPerBar = timeframe === '4h' ? 4 : timeframe === '1d' ? 24 : 1;
  const periods: TimePeriod[] = [];

  for (let i = 0; i < numPeriods; i++) {
    const dataStartBar = i * periodLength;
    const startBar = Math.max(0, dataStartBar - warmupBars);
    const endBar = i === numPeriods - 1 ? totalBars : (i + 1) * periodLength;
    const bars = endBar - dataStartBar;

    // Estimate date range
    const startMonths = Math.round(dataStartBar * hoursPerBar / 730); // ~730 hours per month
    const endMonths = Math.round(endBar * hoursPerBar / 730);
    const label = `Period ${i + 1} (~month ${startMonths} → ${endMonths})`;

    periods.push({ index: i, label, startBar, endBar, dataStartBar, bars });
  }

  return periods;
}

// ─── Stability Metrics ───

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]): number {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

export function computeStabilityMetrics(periodResults: PeriodResult[]): StabilityMetrics {
  const sharpes = periodResults.map(r => r.sharpeRatio);
  const winRates = periodResults.map(r => r.winRate);
  const pnls = periodResults.map(r => r.totalPnl);
  const maxDDs = periodResults.map(r => r.maxDrawdownPercent);

  const avgSharpe = mean(sharpes);
  const stdSharpe = std(sharpes);
  const sharpeStability = stdSharpe > 0 ? avgSharpe / stdSharpe : (avgSharpe > 0 ? 10 : 0);

  const winRateConsistency = 1 - std(winRates);
  const profitablePeriodsRatio = pnls.filter(p => p > 0).length / pnls.length;
  const drawdownConsistency = 1 - std(maxDDs);
  const minSharpe = Math.min(...sharpes);
  const maxSharpe = Math.max(...sharpes);
  const avgPnl = mean(pnls);
  const totalPnlAllPeriods = pnls.reduce((a, b) => a + b, 0);

  // Composite score — weighted, stability-first
  const compositeScore = (
    0.30 * Math.max(0, sharpeStability) +
    0.20 * profitablePeriodsRatio * 10 +
    0.15 * Math.max(0, avgSharpe) +
    0.15 * Math.max(0, minSharpe) * 2 +
    0.10 * Math.max(0, winRateConsistency) * 10 +
    0.10 * Math.max(0, drawdownConsistency) * 10
  );

  return {
    sharpeStability, winRateConsistency, profitablePeriodsRatio,
    drawdownConsistency, avgSharpe, minSharpe, maxSharpe,
    avgPnl, totalPnlAllPeriods, compositeScore,
  };
}

// ─── Main Engine ───

export function runWalkForwardAnalysis(
  pricesA: number[],
  pricesB: number[],
  pair: string,
  config: WalkForwardConfig,
  paramSpace: ZScoreParamSpace = CLASSIC_PARAM_SPACE,
): WalkForwardResult {
  const startTime = Date.now();
  const n = Math.min(pricesA.length, pricesB.length);

  if (n < 200) {
    return {
      pair, dataPoints: n, totalBars: n, periods: [], totalRounds: 0,
      validRounds: 0, elapsed: 0, rounds: [], top: [],
      paramSensitivity: { paramCorrelations: {}, optimalRanges: {} },
      dangerZone: [],
    };
  }

  // 1. Compute spread once (hedge ratio from first 50%)
  const halfN = Math.floor(n * 0.5);
  const logA = pricesA.slice(0, n).map(Math.log);
  const logB = pricesB.slice(0, n).map(Math.log);
  const { beta } = ols(logB.slice(0, halfN), logA.slice(0, halfN));

  const spread: number[] = [];
  for (let i = 0; i < n; i++) {
    spread.push(logA[i] - beta * logB[i]);
  }

  // 2. Split into periods
  const periods = splitIntoPeriods(n, config.periods, config.warmupBars, config.timeframe);

  console.log(`  📊 Spread computed: beta=${beta.toFixed(6)}, ${n} bars`);
  console.log(`  📅 ${config.periods} periods × ~${periods[0]?.bars ?? 0} bars each (warmup: ${config.warmupBars})`);
  console.log(``);

  // 3. Initialize PRNG
  const rng = mulberry32(config.seed ?? Date.now());

  // Optimizer config for runClassicFast
  const optiConfig: OptimizerConfig = {
    rounds: config.rounds,
    strategyType: 'classic',
    capitalPerLeg: config.capitalPerLeg,
    leverage: config.leverage,
    feeRate: config.feeRate,
    inSampleRatio: 0.5,
    topN: config.topN,
  };

  // 4. Run parameter sweep
  const allRounds: WalkForwardRound[] = [];
  let validCount = 0;
  const totalTests = config.rounds * config.periods;

  for (let r = 0; r < config.rounds; r++) {
    const params = generateClassicParams(paramSpace, rng);
    if (!params) continue;

    const periodResults: PeriodResult[] = [];
    let hasAnyTrades = false;

    for (const period of periods) {
      // Slice spread for this period (with warmup)
      const periodSpread = spread.slice(period.startBar, period.endBar);

      // Run fast backtest on this period's spread
      const trades = runClassicFast(periodSpread, params, optiConfig);
      const metrics = computeQuickMetrics(trades);

      if (metrics.totalTrades > 0) hasAnyTrades = true;

      periodResults.push({
        periodIndex: period.index,
        totalTrades: metrics.totalTrades,
        winRate: metrics.winRate,
        totalPnl: metrics.totalPnl,
        avgPnl: metrics.avgPnl,
        sharpeRatio: metrics.sharpeRatio,
        maxDrawdown: metrics.maxDrawdown,
        maxDrawdownPercent: metrics.maxDrawdownPercent,
        profitFactor: Math.min(metrics.profitFactor, 100), // cap infinite
        avgBarsHeld: metrics.avgBarsHeld,
      });
    }

    if (hasAnyTrades) validCount++;

    const stability = computeStabilityMetrics(periodResults);

    allRounds.push({
      rank: 0,
      params,
      periodResults,
      stability,
    });

    // Progress
    const completed = r + 1;
    if (completed % 10 === 0 || completed === config.rounds) {
      const pct = (completed / config.rounds * 100).toFixed(0);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const backtests = completed * config.periods;
      process.stdout.write(
        `\r  ⚡ Progress: ${completed}/${config.rounds} params (${pct}%) | ${backtests} backtests | Valid: ${validCount} | ${elapsed}s`
      );
    }
  }

  console.log(''); // newline after progress

  // 5. Sort by composite score
  allRounds.sort((a, b) => b.stability.compositeScore - a.stability.compositeScore);

  // Assign ranks
  for (let i = 0; i < allRounds.length; i++) {
    allRounds[i].rank = i + 1;
  }

  const top = allRounds.slice(0, config.topN);
  const elapsed = (Date.now() - startTime) / 1000;

  // 6. Parameter sensitivity
  const paramSensitivity = analyzeParamSensitivity(allRounds);

  // 7. Danger zone
  const compositeValues = allRounds.map(r => r.stability.compositeScore).sort((a, b) => a - b);
  const medianComposite = compositeValues[Math.floor(compositeValues.length / 2)] ?? 0;
  const dangerZone = identifyDangerZone(allRounds, medianComposite);

  return {
    pair, dataPoints: n, totalBars: n, periods,
    totalRounds: config.rounds, validRounds: validCount,
    elapsed, rounds: allRounds, top,
    paramSensitivity, dangerZone,
  };
}

// ─── Parameter Sensitivity ───

function analyzeParamSensitivity(rounds: WalkForwardRound[]): ParamSensitivityAnalysis {
  const withTrades = rounds.filter(r =>
    r.periodResults.some(p => p.totalTrades > 0)
  );

  if (withTrades.length === 0) {
    return { paramCorrelations: {}, optimalRanges: {} };
  }

  const paramNames = Object.keys(withTrades[0].params);
  const paramCorrelations: Record<string, number> = {};

  for (const pName of paramNames) {
    const paramVals = withTrades.map(r => r.params[pName]);
    const scoreVals = withTrades.map(r => r.stability.compositeScore);
    paramCorrelations[pName] = pearsonCorrelation(paramVals, scoreVals);
  }

  // Optimal ranges from top 10%
  const topCount = Math.max(1, Math.floor(withTrades.length * 0.1));
  const topRounds = withTrades.slice(0, topCount);

  const optimalRanges: Record<string, { min: number; max: number; mean: number; median: number }> = {};
  for (const pName of paramNames) {
    const vals = topRounds.map(r => r.params[pName]).sort((a, b) => a - b);
    optimalRanges[pName] = {
      min: vals[0],
      max: vals[vals.length - 1],
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      median: vals[Math.floor(vals.length / 2)],
    };
  }

  return { paramCorrelations, optimalRanges };
}

// ─── Danger Zone ───

function identifyDangerZone(rounds: WalkForwardRound[], medianComposite: number): WalkForwardRound[] {
  return rounds.filter(r =>
    r.stability.totalPnlAllPeriods > 0 &&              // Looks profitable overall
    r.stability.compositeScore < medianComposite &&     // But unstable
    r.stability.profitablePeriodsRatio < 0.67           // Fails in 2+ of 6 periods
  ).slice(0, 10);
}

// ─── Report Formatting ───

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function corrBar(corr: number): string {
  const width = 20;
  const center = Math.floor(width / 2);
  const chars = Array(width).fill('·');
  const filled = Math.round(Math.abs(corr) * center);
  if (corr >= 0) {
    for (let i = 0; i < filled; i++) chars[center + i] = '█';
  } else {
    for (let i = 0; i < filled; i++) chars[center - 1 - i] = '█';
  }
  chars[center] = '│';
  return `[${chars.join('')}]`;
}

export function formatWalkForwardReport(result: WalkForwardResult): string {
  const lines: string[] = [];

  // ── Header ──
  lines.push(`
╔══════════════════════════════════════════════════════════════════════════════╗
║          WALK-FORWARD STABILITY ANALYSIS                                   ║
╚══════════════════════════════════════════════════════════════════════════════╝
`);

  lines.push(`  Pair:          ${result.pair}`);
  lines.push(`  Data Points:   ${result.dataPoints.toLocaleString()} candles`);
  lines.push(`  Periods:       ${result.periods.length} × ~${result.periods[0]?.bars.toLocaleString() ?? '?'} bars`);
  lines.push(`  Param Rounds:  ${result.totalRounds} (× ${result.periods.length} periods = ${result.totalRounds * result.periods.length} backtests)`);
  lines.push(`  Valid Rounds:  ${result.validRounds} (${(result.validRounds / result.totalRounds * 100).toFixed(1)}%)`);
  lines.push(`  Elapsed:       ${result.elapsed.toFixed(1)}s`);
  lines.push(``);

  // ── Period Overview ──
  lines.push(`  ═══ TIME PERIODS ═══`);
  lines.push(``);
  lines.push(`  ${'#'.padStart(3)} | ${'Start Bar'.padStart(10)} | ${'End Bar'.padStart(8)} | ${'Scoring'.padStart(8)} | ${'Label'}`);
  lines.push(`  ${'─'.repeat(70)}`);
  for (const p of result.periods) {
    lines.push(`  ${String(p.index + 1).padStart(3)} | ${String(p.startBar).padStart(10)} | ${String(p.endBar).padStart(8)} | ${String(p.bars).padStart(8)} | ${p.label}`);
  }
  lines.push(``);

  // ── Top N Stable Configs ──
  lines.push(`  ═══ TOP ${result.top.length} MOST STABLE PARAMETER SETS (by Composite Score) ═══`);
  lines.push(``);

  const header = `  ${'#'.padStart(3)} | ${'EntZ'.padStart(5)} | ${'ExZ'.padStart(4)} | ${'SLZ'.padStart(4)} | ${'Win'.padStart(5)} | ${'Buf'.padStart(4)} | ${'Grc'.padStart(3)} | ${'Coo'.padStart(3)} | ${'Score'.padStart(6)} | ${'AvgShp'.padStart(6)} | ${'MinShp'.padStart(6)} | ${'Prof'.padStart(4)} | ${'StabS'.padStart(5)} | ${'AvgPnL'.padStart(8)}`;
  const sep = `  ${'─'.repeat(header.length - 2)}`;

  lines.push(header);
  lines.push(sep);

  for (const r of result.top) {
    const rank = String(r.rank).padStart(3);
    const entryZ = r.params.entryZ.toFixed(1).padStart(5);
    const exitZ = r.params.exitZ.toFixed(1).padStart(4);
    const slZ = r.params.stopLossZ.toFixed(1).padStart(4);
    const win = String(Math.round(r.params.window)).padStart(5);
    const buf = r.params.safeZoneBuffer.toFixed(1).padStart(4);
    const grace = String(Math.round(r.params.gracePeriodBars)).padStart(3);
    const cool = String(Math.round(r.params.cooldownBars)).padStart(3);
    const score = r.stability.compositeScore.toFixed(2).padStart(6);
    const avgShp = r.stability.avgSharpe.toFixed(3).padStart(6);
    const minShp = r.stability.minSharpe.toFixed(3).padStart(6);
    const prof = `${Math.round(r.stability.profitablePeriodsRatio * result.periods.length)}/${result.periods.length}`.padStart(4);
    const stabS = r.stability.sharpeStability.toFixed(2).padStart(5);
    const avgPnl = `$${r.stability.avgPnl.toFixed(2)}`.padStart(8);

    const prefix = r.rank === 1 ? '🏆' : '  ';
    lines.push(`${prefix}${rank} | ${entryZ} | ${exitZ} | ${slZ} | ${win} | ${buf} | ${grace} | ${cool} | ${score} | ${avgShp} | ${minShp} | ${prof} | ${stabS} | ${avgPnl}`);
  }
  lines.push(sep);

  // ── Per-Period Breakdown for Top 5 ──
  lines.push(``);
  lines.push(`  ═══ PER-PERIOD BREAKDOWN (Top 5 Configs) ═══`);

  const top5 = result.top.slice(0, 5);
  for (const r of top5) {
    lines.push(``);
    lines.push(`  Config #${r.rank}: entryZ=${r.params.entryZ.toFixed(1)}, exitZ=${r.params.exitZ.toFixed(1)}, SLZ=${r.params.stopLossZ.toFixed(1)}, win=${Math.round(r.params.window)}, buf=${r.params.safeZoneBuffer.toFixed(1)}`);
    lines.push(`  ${'P'.padStart(3)} | ${'Sharpe'.padStart(7)} | ${'WinR%'.padStart(6)} | ${'PnL $'.padStart(8)} | ${'MaxDD$'.padStart(7)} | ${'Trades'.padStart(6)} | ${'PF'.padStart(6)} | ${'Bars'.padStart(5)}`);
    lines.push(`  ${'─'.repeat(65)}`);

    for (const pr of r.periodResults) {
      const pIdx = String(pr.periodIndex + 1).padStart(3);
      const sharpe = pr.sharpeRatio.toFixed(3).padStart(7);
      const wr = (pr.winRate * 100).toFixed(1).padStart(6);
      const pnl = pr.totalPnl.toFixed(2).padStart(8);
      const dd = pr.maxDrawdown.toFixed(2).padStart(7);
      const trades = String(pr.totalTrades).padStart(6);
      const pf = (pr.profitFactor >= 100 ? '∞' : pr.profitFactor.toFixed(2)).padStart(6);
      const bars = pr.avgBarsHeld.toFixed(1).padStart(5);
      lines.push(`  ${pIdx} | ${sharpe} | ${wr} | ${pnl} | ${dd} | ${trades} | ${pf} | ${bars}`);
    }

    // AVG + STD rows
    const prs = r.periodResults;
    const avgRow = (arr: number[]) => mean(arr);
    const stdRow = (arr: number[]) => std(arr);

    lines.push(`  ${'─'.repeat(65)}`);
    lines.push(`  ${'AVG'.padStart(3)} | ${avgRow(prs.map(p => p.sharpeRatio)).toFixed(3).padStart(7)} | ${(avgRow(prs.map(p => p.winRate)) * 100).toFixed(1).padStart(6)} | ${avgRow(prs.map(p => p.totalPnl)).toFixed(2).padStart(8)} | ${avgRow(prs.map(p => p.maxDrawdown)).toFixed(2).padStart(7)} | ${avgRow(prs.map(p => p.totalTrades)).toFixed(0).padStart(6)} | ${avgRow(prs.map(p => Math.min(p.profitFactor, 100))).toFixed(2).padStart(6)} | ${avgRow(prs.map(p => p.avgBarsHeld)).toFixed(1).padStart(5)}`);
    lines.push(`  ${'STD'.padStart(3)} | ${stdRow(prs.map(p => p.sharpeRatio)).toFixed(3).padStart(7)} | ${(stdRow(prs.map(p => p.winRate)) * 100).toFixed(1).padStart(6)} | ${stdRow(prs.map(p => p.totalPnl)).toFixed(2).padStart(8)} | ${stdRow(prs.map(p => p.maxDrawdown)).toFixed(2).padStart(7)} | ${stdRow(prs.map(p => p.totalTrades)).toFixed(0).padStart(6)} | ${''.padStart(6)} | ${stdRow(prs.map(p => p.avgBarsHeld)).toFixed(1).padStart(5)}`);
  }

  // ── Parameter Sensitivity ──
  lines.push(``);
  lines.push(`  ═══ PARAMETER SENSITIVITY (Correlation with Composite Score) ═══`);
  lines.push(`  (Higher |r| = more impact on stability)`);
  lines.push(``);

  const sortedCorr = Object.entries(result.paramSensitivity.paramCorrelations)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  for (const [param, corr] of sortedCorr) {
    const bar = corrBar(corr);
    const impact = Math.abs(corr) > 0.3 ? '⚠️  HIGH' : Math.abs(corr) > 0.15 ? '📊 MED ' : '   LOW ';
    lines.push(`  ${impact} ${param.padEnd(18)} r=${corr.toFixed(4).padStart(8)}  ${bar}`);
  }

  // ── Optimal Ranges ──
  lines.push(``);
  lines.push(`  ═══ OPTIMAL PARAMETER RANGES (Top 10% by Composite Score) ═══`);
  lines.push(``);
  lines.push(`  ${'Parameter'.padEnd(18)} | ${'Min'.padStart(8)} | ${'Max'.padStart(8)} | ${'Mean'.padStart(8)} | ${'Median'.padStart(8)}`);
  lines.push(`  ${'─'.repeat(60)}`);

  for (const [param, range] of Object.entries(result.paramSensitivity.optimalRanges)) {
    lines.push(`  ${param.padEnd(18)} | ${fmtNum(range.min).padStart(8)} | ${fmtNum(range.max).padStart(8)} | ${fmtNum(range.mean).padStart(8)} | ${fmtNum(range.median).padStart(8)}`);
  }

  // ── Danger Zone ──
  if (result.dangerZone.length > 0) {
    lines.push(``);
    lines.push(`  ═══ ⚠️ DANGER ZONE (Profitable but Unstable) ═══`);
    lines.push(`  These configs look good overall but have HIGH variance across periods:`);
    lines.push(``);
    lines.push(`  ${'#'.padStart(3)} | ${'EntZ'.padStart(5)} | ${'ExZ'.padStart(4)} | ${'SLZ'.padStart(4)} | ${'TotalPnL'.padStart(9)} | ${'Prof'.padStart(4)} | ${'Score'.padStart(6)} | ${'AvgShp'.padStart(6)} | ${'MinShp'.padStart(6)}`);
    lines.push(`  ${'─'.repeat(60)}`);

    for (let i = 0; i < result.dangerZone.length; i++) {
      const r = result.dangerZone[i];
      lines.push(`  ${String(i + 1).padStart(3)} | ${r.params.entryZ.toFixed(1).padStart(5)} | ${r.params.exitZ.toFixed(1).padStart(4)} | ${r.params.stopLossZ.toFixed(1).padStart(4)} | ${'$' + r.stability.totalPnlAllPeriods.toFixed(2).padStart(8)} | ${Math.round(r.stability.profitablePeriodsRatio * result.periods.length) + '/' + result.periods.length} | ${r.stability.compositeScore.toFixed(2).padStart(6)} | ${r.stability.avgSharpe.toFixed(3).padStart(6)} | ${r.stability.minSharpe.toFixed(3).padStart(6)}`);
    }
  }

  // ── Recommended Config ──
  if (result.top.length > 0) {
    const best = result.top[0];
    lines.push(``);
    lines.push(`  ═══ 🏆 RECOMMENDED CONFIG (Most Stable) ═══`);
    lines.push(``);
    lines.push(`  Strategy: Classic Z-Score`);
    for (const [k, v] of Object.entries(best.params)) {
      lines.push(`    ${k}: ${fmtNum(v)}`);
    }
    lines.push(``);
    lines.push(`  Stability Metrics:`);
    lines.push(`    Composite Score:     ${best.stability.compositeScore.toFixed(2)}`);
    lines.push(`    Sharpe Stability:    ${best.stability.sharpeStability.toFixed(2)} (mean/std of Sharpe across periods)`);
    lines.push(`    Avg Sharpe:          ${best.stability.avgSharpe.toFixed(4)}`);
    lines.push(`    Min Sharpe:          ${best.stability.minSharpe.toFixed(4)} (worst period)`);
    lines.push(`    Max Sharpe:          ${best.stability.maxSharpe.toFixed(4)} (best period)`);
    lines.push(`    Profitable Periods:  ${Math.round(best.stability.profitablePeriodsRatio * result.periods.length)}/${result.periods.length}`);
    lines.push(`    Avg PnL/Period:      $${best.stability.avgPnl.toFixed(2)}`);
    lines.push(`    Total PnL (all):     $${best.stability.totalPnlAllPeriods.toFixed(2)}`);
    lines.push(`    Win Rate Consistency: ${best.stability.winRateConsistency.toFixed(4)}`);
    lines.push(`    Drawdown Consistency: ${best.stability.drawdownConsistency.toFixed(4)}`);
  }

  lines.push(``);
  return lines.join('\n');
}

// ─── CLI Entry Point ───

export async function runFromCli(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse CLI args
  const config: WalkForwardConfig = { ...DEFAULT_WF_CONFIG };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--pair': case '-p': config.pair = args[++i]; break;
      case '--years': case '-y': config.years = parseFloat(args[++i]); break;
      case '--periods': config.periods = parseInt(args[++i]); break;
      case '--rounds': case '-n': config.rounds = parseInt(args[++i]); break;
      case '--timeframe': case '-t': config.timeframe = args[++i] as '1h' | '4h' | '1d'; break;
      case '--leverage': config.leverage = parseInt(args[++i]); break;
      case '--capital': config.capitalPerLeg = parseFloat(args[++i]); break;
      case '--warmup': config.warmupBars = parseInt(args[++i]); break;
      case '--seed': config.seed = parseInt(args[++i]); break;
      case '--top': config.topN = parseInt(args[++i]); break;
      case '--json': config.jsonOutput = true; break;
      case '--help': case '-h':
        console.log(`
╔══════════════════════════════════════════════════════════════════╗
║     Walk-Forward Stability Analysis                             ║
╚══════════════════════════════════════════════════════════════════╝

Usage: npx tsx src/backtest/walk-forward-analysis.ts [options]

Options:
  --pair, -p <A/B>      Pair to analyze (default: ETH/XRP)
  --years, -y <N>       Years of historical data (default: 3)
  --periods <N>         Number of sub-periods (default: 6)
  --rounds, -n <N>      Parameter combinations to test (default: 300)
  --timeframe, -t <tf>  Timeframe: 1h, 4h, 1d (default: 1h)
  --leverage <N>        Leverage multiplier (default: 10)
  --capital <N>         Capital per leg $ (default: 25)
  --warmup <N>          Warmup overlap bars per period (default: 500)
  --seed <N>            Random seed for reproducibility
  --top <N>             Show top N results (default: 20)
  --json                Output JSON results
  --help, -h            Show this help

Examples:
  npx tsx src/backtest/walk-forward-analysis.ts --pair ETH/XRP --rounds 300 --seed 42
  npx tsx src/backtest/walk-forward-analysis.ts --pair PEPE/SHIB -n 500 --years 2
  npx tsx src/backtest/walk-forward-analysis.ts --pair BTC/ETH --periods 12 --warmup 300
        `);
        process.exit(0);
    }
  }

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║     Walk-Forward Stability Analysis                             ║
╚══════════════════════════════════════════════════════════════════╝
`);

  const [symbolA, symbolB] = config.pair.split('/');
  if (!symbolA || !symbolB) {
    console.error('❌ Invalid pair format. Use: ETH/XRP');
    process.exit(1);
  }

  console.log(`  Pair:       ${config.pair}`);
  console.log(`  Rounds:     ${config.rounds} (× ${config.periods} periods = ${config.rounds * config.periods} backtests)`);
  console.log(`  Data:       ${config.years} year(s) of ${config.timeframe} candles`);
  console.log(`  Periods:    ${config.periods} (~${(config.years * 12 / config.periods).toFixed(0)} months each)`);
  console.log(`  Warmup:     ${config.warmupBars} bars overlap`);
  console.log(`  Leverage:   ${config.leverage}x`);
  console.log(`  Capital:    $${config.capitalPerLeg}/leg`);
  if (config.seed !== undefined) console.log(`  Seed:       ${config.seed}`);
  console.log(``);

  // Fetch historical data
  const { fetchHistoricalData, getCacheInfo } = await import('./historical-fetcher.js');

  const histConfig: Partial<HistoricalFetchConfig> = {
    years: config.years,
    timeframe: config.timeframe,
    batchSize: 300,
    delayMs: 200,
  };

  // Show cache info
  const cacheA = getCacheInfo(symbolA, config.timeframe);
  const cacheB = getCacheInfo(symbolB, config.timeframe);
  if (cacheA) console.log(`  📦 Cache ${symbolA}: ${cacheA.total} candles`);
  if (cacheB) console.log(`  📦 Cache ${symbolB}: ${cacheB.total} candles`);

  console.log(`\n📡 Fetching ${config.years} year(s) of ${config.timeframe} data for ${symbolA}...`);
  const pricesA = await fetchHistoricalData(symbolA, histConfig, (p) => {
    const bar = progressBar(p.percentComplete, 30);
    process.stdout.write(`\r  ${bar} ${p.percentComplete.toFixed(1)}% | ${p.totalCandles} candles | ${p.elapsed.toFixed(0)}s`);
  });
  console.log(`\n  ✅ ${symbolA}: ${pricesA.length} candles`);

  console.log(`📡 Fetching ${config.years} year(s) of ${config.timeframe} data for ${symbolB}...`);
  const pricesB = await fetchHistoricalData(symbolB, histConfig, (p) => {
    const bar = progressBar(p.percentComplete, 30);
    process.stdout.write(`\r  ${bar} ${p.percentComplete.toFixed(1)}% | ${p.totalCandles} candles | ${p.elapsed.toFixed(0)}s`);
  });
  console.log(`\n  ✅ ${symbolB}: ${pricesB.length} candles`);

  // Align lengths
  const minLen = Math.min(pricesA.length, pricesB.length);
  const alignedA = pricesA.slice(pricesA.length - minLen);
  const alignedB = pricesB.slice(pricesB.length - minLen);

  const barsPerDay = config.timeframe === '4h' ? 6 : config.timeframe === '1d' ? 1 : 24;
  console.log(`\n📊 Aligned to ${minLen.toLocaleString()} candles (~${(minLen / barsPerDay / 365.25).toFixed(1)} years)`);

  // Cointegration test
  const { testCointegration } = await import('../scanner/cointegration.js');
  const coint = testCointegration(alignedA, alignedB, symbolA, symbolB);
  console.log(`📈 Cointegration: pValue=${coint.pValue.toFixed(4)}, halfLife=${coint.halfLife.toFixed(1)}, beta=${coint.beta.toFixed(6)}`);
  console.log(`   Cointegrated: ${coint.isCointegrated ? '✅ YES' : '❌ NO'}`);

  // Validate period size
  const approxBarsPerPeriod = Math.floor(minLen / config.periods);
  if (approxBarsPerPeriod < config.warmupBars + 100) {
    console.warn(`\n⚠️ Warning: Period size (${approxBarsPerPeriod} bars) is too small for warmup (${config.warmupBars} bars). Reducing warmup.`);
    config.warmupBars = Math.max(50, Math.floor(approxBarsPerPeriod * 0.3));
  }

  // Run analysis
  console.log(`\n🚀 Starting ${config.rounds}-round walk-forward analysis across ${config.periods} periods...\n`);

  const result = runWalkForwardAnalysis(alignedA, alignedB, config.pair, config);

  // Print report
  console.log(formatWalkForwardReport(result));

  // JSON output
  if (config.jsonOutput) {
    const jsonData = {
      pair: result.pair,
      dataPoints: result.dataPoints,
      periods: result.periods,
      totalRounds: result.totalRounds,
      validRounds: result.validRounds,
      elapsed: result.elapsed,
      top: result.top.map(r => ({
        rank: r.rank,
        params: r.params,
        stability: r.stability,
        periodResults: r.periodResults,
      })),
      paramSensitivity: result.paramSensitivity,
      dangerZone: result.dangerZone.map(r => ({
        params: r.params,
        stability: r.stability,
      })),
    };
    console.log('\n--- JSON OUTPUT ---');
    console.log(JSON.stringify(jsonData, null, 2));
  }

  console.log(`\n✅ Walk-forward analysis complete.`);
}

// Run if called directly
const isMainModule = process.argv[1]?.includes('walk-forward-analysis');
if (isMainModule) {
  runFromCli().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
  });
}
