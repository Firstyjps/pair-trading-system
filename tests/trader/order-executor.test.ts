import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executePairTrade, closePairPosition, type FullExchangeAdapter } from '../../src/trader/order-executor.js';
import { TradingQueries } from '../../src/db/queries.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { resetConfigForTesting, loadTradingConfig } from '../../src/config.js';
import type Database from 'better-sqlite3';
import type { OrderParams } from '../../src/types.js';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '..', 'data', 'test');

function createMockExchange(overrides?: Partial<FullExchangeAdapter>): FullExchangeAdapter {
  return {
    createOrder: async (params: OrderParams) => ({
      success: true,
      orderId: `order-${uuid().slice(0, 8)}`,
      avgPrice: params.price ?? 100,
    }),
    setLeverage: async () => {},
    getPosition: async () => null,
    closePosition: async () => ({ success: true, orderId: `close-${uuid().slice(0, 8)}`, avgPrice: 100 }),
    getContractSize: async () => 0.1,
    ...overrides,
  };
}

describe('executePairTrade', () => {
  let db: Database.Database;
  let queries: TradingQueries;
  let dbPath: string;

  beforeEach(() => {
    resetConfigForTesting();
    loadTradingConfig();
    dbPath = path.join(TEST_DB_DIR, `test-exec-${uuid()}.db`);
    db = initializeDatabase(dbPath);
    queries = new TradingQueries(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  const legA: OrderParams = {
    instrument: 'BTC-USDT-SWAP',
    side: 'sell',
    size: 10,
    leverage: 5,
  };
  const legB: OrderParams = {
    instrument: 'ETH-USDT-SWAP',
    side: 'buy',
    size: 100,
    leverage: 5,
  };

  it('should execute both legs successfully', async () => {
    const exchange = createMockExchange();
    const result = await executePairTrade(
      exchange, queries, legA, legB,
      'SHORT_SPREAD', 2.3, 0.15, uuid(), uuid(),
    );

    expect(result.success).toBe(true);
    expect(result.positionId).toBeDefined();

    const pos = queries.getPosition(result.positionId!);
    expect(pos!.state).toBe('BOTH_LEGS_OPEN');
    expect(pos!.leg_a_order_id).toBeDefined();
    expect(pos!.leg_b_order_id).toBeDefined();
  });

  it('should rollback Leg A when Leg B fails', async () => {
    let rollbackCalled = false;
    const exchange = createMockExchange({
      createOrder: async (params) => {
        if (params.instrument === 'ETH-USDT-SWAP') {
          return { success: false, error: 'Insufficient margin' };
        }
        return { success: true, orderId: `order-A`, avgPrice: 50000 };
      },
      closePosition: async () => {
        rollbackCalled = true;
        return { success: true };
      },
    });

    const result = await executePairTrade(
      exchange, queries, legA, legB,
      'SHORT_SPREAD', 2.3, 0.15, uuid(), uuid(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Leg B failed');
    expect(rollbackCalled).toBe(true);

    // Position should be in ERROR state
    const positions = queries.getOpenPositions();
    expect(positions.length).toBe(0); // ERROR positions are filtered out
  });

  it('should accept trade at any Z (safe zone checked upstream in signal-generator)', async () => {
    // Safe zone is now enforced in signal-generator and pre-trade re-check,
    // not in executePairTrade itself
    const exchange = createMockExchange();
    const result = await executePairTrade(
      exchange, queries, legA, legB,
      'SHORT_SPREAD', 3.6, 0.15, uuid(), uuid(),
    );

    expect(result.success).toBe(true);
  });

  it('should reject invalid orders (Infinity size)', async () => {
    const exchange = createMockExchange();
    const badLeg: OrderParams = { ...legA, size: Infinity };
    const result = await executePairTrade(
      exchange, queries, badLeg, legB,
      'SHORT_SPREAD', 2.3, 0.15, uuid(), uuid(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Validation failed');
  });

  it('should reject NaN size', async () => {
    const exchange = createMockExchange();
    const badLeg: OrderParams = { ...legA, size: NaN };
    const result = await executePairTrade(
      exchange, queries, badLeg, legB,
      'SHORT_SPREAD', 2.3, 0.15, uuid(), uuid(),
    );

    expect(result.success).toBe(false);
  });

  it('should reject same instrument on both legs', async () => {
    const exchange = createMockExchange();
    const sameLeg: OrderParams = { ...legB, instrument: 'BTC-USDT-SWAP' };
    const result = await executePairTrade(
      exchange, queries, legA, sameLeg,
      'SHORT_SPREAD', 2.3, 0.15, uuid(), uuid(),
    );

    expect(result.success).toBe(false);
  });

  it('should persist position to DB even on Leg A failure', async () => {
    const exchange = createMockExchange({
      createOrder: async () => ({ success: false, error: 'Network error' }),
    });

    const result = await executePairTrade(
      exchange, queries, legA, legB,
      'SHORT_SPREAD', 2.3, 0.15, uuid(), uuid(),
    );

    expect(result.success).toBe(false);
    // Position should exist in DB as ERROR
    const allPositions = db.prepare('SELECT * FROM positions').all();
    expect(allPositions.length).toBe(1);
    expect((allPositions[0] as any).state).toBe('ERROR');
  });

  it('should handle exchange throwing exception', async () => {
    const exchange = createMockExchange({
      setLeverage: async () => { throw new Error('API timeout'); },
    });

    const result = await executePairTrade(
      exchange, queries, legA, legB,
      'SHORT_SPREAD', 2.3, 0.15, uuid(), uuid(),
    );

    expect(result.success).toBe(false);
  });

  it('should record rollback failure as orphan in metadata', async () => {
    const exchange = createMockExchange({
      createOrder: async (params) => {
        if (params.instrument === 'ETH-USDT-SWAP') {
          return { success: false, error: 'Insufficient margin' };
        }
        return { success: true, orderId: 'order-A', avgPrice: 50000 };
      },
      closePosition: async () => ({ success: false, error: 'Rollback failed' }),
      getPosition: async () => ({ size: 10, side: 'sell' }), // Still exists
    });

    const result = await executePairTrade(
      exchange, queries, legA, legB,
      'SHORT_SPREAD', 2.3, 0.15, uuid(), uuid(),
    );

    expect(result.success).toBe(false);

    const allPositions = db.prepare('SELECT * FROM positions').all();
    const pos = allPositions[0] as any;
    expect(pos.state).toBe('ERROR');
    const metadata = JSON.parse(pos.metadata);
    expect(metadata.rollback).toContain('FAILED');
  });
});

describe('closePairPosition', () => {
  let db: Database.Database;
  let queries: TradingQueries;
  let dbPath: string;

  beforeEach(() => {
    resetConfigForTesting();
    loadTradingConfig();
    dbPath = path.join(TEST_DB_DIR, `test-close-${uuid()}.db`);
    db = initializeDatabase(dbPath);
    queries = new TradingQueries(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('should close both legs and mark CLOSED', async () => {
    const exchange = createMockExchange();
    const posId = uuid();
    queries.insertPosition({
      id: posId, pair: 'BTC/ETH', direction: 'SHORT_SPREAD', state: 'BOTH_LEGS_OPEN',
      leg_a_symbol: 'BTC-USDT-SWAP', leg_a_side: 'sell', leg_a_size: 10,
      leg_a_entry_price: 50000, leg_a_order_id: 'A1',
      leg_b_symbol: 'ETH-USDT-SWAP', leg_b_side: 'buy', leg_b_size: 100,
      leg_b_entry_price: 3000, leg_b_order_id: 'B1',
      entry_z_score: 2.5, entry_spread: 0.15, current_z_score: 0.3,
      stop_loss_z: 3.5, take_profit_z: 0.5, leverage: 5, margin_per_leg: 300,
      pnl: null, signal_id: uuid(), group_id: uuid(),
      opened_at: new Date().toISOString(), closed_at: null, close_reason: null, metadata: null,
    });

    const pos = queries.getPosition(posId)!;
    const result = await closePairPosition(exchange, queries, pos, 'TP');

    expect(result.success).toBe(true);
    const closed = queries.getPosition(posId)!;
    expect(closed.state).toBe('CLOSED');
    expect(closed.close_reason).toBe('TP');
  });
});
