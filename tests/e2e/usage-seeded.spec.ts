import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const require = createRequire(join(process.cwd(), 'package.json'));

/** Seed a synthetic profile under Electron's Node ABI, which better-sqlite3 uses. */
function seedProfile(dir: string): void {
  const binary = require('electron') as string;
  execFileSync(binary, [join(process.cwd(), 'tests/e2e/fixtures/seed-usage.cjs'), dir], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'pipe',
  });
}

test('shows nonzero measured spend alongside legacy and unpriced usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'locrew-usage-seeded-'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    seedProfile(dir);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) env[key] = value;
    }
    app = await electron.launch({ args: ['.', `--user-data-dir=${dir}`], cwd: process.cwd(), env });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Members: 4' }).waitFor();

    await page.getByRole('button', { name: 'Agents', exact: true }).first().click();
    // Scope to the directory row, not the name wherever it appears: an agent's
    // name is also rendered in the sidebar, and an unscoped match hits both.
    const row = (name: string) => page.locator('div.group').filter({ hasText: name });
    const codex = row('Measured Codex');
    const claude = row('Legacy Claude');
    const model = row('Unpriced Model');
    await expect(codex).toContainText(/Today\s*\$1\.25/);
    await expect(codex).toContainText(/7d\s*\$1\.25/);
    await expect(claude).toContainText(/Today\s*not measured/);
    await expect(model).toContainText(/Today\s*1\.2k tok/);

    await page.getByRole('button', { name: 'usage-fixture', exact: true }).first().click();
    await page.getByRole('button', { name: 'Members: 4' }).click();
    const spend = page.getByRole('button', { name: 'Spend', exact: true }).locator('xpath=../..');
    await expect(spend).toContainText(/This channel\s*\+\$1\.25/);
    await expect(spend).toContainText(/Last 24 hours\s*\+\$1\.25/);
    await expect(spend).toContainText(/All time\s*\+\$1\.25/);
  } finally {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
