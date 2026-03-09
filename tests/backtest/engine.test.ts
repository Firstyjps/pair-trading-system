import { describe, it, expect } from 'vitest';
import { runBacktest, type BacktestConfig } from '../../src/backtest/engine.js';

const defaultConfig: BacktestConfig = {
  entryZ: 2.0,
  exitZ: 0.5,
  stopLossZ: 3.5,
  halfLifeFilter: 24,
  correlationFilter: 0.75,
  safeZoneBuffer: 0.5,
  gracePeriodBars: 5,
  cooldownBars: 24,
  capitalPerLeg: 300,
  leverage: 5,
  feeRate: 0.0006,
};

function generateCointegrated(n: number): { pricesA: number[]; pricesB: number[] } {
  const pricesA: number[] = [];
  const pricesB: number[] = [];
  let a = 100;
  let b = 50;
  const noise = () => (Math.random() - 0.5) * 0.5;

  for (let i = 0; i < n; i++) {
    a += (Math.random() - 0.5) * 2;
    b = a * 0.5 + Math.sin(i / 20) * 3 + noise(); // Mean-reverting spread with oscillation
    pricesA.push(Math.max(1, a));
    pricesB.push(Math.max(1, b));
  }

  return { pricesA, pricesB };
}

describe('Backtest Engine', () => {
  it('should return empty report for insufficient data', () => {
    const report = runBacktest([100, 101], [50, 51], 'A/B', defaultConfig);
    expect(report.totalTrades).toBe(0);
    expect(report.winRate).toBe(0);
  });

  it('should run backtest on cointegrated series', () => {
    const { pricesA, pricesB } = generateCointegrated(2000);
    const report = runBacktest(pricesA, pricesB, 'A/B', defaultConfig);

    expect(report.pair).toBe('A/B');
    expect(report.totalTrades).toBeGreaterThanOrEqual(0);
    expect(typeof report.winRate).toBe('number');
    expect(typeof report.sharpeRatio).toBe('number');
    expect(typeof report.maxDrawdown).toBe('number');
  });

  it('should respect safe zone buffer — no entries too close to SL', () => {
    const { pricesA, pricesB } = generateCointegrated(2000);
    const config: BacktestConfig = {
      ...defaultConfig,
      entryZ: 2.0,
      stopLossZ: 2.3,
      safeZoneBuffer: 0.5,
    };

    const report = runBacktest(pricesA, pricesB, 'A/B', config);
    // With entryZ=2.0 and SL=2.3, buffer=0.5 → entry+buffer(2.5) >= SL(2.3)
    // No trades should be possible
    expect(report.totalTrades).toBe(0);
  });

  it('should respect cooldown between trades', () => {
    const { pricesA, pricesB } = generateCointegrated(2000);
    const config: BacktestConfig = {
      ...defaultConfig,
      cooldownBars: 100, // Long cooldown
    };

    const report = runBacktest(pricesA, pricesB, 'A/B', config);

    // Check no two trades are within cooldown
    for (let i = 1; i < report.trades.length; i++) {
      const gap = report.trades[i].entryBar - report.trades[i - 1].exitBar;
      expect(gap).toBeGreaterThanOrEqual(100);
    }
  });

  it('should respect grace period — no SL within first N bars', () => {
    const { pricesA, pricesB } = generateCointegrated(2000);
    const config: BacktestConfig = {
      ...defaultConfig,
      gracePeriodBars: 10,
    };

    const report = runBacktest(pricesA, pricesB, 'A/B', config);

    for (const trade of report.trades) {
      if (trade.closeReason === 'SL') {
        expect(trade.barsHeld).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('should calculate PnL including fees', () => {
    const { pricesA, pricesB } = generateCointegrated(2000);
    const reportWithFees = runBacktest(pricesA, pricesB, 'A/B', defaultConfig);
    const reportNoFees = runBacktest(pricesA, pricesB, 'A/B', { ...defaultConfig, feeRate: 0 });

    if (reportWithFees.totalTrades > 0 && reportNoFees.totalTrades > 0) {
      expect(reportWithFees.totalPnl).toBeLessThanOrEqual(reportNoFees.totalPnl);
    }
  });

  it('should track max drawdown correctly', () => {
    const { pricesA, pricesB } = generateCointegrated(2000);
    const report = runBacktest(pricesA, pricesB, 'A/B', defaultConfig);
    expect(report.maxDrawdown).toBeGreaterThanOrEqual(0);
  });

  it('should distinguish TP and SL trades', () => {
    const { pricesA, pricesB } = generateCointegrated(3000);
    const report = runBacktest(pricesA, pricesB, 'A/B', defaultConfig);

    const tpTrades = report.trades.filter(t => t.closeReason === 'TP');
    const slTrades = report.trades.filter(t => t.closeReason === 'SL');
    expect(tpTrades.length + slTrades.length).toBe(report.totalTrades);
  });

  it('should handle different entry/exit Z levels', () => {
    const { pricesA, pricesB } = generateCointegrated(2000);

    const tight = runBacktest(pricesA, pricesB, 'A/B', { ...defaultConfig, entryZ: 1.0 });
    const loose = runBacktest(pricesA, pricesB, 'A/B', { ...defaultConfig, entryZ: 3.0 });

    // Tighter entry should generate more trades
    expect(tight.totalTrades).toBeGreaterThanOrEqual(loose.totalTrades);
  });

  it('should produce correct trade directions', () => {
    const { pricesA, pricesB } = generateCointegrated(2000);
    const report = runBacktest(pricesA, pricesB, 'A/B', defaultConfig);

    for (const trade of report.trades) {
      expect(['SHORT_SPREAD', 'LONG_SPREAD']).toContain(trade.direction);
    }
  });

  it('should calculate average bars held', () => {
    const { pricesA, pricesB } = generateCointegrated(2000);
    const report = runBacktest(pricesA, pricesB, 'A/B', defaultConfig);

    if (report.totalTrades > 0) {
      expect(report.avgBarsHeld).toBeGreaterThan(0);
    }
  });
});
