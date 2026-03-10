/**
 * Multi-Logic Backtest Engine
 *
 * Runs multiple trading strategies against the same historical price data
 * for fair side-by-side comparison. Uses the Strategy interface so any
 * new strategy can be plugged in without changing this engine.
 */

import type { Direction } from '../types.js';
import type { Strategy, StrategyState } from './strategies.js';
import { ols } from '../scanner/cointegration.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('multi-logic');

// ─── Types ───

export interface MultiBacktestConfig {
  capitalPerLeg: number;
  leverage: number;
  feeRate: number;           // e.g. 0.0006 for 0.06%
  inSampleRatio: number;     // e.g. 0.5 = first 50% for hedge ratio calc
}

export interface StrategyTrade {
  entryBar: number;
  exitBar: number;
  direction: Direction;
  entryZ: number;
  exitZ: number;
  entrySpread: number;
  exitSpread: number;
  pnl: number;
  pnlPercent: number;
  closeReason: 'TP' | 'SL' | 'TRAILING';
  barsHeld: number;
}

export interface StrategyReport {
  strategyName: string;
  strategyDescription: string;
  strategyParams: Record<string, number>;
  pair: string;
  trades: StrategyTrade[];
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  avgBarsHeld: number;
  /** Equity curve — cumulative PnL at each trade */
  equityCurve: number[];
  /** Calendar: { bar → equity } */
  barEquity: Map<number, number>;
}

export interface MultiLogicResult {
  pair: string;
  dataPoints: number;
  strategies: StrategyReport[];
  /** Best strategy by Sharpe ratio */
  bestStrategy: string;
  /** Summary comparison table data */
  comparison: StrategyComparison[];
}

export interface StrategyComparison {
  rank: number;
  name: string;
  trades: number;
  winRate: number;
  totalPnl: number;
  sharpe: number;
  maxDD: number;
  profitFactor: number;
  avgBars: number;
}

// ─── Engine ───

const DEFAULT_CONFIG: MultiBacktestConfig = {
  capitalPerLeg: 25,
  leverage: 10,
  feeRate: 0.0006,
  inSampleRatio: 0.5,
};

/**
 * Run multiple strategies against the same pair data
 */
export function runMultiLogicBacktest(
  pricesA: number[],
  pricesB: number[],
  pair: string,
  strategies: Strategy[],
  config: MultiBacktestConfig = DEFAULT_CONFIG,
): MultiLogicResult {
  const n = Math.min(pricesA.length, pricesB.length);

  if (n < 50) {
    return {
      pair,
      dataPoints: n,
      strategies: [],
      bestStrategy: 'N/A',
      comparison: [],
    };
  }

  // Calculate hedge ratio from in-sample data
  const halfN = Math.floor(n * config.inSampleRatio);
  const logA = pricesA.slice(0, n).map(Math.log);
  const logB = pricesB.slice(0, n).map(Math.log);
  const { beta } = ols(logB.slice(0, halfN), logA.slice(0, halfN));

  // Calculate full spread
  const spread: number[] = [];
  for (let i = 0; i < n; i++) {
    spread.push(logA[i] - beta * logB[i]);
  }

  log.info({ pair, dataPoints: n, beta: beta.toFixed(6), strategies: strategies.length }, 'Starting multi-logic backtest');

  // Run each strategy
  const reports: StrategyReport[] = [];

  for (const strategy of strategies) {
    strategy.reset();
    const trades = runSingleStrategy(spread, strategy, config);
    const report = computeReport(strategy, pair, trades, config);
    reports.push(report);

    log.info({
      strategy: strategy.name,
      trades: report.totalTrades,
      winRate: (report.winRate * 100).toFixed(1) + '%',
      pnl: report.totalPnl.toFixed(2),
      sharpe: report.sharpeRatio.toFixed(3),
    }, 'Strategy completed');
  }

  // Rank by Sharpe ratio
  const comparison = buildComparison(reports);
  const bestStrategy = comparison.length > 0 ? comparison[0].name : 'N/A';

  return {
    pair,
    dataPoints: n,
    strategies: reports,
    bestStrategy,
    comparison,
  };
}

/**
 * Run a single strategy against spread data
 */
