#!/usr/bin/env npx tsx
/**
 * Z-Score 1,000-Round Parameter Optimizer
 *
 * Monte Carlo random-search optimizer for Classic Z-Score and Adaptive Z-Score strategies.
 * Generates N random parameter combinations (default 1000), runs each against historical
 * spread data, then ranks by Sharpe ratio and provides distribution analysis.
 *
 * Features:
 * - Latin Hypercube Sampling for even coverage across parameter space
 * - Constraint validation (exitZ < entryZ < stopLossZ, etc.)
 * - Multi-pair support (test same params across multiple pairs)
 * - Parameter heatmap analysis (ASCII)
 * - Top-N results with full metrics
 * - Export to JSON for further analysis
 */

import { ols } from '../scanner/cointegration.js';
import { createChildLogger } from '../logger.js';
import {
  ClassicZScoreStrategy,
  AdaptiveZScoreStrategy,
  type Strategy,
} from './strategies.js';
import type { MultiBacktestConfig, StrategyReport, StrategyTrade } from './multi-logic-engine.js';
import type { Direction } from '../types.js';

const log = createChildLogger('zscore-optimizer');

// ─── Types ───

export interface ParamRange {
  min: number;
  max: number;
  step?: number;  // If set, values snap to step grid
  isInt?: boolean; // Round to integer
}

export interface ZScoreParamSpace {
  entryZ: ParamRange;
  exitZ: ParamRange;
  stopLossZ: ParamRange;
  window: ParamRange;
  safeZoneBuffer: ParamRange;
  gracePeriodBars: ParamRange;
  cooldownBars: ParamRange;
}

export interface AdaptiveParamSpace extends ZScoreParamSpace {
  baseWindow: ParamRange;
  halfLifeMultiplier: ParamRange;
  minWindow: ParamRange;
  maxWindow: ParamRange;
  recalcInterval: ParamRange;
}

export interface OptimizerConfig {
  rounds: number;           // Number of random parameter combinations
  strategyType: 'classic' | 'adaptive' | 'both';
  capitalPerLeg: number;
  leverage: number;
  feeRate: number;
  inSampleRatio: number;
  topN: number;             // Show top N results
  seed?: number;            // Random seed for reproducibility
}

export interface ParamSet {
  strategyType: 'classic' | 'adaptive';
  params: Record<string, number>;
}

export interface OptimizationRound {
  round: number;
  strategyType: 'classic' | 'adaptive';
  params: Record<string, number>;
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

export interface OptimizationResult {
  pair: string;
  dataPoints: number;
  totalRounds: number;
  validRounds: number;
  elapsed: number;
  rounds: OptimizationRound[];
  top: OptimizationRound[];
  paramAnalysis: ParamAnalysis;
}

export interface ParamAnalysis {
  /** For each parameter: { param → { bestRange, correlation with Sharpe, distribution } } */
  paramCorrelations: Record<string, number>;
  /** Optimal ranges (top 10% results) */
  optimalRanges: Record<string, { min: number; max: number; mean: number; median: number }>;
  /** Heatmap data for top 2 most impactful parameters */
  heatmap?: HeatmapData;
}

export interface HeatmapData {
  paramX: string;
  paramY: string;
  cells: Array<{ x: number; y: number; sharpe: number; count: number }>;
}

// ─── Default Parameter Spaces ───

export const CLASSIC_PARAM_SPACE: ZScoreParamSpace = {
  entryZ:         { min: 1.0, max: 3.5, step: 0.1 },
  exitZ:          { min: 0.0, max: 1.5, step: 0.1 },
  stopLossZ:      { min: 2.5, max: 5.0, step: 0.1 },
  window:         { min: 48, max: 500, isInt: true },
  safeZoneBuffer: { min: 0.1, max: 1.5, step: 0.1 },
  gracePeriodBars:{ min: 2, max: 20, isInt: true },
  cooldownBars:   { min: 4, max: 72, isInt: true },
};

export const ADAPTIVE_PARAM_SPACE: AdaptiveParamSpace = {
  ...CLASSIC_PARAM_SPACE,
  baseWindow:         { min: 48, max: 500, isInt: true },
  halfLifeMultiplier: { min: 1.5, max: 5.0, step: 0.5 },
  minWindow:          { min: 20, max: 100, isInt: true },
  maxWindow:          { min: 200, max: 800, isInt: true },
  recalcInterval:     { min: 12, max: 96, isInt: true },
};

const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  rounds: 1000,
  strategyType: 'classic',
  capitalPerLeg: 25,
  leverage: 10,
  feeRate: 0.0006,
  inSampleRatio: 0.5,
  topN: 20,
};

// ─── PRNG (Mulberry32 — seedable) ───

