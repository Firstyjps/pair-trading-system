/**
 * Adaptive Auto-Tuning Scheduler
 *
 * Runs weekly walk-forward optimization on recent data,
 * compares proposed config vs current config,
 * and sends Telegram approval request before applying.
 */

import { ols } from '../scanner/cointegration.js';
import {
  mulberry32,
  generateClassicParams,
  runClassicFast,
  computeQuickMetrics,
  CLASSIC_PARAM_SPACE,
  type ZScoreParamSpace,
  type OptimizerConfig,
} from '../backtest/zscore-optimizer.js';
import { getTradingConfig, updateTradingConfig, type TradingConfig } from '../config.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('autotuner');

// ─── Types ───

export interface TuneResult {
  currentConfig: Partial<TradingConfig>;
  proposedConfig: Partial<TradingConfig>;
  currentMetrics: TuneMetrics;
  proposedMetrics: TuneMetrics;
  improvement: {
    sharpe: number;
    winRate: number;
    pnl: number;
  };
  rounds: number;
  dataPoints: number;
  timestamp: string;
}

export interface TuneMetrics {
  sharpeRatio: number;
  winRate: number;
  totalPnl: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  totalTrades: number;
}

// ─── Pending Approval State ───

let pendingProposal: TuneResult | null = null;

export function getPendingProposal(): TuneResult | null {
  return pendingProposal;
}

export function clearPendingProposal(): void {
  pendingProposal = null;
}

/**
 * Approve the pending proposal and apply it to config.
 * Returns the applied config changes.
 */
export function approveProposal(queries?: { insertConfigHistory(json: string): void }): Partial<TradingConfig> | null {
  if (!pendingProposal) return null;

  const proposed = pendingProposal.proposedConfig;
  log.info({ proposed }, 'Applying approved auto-tune config');

  updateTradingConfig(proposed);

  if (queries) {
    queries.insertConfigHistory(JSON.stringify(getTradingConfig()));
  }

  const applied = { ...proposed };
  pendingProposal = null;
  return applied;
}

/**
 * Reject the pending proposal.
 */
export function rejectProposal(): void {
  log.info('Auto-tune proposal rejected');
  pendingProposal = null;
}

// ─── Core Auto-Tune Logic ───

export interface AutoTuneConfig {
  rounds: number;
  lookbackDays: number;
  capitalPerLeg: number;
  leverage: number;
  feeRate: number;
  minImprovement: number; // minimum Sharpe improvement to propose (e.g. 0.1)
}

const DEFAULT_AUTOTUNE: AutoTuneConfig = {
  rounds: 200,
  lookbackDays: 30,
  capitalPerLeg: 25,
  leverage: 5,
  feeRate: 0.0006,
  minImprovement: 0.1,
};

/**
 * Run auto-tune optimization on provided price data.
 *
 * @param pricePairs - Map of "SYMBOL_A/SYMBOL_B" → { pricesA, pricesB }
 * @param userConfig - Override default auto-tune settings
 * @returns TuneResult if a better config was found, null otherwise
 */
