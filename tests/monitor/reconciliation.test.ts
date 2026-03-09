import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reconcile, type ReconciliationExchange, type ExchangePosition } from '../../src/monitor/reconciliation.js';
import { detectOrphans } from '../../src/monitor/orphan-detector.js';
import { TradingQueries } from '../../src/db/queries.js';
import { initializeDatabase } from '../../src/db/schema.js';
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '..', 'data', 'test');

function makeExchange(positions: ExchangePosition[]): ReconciliationExchange {
  return { fetchPositions: async () => positions };
}

function insertTestPosition(queries: TradingQueries, overrides: Record<string, any> = {}) {
  const defaults = {
    id: uuid(),
    pair: 'BTC/ETH',
    direction: 'SHORT_SPREAD',
    state: 'BOTH_LEGS_OPEN',
    leg_a_symbol: 'BTC-USDT-SWAP',
    leg_a_side: 'sell',
    leg_a_size: 10,
    leg_a_entry_price: 50000,
    leg_a_order_id: 'A1',
    leg_b_symbol: 'ETH-USDT-SWAP',
    leg_b_side: 'buy',
    leg_b_size: 100,
    leg_b_entry_price: 3000,
    leg_b_order_id: 'B1',
    entry_z_score: 2.5,
    entry_spread: 0.15,
    current_z_score: 2.0,
    stop_loss_z: 3.5,
    take_profit_z: 0.5,
    leverage: 5,
    margin_per_leg: 300,
    pnl: null,
    signal_id: uuid(),
    group_id: uuid(),
    opened_at: new Date().toISOString(),
    closed_at: null,
    close_reason: null,
    metadata: null,
  };
  const pos = { ...defaults, ...overrides };
  queries.insertPosition(pos as any);
  return pos;
}

