import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

function guiEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE') continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Renders a transcript of mixed Hebrew, English and code in the real app, so
 * the bidi behaviour can be looked at rather than assumed.
 */
test('capture a mixed-direction transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rtl-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${dir}`],
    cwd: process.cwd(),
    env: guiEnv(),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(1200);

  const conversationId = await page.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke(c: string, p?: unknown): Promise<unknown> };
    }).api;

    const conversation = (await api.invoke('conversations:create', {
      kind: 'channel',
      name: 'פיתוח',
      topic: 'תיאום בין אנשי הצוות',
      memberAgentIds: [],
    })) as { id: string };

    const lines = [
      'למה התיאום ביניכם סגור ?',
      '@Roger תבדוק את `src/main/orchestrator/orchestrator.ts` ותגיד לי מה דעתך',
      'Here is the plan in English, mixing שלום inline.',
      [
        'מצאתי את הבאג. הנה התיקון:',
        '',
        '```ts',
        'const tasks = useApp((s) => s.tasks[conversationId]) ?? NO_TASKS;',
        '```',
        '',
        'שים לב שזה חייב להיות הפניה יציבה.',
      ].join('\n'),
      ['רשימת הצעדים:', '', '- לבדוק את הקוד', '- להריץ בדיקות', '- לפרסם גרסה'].join('\n'),
      '> ציטוט בעברית כדי לבדוק את הפס בצד',
    ];

    for (const body of lines) {
      await api.invoke('messages:send', { conversationId: conversation.id, body });
    }
    return conversation.id;
  });

  expect(conversationId).toBeTruthy();
  await page.reload();
  await page.waitForTimeout(1500);

  await page.getByRole('button', { name: /פיתוח/ }).first().click();
  await page.waitForTimeout(900);

  await page.screenshot({ path: 'test-results/shot-rtl.png' });

  await app.close();
});
