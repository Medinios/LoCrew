import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The database file of installs made before the app was renamed Locrew. */
export const LEGACY_DATABASE_FILE = 'agent-workspace.db';
export const DATABASE_FILE = 'locrew.db';

/** Data folders the app used while it was called AgentWorkspace: dev runs, then packaged builds. */
const LEGACY_FOLDERS = ['agent-workspace', 'Agent Workspace'];

/**
 * The data folder of an install made before the rename, if there is one.
 *
 * Locrew keeps using it rather than starting a new one: it holds the
 * database and, on Windows, the key that decrypts stored API keys (Chromium
 * keeps it in the folder's `Local State`). A fresh folder would look like
 * every agent, conversation and credential had been lost.
 */
export function legacyUserDataDir(
  appData: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const folder of LEGACY_FOLDERS) {
    const dir = join(appData, folder);
    if (exists(join(dir, LEGACY_DATABASE_FILE))) return dir;
  }
  return null;
}

/** The database in a data folder: the pre-rename file when there is one, otherwise the new name. */
export function databasePath(userData: string, exists: (path: string) => boolean = existsSync): string {
  const legacy = join(userData, LEGACY_DATABASE_FILE);
  return exists(legacy) ? legacy : join(userData, DATABASE_FILE);
}
