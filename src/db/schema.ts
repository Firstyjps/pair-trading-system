import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger.js';

const SCHEMA_VERSION = 1;

const TABLES_SQL = `
-- Position state machine: PENDING -> LEG_A_OPEN -> BOTH_LEGS_OPEN -> CLOSING -> CLOSED | ERROR
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  pair TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('SHORT_SPREAD', 'LONG_SPREAD')),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING', 'LEG_A_OPEN', 'BOTH_LEGS_OPEN', 'CLOSING', 'CLOSED', 'ERROR')),
  leg_a_symbol TEXT NOT NULL,
  leg_a_side TEXT NOT NULL CHECK(leg_a_side IN ('buy', 'sell')),
  leg_a_size REAL NOT NULL,
  leg_a_entry_price REAL,
  leg_a_order_id TEXT,
  leg_b_symbol TEXT NOT NULL,
  leg_b_side TEXT NOT NULL CHECK(leg_b_side IN ('buy', 'sell')),
  leg_b_size REAL NOT NULL,
  leg_b_entry_price REAL,
  leg_b_order_id TEXT,
  entry_z_score REAL NOT NULL,
  entry_spread REAL NOT NULL,
  current_z_score REAL,
  stop_loss_z REAL NOT NULL,
  take_profit_z REAL NOT NULL,
  leverage INTEGER NOT NULL DEFAULT 5,
  margin_per_leg REAL NOT NULL,
  pnl REAL,
  signal_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT CHECK(close_reason IN ('TP', 'SL', 'MANUAL', 'ORPHAN', 'ERROR') OR close_reason IS NULL),
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  z_score REAL NOT NULL,
  spread REAL NOT NULL,
  correlation REAL NOT NULL,
  cointegration_pvalue REAL NOT NULL,
  half_life REAL NOT NULL,
  created_at TEXT NOT NULL,
  acted_on INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS z_score_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair TEXT NOT NULL,
  z_score REAL NOT NULL,
  spread REAL NOT NULL,
  price_a REAL NOT NULL,
  price_b REAL NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_json TEXT NOT NULL,
  backtest_rank INTEGER,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_json TEXT NOT NULL,
  pair TEXT,
  total_trades INTEGER,
  win_rate REAL,
  sharpe_ratio REAL,
  max_drawdown REAL,
  total_pnl REAL,
  rank INTEGER,
  tested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ohlcv_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
`;

const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_positions_pair_state ON positions(pair, state);
CREATE INDEX IF NOT EXISTS idx_positions_group_id ON positions(group_id);
CREATE INDEX IF NOT EXISTS idx_positions_signal_id ON positions(signal_id);
CREATE INDEX IF NOT EXISTS idx_positions_state ON positions(state);
CREATE INDEX IF NOT EXISTS idx_signals_pair ON signals(pair, created_at);
CREATE INDEX IF NOT EXISTS idx_signals_acted ON signals(acted_on);
CREATE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(dedup_key);
CREATE INDEX IF NOT EXISTS idx_z_history_pair ON z_score_history(pair, timestamp);
CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_tf ON ohlcv_cache(symbol, timeframe, timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ohlcv_unique ON ohlcv_cache(symbol, timeframe, timestamp);
`;

export function initializeDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Performance settings for SQLite
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Run schema creation in a transaction
  db.transaction(() => {
    db.exec(TABLES_SQL);
    db.exec(INDEXES_SQL);

    // Track schema version
    const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    if (!versionRow) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
      logger.info({ version: SCHEMA_VERSION }, 'Database schema initialized');
    } else if (versionRow.version < SCHEMA_VERSION) {
      // Future migrations go here
      db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
      logger.info({ from: versionRow.version, to: SCHEMA_VERSION }, 'Database schema migrated');
    }
  })();

  logger.info({ path: dbPath }, 'Database initialized');
  return db;
}

export type { Database };