function runSingleStrategy(
  spread: number[],
  strategy: Strategy,
  config: MultiBacktestConfig,
): StrategyTrade[] {
  const trades: StrategyTrade[] = [];
  const n = spread.length;

  // Initialize state
  const state: StrategyState = {
    inPosition: false,
    direction: 'SHORT_SPREAD',
    entryBar: 0,
    entrySpread: 0,
    entryZ: 0,
    gracePeriodEnd: 0,
    cooldownUntil: 0,
    custom: {},
  };

  for (let i = 0; i < n; i++) {
    const signal = strategy.evaluate(i, spread, state);

    switch (signal.action) {
      case 'ENTER':
        if (!state.inPosition) {
          state.inPosition = true;
          state.direction = signal.direction!;
          state.entryBar = i;
          state.entrySpread = spread[i];
          // Calculate entry z for logging
          state.entryZ = computeZScoreSimple(spread, i, 168);
          // Grace period from strategy params
          const graceParam = strategy.params.gracePeriodBars ?? strategy.params.gracePeriod ?? 5;
          state.gracePeriodEnd = i + graceParam;
        }
        break;

      case 'EXIT':
        if (state.inPosition) {
          const spreadChange = spread[i] - state.entrySpread;
          const pnlDirection = state.direction === 'SHORT_SPREAD' ? -1 : 1;
          const rawPnl = pnlDirection * spreadChange * config.capitalPerLeg * config.leverage;
          const fees = config.capitalPerLeg * config.leverage * 2 * config.feeRate * 2;
          const pnl = rawPnl - fees;
          const pnlPercent = pnl / (config.capitalPerLeg * 2);
          const exitZ = computeZScoreSimple(spread, i, 168);

          trades.push({
            entryBar: state.entryBar,
            exitBar: i,
            direction: state.direction,
            entryZ: state.entryZ,
            exitZ,
            entrySpread: state.entrySpread,
            exitSpread: spread[i],
            pnl,
            pnlPercent,
            closeReason: signal.reason ?? 'TP',
            barsHeld: i - state.entryBar,
          });

          state.inPosition = false;
          const cooldownParam = strategy.params.cooldownBars ?? strategy.params.cooldown ?? 24;
          state.cooldownUntil = i + cooldownParam;
        }
        break;
    }
  }

  return trades;
}

function computeZScoreSimple(spread: number[], bar: number, window: number): number {
  if (bar < window) return 0;
  const start = bar - window + 1;
  const slice = spread.slice(start, bar + 1);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  const std = Math.sqrt(variance);
  return std > 0 ? (spread[bar] - mean) / std : 0;
}

/**
 * Compute performance report for a strategy
 */
