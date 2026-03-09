import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { calculateZScore, generateSignals, persistSignals } from '../../src/scanner/signal-generator.js';
import { TradingQueries } from '../../src/db/queries.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { resetConfigForTesting, loadTradingConfig } from '../../src/config.js';
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '..', 'data', 'test');

describe('calculateZScore', () => {
  it('should return 0 for constant prices', () => {
    const prices = Array(50).fill(100);
    const { zScore } = calculateZScore(prices, prices, 1);
    expect(zScore).toBe(0);
  });

  it('should detect positive Z-Score when spread widens', () => {
    const n = 100;
    const pricesA = Array.from({ length: n }, (_, i) => 100 + i * 0.1);
    const pricesB = Array.from({ length: n }, () => 100);
    // Last price much higher for A
    pricesA[n - 1] = 120;

    const { zScore } = calculateZScore(pricesA, pricesB, 1);
    expect(zScore).toBeGreaterThan(0);
  });

  it('should detect negative Z-Score when spread narrows', () => {
    const n = 100;
    const pricesA = Array.from({ length: n }, () => 100);
    const pricesB = Array.from({ length: n }, (_, i) => 100 + i * 0.1);
    // Last price of B jumps
    pricesB[n - 1] = 120;

    const { zScore } = calculateZScore(pricesA, pricesB, 1);
    expect(zScore).toBeLessThan(0);
  });

  it('should use beta in spread calculation', () => {
    const pricesA = Array.from({ length: 50 }, () => 100);
    const pricesB = Array.from({ length: 50 }, () => 50);
    const { spread } = calculateZScore(pricesA, pricesB, 2);
    // spread = log(100) - 2 * log(50) ≈ 4.605 - 2*3.912 = -3.219
    expect(spread).toBeCloseTo(Math.log(100) - 2 * Math.log(50), 5);
  });

  it('should return mean and std', () => {
    const pricesA = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 5);
    const pricesB = Array.from({ length: 50 }, () => 100);
    const { mean, std } = calculateZScore(pricesA, pricesB, 1);
    expect(typeof mean).toBe('number');
    expect(std).toBeGreaterThan(0);
  });
});

describe('generateSignals', () => {
  beforeEach(() => {
    resetConfigForTesting();
    loadTradingConfig();
  });

  it('should generate SHORT_SPREAD when Z > entry', () => {
    const n = 200;
    const pricesA = Array.from({ length: n }, () => 100);
    const pricesB = Array.from({ length: n }, () => 100);
    // Make last price very different to get high Z
    pricesA[n - 1] = 150; // A price jumps → spread increases → Z > 0

    const signals = generateSignals([{
      symbolA: 'A-USDT-SWAP',
      symbolB: 'B-USDT-SWAP',
      correlation: 0.9,
      coint: {
        symbolA: 'A-USDT-SWAP', symbolB: 'B-USDT-SWAP',
        beta: 1, pValue: 0.01, halfLife: 24,
        spread: [], spreadMean: 0, spreadStd: 1, isCointegrated: true,
      },
      pricesA,
      pricesB,
    }]);

    expect(signals.length).toBe(1);
    expect(signals[0].direction).toBe('SHORT_SPREAD');
  });

  it('should return empty when Z is within threshold', () => {
    const prices = Array.from({ length: 200 }, () => 100);

    const signals = generateSignals([{
      symbolA: 'A-USDT-SWAP',
      symbolB: 'B-USDT-SWAP',
      correlation: 0.9,
      coint: {
        symbolA: 'A-USDT-SWAP', symbolB: 'B-USDT-SWAP',
        beta: 1, pValue: 0.01, halfLife: 24,
        spread: [], spreadMean: 0, spreadStd: 1, isCointegrated: true,
      },
      pricesA: prices,
      pricesB: prices,
    }]);

    expect(signals.length).toBe(0);
  });
});

describe('persistSignals', () => {
  let db: Database.Database;
  let queries: TradingQueries;
  let dbPath: string;

  beforeEach(() => {
    resetConfigForTesting();
    loadTradingConfig();
    dbPath = path.join(TEST_DB_DIR, `test-sig-${uuid()}.db`);
    db = initializeDatabase(dbPath);
    queries = new TradingQueries(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('should persist signals to DB', () => {
    const candidates = [{
      symbolA: 'A-USDT-SWAP',
      symbolB: 'B-USDT-SWAP',
      direction: 'SHORT_SPREAD' as const,
      zScore: 2.5,
      spread: 0.1,
      correlation: 0.9,
      cointegrationPValue: 0.01,
      halfLife: 24,
    }];

    const persisted = persistSignals(queries, candidates);
    expect(persisted.length).toBe(1);

    const unacted = queries.getUnactedSignals();
    expect(unacted.length).toBe(1);
  });

  it('should deduplicate recent signals', () => {
    const candidates = [{
      symbolA: 'A-USDT-SWAP',
      symbolB: 'B-USDT-SWAP',
      direction: 'SHORT_SPREAD' as const,
      zScore: 2.5,
      spread: 0.1,
      correlation: 0.9,
      cointegrationPValue: 0.01,
      halfLife: 24,
    }];

    persistSignals(queries, candidates);
    const second = persistSignals(queries, candidates);
    expect(second.length).toBe(0); // Deduped
  });
});
