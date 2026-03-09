import { createChildLogger } from '../logger.js';

const log = createChildLogger('cointegration');

export interface CointegrationResult {
  symbolA: string;
  symbolB: string;
  beta: number;           // Hedge ratio
  pValue: number;         // ADF test p-value (lower = more cointegrated)
  halfLife: number;       // Mean reversion half-life in bars
  spread: number[];       // The residual spread
  spreadMean: number;
  spreadStd: number;
  isCointegrated: boolean;
}

/**
 * Ordinary Least Squares regression: y = alpha + beta * x
 */
export function ols(x: number[], y: number[]): { alpha: number; beta: number; residuals: number[] } {
  const n = Math.min(x.length, y.length);
  if (n < 3) throw new Error('Need at least 3 data points for OLS');

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
  }

  const beta = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const alpha = (sumY - beta * sumX) / n;

  const residuals: number[] = [];
  for (let i = 0; i < n; i++) {
    residuals.push(y[i] - alpha - beta * x[i]);
  }

  return { alpha, beta, residuals };
}

/**
 * Augmented Dickey-Fuller test (simplified)
 * Tests H0: unit root exists (non-stationary)
 * Low p-value → reject H0 → series is stationary (cointegrated)
 *
 * Uses MacKinnon critical values for approximation:
 *   1%: -3.43, 5%: -2.86, 10%: -2.57
 */
export function adfTest(series: number[]): { testStatistic: number; pValue: number } {
  const n = series.length;
  if (n < 10) return { testStatistic: 0, pValue: 1 };

  // First differences
  const dy: number[] = [];
  const yLag: number[] = [];
  for (let i = 1; i < n; i++) {
    dy.push(series[i] - series[i - 1]);
    yLag.push(series[i - 1]);
  }

  // Regression: dy = alpha + gamma * y_{t-1} + error
  // gamma < 0 and significantly so → stationary
  const m = dy.length;
  let sumY = 0, sumDY = 0, sumYDY = 0, sumY2 = 0;
  for (let i = 0; i < m; i++) {
    sumY += yLag[i];
    sumDY += dy[i];
    sumYDY += yLag[i] * dy[i];
    sumY2 += yLag[i] * yLag[i];
  }

  const gamma = (m * sumYDY - sumY * sumDY) / (m * sumY2 - sumY * sumY);

  // Standard error of gamma
  const alpha = (sumDY - gamma * sumY) / m;
  let sse = 0;
  for (let i = 0; i < m; i++) {
    const residual = dy[i] - alpha - gamma * yLag[i];
    sse += residual * residual;
  }
  const mse = sse / (m - 2);
  const seGamma = Math.sqrt(mse * m / (m * sumY2 - sumY * sumY));

  const testStatistic = seGamma > 0 ? gamma / seGamma : 0;

  // Approximate p-value using critical values
  let pValue: number;
  if (testStatistic < -3.43) pValue = 0.01;
  else if (testStatistic < -2.86) pValue = 0.05;
  else if (testStatistic < -2.57) pValue = 0.10;
  else if (testStatistic < -1.94) pValue = 0.30;
  else if (testStatistic < -1.62) pValue = 0.50;
  else pValue = 0.90;

  return { testStatistic, pValue };
}

/**
 * Calculate half-life of mean reversion from AR(1) model
 * halfLife = -log(2) / log(beta) where beta is AR(1) coefficient
 */
export function calculateHalfLife(spread: number[]): number {
  const n = spread.length;
  if (n < 5) return Infinity;

  // AR(1): spread_t = alpha + beta * spread_{t-1} + error
  const y = spread.slice(1);
  const x = spread.slice(0, -1);

  const result = ols(x, y);
  const arBeta = result.beta;

  // beta must be < 1 for mean reversion
  if (arBeta >= 1 || arBeta <= 0) return Infinity;

  const halfLife = -Math.log(2) / Math.log(arBeta);
  return Math.max(1, halfLife); // At least 1 bar
}

/**
 * Engle-Granger two-step cointegration test
 */
export function testCointegration(
  pricesA: number[],
  pricesB: number[],
  symbolA: string,
  symbolB: string,
  pValueThreshold: number = 0.05,
): CointegrationResult {
  const n = Math.min(pricesA.length, pricesB.length);

  // Use log prices
  const logA = pricesA.slice(-n).map(Math.log);
  const logB = pricesB.slice(-n).map(Math.log);

  // Step 1: OLS regression logA = alpha + beta * logB
  const { beta, residuals: spread } = ols(logB, logA);

  // Step 2: ADF test on residuals
  const { testStatistic, pValue } = adfTest(spread);

  // Step 3: Half-life
  const halfLife = calculateHalfLife(spread);

  // Statistics
  const spreadMean = spread.reduce((a, b) => a + b, 0) / spread.length;
  const spreadVariance = spread.reduce((a, b) => a + (b - spreadMean) ** 2, 0) / spread.length;
  const spreadStd = Math.sqrt(spreadVariance);

  const isCointegrated = pValue <= pValueThreshold && halfLife < 168 && halfLife > 1;

  log.debug({
    symbolA, symbolB, beta, pValue, halfLife, isCointegrated, testStatistic,
  }, 'Cointegration test result');

  return {
    symbolA,
    symbolB,
    beta,
    pValue,
    halfLife,
    spread,
    spreadMean,
    spreadStd,
    isCointegrated,
  };
}

/**
 * Rank pairs by composite score: correlation × (1/pValue) × (1/halfLife)
 */
export function rankPairs(
  pairs: Array<{ symbolA: string; symbolB: string; correlation: number }>,
  cointegrationResults: Map<string, CointegrationResult>,
): Array<CointegrationResult & { correlation: number; score: number }> {
  const ranked: Array<CointegrationResult & { correlation: number; score: number }> = [];

  for (const pair of pairs) {
    const key = `${pair.symbolA}/${pair.symbolB}`;
    const coint = cointegrationResults.get(key);
    if (!coint || !coint.isCointegrated) continue;

    const score = pair.correlation * (1 / Math.max(coint.pValue, 0.001)) * (1 / Math.max(coint.halfLife, 1));
    ranked.push({
      ...coint,
      correlation: pair.correlation,
      score,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}