function computeReport(
  strategy: Strategy,
  pair: string,
  trades: StrategyTrade[],
  config: MultiBacktestConfig,
): StrategyReport {
  const empty: StrategyReport = {
    strategyName: strategy.name,
    strategyDescription: strategy.description,
    strategyParams: { ...strategy.params },
    pair,
    trades: [],
    totalTrades: 0,
    winRate: 0,
    totalPnl: 0,
    avgPnl: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    profitFactor: 0,
    avgBarsHeld: 0,
    equityCurve: [],
    barEquity: new Map(),
  };

  if (trades.length === 0) return empty;

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

  // Equity curve
  const equityCurve: number[] = [];
  const barEquity = new Map<number, number>();
  let equity = 0;
  for (const trade of trades) {
    equity += trade.pnl;
    equityCurve.push(equity);
    barEquity.set(trade.exitBar, equity);
  }

  // Sharpe Ratio (annualized, assuming 1h bars)
  const pnls = trades.map(t => t.pnlPercent);
  const pnlMean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const pnlStd = Math.sqrt(
    pnls.reduce((a, b) => a + (b - pnlMean) ** 2, 0) / pnls.length,
  );
  const sharpeRatio = pnlStd > 0 ? (pnlMean / pnlStd) * Math.sqrt(8760 / trades.length) : 0;

  // Max Drawdown
  let peak = 0;
  let maxDrawdown = 0;
  equity = 0;
  for (const trade of trades) {
    equity += trade.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Profit Factor
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const avgBarsHeld = trades.reduce((sum, t) => sum + t.barsHeld, 0) / trades.length;

  return {
    strategyName: strategy.name,
    strategyDescription: strategy.description,
    strategyParams: { ...strategy.params },
    pair,
    trades,
    totalTrades: trades.length,
    winRate: wins.length / trades.length,
    totalPnl,
    avgPnl: totalPnl / trades.length,
    sharpeRatio,
    maxDrawdown,
    maxDrawdownPercent: peak > 0 ? maxDrawdown / peak : 0,
    profitFactor,
    avgBarsHeld,
    equityCurve,
    barEquity,
  };
}

/**
 * Build comparison table sorted by Sharpe ratio
 */
function buildComparison(reports: StrategyReport[]): StrategyComparison[] {
  const sorted = [...reports]
    .filter(r => r.totalTrades > 0)
    .sort((a, b) => b.sharpeRatio - a.sharpeRatio);

  return sorted.map((r, i) => ({
    rank: i + 1,
    name: r.strategyName,
    trades: r.totalTrades,
    winRate: r.winRate,
    totalPnl: r.totalPnl,
    sharpe: r.sharpeRatio,
    maxDD: r.maxDrawdown,
    profitFactor: r.profitFactor,
    avgBars: r.avgBarsHeld,
  }));
}

// ─── Grid Search per Strategy ───

export interface MultiLogicGridParams {
  /** Which strategies to grid-search */
  strategies: Array<{
    name: string;
    baseStrategy: Strategy;
    paramGrid: Record<string, number[]>;
  }>;
}

/**
 * Grid search across multiple strategies with their own param grids
 */
export function runMultiLogicGridSearch(
  pricesA: number[],
  pricesB: number[],
  pair: string,
  gridParams: MultiLogicGridParams,
  config: MultiBacktestConfig = DEFAULT_CONFIG,
): MultiLogicResult {
  const n = Math.min(pricesA.length, pricesB.length);

  if (n < 50) {
    return { pair, dataPoints: n, strategies: [], bestStrategy: 'N/A', comparison: [] };
  }

  // Compute spread once
  const halfN = Math.floor(n * config.inSampleRatio);
  const logA = pricesA.slice(0, n).map(Math.log);
  const logB = pricesB.slice(0, n).map(Math.log);
  const { beta } = ols(logB.slice(0, halfN), logA.slice(0, halfN));

  const spread: number[] = [];
  for (let i = 0; i < n; i++) {
    spread.push(logA[i] - beta * logB[i]);
  }

  const allReports: StrategyReport[] = [];

  for (const stratDef of gridParams.strategies) {
    const combos = generateCombinations(stratDef.paramGrid);

    log.info({
      strategy: stratDef.name,
      combinations: combos.length,
    }, 'Grid search starting');

    let bestSharpe = -Infinity;
    let bestReport: StrategyReport | null = null;

    for (const paramSet of combos) {
      // Clone strategy and override params — create fresh instance
      const strategy = { ...stratDef.baseStrategy };
      Object.assign(strategy, { params: { ...stratDef.baseStrategy.params, ...paramSet } });

      // Use the evaluate method from the base strategy type
      stratDef.baseStrategy.reset();
      const trades = runSingleStrategy(spread, stratDef.baseStrategy, config);
      const report = computeReport(stratDef.baseStrategy, pair, trades, config);

      if (report.sharpeRatio > bestSharpe && report.totalTrades > 0) {
        bestSharpe = report.sharpeRatio;
        bestReport = report;
      }
    }

    if (bestReport) {
      allReports.push(bestReport);
    }
  }

  const comparison = buildComparison(allReports);
  return {
    pair,
    dataPoints: n,
    strategies: allReports,
    bestStrategy: comparison[0]?.name ?? 'N/A',
    comparison,
  };
}

function generateCombinations(grid: Record<string, number[]>): Record<string, number>[] {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [{}];

  const result: Record<string, number>[] = [];

  function recurse(idx: number, current: Record<string, number>): void {
    if (idx === keys.length) {
      result.push({ ...current });
      return;
    }
    const key = keys[idx];
    for (const value of grid[key]) {
      current[key] = value;
      recurse(idx + 1, current);
    }
  }

  recurse(0, {});
  return result;
}
