import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { TradingQueries } from '../../src/db/queries.js';
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { PairPosition, Signal } from '../../src/types.js';
import fs from 'fs';
import path from 'path';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '..', 'data', 'test');

function getTestDbPath() {
  return path.join(TEST_DB_DIR, `test-${uuid()}.db`);
}

function makePosition(overrides: Partial<PairPosition> = {}): PairPosition {
  return {
    id: uuid(),
    pair: 'HMSTR/BABY',
    direction: 'SHORT_SPREAD',
    state: 'PENDING',
    leg_a_symbol: 'HMSTR-USDT-SWAP',
    leg_a_side: 'sell',
    leg_a_size: 100,
    leg_a_entry_price: null,
    leg_a_order_id: null,
    leg_b_symbol: 'BABY-USDT-SWAP',
    leg_b_side: 'buy',
    leg_b_size: 200,
    leg_b_entry_price: null,
    leg_b_order_id: null,
    entry_z_score: 2.5,
    entry_spread: 0.15,
    current_z_score: null,
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
    ...overrides,
  };
}

describe('Database Schema', () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDbPath();
    db = initializeDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('should create all required tables', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('positions');
    expect(tableNames).toContain('signals');
    expect(tableNames).toContain('z_score_history');
    expect(tableNames).toContain('config_history');
    expect(tableNames).toContain('notifications');
    expect(tableNames).toContain('backtest_results');
    expect(tableNames).toContain('ohlcv_cache');
    expect(tableNames).toContain('schema_version');
  });

  it('should set WAL journal mode', () => {
    const result = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe('wal');
  });

  it('should track schema version', () => {
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(1);
  });

  it('should be idempotent — re-initializing same path works', () => {
    db.close();
    const db2 = initializeDatabase(dbPath);
    const row = db2.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(1);
    db2.close();
    db = initializeDatabase(dbPath); // for afterEach
  });

  it('should create data directory if not exists', () => {
    const newDir = path.join(TEST_DB_DIR, 'nested', uuid());
    const newPath = path.join(newDir, 'test.db');
    const newDb = initializeDatabase(newPath);
    expect(fs.existsSync(newDir)).toBe(true);
    newDb.close();
    fs.unlinkSync(newPath);
    fs.rmdirSync(newDir);
    fs.rmdirSync(path.dirname(newDir));
  });

  it('should enforce position state CHECK constraint', () => {
    const pos = makePosition({ state: 'PENDING' });
    const queries = new TradingQueries(db);
    queries.insertPosition(pos);

    expect(() => {
      db.prepare("UPDATE positions SET state = 'INVALID' WHERE id = ?").run(pos.id);
    }).toThrow();
  });

  it('should enforce direction CHECK constraint', () => {
    expect(() => {
      const pos = makePosition();
      db.prepare(`
        INSERT INTO positions (id, pair, direction, state, leg_a_symbol, leg_a_side, leg_a_size, leg_b_symbol, leg_b_side, leg_b_size,
          entry_z_score, entry_spread, stop_loss_z, take_profit_z, leverage, margin_per_leg, signal_id, group_id, opened_at)
        VALUES (?, ?, 'INVALID', 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pos.id, pos.pair, pos.leg_a_symbol, pos.leg_a_side, pos.leg_a_size,
        pos.leg_b_symbol, pos.leg_b_side, pos.leg_b_size,
        pos.entry_z_score, pos.entry_spread, pos.stop_loss_z, pos.take_profit_z,
        pos.leverage, pos.margin_per_leg, pos.signal_id, pos.group_id, pos.opened_at
      );
    }).toThrow();
  });
});

describe('TradingQueries — Positions', () => {
  let db: Database.Database;
  let queries: TradingQueries;
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDbPath();
    db = initializeDatabase(dbPath);
    queries = new TradingQueries(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('should insert and retrieve a position', () => {
    const pos = makePosition();
    queries.insertPosition(pos);

    const retrieved = queries.getPosition(pos.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.pair).toBe('HMSTR/BABY');
    expect(retrieved!.state).toBe('PENDING');
  });

  it('should update position state with additional fields', () => {
    const pos = makePosition();
    queries.insertPosition(pos);

    queries.updatePositionState(pos.id, 'LEG_A_OPEN', {
      leg_a_order_id: 'order-123',
      leg_a_entry_price: 0.05,
    });

    const updated = queries.getPosition(pos.id);
    expect(updated!.state).toBe('LEG_A_OPEN');
    expect(updated!.leg_a_order_id).toBe('order-123');
    expect(updated!.leg_a_entry_price).toBe(0.05);
  });

  it('should track full position lifecycle: PENDING -> ... -> CLOSED', () => {
    const pos = makePosition();
    queries.insertPosition(pos);

    queries.updatePositionState(pos.id, 'LEG_A_OPEN', { leg_a_order_id: 'A1' });
    queries.updatePositionState(pos.id, 'BOTH_LEGS_OPEN', { leg_b_order_id: 'B1' });
    queries.updatePositionState(pos.id, 'CLOSING');
    queries.updatePositionState(pos.id, 'CLOSED', {
      pnl: 15.5,
      closed_at: new Date().toISOString(),
      close_reason: 'TP',
    });

    const final = queries.getPosition(pos.id);
    expect(final!.state).toBe('CLOSED');
    expect(final!.pnl).toBe(15.5);
    expect(final!.close_reason).toBe('TP');
    expect(final!.closed_at).toBeDefined();
  });

  it('should return only open positions (not CLOSED or ERROR)', () => {
    const p1 = makePosition({ pair: 'A/B' });
    const p2 = makePosition({ pair: 'C/D', state: 'BOTH_LEGS_OPEN' });
    const p3 = makePosition({ pair: 'E/F', state: 'CLOSED' });
    queries.insertPosition(p1);
    queries.insertPosition(p2);
    queries.insertPosition(p3);

    const open = queries.getOpenPositions();
    expect(open.length).toBe(2);
    expect(open.map(p => p.pair)).toContain('A/B');
    expect(open.map(p => p.pair)).toContain('C/D');
    expect(open.map(p => p.pair)).not.toContain('E/F');
  });

  it('should detect open positions by pair', () => {
    const pos = makePosition({ pair: 'BTC/ETH', state: 'BOTH_LEGS_OPEN' });
    queries.insertPosition(pos);

    expect(queries.hasOpenPosition('BTC/ETH')).toBe(true);
    expect(queries.hasOpenPosition('DOGE/SHIB')).toBe(false);
  });

  it('should get last closed time', () => {
    const closedAt = new Date(Date.now() - 30000).toISOString();
    const pos = makePosition({ pair: 'A/B', state: 'CLOSED', closed_at: closedAt });
    queries.insertPosition(pos);

    const lastClosed = queries.getLastClosedTime('A/B');
    expect(lastClosed).toBeDefined();
    expect(Math.abs(lastClosed! - new Date(closedAt).getTime())).toBeLessThan(1000);

    expect(queries.getLastClosedTime('X/Y')).toBeNull();
  });

  it('should check group ID usage', () => {
    const groupId = uuid();
    const pos = makePosition({ group_id: groupId });
    queries.insertPosition(pos);

    expect(queries.isGroupIdUsed(groupId)).toBe(true);
    expect(queries.isGroupIdUsed(uuid())).toBe(false);
  });

  it('should count open positions', () => {
    queries.insertPosition(makePosition({ state: 'PENDING' }));
    queries.insertPosition(makePosition({ state: 'BOTH_LEGS_OPEN' }));
    queries.insertPosition(makePosition({ state: 'CLOSED' }));

    expect(queries.getOpenPositionCount()).toBe(2);
  });

  it('should calculate realized PnL', () => {
    queries.insertPosition(makePosition({ state: 'CLOSED', pnl: 10 }));
    queries.insertPosition(makePosition({ state: 'CLOSED', pnl: -5 }));
    queries.insertPosition(makePosition({ state: 'CLOSED', pnl: 20 }));
    queries.insertPosition(makePosition({ state: 'BOTH_LEGS_OPEN', pnl: null }));

    const pnl = queries.getRealizedPnl();
    expect(pnl.total).toBe(25);
    expect(pnl.count).toBe(3);
    expect(pnl.wins).toBe(2);
    expect(pnl.losses).toBe(1);
  });

  it('should find recently closed pairs', () => {
    const recentClose = new Date(Date.now() - 60000).toISOString(); // 1 min ago
    const oldClose = new Date(Date.now() - 7200000).toISOString(); // 2 hrs ago
    queries.insertPosition(makePosition({ pair: 'A/B', state: 'CLOSED', closed_at: recentClose }));
    queries.insertPosition(makePosition({ pair: 'C/D', state: 'CLOSED', closed_at: oldClose }));

    const recent = queries.getRecentlyClosedPairs(3600000); // within 1 hour
    expect(recent).toContain('A/B');
    expect(recent).not.toContain('C/D');
  });

  // Persistence test — simulate kill/restart
  it('should survive process restart (DB persistence)', () => {
    const pos = makePosition({ state: 'BOTH_LEGS_OPEN' });
    queries.insertPosition(pos);
    queries.updatePositionState(pos.id, 'BOTH_LEGS_OPEN', {
      leg_a_order_id: 'A1',
      leg_b_order_id: 'B1',
    });

    // Close the database (simulates process kill)
    db.close();

    // Re-open (simulates restart)
    const db2 = initializeDatabase(dbPath);
    const queries2 = new TradingQueries(db2);

    const restored = queries2.getPosition(pos.id);
    expect(restored).toBeDefined();
    expect(restored!.state).toBe('BOTH_LEGS_OPEN');
    expect(restored!.leg_a_order_id).toBe('A1');
    expect(restored!.leg_b_order_id).toBe('B1');

    const openPositions = queries2.getOpenPositions();
    expect(openPositions.length).toBe(1);

    db2.close();
    // Re-open for afterEach
    db = initializeDatabase(dbPath);
  });
});

describe('TradingQueries — Signals', () => {
  let db: Database.Database;
  let queries: TradingQueries;
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDbPath();
    db = initializeDatabase(dbPath);
    queries = new TradingQueries(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('should insert and retrieve signals', () => {
    const signal: Signal = {
      id: uuid(),
      pair: 'BTC/ETH',
      direction: 'SHORT_SPREAD',
      z_score: 2.5,
      spread: 0.1,
      correlation: 0.85,
      cointegration_pvalue: 0.03,
      half_life: 24,
      created_at: new Date().toISOString(),
      acted_on: false,
    };

    queries.insertSignal(signal);
    const unacted = queries.getUnactedSignals();
    expect(unacted.length).toBe(1);
    expect(unacted[0].pair).toBe('BTC/ETH');
    expect(unacted[0].acted_on).toBe(false);
  });

  it('should mark signal as acted on', () => {
    const signal: Signal = {
      id: uuid(),
      pair: 'A/B',
      direction: 'LONG_SPREAD',
      z_score: -2.1,
      spread: -0.05,
      correlation: 0.9,
      cointegration_pvalue: 0.01,
      half_life: 48,
      created_at: new Date().toISOString(),
      acted_on: false,
    };

    queries.insertSignal(signal);
    queries.markSignalActedOn(signal.id);

    const unacted = queries.getUnactedSignals();
    expect(unacted.length).toBe(0);
  });
});

describe('TradingQueries — Notifications', () => {
  let db: Database.Database;
  let queries: TradingQueries;
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDbPath();
    db = initializeDatabase(dbPath);
    queries = new TradingQueries(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('should detect recent notifications by dedup key', () => {
    queries.insertNotification({
      id: uuid(),
      type: 'SIGNAL',
      message: 'Test',
      dedup_key: 'BTC/ETH:SIGNAL:12345',
      sent_at: new Date().toISOString(),
    });

    expect(queries.hasRecentNotification('BTC/ETH:SIGNAL:12345', 300000)).toBe(true);
    expect(queries.hasRecentNotification('OTHER:KEY', 300000)).toBe(false);
  });

  it('should clean old notifications', () => {
    const oldTime = new Date(Date.now() - 86400000).toISOString(); // 24h ago
    queries.insertNotification({
      id: uuid(),
      type: 'SIGNAL',
      message: 'Old',
      dedup_key: 'old-key',
      sent_at: oldTime,
    });
    queries.insertNotification({
      id: uuid(),
      type: 'SIGNAL',
      message: 'New',
      dedup_key: 'new-key',
      sent_at: new Date().toISOString(),
    });

    const cleaned = queries.cleanOldNotifications(3600000); // older than 1h
    expect(cleaned).toBe(1);
  });
});

describe('TradingQueries — OHLCV Cache', () => {
  let db: Database.Database;
  let queries: TradingQueries;
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDbPath();
    db = initializeDatabase(dbPath);
    queries = new TradingQueries(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('should cache and retrieve OHLCV data', () => {
    const candles = [
      { timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      { timestamp: 2000, open: 1.5, high: 3, low: 1, close: 2.5, volume: 200 },
    ];

    queries.upsertOHLCV('BTC-USDT-SWAP', '1h', candles);

    const retrieved = queries.getOHLCV('BTC-USDT-SWAP', '1h');
    expect(retrieved.length).toBe(2);
    expect(retrieved[0].open).toBe(1);
    expect(retrieved[1].close).toBe(2.5);
  });

  it('should upsert (replace) existing candles', () => {
    const candle1 = [{ timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }];
    const candle2 = [{ timestamp: 1000, open: 1.1, high: 2.1, low: 0.6, close: 1.6, volume: 150 }];

    queries.upsertOHLCV('BTC-USDT-SWAP', '1h', candle1);
    queries.upsertOHLCV('BTC-USDT-SWAP', '1h', candle2);

    const retrieved = queries.getOHLCV('BTC-USDT-SWAP', '1h');
    expect(retrieved.length).toBe(1);
    expect(retrieved[0].open).toBe(1.1);
  });

  it('should filter OHLCV by since timestamp', () => {
    const candles = [
      { timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      { timestamp: 2000, open: 1.5, high: 3, low: 1, close: 2.5, volume: 200 },
      { timestamp: 3000, open: 2.5, high: 4, low: 2, close: 3.5, volume: 300 },
    ];

    queries.upsertOHLCV('ETH-USDT-SWAP', '4h', candles);

    const filtered = queries.getOHLCV('ETH-USDT-SWAP', '4h', 2000);
    expect(filtered.length).toBe(2);
    expect(filtered[0].timestamp).toBe(2000);
  });
});

describe('TradingQueries — Transactions', () => {
  let db: Database.Database;
  let queries: TradingQueries;
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDbPath();
    db = initializeDatabase(dbPath);
    queries = new TradingQueries(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('should rollback transaction on error', () => {
    const pos1 = makePosition({ pair: 'A/B' });

    expect(() => {
      queries.runInTransaction(() => {
        queries.insertPosition(pos1);
        throw new Error('Simulated error');
      });
    }).toThrow('Simulated error');

    expect(queries.getPosition(pos1.id)).toBeUndefined();
  });

  it('should commit transaction on success', () => {
    const pos1 = makePosition({ pair: 'A/B' });
    const pos2 = makePosition({ pair: 'C/D' });

    queries.runInTransaction(() => {
      queries.insertPosition(pos1);
      queries.insertPosition(pos2);
    });

    expect(queries.getPosition(pos1.id)).toBeDefined();
    expect(queries.getPosition(pos2.id)).toBeDefined();
  });
});