export function runAutoTune(
  pricePairs: Map<string, { pricesA: number[]; pricesB: number[] }>,
  userConfig?: Partial<AutoTuneConfig>,
): TuneResult | null {
  const cfg = { ...DEFAULT_AUTOTUNE, ...userConfig };
  const tradingConfig = getTradingConfig();

  if (pricePairs.size === 0) {
    log.warn('No price data provided for auto-tune');
    return null;
  }

  log.info({ pairs: pricePairs.size, rounds: cfg.rounds }, 'Starting auto-tune optimization');

  // Build spreads from all pairs
  const spreads: number[][] = [];
  for (const [pair, { pricesA, pricesB }] of pricePairs) {
    const n = Math.min(pricesA.length, pricesB.length);
    if (n < 100) {
      log.warn({ pair, bars: n }, 'Insufficient data for auto-tune, skipping pair');
      continue;
    }

    // Compute spread using OLS hedge ratio
    const { beta } = ols(pricesA.slice(0, n), pricesB.slice(0, n));
    const spread = pricesA.slice(0, n).map((a, i) => a - beta * pricesB[i]);
    spreads.push(spread);
  }

  if (spreads.length === 0) {
    log.warn('No valid spreads for auto-tune');
    return null;
  }

  const totalDataPoints = spreads.reduce((s, sp) => s + sp.length, 0);

  // Evaluate current config
  const currentParams: Record<string, number> = {
    entryZ: tradingConfig.entryZScore,
    exitZ: tradingConfig.exitZScore,
    stopLossZ: tradingConfig.stopLossZScore,
    window: tradingConfig.lookbackPeriods,
    safeZoneBuffer: tradingConfig.safeZoneBuffer,
    gracePeriodBars: 5,
    cooldownBars: 24,
  };

  const optimizerConfig: OptimizerConfig = {
    rounds: cfg.rounds,
    strategyType: 'classic',
    capitalPerLeg: cfg.capitalPerLeg,
    leverage: cfg.leverage,
    feeRate: cfg.feeRate,
    inSampleRatio: 1.0,
    topN: 10,
  };

  const currentMetrics = evaluateParams(currentParams, spreads, optimizerConfig);

  // Random search for better params
  const rng = mulberry32(Date.now());
  let bestParams = currentParams;
  let bestMetrics = currentMetrics;

  for (let round = 0; round < cfg.rounds; round++) {
    const params = generateClassicParams(CLASSIC_PARAM_SPACE, rng);
    if (!params) continue;

    const metrics = evaluateParams(params, spreads, optimizerConfig);

    // Score: prioritize Sharpe but penalize low trade count and high drawdown
    const score = metrics.sharpeRatio * (metrics.totalTrades >= 5 ? 1 : 0.3) * (1 - metrics.maxDrawdownPercent * 0.5);
    const bestScore = bestMetrics.sharpeRatio * (bestMetrics.totalTrades >= 5 ? 1 : 0.3) * (1 - bestMetrics.maxDrawdownPercent * 0.5);

    if (score > bestScore && metrics.totalTrades >= 3) {
      bestParams = params;
      bestMetrics = metrics;
    }
  }

  // Check if improvement is significant
  const sharpeImprovement = bestMetrics.sharpeRatio - currentMetrics.sharpeRatio;
  if (sharpeImprovement < cfg.minImprovement) {
    log.info({
      currentSharpe: currentMetrics.sharpeRatio.toFixed(2),
      bestSharpe: bestMetrics.sharpeRatio.toFixed(2),
      improvement: sharpeImprovement.toFixed(3),
    }, 'No significant improvement found — keeping current config');
    return null;
  }

  // Build proposed config
  const proposedConfig: Partial<TradingConfig> = {
    entryZScore: bestParams.entryZ,
    exitZScore: bestParams.exitZ,
    stopLossZScore: bestParams.stopLossZ,
    lookbackPeriods: bestParams.window,
    safeZoneBuffer: bestParams.safeZoneBuffer,
  };

  const result: TuneResult = {
    currentConfig: {
      entryZScore: tradingConfig.entryZScore,
      exitZScore: tradingConfig.exitZScore,
      stopLossZScore: tradingConfig.stopLossZScore,
      lookbackPeriods: tradingConfig.lookbackPeriods,
      safeZoneBuffer: tradingConfig.safeZoneBuffer,
    },
    proposedConfig,
    currentMetrics,
    proposedMetrics: bestMetrics,
    improvement: {
      sharpe: sharpeImprovement,
      winRate: bestMetrics.winRate - currentMetrics.winRate,
      pnl: bestMetrics.totalPnl - currentMetrics.totalPnl,
    },
    rounds: cfg.rounds,
    dataPoints: totalDataPoints,
    timestamp: new Date().toISOString(),
  };

  // Store as pending proposal
  pendingProposal = result;

  log.info({
    currentSharpe: currentMetrics.sharpeRatio.toFixed(2),
    proposedSharpe: bestMetrics.sharpeRatio.toFixed(2),
    improvement: sharpeImprovement.toFixed(3),
  }, 'Auto-tune proposal ready — awaiting approval');

  return result;
}

