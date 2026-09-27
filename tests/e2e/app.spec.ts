/**
 * End-to-end tests that drive the real Electron application.
 *
 * These launch the built app (run `npm run build` first), so they cover the
 * whole stack: main process, preload bridge, IPC validation, SQLite and the
 * React renderer. No agent runtime is invoked, so they cost nothing to run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

/** Electron env without ELECTRON_RUN_AS_NODE, which would start it in Node mode. */
function guiEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE') continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

test.beforeAll(async () => {
  // A throwaway userData directory keeps each run isolated from the real app.
  userDataDir = mkdtempSync(join(tmpdir(), 'locrew-e2e-'));

  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd(),
    env: { ...guiEnv(), NODE_ENV: 'test' },
  });

  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test('launches and renders the workspace shell', async () => {
  await expect(page.getByText('LoCrew').first()).toBeVisible();
  await expect(page.getByPlaceholder('Search everything')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeVisible();
  await expect(page.getByText('Direct messages', { exact: true })).toBeVisible();
});

test('shows an empty state before any conversation exists', async () => {
  await expect(page.getByText('Welcome to LoCrew')).toBeVisible();
  await expect(page.getByText('Your local agent team.').first()).toBeVisible();
});

test('keeps Node out of the renderer', async () => {
  const exposure = await page.evaluate(() => ({
    hasRequire: typeof (globalThis as Record<string, unknown>)['require'] !== 'undefined',
    hasProcess: typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined',
    hasApi: typeof (globalThis as Record<string, unknown>)['api'] !== 'undefined',
  }));

  expect(exposure.hasRequire).toBe(false);
  expect(exposure.hasProcess).toBe(false);
  // The only bridge is the narrow preload API.
  expect(exposure.hasApi).toBe(true);
});

test('rejects an IPC channel that is not on the allowlist', async () => {
  const result = await page.evaluate(async () => {
    try {
      await (window as unknown as { api: { invoke(c: string): Promise<unknown> } }).api.invoke(
        'shell:executeAnything',
      );
      return 'allowed';
    } catch (error) {
      return (error as Error).message;
    }
  });

  expect(result).toContain('Unknown IPC channel');
});

test('rejects a malformed payload on a real channel', async () => {
  const result = await page.evaluate(async () => {
    try {
      await (
        window as unknown as { api: { invoke(c: string, p: unknown): Promise<unknown> } }
      ).api.invoke('messages:send', { conversationId: '', body: '' });
      return 'allowed';
    } catch (error) {
      return (error as Error).message;
    }
  });

  expect(result).toContain('Invalid payload');
});

test('opens the create-agent wizard and detects the local runtime', async () => {
  await page.getByRole('button', { name: 'Create agent', exact: true }).first().click();

  const wizard = page.getByRole('dialog', { name: 'Create agent' });
  await expect(wizard.getByText('Name & avatar', { exact: true })).toBeVisible();

  // Step 1 -> 2: identity, then the engine choices.
  await wizard.getByPlaceholder('Security Architect').fill('E2E Agent');
  await wizard.getByRole('button', { name: 'Continue' }).click();
  await expect(wizard.getByText('AI providers', { exact: true })).toBeVisible();
  await expect(wizard.getByText('No AI providers yet.', { exact: false })).toBeVisible();
  await expect(wizard.getByText('OpenAI Codex', { exact: true })).toBeVisible();
  await expect(wizard.getByText('Connect an A2A agent', { exact: true })).toBeVisible();

  // Choosing Claude Code runs the real install probe.
  await wizard.getByRole('button', { name: /^Claude Code/ }).click();
  await expect(
    wizard.getByText(/Looking for Claude Code|Claude Code found|Claude Code not found/),
  ).toBeVisible({ timeout: 90_000 });

  // "Add provider" opens Settings on top of the wizard; closing it returns here.
  await wizard.getByRole('button', { name: 'Add provider' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('heading', { name: 'AI Providers' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(wizard).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(wizard).toBeHidden();
});

test('creates a channel through the UI', async () => {
  await page.getByLabel('Create channel').click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Create a channel', { exact: true })).toBeVisible();

  await dialog.getByPlaceholder('development').fill('e2e-channel');
  await dialog.getByRole('button', { name: 'Create channel' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('heading', { name: 'e2e-channel' })).toBeVisible();
  await expect(page.getByPlaceholder('Message #e2e-channel')).toBeVisible();
});

test('gives a channel an icon from its settings', async () => {
  await page.getByRole('button', { name: 'Channel settings' }).click();
  const dialog = page.getByRole('dialog', { name: '#e2e-channel' });
  await dialog.getByRole('button', { name: 'Choose a channel icon' }).click();
  await dialog.getByRole('button', { name: '🚀', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  // The sidebar row and the header both show the icon instead of the hash.
  await expect(page.getByRole('button', { name: /e2e-channel/ }).first()).toContainText('🚀');
  await expect(page.locator('header').first()).toContainText('🚀');
});

test('finds messages in the open conversation', async () => {
  const composer = page.getByPlaceholder('Message #e2e-channel');
  for (const text of ['alpha release notes', 'beta checklist', 'alpha rollback plan']) {
    await composer.fill(text);
    await composer.press('Enter');
    await expect(page.locator('article').getByText(text, { exact: true })).toBeVisible();
  }

  await page.keyboard.press('Control+f');
  const find = page.getByLabel('Find in conversation');
  await expect(find).toBeFocused();
  await find.fill('alpha');
  // It starts on the newest match; Enter steps back to older ones and wraps.
  await expect(page.getByText('2 of 2', { exact: true })).toBeVisible();
  await find.press('Enter');
  await expect(page.getByText('1 of 2', { exact: true })).toBeVisible();
  await find.press('Enter');
  await expect(page.getByText('2 of 2', { exact: true })).toBeVisible();
  await find.press('Shift+Enter');
  await expect(page.getByText('1 of 2', { exact: true })).toBeVisible();

  await find.fill('nothing like this');
  await expect(page.getByText('No matches', { exact: true })).toBeVisible();

  await find.press('Escape');
  await expect(find).toBeHidden();
  await expect(page.getByRole('button', { name: /^Search this conversation/ })).toBeVisible();
});

test('sets the profile name and photo', async () => {
  await page.getByTitle('Profile and settings', { exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('heading', { name: 'Profile' })).toBeVisible();

  const name = settings.getByPlaceholder('Your name');
  await name.fill('Dana');
  await name.press('Enter');
  await expect(page.getByTitle('Profile and settings', { exact: true })).toContainText('Dana');

  // A wide image: the app crops it to a square and re-encodes it small.
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 300;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#d6453d';
    context.fillRect(0, 0, 600, 300);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await settings.getByLabel('Photo file').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });

  const sidebarPhoto = page.getByTitle('Profile and settings', { exact: true }).locator('img');
  await expect(sidebarPhoto).toBeVisible();
  const photo = await sidebarPhoto.evaluate((img: HTMLImageElement) => ({
    src: img.src.slice(0, 22),
    width: img.naturalWidth,
    height: img.naturalHeight,
  }));
  expect(photo).toEqual({ src: 'data:image/webp;base64', width: 256, height: 256 });
  await expect(settings.getByRole('button', { name: 'Remove photo' })).toBeVisible();

  // Clicking the portrait group's caption must not pick an option.
  await settings.getByText('Or choose a portrait', { exact: true }).click();
  await expect(sidebarPhoto).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
});

test('refuses a profile image that is not a raster image', async () => {
  const result = await page.evaluate(async () => {
    try {
      await (
        window as unknown as { api: { invoke(c: string, p: unknown): Promise<unknown> } }
      ).api.invoke('settings:update', {
        avatarImage: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
      });
      return 'allowed';
    } catch (error) {
      return (error as Error).message;
    }
  });

  expect(result).toContain('Invalid payload');
});

test('shows an About screen with the project links and credits', async () => {
  await page.getByRole('button', { name: /workspace menu/ }).click();
  await page.getByRole('menuitem', { name: /^About/ }).click();

  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByText(/^Version \d/)).toBeVisible();

  // The repository link points at the real project and opens outside the app.
  const source = settings.getByRole('link', { name: /Source code/ });
  await expect(source).toHaveAttribute('href', 'https://github.com/Medinios/LoCrew');
  await expect(source).toHaveAttribute('target', '_blank');

  // Discord has no invite yet, so it is shown but is not a link.
  await expect(settings.getByText('Coming soon')).toBeVisible();
  await expect(settings.getByRole('link', { name: /Discord/ })).toHaveCount(0);

  // Credits come from the installed packages, with their licences.
  await expect(settings.getByRole('link', { name: 'electron' })).toBeVisible();
  await expect(settings.getByRole('link', { name: '@modelcontextprotocol/sdk' })).toBeVisible();
  await expect(settings.getByText('MIT').first()).toBeVisible();

  // And the versions a bug report needs.
  await expect(settings.getByText('Chromium')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('opens and ends a work session for write access', async () => {
  // A CLI agent set to "ask first": the only kind a work session applies to.
  await page.evaluate(async () => {
    const api = (window as unknown as { api: { invoke(c: string, p?: unknown): Promise<unknown> } }).api;
    await api.invoke('agents:create', {
      name: 'Writer',
      description: '',
      runtimeType: 'claude-code',
      avatar: '',
      avatarColor: '#35D6C1',
      workingDirectory: 'C:/e2e/project',
      permissions: {
        workspaceAccess: 'approval_required',
        allowAgentToAgent: true,
        allowTaskUpdates: true,
        maxCostPerExecutionUsd: 2,
      },
      config: { maxTurnsPerExecution: 6, timeoutMs: 600000 },
    });
  });

  await page.getByTitle('Profile and settings', { exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Write access' }).click();
  await expect(settings.getByText('No session is open.', { exact: false })).toBeVisible();

  await settings.getByRole('button', { name: 'Start session' }).click();

  // It shows up as open, and the sidebar says so even with Settings closed.
  const row = settings.getByRole('listitem').filter({ hasText: 'Writer' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('This agent writes without asking');
  await page.keyboard.press('Escape');
  const badge = page.getByRole('button', { name: /Write access on/ });
  await expect(badge).toBeVisible();

  // The badge opens the pane that ends it.
  await badge.click();
  await expect(settings.getByRole('heading', { name: 'Write access' })).toBeVisible();
  await settings.getByRole('listitem').filter({ hasText: 'Writer' }).getByRole('button', { name: 'End' }).click();
  await expect(settings.getByText('No session is open.', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(badge).toBeHidden();
});

test('persists the channel across a restart', async () => {
  await app.close();

  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd(),
    env: guiEnv(),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await expect(page.getByText('e2e-channel').first()).toBeVisible({ timeout: 30_000 });
  const profile = page.getByTitle('Profile and settings', { exact: true });
  await expect(profile).toContainText('Dana');
  await expect(profile.locator('img')).toBeVisible();
});
