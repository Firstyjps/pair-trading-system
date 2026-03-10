import { createChildLogger } from '../logger.js';

const log = createChildLogger('dynamic-leverage');

/**
 * Calculate Average True Range (ATR) from price data.
 * Uses close-to-close returns since we only have close prices (no OHLC in cache).
 * ATR = rolling average of absolute returns.
 */
export function calculateATR(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 0;

  // Calculate absolute returns
  const absReturns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    absReturns.push(Math.abs((prices[i] - prices[i - 1]) / prices[i - 1]));
  }

  // Use last `period` returns
  const recent = absReturns.slice(-period);
  const atr = recent.reduce((a, b) => a + b, 0) / recent.length;
  return atr;
}

/**
 * Calculate annualized volatility from close prices.
 * vol = std(returns) * sqrt(barsPerYear)
 */
export function calculateVolatility(prices: number[], barsPerYear: number = 8760): number {
  if (prices.length < 10) return 0;

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(barsPerYear);
}

export interface DynamicLeverageConfig {
  /** Maximum leverage allowed */
  maxLeverage: number;
  /** Minimum leverage floor */
  minLeverage: number;
  /** Target volatility (annualized) — leverage adjusts to hit this target */
  targetVolatility: number;
  /** ATR period for volatility calculation */
  atrPeriod: number;
}

const DEFAULT_CONFIG: DynamicLeverageConfig = {
  maxLeverage: 5,
  minLeverage: 1,
  targetVolatility: 0.5, // 50% annualized
  atrPeriod: 14,
};

/**
 * Calculate dynamic leverage based on pair volatility.
 *
 * Logic: leverage = targetVol / currentVol
 * - High volatility → lower leverage (safer)
 * - Low volatility → higher leverage (capitalize on stability)
 * - Clamped between minLeverage and maxLeverage
 *
 * Uses the COMBINED spread volatility of the pair (not individual legs).
 */
export function calculateDynamicLeverage(
  pricesA: number[],
  pricesB: number[],
  beta: number,
  config: Partial<DynamicLeverageConfig> = {},
): { leverage: number; spreadVol: number; atr: number } {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Calculate spread: log(A) - beta * log(B)
  const n = Math.min(pricesA.length, pricesB.length);
  const spreads: number[] = [];
  for (let i = 0; i < n; i++) {
    spreads.push(Math.log(pricesA[i]) - beta * Math.log(pricesB[i]));
  }

  // Spread ATR (volatility of spread changes)
  const atr = calculateATR(spreads, cfg.atrPeriod);

  // Spread annualized volatility
  const spreadVol = calculateVolatility(spreads);

  if (spreadVol <= 0) {
    log.debug('Spread volatility is zero — using max leverage');
    return { leverage: cfg.maxLeverage, spreadVol: 0, atr: 0 };
  }

  // Inverse vol scaling: high vol → low leverage
  const rawLeverage = cfg.targetVolatility / spreadVol;
  const leverage = Math.max(cfg.minLeverage, Math.min(cfg.maxLeverage, Math.round(rawLeverage)));

  log.debug({
    spreadVol: spreadVol.toFixed(4),
    atr: atr.toFixed(6),
    rawLeverage: rawLeverage.toFixed(2),
    clampedLeverage: leverage,
  }, 'Dynamic leverage calculated');

  return { leverage, spreadVol, atr };
}
