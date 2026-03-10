/**
 * Multi-Logic Trading Strategies for Pair Trading Backtesting
 *
 * Each strategy takes the same spread data and returns entry/exit signals.
 * This allows fair comparison under identical market conditions.
 */

import type { Direction } from '../types.js';

// ─── Common Types ───

export interface StrategySignal {
  action: 'ENTER' | 'EXIT' | 'NONE';
  direction?: Direction;
  reason?: 'TP' | 'SL' | 'TRAILING';
}

export interface StrategyState {
  inPosition: boolean;
  direction: Direction;
  entryBar: number;
  entrySpread: number;
  entryZ: number;
  gracePeriodEnd: number;
  cooldownUntil: number;
  /** Strategy-specific custom state */
  custom: Record<string, unknown>;
}

export interface StrategyConfig {
  name: string;
  description: string;
  params: Record<string, number>;
}

export interface Strategy {
  readonly name: string;
  readonly description: string;
  readonly params: Record<string, number>;

  /**
   * Initialize or reset strategy internal state
   */
  reset(): void;

  /**
   * Evaluate bar and return signal
   * @param bar - Current bar index
   * @param spread - Full spread array
   * @param state - Current position state
   */
  evaluate(
    bar: number,
    spread: number[],
    state: StrategyState,
  ): StrategySignal;
}

// ─── Helper Functions ───

