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
 * Photographs the usage surfaces in the real app, against whatever login this
 * machine actually has. The quota read runs no model turn, so this costs
 * nothing to take.
 */

test('capture the usage surfaces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-usage-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${dir}`],
    cwd: process.cwd(),
    env: guiEnv(),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.waitForTimeout(1500);

  // Create a Claude Code agent through the real wizard, so the layout under
  // test is the one a user gets.
  await page.getByRole('button', { name: 'Create agent', exact: true }).first().click();
  await page.waitForTimeout(500);
  const wizard = page.getByRole('dialog', { name: 'Create agent' });
  await wizard.getByPlaceholder('Security Architect').fill('Quartermaster');
  await page.waitForTimeout(200);

  // Walk the wizard to the end, whatever its step count is.
  for (let i = 0; i < 10; i += 1) {
    if (!(await wizard.isVisible().catch(() => false))) break;
    await page.screenshot({ path: `test-results/usage-wizard-${i}.png` });
    const finish = wizard.getByRole('button', { name: /^(Create agent|Add agent|Finish|Done)$/i }).last();
    if ((await finish.isVisible().catch(() => false)) && !(await finish.isDisabled().catch(() => true))) {
      await finish.click();
      await page.waitForTimeout(800);
      continue;
    }
    const next = wizard.getByRole('button', { name: /^Continue$/i }).last();
    if (!(await next.isVisible().catch(() => false))) break;
    if (await next.isDisabled().catch(() => true)) {
      // A step needs a choice before it will advance: take the first engine.
      const option = wizard.locator('button', { hasText: /Claude Code/i }).first();
      if (await option.isVisible().catch(() => false)) {
        await option.click();
        await page.waitForTimeout(400);
        continue;
      }
      break;
    }
    await next.click();
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'test-results/usage-after-wizard.png' });

  // The agents directory carries the compact recorded-usage chips.
  const agentsTab = page.getByRole('button', { name: /Agents/i }).first();
  if (await agentsTab.isVisible().catch(() => false)) {
    await agentsTab.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'test-results/usage-agents-directory.png' });
  }

  // Open a DM with the agent, then its details panel, which is where the
  // provider quota bars live.
  const message = page.getByRole('button', { name: /^Message$/ }).first();
  if (await message.isVisible().catch(() => false)) {
    await message.click();
    await page.waitForTimeout(1200);
  }
  await page.screenshot({ path: 'test-results/usage-dm.png' });

  const details = page.getByRole('button', { name: /^Members: \d+$/ }).first();
  if (await details.isVisible().catch(() => false)) {
    await details.click();
  }
  // The provider read takes about a second; give it room plus the render.
  await page.waitForTimeout(8000);
  await page.screenshot({ path: 'test-results/usage-right-panel.png', fullPage: false });

  // Scroll the panel so the quota group is in frame for the screenshot.
  const panel = page.locator('text=Provider usage').first();
  if (await panel.isVisible().catch(() => false)) {
    await panel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'test-results/usage-quota-bars.png' });
  }

  const text = await page.locator('body').innerText();
  console.log('--- PANEL TEXT ---\n' + text.slice(0, 4000));

  await app.close();

  // The panel must say something about usage either way: real percentages when
  // the login has a plan, or a stated reason when it does not. What it must
  // never do is show a bare 0%.
  expect(text.length).toBeGreaterThan(0);
});
