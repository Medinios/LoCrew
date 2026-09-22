import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

/** Electron env without ELECTRON_RUN_AS_NODE, which would start it in Node mode. */
function guiEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE') continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Drives the app far enough to photograph the screens that are easy to get
 * wrong, and asserts the editor actually round-trips a change.
 */
test('capture the crew screens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-shot-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${dir}`],
    cwd: process.cwd(),
    env: guiEnv(),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.waitForTimeout(1200);

  await page.screenshot({ path: 'test-results/shot-shell.png' });

  // Create a crew member through the wizard, skipping the live runtime probe by
  // seeding the store directly would hide layout bugs, so use the real UI.
  await page.getByRole('button', { name: 'Create agent', exact: true }).first().click();
  await page.waitForTimeout(400);

  const wizard = page.getByRole('dialog', { name: 'Create agent' });
  await wizard.getByPlaceholder('Security Architect').fill('Blackbeard');
  await wizard.screenshot({ path: 'test-results/shot-picker.png' });
  await wizard.getByRole('button', { name: 'Continue' }).click();
  await page.waitForTimeout(400);
  await wizard.screenshot({ path: 'test-results/shot-engine.png' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // The wizard needs a live runtime to finish, so seed one agent for the editor.
  await page.evaluate(async () => {
    await (
      window as unknown as { api: { invoke(c: string, p: unknown): Promise<unknown> } }
    ).api.invoke('agents:create', {
      name: 'Blackbeard',
      runtimeType: 'claude-code',
      avatar: 'blackbeard',
      avatarColor: '#C9A227',
      workingDirectory: 'D:\\Dev\\AgentWorkspace',
      permissions: {
        workspaceAccess: 'approval_required',
        allowAgentToAgent: true,
        allowTaskUpdates: true,
        maxCostPerExecutionUsd: 2,
      },
      config: { maxTurnsPerExecution: 24, timeoutMs: 600000 },
    });
  });
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForTimeout(1200);

  // Agents are edited from the Agents view; the sidebar row opens the DM.
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Blackbeard' }).click();
  await page.waitForTimeout(500);

  const editor = page.getByRole('dialog');
  await expect(editor.getByText('Edit Blackbeard')).toBeVisible();
  await editor.screenshot({ path: 'test-results/shot-editor.png' });

  // A real round-trip: change the name and confirm it survives.
  const nameField = editor.getByRole('textbox').first();
  await nameField.fill('Captain Blackbeard');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForTimeout(800);

  await expect(page.getByText('Captain Blackbeard').first()).toBeVisible();

  await app.close();
});
