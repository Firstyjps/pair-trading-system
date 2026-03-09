import { describe, it, expect } from 'vitest';
import { dollarNeutral } from '../../src/sizing/dollar-neutral.js';
import { kellyCriterion } from '../../src/sizing/kelly.js';
import { fixedFraction } from '../../src/sizing/fixed-fraction.js';
import { volatilityScaled, calculateATR } from '../../src/sizing/volatility-scaled.js';
import { equalWeight } from '../../src/sizing/equal-weight.js';

describe('Dollar-Neutral Sizing', () => {
  it('should allocate equal USD on both legs', () => {
    // Use prices where contract sizes are reasonable (meme coins, small prices)
    const result = dollarNeutral(0.01, 0.05, 300, 5);
    // Notional = 300 * 5 = 1500 per leg
    expect(result.legANotional).toBeGreaterThan(0);
    expect(result.legBNotional).toBeGreaterThan(0);
    // Dollar-neutral: approximately equal notional
    expect(Math.abs(result.legANotional - result.legBNotional) / result.legANotional).toBeLessThan(0.01);
  });

  it('should respect lot sizes', () => {
    const result = dollarNeutral(0.001, 0.05, 300, 5, 100, 10);
    expect(result.legASize % 100).toBe(0);
    expect(result.legBSize % 10).toBe(0);
  });

  it('should handle very small prices', () => {
    const result = dollarNeutral(0.0001, 0.001, 300, 5);
    expect(result.legASize).toBeGreaterThan(0);
  });
});

describe('Kelly Criterion Sizing', () => {
  it('should size proportionally to edge', () => {
    const result = kellyCriterion(100, 50, 10000, 5, 0.6, 2, 1);
    expect(result.legASize).toBeGreaterThan(0);
    expect(result.legBSize).toBeGreaterThan(0);
    expect(result.totalExposure).toBeLessThanOrEqual(10000 * 0.25 * 5 * 2);
  });

  it('should return zero for negative edge (win rate too low)', () => {
    const result = kellyCriterion(100, 50, 10000, 5, 0.2, 1, 2);
    expect(result.legASize).toBe(0);
    expect(result.legBSize).toBe(0);
  });

  it('should cap at 25% of capital', () => {
    const result = kellyCriterion(100, 50, 1000, 5, 0.99, 10, 1, 1.0);
    const maxCapitalPerLeg = 1000 * 0.25;
    expect(result.legANotional).toBeLessThanOrEqual(maxCapitalPerLeg * 5 + 1);
  });
});

describe('Fixed Fraction Sizing', () => {
  it('should use fraction of total capital', () => {
    const result = fixedFraction(100, 50, 10000, 0.1, 5);
    // 10% of 10000 = 1000, split between two legs = 500 each, x5 leverage = 2500
    expect(result.totalExposure).toBeLessThanOrEqual(5200); // Allow for rounding
  });

  it('should clamp fraction between 1% and 100%', () => {
    const result = fixedFraction(100, 50, 10000, 0.001, 5);
    expect(result.legASize).toBeGreaterThan(0);
  });
});

describe('Volatility-Scaled Sizing', () => {
  it('should give less capital to more volatile asset', () => {
    // Asset A has higher ATR → should get less capital
    const result = volatilityScaled(100, 100, 10, 2, 300, 5);

    // Asset B has lower ATR percentage → should get more
    expect(result.legBNotional).toBeGreaterThan(result.legANotional);
  });

  it('should fall back to equal when ATRs are equal', () => {
    const result = volatilityScaled(100, 100, 5, 5, 300, 5);
    expect(Math.abs(result.legANotional - result.legBNotional)).toBeLessThan(1);
  });

  it('should handle zero ATR gracefully', () => {
    const result = volatilityScaled(100, 100, 0, 0, 300, 5);
    expect(result.legASize).toBeGreaterThanOrEqual(0);
  });
});

describe('calculateATR', () => {
  it('should compute ATR for valid data', () => {
    const highs = [110, 112, 115, 113, 118, 120, 119, 122, 125, 123,
                   127, 130, 128, 132, 135, 133];
    const lows =  [100, 102, 105, 103, 108, 110, 109, 112, 115, 113,
                   117, 120, 118, 122, 125, 123];
    const closes = [105, 107, 110, 108, 113, 115, 114, 117, 120, 118,
                    122, 125, 123, 127, 130, 128];

    const atr = calculateATR(highs, lows, closes, 14);
    expect(atr).toBeGreaterThan(0);
  });

  it('should return 0 for insufficient data', () => {
    expect(calculateATR([100], [90], [95], 14)).toBe(0);
  });
});

describe('Equal Weight Sizing', () => {
  it('should use fixed contract count', () => {
    const result = equalWeight(100, 50, 10);
    expect(result.legASize).toBe(10);
    expect(result.legBSize).toBe(10);
    expect(result.legANotional).toBe(1000);
    expect(result.legBNotional).toBe(500);
  });

  it('should respect lot sizes', () => {
    const result = equalWeight(100, 50, 15, 10, 5);
    expect(result.legASize).toBe(10); // floor(15/10)*10
    expect(result.legBSize).toBe(15); // floor(15/5)*5
  });
});
