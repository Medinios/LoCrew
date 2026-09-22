import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { databasePath, legacyUserDataDir } from '../../src/main/user-data';

const APP_DATA = join('C:', 'Users', 'someone', 'AppData', 'Roaming');
const existing = (...paths: string[]) => (path: string) => paths.includes(path);

describe('data folder across the rename to Locrew', () => {
  it('keeps using the AgentWorkspace folder when it holds a database', () => {
    const dir = join(APP_DATA, 'agent-workspace');
    expect(legacyUserDataDir(APP_DATA, existing(join(dir, 'agent-workspace.db')))).toBe(dir);
  });

  it('finds a packaged build folder too', () => {
    const dir = join(APP_DATA, 'Agent Workspace');
    expect(legacyUserDataDir(APP_DATA, existing(join(dir, 'agent-workspace.db')))).toBe(dir);
  });

  it('ignores an old folder with no database in it', () => {
    expect(legacyUserDataDir(APP_DATA, existing(join(APP_DATA, 'agent-workspace')))).toBeNull();
  });

  it('starts fresh installs on the new database name', () => {
    const dir = join(APP_DATA, 'Locrew');
    expect(databasePath(dir, existing())).toBe(join(dir, 'locrew.db'));
  });

  it('opens the existing database file under its old name', () => {
    const dir = join(APP_DATA, 'agent-workspace');
    const legacy = join(dir, 'agent-workspace.db');
    expect(databasePath(dir, existing(legacy))).toBe(legacy);
  });
});