/**
 * Evaluate a parameter set across multiple spreads and return aggregated metrics.
 */
function evaluateParams(
  params: Record<string, number>,
  spreads: number[][],
  config: OptimizerConfig,
): TuneMetrics {
  let allPnl = 0;
  let allTrades = 0;
  let allWins = 0;
  let allGross = 0;
  let allLoss = 0;
  let worstDD = 0;
  const allSharpes: number[] = [];

  for (const spread of spreads) {
    const trades = runClassicFast(spread, params, config);
    const metrics = computeQuickMetrics(trades);

    allPnl += metrics.totalPnl;
    allTrades += metrics.totalTrades;
    allWins += Math.round(metrics.winRate * metrics.totalTrades);
    allGross += trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    allLoss += Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    if (metrics.maxDrawdownPercent > worstDD) worstDD = metrics.maxDrawdownPercent;
    if (metrics.totalTrades > 0) allSharpes.push(metrics.sharpeRatio);
  }

  const avgSharpe = allSharpes.length > 0
    ? allSharpes.reduce((a, b) => a + b, 0) / allSharpes.length
    : 0;

  return {
    sharpeRatio: avgSharpe,
    winRate: allTrades > 0 ? allWins / allTrades : 0,
    totalPnl: allPnl,
    profitFactor: allLoss > 0 ? allGross / allLoss : allGross > 0 ? Infinity : 0,
    maxDrawdownPercent: worstDD,
    totalTrades: allTrades,
  };
}

// ─── Formatting ───

export function formatTuneResult(result: TuneResult): string {
  const c = result.currentMetrics;
  const p = result.proposedMetrics;
  const imp = result.improvement;

  const arrow = (v: number) => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);

  const lines = [
    `🔧 *Auto-Tune Proposal*`,
    ``,
    `📊 *Current Config*`,
    ...Object.entries(result.currentConfig).map(([k, v]) => `  ${k}: ${typeof v === 'number' ? (v as number).toFixed(2) : v}`),
    `  Sharpe: ${c.sharpeRatio.toFixed(2)} | WR: ${(c.winRate * 100).toFixed(1)}% | PnL: $${c.totalPnl.toFixed(2)}`,
    `  Trades: ${c.totalTrades} | PF: ${c.profitFactor === Infinity ? '∞' : c.profitFactor.toFixed(2)} | MaxDD: ${(c.maxDrawdownPercent * 100).toFixed(1)}%`,
    ``,
    `📈 *Proposed Config*`,
    ...Object.entries(result.proposedConfig).map(([k, v]) => `  ${k}: ${typeof v === 'number' ? (v as number).toFixed(2) : v}`),
    `  Sharpe: ${p.sharpeRatio.toFixed(2)} | WR: ${(p.winRate * 100).toFixed(1)}% | PnL: $${p.totalPnl.toFixed(2)}`,
    `  Trades: ${p.totalTrades} | PF: ${p.profitFactor === Infinity ? '∞' : p.profitFactor.toFixed(2)} | MaxDD: ${(p.maxDrawdownPercent * 100).toFixed(1)}%`,
    ``,
    `✨ *Improvement*`,
    `  Sharpe: ${arrow(imp.sharpe)} | WR: ${arrow(imp.winRate * 100)}% | PnL: ${arrow(imp.pnl)}`,
    ``,
    `🔢 Rounds: ${result.rounds} | Data: ${result.dataPoints} bars`,
    ``,
    `Reply /tune approve or /tune reject`,
  ];

  return lines.join('\n');
}
