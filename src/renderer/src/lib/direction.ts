/**
 * Base-direction detection for user and agent text.
 *
 * The browser's own `dir="auto"` picks the first strong directional character,
 * which is wrong for the shape of message this app actually carries: a Hebrew
 * or Arabic sentence very often opens with an `@mention`, a file path or a
 * fenced code block, and the first strong character is then Latin. The message
 * renders left-to-right with its punctuation stranded on the wrong side.
 *
 * So direction is decided by weight instead: count strong characters of each
 * script and let the majority win. Code is excluded before counting, because
 * code is Latin by nature and would drag every mixed message back to LTR.
 */

/** Hebrew, Arabic, Syriac, Thaana, and the Arabic presentation forms. */
const RTL_PATTERN =
  /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿ࢠ-ࣿיִ-﷿ﹰ-﻿]/g;

/** Latin, Greek and Cyrillic letters -- the strong left-to-right characters. */
const LTR_PATTERN = /[A-Za-zÀ-ʯͰ-ӿ]/g;

/** Fenced blocks and inline spans, which stay LTR whatever surrounds them. */
const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;

export type TextDirection = 'ltr' | 'rtl';

/**
 * Counts strong characters outside code and returns the dominant direction.
 * Defaults to `ltr` for text with no strong characters at all.
 */
export function detectDirection(text: string): TextDirection {
  if (!text) return 'ltr';

  const prose = text.replace(CODE_PATTERN, ' ');
  const rtl = prose.match(RTL_PATTERN)?.length ?? 0;
  const ltr = prose.match(LTR_PATTERN)?.length ?? 0;

  return rtl > ltr ? 'rtl' : 'ltr';
}

/** True when the text reads right-to-left. */
export function isRtl(text: string): boolean {
  return detectDirection(text) === 'rtl';
}
