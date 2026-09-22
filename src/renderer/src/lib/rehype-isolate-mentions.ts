/**
 * Keeps `@mention` and `#channel` tokens readable inside right-to-left text.
 *
 * In an RTL paragraph the `@` is a neutral character, so Unicode bidi gives it
 * the paragraph's direction and it lands on the wrong side of the name:
 * `@Roger` renders as `Roger@`. Wrapping the whole token in a `<bdi>` isolates
 * it, so it is laid out as one left-to-right unit and keeps its sigil.
 *
 * This runs as a rehype plugin over the parsed tree rather than by rewriting
 * the markdown string, so no raw HTML is ever introduced and there is no
 * injection surface.
 */

interface HastText {
  type: 'text';
  value: string;
}

interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

/** `@name` or `#channel`, allowing the punctuation agent names actually use. */
const TOKEN_SOURCE = '[@#][A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?';
/**
 * Capturing and global, so `split` keeps the delimiters. The lookbehind is what
 * stops `sam@example.com` being read as an address plus a mention: a sigil that
 * follows a word character belongs to that word.
 */
const TOKEN = new RegExp(`((?<![A-Za-z0-9._-])${TOKEN_SOURCE})`, 'g');
/**
 * Non-global twin for testing a single part. `RegExp.test` on a global regex
 * advances `lastIndex`, so reusing TOKEN here would match every other time.
 */
const IS_TOKEN = new RegExp(`^${TOKEN_SOURCE}$`);

function isText(node: HastNode): node is HastText {
  return node.type === 'text' && typeof (node as HastText).value === 'string';
}

function isElement(node: HastNode): node is HastElement {
  return node.type === 'element';
}

/** Splits one text node into plain text and isolated mention elements. */
function split(value: string): HastNode[] {
  const parts = value.split(TOKEN);
  if (parts.length === 1) return [{ type: 'text', value }];

  return parts
    .filter((part) => part !== '')
    .map<HastNode>((part) =>
      IS_TOKEN.test(part)
        ? {
            type: 'element',
            tagName: 'bdi',
            properties: { className: ['mention-token'] },
            children: [{ type: 'text', value: part }],
          }
        : { type: 'text', value: part },
    );
}

function walk(node: HastNode): void {
  const children = (node as { children?: HastNode[] }).children;
  if (!Array.isArray(children)) return;

  // Code keeps its own direction and must not be rewritten.
  if (isElement(node) && (node.tagName === 'code' || node.tagName === 'pre')) return;

  const next: HastNode[] = [];
  for (const child of children) {
    if (isText(child)) {
      next.push(...split(child.value));
    } else {
      walk(child);
      next.push(child);
    }
  }
  (node as { children: HastNode[] }).children = next;
}

export function rehypeIsolateMentions() {
  return (tree: HastNode): void => {
    TOKEN.lastIndex = 0;
    walk(tree);
  };
}
