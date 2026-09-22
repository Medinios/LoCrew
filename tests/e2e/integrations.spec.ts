/**
 * The universal-agent path, driven through the real Electron UI:
 *
 *   Settings → AI Providers → add an OpenAI-compatible provider, test it
 *   Settings → MCP Servers  → add a local stdio server, approve its launch
 *   Create agent wizard     → an agent on that provider with one MCP tool
 *   Direct message          → the agent calls the tool and answers
 *
 * The provider is a local mock that speaks the Chat Completions wire format
 * (tests/support/mock-provider.ts) -- no real model is contacted. The MCP
 * server is a real MCP SDK server over stdio (tests/fixtures).
 *
 * Run `npm run build` first; this launches the built app.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { chatRequests, lastMessage, startMockProvider, textStream, toolCallStream, type MockProvider } from '../support/mock-provider';

const API_KEY = 'sk-e2e-secret-4f1c9a';
const FIXTURE = resolve('tests/fixtures/mcp-notes-server.mjs');

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let provider: MockProvider;

// Each step builds on the one before.
test.describe.configure({ mode: 'serial' });

function guiEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE') continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    try {
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    } catch {
      return [];
    }
  });
}

test.beforeAll(async () => {
  provider = await startMockProvider(async (request) => {
    if (request.method === 'GET' && request.path.endsWith('/models')) {
      return { status: 200, json: { object: 'list', data: [{ id: 'mock-model', object: 'model' }] } };
    }
    const last = lastMessage(request);
    if (last?.role === 'tool') return textStream(`Echo said: ${String(last.content)}`);
    // A pasted image arrives as an image part in the user turn.
    if (Array.isArray(last?.content) && (last.content as Array<{ type: string }>).some((p) => p.type === 'image_url')) {
      return textStream('I can see the image you pasted.');
    }
    const tools = (request.body?.tools ?? []) as Array<{ function: { name: string } }>;
    const echo = tools.find((t) => t.function.name.endsWith('__echo'));
    if (!echo) return textStream('No echo tool was offered.');
    // The model "reads" for a moment before answering, long enough to see
    // the live reaction on the message.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return toolCallStream([{ id: 'call_1', name: echo.function.name, args: { text: 'ping' } }]);
  });

  userDataDir = mkdtempSync(join(tmpdir(), 'locrew-e2e-int-'));
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd(),
    env: { ...guiEnv(), NODE_ENV: 'test' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // The launch approval is a native message box Playwright cannot click.
  // Answer "Launch" and keep what it showed so the test can check it.
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __launchPrompts: string[] };
    g.__launchPrompts = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { message: string; detail?: string };
      g.__launchPrompts.push(`${options.message}\n${options.detail ?? ''}`);
      return { response: 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
});

test.afterAll(async () => {
  await app?.close();
  await provider?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test('adds an OpenAI-compatible provider and tests the connection', async () => {
  await page.getByTitle('Profile and settings', { exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'AI Providers' }).click();
  await settings.getByRole('button', { name: 'Add provider' }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Add provider' });
  await dialog.getByRole('button', { name: /Any endpoint that speaks Chat Completions/ }).click();
  await dialog.getByRole('button', { name: /LiteLLM, a gateway/ }).click();

  const form = page.getByRole('dialog', { name: 'Add OpenAI-compatible API' });
  await form.getByPlaceholder('My Local AI').fill('Mock Provider');
  await form.getByPlaceholder('http://localhost:1234/v1').fill(`${provider.url}/v1`);
  await form.getByPlaceholder('Encrypted with your OS keychain').fill(API_KEY);
  await form.getByRole('button', { name: 'Test connection' }).click();
  await expect(form.getByText('Connection works')).toBeVisible();

  await form.getByRole('button', { name: 'Add provider' }).click();
  await expect(form).toBeHidden();
  await expect(settings.getByText('Mock Provider', { exact: true })).toBeVisible();
  await expect(settings.getByText(/1 model/).first()).toBeVisible();

  // The key went out as a bearer token...
  const listing = provider.requests.find((r) => r.path === '/v1/models');
  expect(listing?.headers.authorization).toBe(`Bearer ${API_KEY}`);
});

test('adds a local MCP server only after its launch is approved', async () => {
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'MCP Servers' }).click();
  await settings.getByRole('button', { name: 'Add MCP server' }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Add MCP server' });
  await dialog.getByPlaceholder('Filesystem MCP').fill('Notes');
  await dialog.getByPlaceholder('npx').fill('node');
  await dialog.getByRole('textbox', { name: /^Arguments/ }).fill(FIXTURE);
  await dialog.getByRole('button', { name: 'Add and connect' }).click();
  await expect(dialog).toBeHidden();

  await expect(settings.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(settings.getByText('5 tools')).toBeVisible();

  const prompts = await app.evaluate(() => (globalThis as unknown as { __launchPrompts: string[] }).__launchPrompts);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('Launch the MCP server "Notes"?');
  expect(prompts[0]).toContain(FIXTURE);

  // Tool discovery is visible in the pane.
  await settings.getByRole('button', { name: 'Tools, resources and capabilities' }).click();
  await expect(settings.getByText('Returns the text it is given.')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
});

test('creates an agent on the provider with one MCP tool, and it uses it', async () => {
  await page.getByRole('button', { name: 'Create agent', exact: true }).first().click();
  const wizard = page.getByRole('dialog', { name: 'Create agent' });

  await wizard.getByPlaceholder('Security Architect').fill('Mock Agent');
  await wizard.getByPlaceholder('Reviews proposed implementations for security risks').fill('Answers through a mock model');
  await wizard.getByRole('button', { name: 'Continue' }).click();

  await wizard.getByRole('button', { name: /^Mock Provider/ }).click();
  await expect(wizard.getByText('mock-model').first()).toBeVisible();
  await wizard.getByRole('button', { name: 'Continue' }).click();

  await wizard.getByRole('button', { name: 'Continue' }).click();

  await wizard.getByLabel('Grant echo').check();
  await wizard.getByRole('button', { name: 'Allow', exact: true }).click();
  await wizard.getByRole('button', { name: 'Continue' }).click();

  await expect(wizard.getByText('Notes: echo')).toBeVisible();
  await wizard.getByRole('button', { name: 'Create agent' }).click();
  await expect(wizard).toBeHidden();

  // The wizard opens the new agent's direct message.
  const composer = page.getByPlaceholder('Message Mock Agent');
  await expect(composer).toBeVisible();
  await composer.fill('Please echo ping');
  await composer.press('Enter');

  // While the model has the message but has produced nothing, the agent's
  // reaction on it says so -- in the message and next to its name.
  const request = page.locator('article', { hasText: 'Please echo ping' });
  await expect(request.getByRole('img', { name: /^👀 1: Mock Agent: Reading your message/ })).toBeVisible();
  await expect(page.getByTitle('Mock Agent: Reading your message', { exact: true })).toBeVisible();

  // The finished message renders markdown; the live stream preview before it is plain text.
  await expect(page.locator('article').getByRole('paragraph').filter({ hasText: 'Echo said: echo: ping' })).toBeVisible({ timeout: 60_000 });

  // Done: one ✅ on the request, replacing the earlier states rather than adding to them.
  const done = request.getByRole('img', { name: /^✅ 1: Mock Agent: Completed/ });
  await expect(done).toBeVisible();
  await expect(request.getByRole('img', { name: /👀|⚙️|💭|📨/ })).toHaveCount(0);
  await expect(page.getByTitle('Mock Agent: Reading your message', { exact: true })).toHaveCount(0);
  await done.hover();
  await expect(page.getByRole('tooltip')).toContainText('Mock Agent — Completed');

  const chats = chatRequests(provider);
  expect(chats.length).toBeGreaterThanOrEqual(2);
  const offered = (chats[0]!.body?.tools ?? []) as Array<{ function: { name: string } }>;
  const names = offered.map((t) => t.function.name);
  // Only the granted tool is offered from the MCP server.
  expect(names.filter((n) => n.includes('__'))).toEqual([names.find((n) => n.endsWith('__echo'))]);
});

test('lets the user react by hand, separately from the agent', async () => {
  const request = page.locator('article', { hasText: 'Please echo ping' });
  await request.hover();
  await request.getByRole('button', { name: 'Add reaction' }).click();
  await page.getByRole('dialog', { name: 'Add reaction' }).getByRole('button', { name: '👍', exact: true }).click();

  const mine = request.getByRole('button', { name: /^👍 1: you/ });
  await expect(mine).toBeVisible();
  await expect(mine).toHaveAttribute('aria-pressed', 'true');
  // The agent's reaction is untouched and still cannot be clicked.
  await expect(request.getByRole('img', { name: /^✅ 1: Mock Agent: Completed/ })).toBeVisible();

  await mine.click();
  await expect(mine).toHaveCount(0);
  await expect(request.getByRole('img', { name: /^✅ 1: Mock Agent: Completed/ })).toBeVisible();
});

test('keeps reactions when navigating away and back', async () => {
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await page.getByRole('button', { name: /^Mock Agent/ }).first().click();
  const request = page.locator('article', { hasText: 'Please echo ping' });
  await expect(request.getByRole('img', { name: /^✅ 1: Mock Agent: Completed/ })).toBeVisible();
});

test('sends a pasted image to the agent', async () => {
  const composer = page.getByPlaceholder('Message Mock Agent');
  await composer.click();

  // Paste a real PNG the way the clipboard delivers a screenshot: a file, no text.
  await composer.evaluate(async (textarea) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#2E7D6E';
    context.fillRect(0, 0, 320, 200);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }));
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });

  const pending = page.getByLabel('Images to send');
  await expect(pending.getByRole('img', { name: 'screenshot.png' })).toBeVisible();
  await composer.fill('What is in this image?');
  await composer.press('Enter');
  await expect(pending).toHaveCount(0);

  const sent = page.locator('article', { hasText: 'What is in this image?' });
  await expect(sent.getByRole('img', { name: 'screenshot.png' })).toBeVisible();
  await expect(page.locator('article').getByRole('paragraph').filter({ hasText: 'I can see the image you pasted.' })).toBeVisible({ timeout: 30_000 });

  const withImage = chatRequests(provider).find((r) =>
    JSON.stringify(r.body?.messages ?? []).includes('"type":"image_url"'),
  );
  expect(JSON.stringify(withImage?.body?.messages)).toContain('data:image/png;base64,');
});

test('never writes the API key to disk in plain text', async () => {
  const hits = filesUnder(userDataDir).filter((path) => {
    try {
      return readFileSync(path).includes(API_KEY);
    } catch {
      return false;
    }
  });
  expect(hits).toEqual([]);
});

test('shows the final reactions again after a restart', async () => {
  await app.close();
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd(),
    env: { ...guiEnv(), NODE_ENV: 'test' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.getByRole('button', { name: /^Mock Agent/ }).first().click();
  const request = page.locator('article', { hasText: 'Please echo ping' });
  await expect(request.getByRole('img', { name: /^✅ 1: Mock Agent: Completed/ })).toBeVisible({ timeout: 30_000 });
  // The pasted image is still there too, served from the app's data folder.
  const sent = page.locator('article', { hasText: 'What is in this image?' });
  await expect(sent.getByRole('img', { name: 'screenshot.png' })).toBeVisible();
  expect(await sent.getByRole('img', { name: 'screenshot.png' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
});
