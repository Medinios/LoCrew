/**
 * Guards the typecheck itself.
 *
 * A script that edited tsconfig.node.json once stripped `/ ** /` out of every
 * glob while removing JSON comments, turning `src/main/**\/*.ts` into
 * `src/main*.ts`. The project silently dropped from ~30 files to 2, `npm run
 * typecheck` kept printing nothing, and a real signature mismatch in the Codex
 * adapter reached the running app.
 *
 * A passing typecheck is only worth something if it is actually looking at the
 * code, so that is what these assert.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface TsConfig {
  include?: string[];
  exclude?: string[];
}

function config(name: string): TsConfig {
  return JSON.parse(readFileSync(name, 'utf8')) as TsConfig;
}

/** Project files tsc resolves, excluding anything from node_modules. */
function projectFiles(project: string): string[] {
  let out: string;
  try {
    out = execFileSync(
      process.execPath,
      ['node_modules/typescript/lib/tsc.js', '-p', project, '--listFiles', '--noEmit'],
      {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
  } catch (error) {
    // A type error exits non-zero but still prints the file list, and this test
    // is about coverage rather than correctness — the typecheck script reports
    // the errors themselves.
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout !== 'string') throw error;
    out = stdout;
  }
  // Files under this checkout, whatever its folder is called. Compared
  // case-insensitively: Windows drive letters come back in either case.
  const root = `${process.cwd().replace(/\\/g, '/').toLowerCase()}/`;
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line && !line.includes('node_modules') && line.replace(/\\/g, '/').toLowerCase().startsWith(root),
    );
}

describe('typecheck coverage', () => {
  it('keeps recursive globs intact in every project', () => {
    for (const name of ['tsconfig.node.json', 'tsconfig.web.json', 'tsconfig.e2e.json']) {
      for (const pattern of config(name).include ?? []) {
        // A directory pattern must recurse. `src/main*.ts` matches almost
        // nothing and is the exact corruption this guards against.
        if (pattern.includes('/') && pattern.endsWith('.ts') && !pattern.endsWith('.d.ts')) {
          const isExplicitFile = !pattern.includes('*');
          if (!isExplicitFile) {
            expect(pattern, `${name}: "${pattern}" lost its recursive glob`).toContain('**/');
          }
        }
      }
    }
  });

  it('actually typechecks the main process', () => {
    const files = projectFiles('tsconfig.node.json');
    // Roughly one file per module; the real count is ~30. Anything near zero
    // means the project has been gutted again.
    expect(files.length).toBeGreaterThan(15);

    for (const expected of [
      'src/main/runtimes/codex.ts',
      'src/main/runtimes/claude-code.ts',
      'src/main/orchestrator/orchestrator.ts',
      'src/main/gateway/server.ts',
      'src/main/db/store.ts',
      'src/preload/index.ts',
    ]) {
      expect(
        files.some((file) => file.replace(/\\/g, '/').endsWith(expected)),
        `${expected} is not being typechecked`,
      ).toBe(true);
    }
  });

  it('actually typechecks the renderer', () => {
    const files = projectFiles('tsconfig.web.json');
    expect(files.length).toBeGreaterThan(15);

    for (const expected of [
      'src/renderer/src/App.tsx',
      'src/renderer/src/components/chat/MessageItem.tsx',
      'src/renderer/src/stores/app.ts',
    ]) {
      expect(
        files.some((file) => file.replace(/\\/g, '/').endsWith(expected)),
        `${expected} is not being typechecked`,
      ).toBe(true);
    }
  });
});
