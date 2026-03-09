import { describe, it, expect } from 'vitest';
import {
  logReturns,
  pearsonCorrelation,
  rollingCorrelation,
  buildCorrelationMatrix,
  getSector,
} from '../../src/scanner/correlation.js';

describe('logReturns', () => {
  it('should calculate log returns correctly', () => {
    const prices = [100, 110, 105, 115];
    const returns = logReturns(prices);
    expect(returns.length).toBe(3);
    expect(returns[0]).toBeCloseTo(Math.log(110 / 100), 10);
    expect(returns[1]).toBeCloseTo(Math.log(105 / 110), 10);
  });

  it('should handle single price', () => {
    expect(logReturns([100]).length).toBe(0);
  });

  it('should skip zero/negative prices', () => {
    const returns = logReturns([100, 0, 110]);
    expect(returns.length).toBe(0); // Both transitions involve 0
  });
});

describe('pearsonCorrelation', () => {
  it('should return 1 for perfectly correlated data', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(1, 5);
  });

  it('should return -1 for perfectly negatively correlated data', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [10, 8, 6, 4, 2];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(-1, 5);
  });

  it('should return ~0 for uncorrelated data', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const y = [5, 2, 8, 1, 9, 3, 7, 4, 6, 10]; // roughly random
    const corr = pearsonCorrelation(x, y);
    expect(Math.abs(corr)).toBeLessThan(0.5);
  });

  it('should return 0 for too few data points', () => {
    expect(pearsonCorrelation([1, 2], [3, 4])).toBe(0);
  });

  it('should return 0 for constant data', () => {
    expect(pearsonCorrelation([5, 5, 5, 5], [1, 2, 3, 4])).toBe(0);
  });

  it('should handle different length arrays', () => {
    const x = [1, 2, 3, 4, 5, 6];
    const y = [2, 4, 6, 8]; // shorter
    const corr = pearsonCorrelation(x, y);
    expect(corr).toBeCloseTo(1, 5); // first 4 elements
  });

  it('should clamp to [-1, 1]', () => {
    const corr = pearsonCorrelation([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
    expect(corr).toBeGreaterThanOrEqual(-1);
    expect(corr).toBeLessThanOrEqual(1);
  });
});

describe('rollingCorrelation', () => {
  it('should compute rolling windows', () => {
    const x = [1, 2, 3, 4, 5, 6, 7];
    const y = [2, 4, 6, 8, 10, 12, 14];
    const rolling = rollingCorrelation(x, y, 3);
    expect(rolling.length).toBe(5);
    rolling.forEach(r => expect(r).toBeCloseTo(1, 5));
  });
});

describe('buildCorrelationMatrix', () => {
  it('should find correlated pairs above threshold', () => {
    const priceData = new Map<string, number[]>();
    // Two correlated series
    const base = Array.from({ length: 50 }, (_, i) => 100 + i + Math.random() * 2);
    priceData.set('A-USDT-SWAP', base);
    priceData.set('B-USDT-SWAP', base.map(x => x * 1.5 + Math.random()));
    // One uncorrelated
    priceData.set('C-USDT-SWAP', Array.from({ length: 50 }, () => Math.random() * 100));

    const pairs = buildCorrelationMatrix(priceData, 0.7);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs[0].symbolA).toContain('USDT-SWAP');
  });

  it('should return empty for no correlated pairs', () => {
    const priceData = new Map<string, number[]>();
    priceData.set('A', Array.from({ length: 50 }, (_, i) => i));
    priceData.set('B', Array.from({ length: 50 }, (_, i) => 50 - i));

    const pairs = buildCorrelationMatrix(priceData, 0.99);
    expect(pairs.length).toBe(0);
  });
});

describe('getSector', () => {
  it('should tag meme coins', () => {
    expect(getSector('DOGE-USDT-SWAP')).toBe('meme');
    expect(getSector('SHIB-USDT-SWAP')).toBe('meme');
  });

  it('should tag L1s', () => {
    expect(getSector('BTC-USDT-SWAP')).toBe('l1');
    expect(getSector('ETH-USDT-SWAP')).toBe('l1');
  });

  it('should return other for unknown', () => {
    expect(getSector('UNKNOWN-USDT-SWAP')).toBe('other');
  });
});