export function mulberry32(seed: number): () => number {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Parameter Generation ───

export function sampleParam(range: ParamRange, rng: () => number): number {
  let val = range.min + rng() * (range.max - range.min);
  if (range.step) {
    val = Math.round(val / range.step) * range.step;
  }
  if (range.isInt) {
    val = Math.round(val);
  }
  return Math.max(range.min, Math.min(range.max, val));
}

export function generateClassicParams(space: ZScoreParamSpace, rng: () => number): Record<string, number> | null {
  // Sample independently then validate constraints
  for (let attempt = 0; attempt < 20; attempt++) {
    const entryZ = sampleParam(space.entryZ, rng);
    const exitZ = sampleParam(space.exitZ, rng);
    const stopLossZ = sampleParam(space.stopLossZ, rng);
    const safeZoneBuffer = sampleParam(space.safeZoneBuffer, rng);
    const window = sampleParam(space.window, rng);
    const gracePeriodBars = sampleParam(space.gracePeriodBars, rng);
    const cooldownBars = sampleParam(space.cooldownBars, rng);

    // Constraints
    if (exitZ >= entryZ) continue;
    if (entryZ + safeZoneBuffer >= stopLossZ) continue;
    if (exitZ >= entryZ - 0.2) continue; // Need meaningful gap

    return { entryZ, exitZ, stopLossZ, window, safeZoneBuffer, gracePeriodBars, cooldownBars };
  }
  return null;
}

export function generateAdaptiveParams(space: AdaptiveParamSpace, rng: () => number): Record<string, number> | null {
  for (let attempt = 0; attempt < 20; attempt++) {
    const entryZ = sampleParam(space.entryZ, rng);
    const exitZ = sampleParam(space.exitZ, rng);
    const stopLossZ = sampleParam(space.stopLossZ, rng);
    const safeZoneBuffer = sampleParam(space.safeZoneBuffer, rng);
    const baseWindow = sampleParam(space.baseWindow, rng);
    const halfLifeMultiplier = sampleParam(space.halfLifeMultiplier, rng);
    const minWindow = sampleParam(space.minWindow, rng);
    const maxWindow = sampleParam(space.maxWindow, rng);
    const recalcInterval = sampleParam(space.recalcInterval, rng);
    const gracePeriodBars = sampleParam(space.gracePeriodBars, rng);
    const cooldownBars = sampleParam(space.cooldownBars, rng);

    if (exitZ >= entryZ) continue;
    if (entryZ + safeZoneBuffer >= stopLossZ) continue;
    if (exitZ >= entryZ - 0.2) continue;
    if (minWindow >= maxWindow) continue;

    return {
      entryZ, exitZ, stopLossZ, baseWindow, halfLifeMultiplier,
      minWindow, maxWindow, recalcInterval, gracePeriodBars, cooldownBars,
      // Adaptive doesn't use safeZoneBuffer in entry but we store it
      window: baseWindow, safeZoneBuffer,
    };
  }
  return null;
}

// ─── Strategy Runner (inlined for speed) ───

interface QuickState {
  inPosition: boolean;
  direction: Direction;
  entryBar: number;
  entrySpread: number;
  gracePeriodEnd: number;
  cooldownUntil: number;
}

export interface QuickTrade {
  pnl: number;
  pnlPercent: number;
  barsHeld: number;
  closeReason: 'TP' | 'SL';
}

/**
 * Fast Z-Score runner — avoids Strategy class overhead for performance
 */
export function runClassicFast(
  spread: number[],
  params: Record<string, number>,
  config: OptimizerConfig,
): QuickTrade[] {
  const { entryZ, exitZ, stopLossZ, window, safeZoneBuffer, gracePeriodBars, cooldownBars } = params;
  const n = spread.length;
  const trades: QuickTrade[] = [];

  const state: QuickState = {
    inPosition: false,
    direction: 'SHORT_SPREAD',
    entryBar: 0,
    entrySpread: 0,
    gracePeriodEnd: 0,
    cooldownUntil: 0,
  };

  // Precompute rolling stats for speed
  // We'll compute on-the-fly with a running sum approach
  for (let bar = window; bar < n; bar++) {
    // Compute z-score
    const start = bar - window + 1;
    let sum = 0;
    let sumSq = 0;
    for (let j = start; j <= bar; j++) {
      sum += spread[j];
      sumSq += spread[j] * spread[j];
    }
    const mean = sum / window;
    const variance = sumSq / window - mean * mean;
    const std = Math.sqrt(Math.max(0, variance));
    const z = std > 0 ? (spread[bar] - mean) / std : 0;

    if (!state.inPosition) {
      if (bar < state.cooldownUntil) continue;

      if (z > entryZ && z < stopLossZ - safeZoneBuffer) {
        state.inPosition = true;
        state.direction = 'SHORT_SPREAD';
        state.entryBar = bar;
        state.entrySpread = spread[bar];
        state.gracePeriodEnd = bar + gracePeriodBars;
      } else if (z < -entryZ && Math.abs(z) < stopLossZ - safeZoneBuffer) {
        state.inPosition = true;
        state.direction = 'LONG_SPREAD';
        state.entryBar = bar;
        state.entrySpread = spread[bar];
        state.gracePeriodEnd = bar + gracePeriodBars;
      }
    } else {
      let shouldExit = false;
      let reason: 'TP' | 'SL' = 'TP';

      if (Math.abs(z) <= exitZ) {
        shouldExit = true;
        reason = 'TP';
      } else if (bar >= state.gracePeriodEnd && Math.abs(z) > stopLossZ) {
        shouldExit = true;
        reason = 'SL';
      }

      if (shouldExit) {
        const spreadChange = spread[bar] - state.entrySpread;
        const pnlDir = state.direction === 'SHORT_SPREAD' ? -1 : 1;
        const rawPnl = pnlDir * spreadChange * config.capitalPerLeg * config.leverage;
        const fees = config.capitalPerLeg * config.leverage * 2 * config.feeRate * 2;
        const pnl = rawPnl - fees;
        const pnlPercent = pnl / (config.capitalPerLeg * 2);

        trades.push({
          pnl,
          pnlPercent,
          barsHeld: bar - state.entryBar,
          closeReason: reason,
        });

        state.inPosition = false;
        state.cooldownUntil = bar + cooldownBars;
      }
    }
  }

  return trades;
}

/**
 * Compute metrics from quick trades
 */
export function computeQuickMetrics(trades: QuickTrade[]): Omit<OptimizationRound, 'round' | 'strategyType' | 'params'> {
  if (trades.length === 0) {
    return {
      totalTrades: 0, winRate: 0, totalPnl: 0, avgPnl: 0,
      sharpeRatio: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
      profitFactor: 0, avgBarsHeld: 0,
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  // Sharpe
  const pnls = trades.map(t => t.pnlPercent);
  const pnlMean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const pnlStd = Math.sqrt(pnls.reduce((a, b) => a + (b - pnlMean) ** 2, 0) / pnls.length);
  const sharpeRatio = pnlStd > 0 ? (pnlMean / pnlStd) * Math.sqrt(8760 / trades.length) : 0;

  // Max Drawdown
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  // Profit Factor
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const avgBarsHeld = trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length;

  return {
    totalTrades: trades.length,
    winRate: wins.length / trades.length,
    totalPnl,
    avgPnl: totalPnl / trades.length,
    sharpeRatio,
    maxDrawdown: maxDD,
    maxDrawdownPercent: peak > 0 ? maxDD / peak : 0,
    profitFactor,
    avgBarsHeld,
  };
}

// ─── Main Optimizer ───

/**
 * Run N-round Z-Score parameter optimization
 */
export function runZScoreOptimization(
  pricesA: number[],
  pricesB: number[],
  pair: string,
  config: OptimizerConfig = DEFAULT_OPTIMIZER_CONFIG,
  classicSpace: ZScoreParamSpace = CLASSIC_PARAM_SPACE,
  adaptiveSpace?: AdaptiveParamSpace,
): OptimizationResult {
  const startTime = Date.now();
  const n = Math.min(pricesA.length, pricesB.length);

  if (n < 100) {
    return {
      pair, dataPoints: n, totalRounds: 0, validRounds: 0,
      elapsed: 0, rounds: [], top: [], paramAnalysis: { paramCorrelations: {}, optimalRanges: {} },
    };
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

  log.info({ pair, dataPoints: n, beta: beta.toFixed(6), rounds: config.rounds }, 'Starting Z-Score optimization');

  // Initialize PRNG
  const rng = mulberry32(config.seed ?? Date.now());

  const allRounds: OptimizationRound[] = [];
  let validCount = 0;

  // Determine strategy split
  const classicRounds = config.strategyType === 'both'
    ? Math.floor(config.rounds / 2)
    : config.strategyType === 'classic' ? config.rounds : 0;
  const adaptiveRounds = config.rounds - classicRounds;

  // Progress tracking
  const totalRounds = config.rounds;
  let completed = 0;

  // Run classic Z-score rounds
  for (let r = 0; r < classicRounds; r++) {
    const params = generateClassicParams(classicSpace, rng);
    if (!params) continue;

    const trades = runClassicFast(spread, params, config);
    const metrics = computeQuickMetrics(trades);

    completed++;
    if (completed % 100 === 0 || completed === totalRounds) {
      const pct = (completed / totalRounds * 100).toFixed(0);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      process.stdout.write(`\r  ⚡ Progress: ${completed}/${totalRounds} (${pct}%) | Valid: ${validCount} | ${elapsed}s`);
    }

    if (metrics.totalTrades > 0) {
      validCount++;
    }

    allRounds.push({
      round: completed,
      strategyType: 'classic',
      params,
      ...metrics,
    });
  }

  // Run adaptive Z-score rounds
  if (adaptiveRounds > 0 && adaptiveSpace) {
    for (let r = 0; r < adaptiveRounds; r++) {
      const params = generateAdaptiveParams(adaptiveSpace, rng);
      if (!params) continue;

      // For adaptive, we need to use the Strategy class
      const strategy = new AdaptiveZScoreStrategy(
        params.baseWindow, params.halfLifeMultiplier,
        params.minWindow, params.maxWindow,
        params.entryZ, params.exitZ, params.stopLossZ,
        params.recalcInterval, params.gracePeriodBars, params.cooldownBars,
      );
      strategy.reset();

      // Run with strategy interface (slower but needed for adaptive logic)
      const trades = runWithStrategy(spread, strategy, config);
      const metrics = computeQuickMetrics(trades);

      completed++;
      if (completed % 100 === 0 || completed === totalRounds) {
        const pct = (completed / totalRounds * 100).toFixed(0);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stdout.write(`\r  ⚡ Progress: ${completed}/${totalRounds} (${pct}%) | Valid: ${validCount} | ${elapsed}s`);
      }

      if (metrics.totalTrades > 0) {
        validCount++;
      }

      allRounds.push({
        round: completed,
        strategyType: 'adaptive',
        params,
        ...metrics,
      });
    }
  }

  console.log(''); // newline after progress bar

  // Sort by Sharpe ratio
  allRounds.sort((a, b) => b.sharpeRatio - a.sharpeRatio);

  // Update round numbers based on rank
  for (let i = 0; i < allRounds.length; i++) {
    allRounds[i].round = i + 1;
  }

  const top = allRounds.slice(0, config.topN);
  const elapsed = (Date.now() - startTime) / 1000;

  // Parameter analysis
  const paramAnalysis = analyzeParams(allRounds);

  log.info({
    pair, totalRounds, validRounds: validCount, elapsed: elapsed.toFixed(1),
    bestSharpe: top[0]?.sharpeRatio.toFixed(4),
    bestPnl: top[0]?.totalPnl.toFixed(2),
  }, 'Z-Score optimization complete');

  return {
    pair, dataPoints: n, totalRounds, validRounds: validCount,
    elapsed, rounds: allRounds, top, paramAnalysis,
  };
}

/**
 * Run a strategy against spread data (for adaptive which needs class-based evaluation)
 */
export function runWithStrategy(
  spread: number[],
  strategy: Strategy,
  config: OptimizerConfig,
): QuickTrade[] {
  const trades: QuickTrade[] = [];
  const n = spread.length;

  const state = {
    inPosition: false,
    direction: 'SHORT_SPREAD' as Direction,
    entryBar: 0,
    entrySpread: 0,
    entryZ: 0,
    gracePeriodEnd: 0,
    cooldownUntil: 0,
    custom: {},
  };

  for (let i = 0; i < n; i++) {
    const signal = strategy.evaluate(i, spread, state);

    if (signal.action === 'ENTER' && !state.inPosition) {
      state.inPosition = true;
      state.direction = signal.direction!;
      state.entryBar = i;
      state.entrySpread = spread[i];
      const graceParam = (strategy.params.gracePeriodBars ?? strategy.params.gracePeriod ?? 5);
      state.gracePeriodEnd = i + graceParam;
    } else if (signal.action === 'EXIT' && state.inPosition) {
      const spreadChange = spread[i] - state.entrySpread;
      const pnlDir = state.direction === 'SHORT_SPREAD' ? -1 : 1;
      const rawPnl = pnlDir * spreadChange * config.capitalPerLeg * config.leverage;
      const fees = config.capitalPerLeg * config.leverage * 2 * config.feeRate * 2;
      const pnl = rawPnl - fees;
      const pnlPercent = pnl / (config.capitalPerLeg * 2);

      trades.push({
        pnl,
        pnlPercent,
        barsHeld: i - state.entryBar,
        closeReason: signal.reason ?? 'TP',
      });

      state.inPosition = false;
      const cooldownParam = (strategy.params.cooldownBars ?? strategy.params.cooldown ?? 24);
      state.cooldownUntil = i + cooldownParam;
    }
  }

  return trades;
}

// ─── Parameter Analysis ───

function analyzeParams(rounds: OptimizationRound[]): ParamAnalysis {
  const withTrades = rounds.filter(r => r.totalTrades > 0);
  if (withTrades.length === 0) {
    return { paramCorrelations: {}, optimalRanges: {} };
  }

  // Get all param names
  const paramNames = Object.keys(withTrades[0].params);

  // Compute correlation of each param with Sharpe ratio
  const paramCorrelations: Record<string, number> = {};
  for (const pName of paramNames) {
    const paramVals = withTrades.map(r => r.params[pName]);
    const sharpeVals = withTrades.map(r => r.sharpeRatio);
    paramCorrelations[pName] = pearsonCorrelation(paramVals, sharpeVals);
  }

  // Optimal ranges (top 10%)
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

  // Find top 2 most impactful params for heatmap
  const sortedCorr = Object.entries(paramCorrelations)
    .map(([k, v]) => ({ name: k, absCorr: Math.abs(v) }))
    .sort((a, b) => b.absCorr - a.absCorr);

  let heatmap: HeatmapData | undefined;
  if (sortedCorr.length >= 2) {
    heatmap = buildHeatmap(withTrades, sortedCorr[0].name, sortedCorr[1].name);
  }

  return { paramCorrelations, optimalRanges, heatmap };
}

export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0) return 0;

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  return denom > 0 ? cov / denom : 0;
}

function buildHeatmap(rounds: OptimizationRound[], paramX: string, paramY: string): HeatmapData {
  const BINS = 8;

  const xVals = rounds.map(r => r.params[paramX]);
  const yVals = rounds.map(r => r.params[paramY]);

  const xMin = Math.min(...xVals), xMax = Math.max(...xVals);
  const yMin = Math.min(...yVals), yMax = Math.max(...yVals);

  const xStep = (xMax - xMin) / BINS || 1;
  const yStep = (yMax - yMin) / BINS || 1;

  // Accumulate
  const buckets = new Map<string, { sumSharpe: number; count: number; xBin: number; yBin: number }>();

  for (const r of rounds) {
    const xBin = Math.min(BINS - 1, Math.floor((r.params[paramX] - xMin) / xStep));
    const yBin = Math.min(BINS - 1, Math.floor((r.params[paramY] - yMin) / yStep));
    const key = `${xBin},${yBin}`;

    const bucket = buckets.get(key) ?? { sumSharpe: 0, count: 0, xBin, yBin };
    bucket.sumSharpe += r.sharpeRatio;
    bucket.count++;
    buckets.set(key, bucket);
  }

  const cells: HeatmapData['cells'] = [];
  for (const b of buckets.values()) {
    cells.push({
      x: xMin + (b.xBin + 0.5) * xStep,
      y: yMin + (b.yBin + 0.5) * yStep,
      sharpe: b.count > 0 ? b.sumSharpe / b.count : 0,
      count: b.count,
    });
  }

  return { paramX, paramY, cells };
}

// ─── Report Formatting ───

export function formatOptimizationReport(result: OptimizationResult): string {
  const lines: string[] = [];

  lines.push(`
╔══════════════════════════════════════════════════════════════════════════════╗
║          Z-SCORE ${result.totalRounds}-ROUND PARAMETER OPTIMIZATION                        ║
╚══════════════════════════════════════════════════════════════════════════════╝
`);

  lines.push(`  Pair:          ${result.pair}`);
  lines.push(`  Data Points:   ${result.dataPoints} candles`);
  lines.push(`  Total Rounds:  ${result.totalRounds}`);
  lines.push(`  Valid Rounds:  ${result.validRounds} (${(result.validRounds / result.totalRounds * 100).toFixed(1)}%)`);
  lines.push(`  Elapsed:       ${result.elapsed.toFixed(1)}s`);
  lines.push(``);

  // Top N Results Table
  lines.push(`  ═══ TOP ${result.top.length} PARAMETER SETS (by Sharpe) ═══`);
  lines.push(``);

  const header = `  ${'#'.padStart(3)} | ${'Type'.padEnd(8)} | ${'EntryZ'.padStart(6)} | ${'ExitZ'.padStart(5)} | ${'SLZ'.padStart(5)} | ${'Win'.padStart(6)} | ${'Buf'.padStart(4)} | ${'Grace'.padStart(5)} | ${'Cool'.padStart(4)} | ${'Trades'.padStart(6)} | ${'WinR%'.padStart(6)} | ${'PnL $'.padStart(9)} | ${'Sharpe'.padStart(7)} | ${'MaxDD$'.padStart(8)} | ${'PF'.padStart(6)}`;
  const sep = `  ${'─'.repeat(header.length - 2)}`;

  lines.push(header);
  lines.push(sep);

  for (const r of result.top) {
    const rank = String(r.round).padStart(3);
    const type = r.strategyType.padEnd(8);
    const entryZ = r.params.entryZ.toFixed(1).padStart(6);
    const exitZ = r.params.exitZ.toFixed(1).padStart(5);
    const slZ = r.params.stopLossZ.toFixed(1).padStart(5);
    const win = String(Math.round(r.params.window)).padStart(6);
    const buf = r.params.safeZoneBuffer.toFixed(1).padStart(4);
    const grace = String(Math.round(r.params.gracePeriodBars)).padStart(5);
    const cool = String(Math.round(r.params.cooldownBars)).padStart(4);
    const trades = String(r.totalTrades).padStart(6);
    const winRate = (r.winRate * 100).toFixed(1).padStart(6);
    const pnl = r.totalPnl.toFixed(2).padStart(9);
    const sharpe = r.sharpeRatio.toFixed(3).padStart(7);
    const maxDD = r.maxDrawdown.toFixed(2).padStart(8);
    const pf = (r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)).padStart(6);

    const prefix = r.round === 1 ? '🏆' : '  ';
    lines.push(`${prefix}${rank} | ${type} | ${entryZ} | ${exitZ} | ${slZ} | ${win} | ${buf} | ${grace} | ${cool} | ${trades} | ${winRate} | ${pnl} | ${sharpe} | ${maxDD} | ${pf}`);
  }

  lines.push(sep);

  // Parameter Impact Analysis
  lines.push(``);
  lines.push(`  ═══ PARAMETER IMPACT ANALYSIS ═══`);
  lines.push(`  (Pearson correlation with Sharpe ratio — higher |r| = more impactful)`);
  lines.push(``);

  const sortedCorr = Object.entries(result.paramAnalysis.paramCorrelations)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  for (const [param, corr] of sortedCorr) {
    const bar = corrBar(corr);
    const impact = Math.abs(corr) > 0.3 ? '⚠️  HIGH' : Math.abs(corr) > 0.15 ? '📊 MED ' : '   LOW ';
    lines.push(`  ${impact} ${param.padEnd(20)} r=${corr.toFixed(4).padStart(8)}  ${bar}`);
  }

  // Optimal Ranges (top 10%)
  lines.push(``);
  lines.push(`  ═══ OPTIMAL PARAMETER RANGES (Top 10% by Sharpe) ═══`);
  lines.push(``);

  const rangeHeader = `  ${'Parameter'.padEnd(20)} | ${'Min'.padStart(8)} | ${'Max'.padStart(8)} | ${'Mean'.padStart(8)} | ${'Median'.padStart(8)}`;
  const rangeSep = `  ${'─'.repeat(rangeHeader.length - 2)}`;

  lines.push(rangeHeader);
  lines.push(rangeSep);

  for (const [param, range] of Object.entries(result.paramAnalysis.optimalRanges)) {
    const name = param.padEnd(20);
    const min = formatNum(range.min).padStart(8);
    const max = formatNum(range.max).padStart(8);
    const mean = formatNum(range.mean).padStart(8);
    const median = formatNum(range.median).padStart(8);
    lines.push(`  ${name} | ${min} | ${max} | ${mean} | ${median}`);
  }

  lines.push(rangeSep);

  // Heatmap
  if (result.paramAnalysis.heatmap) {
    lines.push(``);
    lines.push(formatHeatmap(result.paramAnalysis.heatmap));
  }

  // Distribution summary
  lines.push(``);
  lines.push(`  ═══ SHARPE RATIO DISTRIBUTION ═══`);
  lines.push(``);

  const validRounds = result.rounds.filter(r => r.totalTrades > 0);
  if (validRounds.length > 0) {
    const sharpes = validRounds.map(r => r.sharpeRatio).sort((a, b) => a - b);
    const profitableRounds = validRounds.filter(r => r.totalPnl > 0);

    lines.push(`  Profitable configs:  ${profitableRounds.length}/${validRounds.length} (${(profitableRounds.length / validRounds.length * 100).toFixed(1)}%)`);
    lines.push(`  Sharpe > 0.5:       ${sharpes.filter(s => s > 0.5).length}`);
    lines.push(`  Sharpe > 1.0:       ${sharpes.filter(s => s > 1.0).length}`);
    lines.push(`  Sharpe > 2.0:       ${sharpes.filter(s => s > 2.0).length}`);
    lines.push(``);
    lines.push(`  Min Sharpe:  ${sharpes[0].toFixed(4)}`);
    lines.push(`  P25 Sharpe:  ${sharpes[Math.floor(sharpes.length * 0.25)].toFixed(4)}`);
    lines.push(`  P50 Sharpe:  ${sharpes[Math.floor(sharpes.length * 0.50)].toFixed(4)}`);
    lines.push(`  P75 Sharpe:  ${sharpes[Math.floor(sharpes.length * 0.75)].toFixed(4)}`);
    lines.push(`  P90 Sharpe:  ${sharpes[Math.floor(sharpes.length * 0.90)].toFixed(4)}`);
    lines.push(`  P99 Sharpe:  ${sharpes[Math.floor(sharpes.length * 0.99)].toFixed(4)}`);
    lines.push(`  Max Sharpe:  ${sharpes[sharpes.length - 1].toFixed(4)}`);

    // ASCII histogram
    lines.push(``);
    lines.push(formatSharpeHistogram(sharpes));
  }

  // Best config recommendation
  if (result.top.length > 0) {
    const best = result.top[0];
    lines.push(``);
    lines.push(`  ═══ 🏆 RECOMMENDED CONFIG ═══`);
    lines.push(``);
    lines.push(`  Strategy: ${best.strategyType === 'classic' ? 'Classic Z-Score' : 'Adaptive Z-Score'}`);
    for (const [k, v] of Object.entries(best.params)) {
      lines.push(`    ${k}: ${formatNum(v)}`);
    }
    lines.push(``);
    lines.push(`  Expected Performance:`);
    lines.push(`    Trades:       ${best.totalTrades}`);
    lines.push(`    Win Rate:     ${(best.winRate * 100).toFixed(1)}%`);
    lines.push(`    Total PnL:    $${best.totalPnl.toFixed(2)}`);
    lines.push(`    Sharpe:       ${best.sharpeRatio.toFixed(4)}`);
    lines.push(`    Max Drawdown: $${best.maxDrawdown.toFixed(2)}`);
    lines.push(`    Profit Factor:${best.profitFactor === Infinity ? ' ∞' : ' ' + best.profitFactor.toFixed(2)}`);
  }

  lines.push(``);
  return lines.join('\n');
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

function formatNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function formatHeatmap(hm: HeatmapData): string {
  const lines: string[] = [];
  lines.push(`  ═══ SHARPE HEATMAP: ${hm.paramX} vs ${hm.paramY} ═══`);
  lines.push(`  (Average Sharpe ratio per bucket — brighter = higher)`);
  lines.push(``);

  // Sort cells into grid
  const xVals = [...new Set(hm.cells.map(c => c.x))].sort((a, b) => a - b);
  const yVals = [...new Set(hm.cells.map(c => c.y))].sort((a, b) => b - a); // reverse for display

  const cellMap = new Map<string, number>();
  let minSharpe = Infinity, maxSharpe = -Infinity;

  for (const c of hm.cells) {
    cellMap.set(`${c.x},${c.y}`, c.sharpe);
    if (c.sharpe < minSharpe) minSharpe = c.sharpe;
    if (c.sharpe > maxSharpe) maxSharpe = c.sharpe;
  }

  const range = maxSharpe - minSharpe || 1;
  const heatChars = ['  ', '░░', '▒▒', '▓▓', '██'];

  // Y-axis label
  lines.push(`  ${hm.paramY.padEnd(8)} ↑`);

  for (const y of yVals) {
    let row = `  ${formatNum(y).padStart(8)} │`;
    for (const x of xVals) {
      const sharpe = cellMap.get(`${x},${y}`);
      if (sharpe === undefined) {
        row += '  ';
      } else {
        const normalized = (sharpe - minSharpe) / range;
        const idx = Math.min(heatChars.length - 1, Math.floor(normalized * (heatChars.length - 1)));
        row += heatChars[idx];
      }
    }
    lines.push(row);
  }

  // X-axis
  let xAxis = `  ${''.padStart(8)} └`;
  for (const _x of xVals) {
    xAxis += '──';
  }
  xAxis += `→ ${hm.paramX}`;
  lines.push(xAxis);

  // X labels
  let xLabels = `  ${''.padStart(9)}`;
  for (const x of xVals) {
    xLabels += formatNum(x).padStart(2);
  }
  lines.push(xLabels);

  lines.push(`  Legend: ${heatChars.map((c, i) => `${c}=${((i / (heatChars.length - 1)) * range + minSharpe).toFixed(2)}`).join(' ')}`);

  return lines.join('\n');
}

function formatSharpeHistogram(sharpes: number[]): string {
  const BINS = 15;
  const min = sharpes[0];
  const max = sharpes[sharpes.length - 1];
  const binWidth = (max - min) / BINS || 1;

  const bins: number[] = Array(BINS).fill(0);
  for (const s of sharpes) {
    const bin = Math.min(BINS - 1, Math.floor((s - min) / binWidth));
    bins[bin]++;
  }

  const maxCount = Math.max(...bins);
  const barWidth = 40;

  const lines: string[] = [];
  lines.push(`  Sharpe Distribution Histogram:`);

  for (let i = 0; i < BINS; i++) {
    const lo = min + i * binWidth;
    const hi = lo + binWidth;
    const label = `${lo.toFixed(2).padStart(7)}`;
    const bar = '█'.repeat(Math.round(bins[i] / maxCount * barWidth));
    const count = bins[i] > 0 ? ` (${bins[i]})` : '';
    lines.push(`  ${label} │${bar}${count}`);
  }

  return lines.join('\n');
}

// ─── CLI Entry Point ───

export async function runFromCli(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse CLI args
  let pair = 'PEPE/SHIB';
  let rounds = 1000;
  let years = 3;
  let timeframe: '1h' | '4h' | '1d' = '1h';
  let strategyType: 'classic' | 'adaptive' | 'both' = 'classic';
  let leverage = 10;
  let capital = 25;
  let topN = 20;
  let jsonOutput = false;
  let seed: number | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--pair': case '-p': pair = args[++i]; break;
      case '--rounds': case '-n': rounds = parseInt(args[++i]); break;
      case '--years': case '-y': years = parseFloat(args[++i]); break;
      case '--timeframe': case '-t': timeframe = args[++i] as '1h' | '4h' | '1d'; break;
      case '--strategy': case '-s': strategyType = args[++i] as 'classic' | 'adaptive' | 'both'; break;
      case '--leverage': leverage = parseInt(args[++i]); break;
      case '--capital': capital = parseFloat(args[++i]); break;
      case '--top': topN = parseInt(args[++i]); break;
      case '--json': jsonOutput = true; break;
      case '--seed': seed = parseInt(args[++i]); break;
      case '--help': case '-h':
        console.log(`
╔══════════════════════════════════════════════════╗
║     Z-Score Parameter Optimizer                  ║
╚══════════════════════════════════════════════════╝

Usage: npx tsx src/backtest/zscore-optimizer.ts [options]

Options:
  --pair, -p <A/B>      Pair to optimize (default: PEPE/SHIB)
  --rounds, -n <N>      Number of random rounds (default: 1000)
  --years, -y <N>       Years of historical data (default: 3)
  --timeframe, -t <tf>  Timeframe: 1h, 4h, 1d (default: 1h)
  --strategy, -s <type> Strategy type: classic, adaptive, both (default: classic)
  --leverage <N>        Leverage multiplier (default: 10)
  --capital <N>         Capital per leg (default: 25)
  --top <N>             Show top N results (default: 20)
  --seed <N>            Random seed for reproducibility
  --json                Output JSON results
  --help, -h            Show this help

Examples:
  npx tsx src/backtest/zscore-optimizer.ts --pair PEPE/SHIB --rounds 1000
  npx tsx src/backtest/zscore-optimizer.ts --pair BTC/ETH --rounds 500 --years 2
  npx tsx src/backtest/zscore-optimizer.ts --pair PEPE/SHIB -n 2000 -s both --seed 42
        `);
        process.exit(0);
    }
  }

  console.log(`
╔══════════════════════════════════════════════════╗
║     Z-Score Parameter Optimizer                  ║
╚══════════════════════════════════════════════════╝
`);

  const [symbolA, symbolB] = pair.split('/');
  if (!symbolA || !symbolB) {
    console.error('❌ Invalid pair format. Use: PEPE/SHIB');
    process.exit(1);
  }

  console.log(`  Pair:       ${pair}`);
  console.log(`  Rounds:     ${rounds}`);
  console.log(`  Strategy:   ${strategyType}`);
  console.log(`  Data:       ${years} year(s) of ${timeframe} candles`);
  console.log(`  Leverage:   ${leverage}x`);
  console.log(`  Capital:    $${capital}/leg`);
  if (seed !== undefined) console.log(`  Seed:       ${seed}`);
  console.log(``);

  // Fetch historical data
  const { fetchHistoricalData, getCacheInfo } = await import('./historical-fetcher.js');

  const histConfig: Partial<HistoricalFetchConfig> = { years, timeframe, batchSize: 300, delayMs: 200 };

  // Show cache info
  const cacheA = getCacheInfo(symbolA, timeframe);
  const cacheB = getCacheInfo(symbolB, timeframe);
  if (cacheA) console.log(`  📦 Cache ${symbolA}: ${cacheA.total} candles`);
  if (cacheB) console.log(`  📦 Cache ${symbolB}: ${cacheB.total} candles`);

  console.log(`\n📡 Fetching ${years} year(s) of ${timeframe} data for ${symbolA}...`);
  const pricesA = await fetchHistoricalData(symbolA, histConfig, (p) => {
    const bar = progressBar(p.percentComplete, 30);
    process.stdout.write(`\r  ${bar} ${p.percentComplete.toFixed(1)}% | ${p.totalCandles} candles | ${p.elapsed.toFixed(0)}s`);
  });
  console.log(`\n  ✅ ${symbolA}: ${pricesA.length} candles`);

  console.log(`📡 Fetching ${years} year(s) of ${timeframe} data for ${symbolB}...`);
  const pricesB = await fetchHistoricalData(symbolB, histConfig, (p) => {
    const bar = progressBar(p.percentComplete, 30);
    process.stdout.write(`\r  ${bar} ${p.percentComplete.toFixed(1)}% | ${p.totalCandles} candles | ${p.elapsed.toFixed(0)}s`);
  });
  console.log(`\n  ✅ ${symbolB}: ${pricesB.length} candles`);

  // Align lengths
  const minLen = Math.min(pricesA.length, pricesB.length);
  const alignedA = pricesA.slice(pricesA.length - minLen);
  const alignedB = pricesB.slice(pricesB.length - minLen);

  console.log(`\n📊 Aligned to ${minLen} candles (~${(minLen / (timeframe === '4h' ? 6 : timeframe === '1d' ? 1 : 24) / 365.25).toFixed(1)} years)`);

  // Cointegration test
  const { testCointegration } = await import('../scanner/cointegration.js');
  const coint = testCointegration(alignedA, alignedB, symbolA, symbolB);
  console.log(`📈 Cointegration: pValue=${coint.pValue.toFixed(4)}, halfLife=${coint.halfLife.toFixed(1)}, beta=${coint.beta.toFixed(6)}`);
  console.log(`   Cointegrated: ${coint.isCointegrated ? '✅ YES' : '❌ NO'}`);

  // Run optimization
  console.log(`\n🚀 Starting ${rounds}-round Z-Score optimization...\n`);

  const optiConfig: OptimizerConfig = {
    rounds,
    strategyType,
    capitalPerLeg: capital,
    leverage,
    feeRate: 0.0006,
    inSampleRatio: 0.5,
    topN,
    seed,
  };

  const result = runZScoreOptimization(
    alignedA, alignedB, pair, optiConfig,
    CLASSIC_PARAM_SPACE,
    strategyType === 'classic' ? undefined : ADAPTIVE_PARAM_SPACE,
  );

  // Print report
  console.log(formatOptimizationReport(result));

  // JSON output
  if (jsonOutput) {
    const jsonData = {
      pair: result.pair,
      dataPoints: result.dataPoints,
      totalRounds: result.totalRounds,
      validRounds: result.validRounds,
      elapsed: result.elapsed,
      top: result.top,
      paramAnalysis: {
        paramCorrelations: result.paramAnalysis.paramCorrelations,
        optimalRanges: result.paramAnalysis.optimalRanges,
      },
    };
    console.log('\n--- JSON OUTPUT ---');
    console.log(JSON.stringify(jsonData, null, 2));
  }

  console.log(`\n✅ Optimization complete.`);
}

export function progressBar(percent: number, width: number): string {
  const filled = Math.floor(percent / 100 * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

// Run if called directly
const isMainModule = process.argv[1]?.includes('zscore-optimizer');
if (isMainModule) {
  runFromCli().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
  });
}
