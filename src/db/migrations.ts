import type Database from 'better-sqlite3';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('migrations');

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

// Add future migrations here
const migrations: Migration[] = [
  {
    version: 2,
    description: 'Add alerts table + metadata columns for partial TP',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS alerts (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          type TEXT NOT NULL,
          pair TEXT,
          target_value REAL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_alerts_chat_pair ON alerts(chat_id, pair);
      `);
    },
  },
];

/**
 * Run pending database migrations.
 *
 * IMPORTANT: Back up the database file (e.g. `cp data/trading.db data/trading.db.bak`)
 * before running migrations or deploying a new version.
 */
export function runMigrations(db: Database.Database): void {
  const currentVersion = getCurrentVersion(db);

  const pending = migrations.filter(m => m.version > currentVersion);
  if (pending.length === 0) {
    log.debug({ currentVersion }, 'No pending migrations');
    return;
  }

  log.info({ currentVersion, pendingCount: pending.length }, 'Running migrations — ensure you have a DB backup before proceeding');

  for (const migration of pending.sort((a, b) => a.version - b.version)) {
    db.transaction(() => {
      log.info({ version: migration.version, description: migration.description }, 'Applying migration');
      migration.up(db);
      db.prepare('UPDATE schema_version SET version = ?').run(migration.version);
    })();
    log.info({ version: migration.version }, 'Migration applied');
  }
}

function getCurrentVersion(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}
