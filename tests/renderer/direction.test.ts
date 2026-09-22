import { describe, expect, it } from 'vitest';
import { detectDirection, isRtl } from '../../src/renderer/src/lib/direction.js';

describe('detectDirection', () => {
  it('reads plain English as left-to-right', () => {
    expect(detectDirection('Build the authentication endpoints.')).toBe('ltr');
  });

  it('reads plain Hebrew as right-to-left', () => {
    expect(detectDirection('בנה את נקודות הקצה של ההזדהות')).toBe('rtl');
  });

  it('reads Arabic as right-to-left', () => {
    expect(detectDirection('مرحبا بك في السفينة')).toBe('rtl');
  });

  it('keeps a Hebrew message RTL when it opens with a mention', () => {
    // The browser's own dir="auto" gets this wrong: the first strong character
    // is the "R" of the mention, so it would render the whole line LTR.
    expect(detectDirection('@Roger שלום, מה מצב המשימה שלך?')).toBe('rtl');
  });

  it('keeps a Hebrew message RTL when it opens with a file path', () => {
    expect(detectDirection('src/main/index.ts הקובץ הזה צריך תיקון דחוף')).toBe('rtl');
  });

  it('ignores fenced code when weighing the direction', () => {
    const message = [
      'הנה התיקון שהצעתי:',
      '```ts',
      'export function resolveMentions(body: string, members: Agent[]) {',
      '  return members.filter((member) => body.includes(member.name));',
      '}',
      '```',
      'תגיד לי אם זה מתאים.',
    ].join('\n');

    // Without stripping the block, the Latin code would outweigh the Hebrew.
    expect(detectDirection(message)).toBe('rtl');
  });

  it('ignores inline code too', () => {
    expect(detectDirection('צריך לשנות את `maxAgentToAgentTurns` בהגדרות')).toBe('rtl');
  });

  it('stays LTR for an English message that quotes Hebrew briefly', () => {
    expect(
      detectDirection('The operator wrote שלום and then asked about the deployment pipeline.'),
    ).toBe('ltr');
  });

  it('treats a code-only message as left-to-right', () => {
    expect(detectDirection('```\nnpm run build\n```')).toBe('ltr');
  });

  it('defaults to left-to-right for empty or symbol-only text', () => {
    expect(detectDirection('')).toBe('ltr');
    expect(detectDirection('   ')).toBe('ltr');
    expect(detectDirection('!!! ??? ...')).toBe('ltr');
    expect(detectDirection('12345 67890')).toBe('ltr');
  });

  it('exposes a boolean helper', () => {
    expect(isRtl('שלום')).toBe(true);
    expect(isRtl('hello')).toBe(false);
  });
});
