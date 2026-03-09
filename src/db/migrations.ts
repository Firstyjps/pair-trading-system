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
  // Example future migration:
  // {
  //   version: 2,
  //   description: 'Add fee tracking columns to positions',
  //   up: (db) => {
  //     db.exec(`
  //       ALTER TABLE positions ADD COLUMN leg_a_fee REAL DEFAULT 0;
  //       ALTER TABLE positions ADD COLUMN leg_b_fee REAL DEFAULT 0;
  //     `);
  //   },
  // },
];

export function runMigrations(db: Database.Database): void {
  const currentVersion = getCurrentVersion(db);

  const pending = migrations.filter(m => m.version > currentVersion);
  if (pending.length === 0) {
    log.debug({ currentVersion }, 'No pending migrations');
    return;
  }

  log.info({ currentVersion, pendingCount: pending.length }, 'Running migrations');

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
