import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

/**
 * better-sqlite3 is a native CommonJS addon. Electron's ESM loader cannot
 * preparse it, so it is loaded through createRequire rather than imported.
 */
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenDbResult {
  db: Db;
  sqlite: DatabaseType.Database;
  close(): void;
}

/**
 * Opens (and if needed creates) the local SQLite database.
 *
 * `migrationsFolder` is resolved by the caller because its location differs
 * between `electron-vite dev` and a packaged app.
 */
export function openDatabase(dbPath: string, migrationsFolder: string): OpenDbResult {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);
  // WAL keeps the UI responsive while an execution writes its event stream.
  if (dbPath !== ':memory:') sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}

export { schema };