describe('Reconciliation', () => {
  let db: Database.Database;
  let queries: TradingQueries;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(TEST_DB_DIR, `test-recon-${uuid()}.db`);
    db = initializeDatabase(dbPath);
    queries = new TradingQueries(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('should find no discrepancies when DB and exchange match', async () => {
    insertTestPosition(queries);
    const exchange = makeExchange([
      { symbol: 'BTC-USDT-SWAP', side: 'sell', size: 10, avgPrice: 50000, unrealizedPnl: 5 },
      { symbol: 'ETH-USDT-SWAP', side: 'buy', size: 100, avgPrice: 3000, unrealizedPnl: -2 },
    ]);

    const discrepancies = await reconcile(queries, exchange);
    expect(discrepancies.length).toBe(0);
  });

  it('should detect DB-only positions (exchange has no position)', async () => {
    insertTestPosition(queries);
    const exchange = makeExchange([]); // Exchange has nothing

    const discrepancies = await reconcile(queries, exchange);
    expect(discrepancies.some(d => d.type === 'DB_ONLY')).toBe(true);
  });

  it('should mark position CLOSED when both legs missing from exchange', async () => {
    const pos = insertTestPosition(queries);
    const exchange = makeExchange([]);

    await reconcile(queries, exchange);

    const updated = queries.getPosition(pos.id);
    expect(updated!.state).toBe('CLOSED');
    expect(updated!.close_reason).toBe('ORPHAN');
  });

  it('should detect exchange-only positions (no DB record)', async () => {
    const exchange = makeExchange([
      { symbol: 'DOGE-USDT-SWAP', side: 'buy', size: 500, avgPrice: 0.1, unrealizedPnl: 10 },
    ]);

    const discrepancies = await reconcile(queries, exchange);
    expect(discrepancies.some(d => d.type === 'EXCHANGE_ONLY')).toBe(true);
    expect(discrepancies.find(d => d.type === 'EXCHANGE_ONLY')!.symbol).toBe('DOGE-USDT-SWAP');
  });

  it('should NOT auto-close exchange positions based on DB mismatch', async () => {
    // Exchange has position, DB doesn't know about it
    const exchange = makeExchange([
      { symbol: 'DOGE-USDT-SWAP', side: 'buy', size: 500, avgPrice: 0.1, unrealizedPnl: 10 },
    ]);

    const discrepancies = await reconcile(queries, exchange);
    const exchOnly = discrepancies.find(d => d.type === 'EXCHANGE_ONLY');
    expect(exchOnly!.action).toContain('ALERT ONLY');
  });

  it('should skip PENDING positions', async () => {
    insertTestPosition(queries, { state: 'PENDING', leg_a_order_id: null, leg_b_order_id: null });
    const exchange = makeExchange([]);

    const discrepancies = await reconcile(queries, exchange);
    // Should not generate discrepancies for PENDING
    expect(discrepancies.filter(d => d.type === 'DB_ONLY').length).toBe(0);
  });

  it('should handle multiple positions correctly', async () => {
    insertTestPosition(queries, {
      pair: 'BTC/ETH',
      leg_a_symbol: 'BTC-USDT-SWAP',
      leg_b_symbol: 'ETH-USDT-SWAP',
    });
    insertTestPosition(queries, {
      pair: 'SOL/AVAX',
      leg_a_symbol: 'SOL-USDT-SWAP',
      leg_b_symbol: 'AVAX-USDT-SWAP',
    });

    const exchange = makeExchange([
      { symbol: 'BTC-USDT-SWAP', side: 'sell', size: 10, avgPrice: 50000, unrealizedPnl: 0 },
      { symbol: 'ETH-USDT-SWAP', side: 'buy', size: 100, avgPrice: 3000, unrealizedPnl: 0 },
      // SOL/AVAX missing from exchange
    ]);

    const discrepancies = await reconcile(queries, exchange);
    expect(discrepancies.some(d => d.symbol === 'SOL-USDT-SWAP')).toBe(true);
  });
});

describe('Orphan Detector', () => {
  let db: Database.Database;
  let queries: TradingQueries;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(TEST_DB_DIR, `test-orphan-${uuid()}.db`);
    db = initializeDatabase(dbPath);
    queries = new TradingQueries(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('should detect positions not tracked in DB', async () => {
    const exchange = makeExchange([
      { symbol: 'DOGE-USDT-SWAP', side: 'buy', size: 500, avgPrice: 0.1, unrealizedPnl: 10 },
    ]);

    const orphans = await detectOrphans(queries, exchange);
    expect(orphans.length).toBe(1);
    expect(orphans[0].symbol).toBe('DOGE-USDT-SWAP');
  });

  it('should not flag tracked positions as orphans', async () => {
    insertTestPosition(queries);
    const exchange = makeExchange([
      { symbol: 'BTC-USDT-SWAP', side: 'sell', size: 10, avgPrice: 50000, unrealizedPnl: 0 },
    ]);

    const orphans = await detectOrphans(queries, exchange);
    expect(orphans.length).toBe(0);
  });

  it('should skip zero-size positions', async () => {
    const exchange = makeExchange([
      { symbol: 'DOGE-USDT-SWAP', side: 'buy', size: 0, avgPrice: 0, unrealizedPnl: 0 },
    ]);

    const orphans = await detectOrphans(queries, exchange);
    expect(orphans.length).toBe(0);
  });

  it('should skip recently closed positions (anti-re-adopt)', async () => {
    // Create and close a position recently
    const pos = insertTestPosition(queries, {
      state: 'CLOSED',
      closed_at: new Date().toISOString(),
      close_reason: 'TP',
    });

    const exchange = makeExchange([
      { symbol: 'BTC-USDT-SWAP', side: 'sell', size: 10, avgPrice: 50000, unrealizedPnl: 0 },
    ]);

    const orphans = await detectOrphans(queries, exchange);
    expect(orphans.length).toBe(0); // Should skip recently closed
  });

  it('should return orphan details for manual review', async () => {
    const exchange = makeExchange([
      { symbol: 'XRP-USDT-SWAP', side: 'long', size: 1000, avgPrice: 0.5, unrealizedPnl: -15 },
    ]);

    const orphans = await detectOrphans(queries, exchange);
    expect(orphans[0].reason).toContain('No matching DB record');
    expect(orphans[0].size).toBe(1000);
    expect(orphans[0].unrealizedPnl).toBe(-15);
  });
});