function rollingMean(data: number[], end: number, window: number): number {
  const start = Math.max(0, end - window + 1);
  const slice = data.slice(start, end + 1);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function rollingStd(data: number[], end: number, window: number): number {
  const start = Math.max(0, end - window + 1);
  const slice = data.slice(start, end + 1);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

function computeZScore(spread: number[], bar: number, window: number): number {
  if (bar < window) return 0;
  const mean = rollingMean(spread, bar, window);
  const std = rollingStd(spread, bar, window);
  return std > 0 ? (spread[bar] - mean) / std : 0;
}

function computeRSI(data: number[], bar: number, period: number): number {
  if (bar < period) return 50;

  let gainSum = 0;
  let lossSum = 0;

  for (let i = bar - period + 1; i <= bar; i++) {
    const change = data[i] - data[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += Math.abs(change);
  }

  const avgGain = gainSum / period;
  const avgLoss = lossSum / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeEMA(data: number[], bar: number, period: number): number {
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i <= bar; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

// ═══════════════════════════════════════════════════════════════
// Strategy 1: Classic Z-Score (existing logic — baseline)
// ═══════════════════════════════════════════════════════════════

export class ClassicZScoreStrategy implements Strategy {
  readonly name = 'classic_zscore';
  readonly description = 'Classic Z-Score mean reversion with fixed entry/exit/SL thresholds';
  readonly params: Record<string, number>;

  constructor(
    private entryZ: number = 2.0,
    private exitZ: number = 0.5,
    private stopLossZ: number = 3.5,
    private window: number = 168,
    private safeZoneBuffer: number = 0.5,
    private gracePeriodBars: number = 5,
    private cooldownBars: number = 24,
    private minHoldBarsTP: number = 2,
    private trailingStopEnabled: boolean = false,
    private trailingStopZ: number = 1.5,
  ) {
    this.params = { entryZ, exitZ, stopLossZ, window, safeZoneBuffer, gracePeriodBars, cooldownBars, minHoldBarsTP, trailingStopZ };
  }

  reset(): void {}

  evaluate(bar: number, spread: number[], state: StrategyState): StrategySignal {
    const z = computeZScore(spread, bar, this.window);
    if (bar < this.window) return { action: 'NONE' };

    if (!state.inPosition) {
      if (bar < state.cooldownUntil) return { action: 'NONE' };

      if (z > this.entryZ && z < this.stopLossZ - this.safeZoneBuffer) {
        state.custom.trailingBestZ = Math.abs(z);
        return { action: 'ENTER', direction: 'SHORT_SPREAD' };
      }
      if (z < -this.entryZ && Math.abs(z) < this.stopLossZ - this.safeZoneBuffer) {
        state.custom.trailingBestZ = Math.abs(z);
        return { action: 'ENTER', direction: 'LONG_SPREAD' };
      }
    } else {
      const barsHeld = bar - state.entryBar;
      const absZ = Math.abs(z);

      // Update trailing best Z
      const bestZ = state.custom.trailingBestZ as number ?? absZ;
      if (absZ < bestZ) {
        state.custom.trailingBestZ = absZ;
      }

      // TP: must hold minHoldBars first (aligned with live)
      if (absZ <= this.exitZ) {
        if (barsHeld >= this.minHoldBarsTP) {
          return { action: 'EXIT', reason: 'TP' };
        }
        // Too early — hold
        return { action: 'NONE' };
      }

      // SL (respecting grace period)
      if (bar >= state.gracePeriodEnd && absZ > this.stopLossZ) {
        return { action: 'EXIT', reason: 'SL' };
      }

      // Trailing stop: Z was converging but bounced back
      if (this.trailingStopEnabled) {
        const currentBestZ = state.custom.trailingBestZ as number;
        if (absZ >= currentBestZ + this.trailingStopZ) {
          return { action: 'EXIT', reason: 'TRAILING' };
        }
      }
    }

    return { action: 'NONE' };
  }
}

// ═══════════════════════════════════════════════════════════════
// Strategy 2: Bollinger Band Spread
// ═══════════════════════════════════════════════════════════════

export class BollingerBandStrategy implements Strategy {
  readonly name = 'bollinger_band';
  readonly description = 'Bollinger Band on spread — enter at outer bands, exit at middle band';
  readonly params: Record<string, number>;

  constructor(
    private window: number = 120,
    private entryStdMult: number = 2.0,
    private exitStdMult: number = 0.5,
    private stopStdMult: number = 3.5,
    private gracePeriodBars: number = 5,
    private cooldownBars: number = 24,
  ) {
    this.params = { window, entryStdMult, exitStdMult, stopStdMult, gracePeriodBars, cooldownBars };
  }

  reset(): void {}

  evaluate(bar: number, spread: number[], state: StrategyState): StrategySignal {
    if (bar < this.window) return { action: 'NONE' };

    const mean = rollingMean(spread, bar, this.window);
    const std = rollingStd(spread, bar, this.window);
    if (std === 0) return { action: 'NONE' };

    const current = spread[bar];
    const upperEntry = mean + this.entryStdMult * std;
    const lowerEntry = mean - this.entryStdMult * std;
    const upperStop = mean + this.stopStdMult * std;
    const lowerStop = mean - this.stopStdMult * std;
    const upperExit = mean + this.exitStdMult * std;
    const lowerExit = mean - this.exitStdMult * std;

    if (!state.inPosition) {
      if (bar < state.cooldownUntil) return { action: 'NONE' };

      // Spread above upper band → short spread
      if (current > upperEntry && current < upperStop) {
        return { action: 'ENTER', direction: 'SHORT_SPREAD' };
      }
      // Spread below lower band → long spread
      if (current < lowerEntry && current > lowerStop) {
        return { action: 'ENTER', direction: 'LONG_SPREAD' };
      }
    } else {
      // Exit: spread reverted to within exit bands
      if (state.direction === 'SHORT_SPREAD' && current <= upperExit) {
        return { action: 'EXIT', reason: 'TP' };
      }
      if (state.direction === 'LONG_SPREAD' && current >= lowerExit) {
        return { action: 'EXIT', reason: 'TP' };
      }

      // Stop-loss
      if (bar >= state.gracePeriodEnd) {
        if (state.direction === 'SHORT_SPREAD' && current > upperStop) {
          return { action: 'EXIT', reason: 'SL' };
        }
        if (state.direction === 'LONG_SPREAD' && current < lowerStop) {
          return { action: 'EXIT', reason: 'SL' };
        }
      }
    }

    return { action: 'NONE' };
  }
}

// ═══════════════════════════════════════════════════════════════
// Strategy 3: Adaptive Z-Score (half-life-based dynamic window)
// ═══════════════════════════════════════════════════════════════

export class AdaptiveZScoreStrategy implements Strategy {
  readonly name = 'adaptive_zscore';
  readonly description = 'Z-Score with window adapting to spread half-life';
  readonly params: Record<string, number>;
  private adaptiveWindow: number;

  constructor(
    private baseWindow: number = 168,
    private halfLifeMultiplier: number = 3,
    private minWindow: number = 30,
    private maxWindow: number = 500,
    private entryZ: number = 2.0,
    private exitZ: number = 0.5,
    private stopLossZ: number = 3.5,
    private recalcInterval: number = 48,
    private gracePeriodBars: number = 5,
    private cooldownBars: number = 24,
  ) {
    this.params = {
      baseWindow, halfLifeMultiplier, minWindow, maxWindow,
      entryZ, exitZ, stopLossZ, recalcInterval, gracePeriodBars, cooldownBars,
    };
    this.adaptiveWindow = baseWindow;
  }

  reset(): void {
    this.adaptiveWindow = this.baseWindow;
  }

  evaluate(bar: number, spread: number[], state: StrategyState): StrategySignal {
    if (bar < this.baseWindow) return { action: 'NONE' };

    // Recalculate adaptive window periodically
    if (bar % this.recalcInterval === 0 && bar > this.minWindow) {
      const halfLife = this.estimateHalfLife(spread, bar, Math.min(bar, 200));
      if (halfLife > 0 && halfLife < Infinity) {
        const newWindow = Math.round(halfLife * this.halfLifeMultiplier);
        this.adaptiveWindow = Math.max(this.minWindow, Math.min(this.maxWindow, newWindow));
      }
    }

    const z = computeZScore(spread, bar, this.adaptiveWindow);

    if (!state.inPosition) {
      if (bar < state.cooldownUntil) return { action: 'NONE' };

      if (z > this.entryZ && z < this.stopLossZ) {
        return { action: 'ENTER', direction: 'SHORT_SPREAD' };
      }
      if (z < -this.entryZ && Math.abs(z) < this.stopLossZ) {
        return { action: 'ENTER', direction: 'LONG_SPREAD' };
      }
    } else {
      if (Math.abs(z) <= this.exitZ) {
        return { action: 'EXIT', reason: 'TP' };
      }
      if (bar >= state.gracePeriodEnd && Math.abs(z) > this.stopLossZ) {
        return { action: 'EXIT', reason: 'SL' };
      }
    }

    return { action: 'NONE' };
  }

  private estimateHalfLife(spread: number[], endBar: number, lookback: number): number {
    const startBar = Math.max(0, endBar - lookback);
    const series = spread.slice(startBar, endBar + 1);
    if (series.length < 10) return this.baseWindow / this.halfLifeMultiplier;

    // AR(1): y_t = a + b * y_{t-1}
    const y = series.slice(1);
    const x = series.slice(0, -1);
    const n = Math.min(x.length, y.length);

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
    }
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return Infinity;

    const beta = (n * sumXY - sumX * sumY) / denom;
    if (beta >= 1 || beta <= 0) return Infinity;

    return -Math.log(2) / Math.log(beta);
  }
}

// ═══════════════════════════════════════════════════════════════
// Strategy 4: RSI Divergence on Spread
// ═══════════════════════════════════════════════════════════════

export class RSIDivergenceStrategy implements Strategy {
  readonly name = 'rsi_divergence';
  readonly description = 'RSI on spread — enter when oversold/overbought, confirm with Z-Score';
  readonly params: Record<string, number>;

  constructor(
    private rsiPeriod: number = 14,
    private rsiOverbought: number = 75,
    private rsiOversold: number = 25,
    private rsiExitUpper: number = 55,
    private rsiExitLower: number = 45,
    private zScoreConfirm: number = 1.5,
    private stopLossZ: number = 3.5,
    private window: number = 168,
    private gracePeriodBars: number = 5,
    private cooldownBars: number = 24,
  ) {
    this.params = {
      rsiPeriod, rsiOverbought, rsiOversold, rsiExitUpper, rsiExitLower,
      zScoreConfirm, stopLossZ, window, gracePeriodBars, cooldownBars,
    };
  }

  reset(): void {}

  evaluate(bar: number, spread: number[], state: StrategyState): StrategySignal {
    if (bar < Math.max(this.window, this.rsiPeriod + 1)) return { action: 'NONE' };

    const rsi = computeRSI(spread, bar, this.rsiPeriod);
    const z = computeZScore(spread, bar, this.window);

    if (!state.inPosition) {
      if (bar < state.cooldownUntil) return { action: 'NONE' };

      // Overbought RSI + positive z-score → short spread
      if (rsi > this.rsiOverbought && z > this.zScoreConfirm && z < this.stopLossZ) {
        return { action: 'ENTER', direction: 'SHORT_SPREAD' };
      }
      // Oversold RSI + negative z-score → long spread
      if (rsi < this.rsiOversold && z < -this.zScoreConfirm && Math.abs(z) < this.stopLossZ) {
        return { action: 'ENTER', direction: 'LONG_SPREAD' };
      }
    } else {
      // Exit when RSI normalizes
      if (state.direction === 'SHORT_SPREAD' && rsi < this.rsiExitUpper) {
        return { action: 'EXIT', reason: 'TP' };
      }
      if (state.direction === 'LONG_SPREAD' && rsi > this.rsiExitLower) {
        return { action: 'EXIT', reason: 'TP' };
      }
      // Stop-loss on extreme z-score
      if (bar >= state.gracePeriodEnd && Math.abs(z) > this.stopLossZ) {
        return { action: 'EXIT', reason: 'SL' };
      }
    }

    return { action: 'NONE' };
  }
}

// ═══════════════════════════════════════════════════════════════
// Strategy 5: Z-Score + Momentum Filter
// ═══════════════════════════════════════════════════════════════

export class MomentumFilterStrategy implements Strategy {
  readonly name = 'momentum_filter';
  readonly description = 'Z-Score entry only when momentum confirms reversion (avoid catching falling knives)';
  readonly params: Record<string, number>;

  constructor(
    private entryZ: number = 2.0,
    private exitZ: number = 0.5,
    private stopLossZ: number = 3.5,
    private window: number = 168,
    private momentumWindow: number = 5,
    private emaFast: number = 12,
    private emaSlow: number = 26,
    private gracePeriodBars: number = 5,
    private cooldownBars: number = 24,
  ) {
    this.params = {
      entryZ, exitZ, stopLossZ, window, momentumWindow,
      emaFast, emaSlow, gracePeriodBars, cooldownBars,
    };
  }

  reset(): void {}

  evaluate(bar: number, spread: number[], state: StrategyState): StrategySignal {
    if (bar < Math.max(this.window, this.emaSlow + 1)) return { action: 'NONE' };

    const z = computeZScore(spread, bar, this.window);

    if (!state.inPosition) {
      if (bar < state.cooldownUntil) return { action: 'NONE' };

      // Check momentum: is the spread reverting back?
      const momentumOk = this.isMomentumConfirming(spread, bar, z > 0 ? 'SHORT_SPREAD' : 'LONG_SPREAD');

      if (z > this.entryZ && z < this.stopLossZ && momentumOk) {
        return { action: 'ENTER', direction: 'SHORT_SPREAD' };
      }
      if (z < -this.entryZ && Math.abs(z) < this.stopLossZ && momentumOk) {
        return { action: 'ENTER', direction: 'LONG_SPREAD' };
      }
    } else {
      if (Math.abs(z) <= this.exitZ) {
        return { action: 'EXIT', reason: 'TP' };
      }
      if (bar >= state.gracePeriodEnd && Math.abs(z) > this.stopLossZ) {
        return { action: 'EXIT', reason: 'SL' };
      }
    }

    return { action: 'NONE' };
  }

  private isMomentumConfirming(spread: number[], bar: number, direction: Direction): boolean {
    if (bar < this.momentumWindow + 1) return false;

    // Short-term momentum: is spread heading back to mean?
    const recentChange = spread[bar] - spread[bar - this.momentumWindow];

    // EMA cross check
    const emaFast = computeEMA(spread, bar, this.emaFast);
    const emaSlow = computeEMA(spread, bar, this.emaSlow);

    if (direction === 'SHORT_SPREAD') {
      // For shorting spread: need spread declining (reverting down)
      return recentChange < 0 || emaFast < emaSlow;
    } else {
      // For longing spread: need spread rising (reverting up)
      return recentChange > 0 || emaFast > emaSlow;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Strategy 6: Kalman Filter Dynamic Hedge
// ═══════════════════════════════════════════════════════════════

export class KalmanFilterStrategy implements Strategy {
  readonly name = 'kalman_filter';
  readonly description = 'Kalman Filter for dynamic hedge ratio — adapts to changing relationships';
  readonly params: Record<string, number>;

  // Kalman state
  private beta: number = 0;
  private P: number = 1;       // Estimate covariance
  private Q: number = 0.0001;  // Process noise
  private R: number = 0.01;    // Measurement noise
  private initialized: boolean = false;

  constructor(
    private entryZ: number = 2.0,
    private exitZ: number = 0.5,
    private stopLossZ: number = 3.5,
    private window: number = 100,
    processNoise: number = 0.0001,
    measurementNoise: number = 0.01,
    private gracePeriodBars: number = 5,
    private cooldownBars: number = 24,
  ) {
    this.Q = processNoise;
    this.R = measurementNoise;
    this.params = {
      entryZ, exitZ, stopLossZ, window,
      processNoise, measurementNoise, gracePeriodBars, cooldownBars,
    };
  }

  reset(): void {
    this.beta = 0;
    this.P = 1;
    this.initialized = false;
  }

  evaluate(bar: number, spread: number[], state: StrategyState): StrategySignal {
    // Kalman spread uses pre-computed spread from OLS as input
    // We treat the spread as the measurement and use Kalman to smooth it
    if (bar < this.window) return { action: 'NONE' };

    // Update Kalman filter
    this.updateKalman(spread[bar]);

    // Calculate z-score on Kalman-filtered residual
    const kalmanSpread = this.getKalmanResidual(spread, bar);
    const mean = rollingMean(kalmanSpread, kalmanSpread.length - 1, this.window);
    const std = rollingStd(kalmanSpread, kalmanSpread.length - 1, this.window);
    const z = std > 0 ? (kalmanSpread[kalmanSpread.length - 1] - mean) / std : 0;

    if (!state.inPosition) {
      if (bar < state.cooldownUntil) return { action: 'NONE' };

      if (z > this.entryZ && z < this.stopLossZ) {
        return { action: 'ENTER', direction: 'SHORT_SPREAD' };
      }
      if (z < -this.entryZ && Math.abs(z) < this.stopLossZ) {
        return { action: 'ENTER', direction: 'LONG_SPREAD' };
      }
    } else {
      if (Math.abs(z) <= this.exitZ) {
        return { action: 'EXIT', reason: 'TP' };
      }
      if (bar >= state.gracePeriodEnd && Math.abs(z) > this.stopLossZ) {
        return { action: 'EXIT', reason: 'SL' };
      }
    }

    return { action: 'NONE' };
  }

  private updateKalman(measurement: number): void {
    if (!this.initialized) {
      this.beta = measurement;
      this.initialized = true;
      return;
    }

    // Predict
    const P_pred = this.P + this.Q;

    // Update
    const K = P_pred / (P_pred + this.R);    // Kalman gain
    this.beta = this.beta + K * (measurement - this.beta);
    this.P = (1 - K) * P_pred;
  }

  private getKalmanResidual(spread: number[], endBar: number): number[] {
    // Re-run Kalman over recent window to get smoothed values
    const start = Math.max(0, endBar - this.window + 1);
    const residuals: number[] = [];

    let kb = spread[start];
    let kP = 1;

    for (let i = start; i <= endBar; i++) {
      const P_pred = kP + this.Q;
      const K = P_pred / (P_pred + this.R);
      kb = kb + K * (spread[i] - kb);
      kP = (1 - K) * P_pred;
      residuals.push(spread[i] - kb);
    }

    return residuals;
  }
}

// ═══════════════════════════════════════════════════════════════
// Strategy Factory
// ═══════════════════════════════════════════════════════════════

export type StrategyName =
  | 'classic_zscore'
  | 'adaptive_zscore'
  | 'momentum_filter'
  | 'kalman_filter';

export const ALL_STRATEGY_NAMES: StrategyName[] = [
  'classic_zscore',
  'adaptive_zscore',
  'momentum_filter',
  'kalman_filter',
];

/**
 * Create a strategy instance with default parameters
 */
export function createStrategy(name: StrategyName): Strategy {
  switch (name) {
    case 'classic_zscore':
      return new ClassicZScoreStrategy();
    case 'adaptive_zscore':
      return new AdaptiveZScoreStrategy();
    case 'momentum_filter':
      return new MomentumFilterStrategy();
    case 'kalman_filter':
      return new KalmanFilterStrategy();
    default:
      throw new Error(`Unknown strategy: ${name}`);
  }
}

/**
 * Create all strategies with default parameters
 */
export function createAllStrategies(): Strategy[] {
  return ALL_STRATEGY_NAMES.map(createStrategy);
}

/**
 * Create strategy with custom parameter overrides
 */
export function createStrategyWithParams(name: StrategyName, overrides: Record<string, number>): Strategy {
  switch (name) {
    case 'classic_zscore':
      return new ClassicZScoreStrategy(
        overrides.entryZ, overrides.exitZ, overrides.stopLossZ,
        overrides.window, overrides.safeZoneBuffer,
        overrides.gracePeriodBars, overrides.cooldownBars,
      );
    case 'adaptive_zscore':
      return new AdaptiveZScoreStrategy(
        overrides.baseWindow, overrides.halfLifeMultiplier,
        overrides.minWindow, overrides.maxWindow,
        overrides.entryZ, overrides.exitZ, overrides.stopLossZ,
        overrides.recalcInterval, overrides.gracePeriodBars, overrides.cooldownBars,
      );
    case 'momentum_filter':
      return new MomentumFilterStrategy(
        overrides.entryZ, overrides.exitZ, overrides.stopLossZ,
        overrides.window, overrides.momentumWindow,
        overrides.emaFast, overrides.emaSlow,
        overrides.gracePeriodBars, overrides.cooldownBars,
      );
    case 'kalman_filter':
      return new KalmanFilterStrategy(
        overrides.entryZ, overrides.exitZ, overrides.stopLossZ,
        overrides.window, overrides.processNoise, overrides.measurementNoise,
        overrides.gracePeriodBars, overrides.cooldownBars,
      );
    default:
      throw new Error(`Unknown strategy: ${name}`);
  }
}
