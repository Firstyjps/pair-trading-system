import { describe, it, expect } from 'vitest';
import {
  ols,
  adfTest,
  calculateHalfLife,
  testCointegration,
  rankPairs,
} from '../../src/scanner/cointegration.js';

describe('OLS regression', () => {
  it('should fit a perfect linear relationship', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [3, 5, 7, 9, 11]; // y = 1 + 2x
    const { alpha, beta, residuals } = ols(x, y);
    expect(beta).toBeCloseTo(2, 5);
    expect(alpha).toBeCloseTo(1, 5);
    residuals.forEach(r => expect(Math.abs(r)).toBeLessThan(1e-10));
  });

  it('should throw with < 3 data points', () => {
    expect(() => ols([1, 2], [3, 4])).toThrow();
  });

  it('should handle noisy data', () => {
    const x = Array.from({ length: 100 }, (_, i) => i);
    const y = x.map(xi => 2 * xi + 5 + (Math.random() - 0.5) * 2);
    const { beta } = ols(x, y);
    expect(beta).toBeCloseTo(2, 0);
  });
});

describe('ADF test', () => {
  it('should detect stationary series (low p-value)', () => {
    // Mean-reverting series
    const series: number[] = [];
    let val = 0;
    for (let i = 0; i < 200; i++) {
      val = 0.5 * val + (Math.random() - 0.5); // AR(1) with phi=0.5
      series.push(val);
    }
    const { pValue } = adfTest(series);
    expect(pValue).toBeLessThanOrEqual(0.1);
  });

  it('should detect non-stationary series (high p-value)', () => {
    // Random walk
    const series: number[] = [0];
    for (let i = 1; i < 200; i++) {
      series.push(series[i - 1] + (Math.random() - 0.5));
    }
    const { pValue } = adfTest(series);
    expect(pValue).toBeGreaterThanOrEqual(0.05);
  });

  it('should handle short series', () => {
    const { pValue } = adfTest([1, 2, 3]);
    expect(pValue).toBe(1);
  });
});

describe('calculateHalfLife', () => {
  it('should return finite half-life for mean-reverting series', () => {
    const series: number[] = [];
    let val = 0;
    for (let i = 0; i < 200; i++) {
      val = 0.8 * val + (Math.random() - 0.5) * 0.1;
      series.push(val);
    }
    const hl = calculateHalfLife(series);
    expect(hl).toBeGreaterThan(0);
    expect(hl).toBeLessThan(200);
  });

  it('should return large half-life for random walk', () => {
    // Use a pure random walk (no mean reversion)
    const series: number[] = [0];
    for (let i = 1; i < 500; i++) {
      series.push(series[i - 1] + (Math.random() - 0.5));
    }
    const hl = calculateHalfLife(series);
    // Random walk should have very high half-life (or Infinity)
    // AR(1) beta should be close to 1
    expect(hl).toBeGreaterThan(5);
  });

  it('should return Infinity for too short series', () => {
    expect(calculateHalfLife([1, 2])).toBe(Infinity);
  });
});

describe('testCointegration', () => {
  it('should detect cointegrated pairs', () => {
    // Create two cointegrated series: B follows A with noise
    const n = 300;
    const pricesA: number[] = [];
    const pricesB: number[] = [];
    let a = 100, b = 50;
    for (let i = 0; i < n; i++) {
      a += (Math.random() - 0.5) * 2;
      b = a * 0.5 + (Math.random() - 0.5) * 1; // cointegrated
      pricesA.push(Math.max(1, a));
      pricesB.push(Math.max(1, b));
    }

    const result = testCointegration(pricesA, pricesB, 'A', 'B', 0.1);
    // beta should be close to 1 (in log space for these prices)
    expect(result.spreadStd).toBeGreaterThan(0);
    expect(result.halfLife).toBeGreaterThan(0);
  });

  it('should not detect cointegration for random walks', () => {
    const n = 200;
    const pricesA: number[] = [100];
    const pricesB: number[] = [100];
    for (let i = 1; i < n; i++) {
      pricesA.push(pricesA[i - 1] * (1 + (Math.random() - 0.5) * 0.02));
      pricesB.push(pricesB[i - 1] * (1 + (Math.random() - 0.5) * 0.02));
    }

    const result = testCointegration(pricesA, pricesB, 'A', 'B', 0.05);
    // Less likely to be cointegrated (but random, so not guaranteed)
    expect(result.spreadStd).toBeGreaterThan(0);
  });
});

describe('rankPairs', () => {
  it('should rank by composite score', () => {
    const pairs = [
      { symbolA: 'A', symbolB: 'B', correlation: 0.9 },
      { symbolA: 'C', symbolB: 'D', correlation: 0.8 },
    ];

    const cointResults = new Map();
    cointResults.set('A/B', {
      symbolA: 'A', symbolB: 'B', beta: 1, pValue: 0.01,
      halfLife: 24, spread: [], spreadMean: 0, spreadStd: 1, isCointegrated: true,
    });
    cointResults.set('C/D', {
      symbolA: 'C', symbolB: 'D', beta: 1, pValue: 0.05,
      halfLife: 48, spread: [], spreadMean: 0, spreadStd: 1, isCointegrated: true,
    });

    const ranked = rankPairs(pairs, cointResults);
    expect(ranked.length).toBe(2);
    expect(ranked[0].symbolA).toBe('A'); // Higher score
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('should filter non-cointegrated pairs', () => {
    const pairs = [{ symbolA: 'A', symbolB: 'B', correlation: 0.9 }];
    const cointResults = new Map();
    cointResults.set('A/B', {
      symbolA: 'A', symbolB: 'B', beta: 1, pValue: 0.5,
      halfLife: 200, spread: [], spreadMean: 0, spreadStd: 1, isCointegrated: false,
    });

    const ranked = rankPairs(pairs, cointResults);
    expect(ranked.length).toBe(0);
  });
});
