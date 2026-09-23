import { isAbsolute, relative, resolve } from 'node:path';
import type { ApprovalFileChange, DiffHunk, DiffLine } from '../../shared/types.js';

/** Unchanged lines kept on each side of a change, so it can be read in place. */
const CONTEXT = 3;
/** Most lines shown for one file. Past this the operator is reading a novel, not a diff. */
const MAX_DIFF_LINES = 400;
/** Files larger than this are not diffed: the point is a decision, not a full read. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/**
 * How much editing effort Myers is allowed to spend. Two files with nothing in
 * common cost O(N+M) steps each; beyond this the honest answer is "replaced".
 */
const MAX_EDIT_DISTANCE = 3000;

type Op = { kind: DiffLine['kind']; text: string };

/**
 * A line diff of two texts, in hunks with context, the way a code review
 * shows one.
 *
 * Myers' algorithm, bounded: files too different to align cheaply are
 * reported as a wholesale replacement rather than a misleading interleaving.
 */
export function diffLines(
  oldText: string,
  newText: string,
): { hunks: DiffHunk[]; added: number; removed: number; truncated: boolean } {
  const before = splitLines(oldText);
  const after = splitLines(newText);
  const ops = myers(before, after) ?? replacement(before, after);
  return toHunks(ops);
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // A trailing newline ends the last line rather than starting an empty one.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Everything removed, then everything added: the fallback when alignment is hopeless. */
function replacement(before: string[], after: string[]): Op[] {
  return [
    ...before.map((text) => ({ kind: 'remove' as const, text })),
    ...after.map((text) => ({ kind: 'add' as const, text })),
  ];
}

/** The classic O((N+M)D) diff. Returns null when the budget runs out. */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(MAX_EDIT_DISTANCE, n + m);
  let v = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];

  for (let d = 0; d <= limit; d++) {
    trace.push(new Map(v));
    const next = new Map(v);
    for (let k = -d; k <= d; k += 2) {
      const goDown = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0));
      let x = goDown ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next.set(k, x);
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
    v = next;
  }
  return null;
}

/** Walks the recorded frontiers backwards into a list of operations. */
function backtrack(trace: Array<Map<number, number>>, a: string[], b: string[], d: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;

  for (let step = d; step > 0; step--) {
    const v = trace[step]!;
    const k = x - y;
    const goDown = k === -step || (k !== step && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0));
    const previousK = goDown ? k + 1 : k - 1;
    const previousX = v.get(previousK) ?? 0;
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      ops.push({ kind: 'context', text: a[x - 1]! });
      x--;
      y--;
    }
    if (goDown) {
      ops.push({ kind: 'add', text: b[y - 1]! });
      y--;
    } else {
      ops.push({ kind: 'remove', text: a[x - 1]! });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: 'context', text: a[x - 1]! });
    x--;
    y--;
  }
  return ops.reverse();
}

/** Groups operations into hunks, dropping long stretches of unchanged lines. */
function toHunks(ops: Op[]): { hunks: DiffHunk[]; added: number; removed: number; truncated: boolean } {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;

  for (const op of ops) {
    if (op.kind === 'add') {
      newLine++;
      added++;
      lines.push({ kind: 'add', text: op.text, oldLine: null, newLine });
    } else if (op.kind === 'remove') {
      oldLine++;
      removed++;
      lines.push({ kind: 'remove', text: op.text, oldLine, newLine: null });
    } else {
      oldLine++;
      newLine++;
      lines.push({ kind: 'context', text: op.text, oldLine, newLine });
    }
  }

  // Every line within CONTEXT of a change is worth showing.
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'context') return;
    for (let i = Math.max(0, index - CONTEXT); i <= Math.min(lines.length - 1, index + CONTEXT); i++) {
      keep[i] = true;
    }
  });

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let shown = 0;
  let truncated = false;

  const close = () => {
    if (!current.length) return;
    const first = current[0]!;
    const oldStart = first.oldLine ?? (current.find((l) => l.oldLine !== null)?.oldLine ?? 0);
    const newStart = first.newLine ?? (current.find((l) => l.newLine !== null)?.newLine ?? 0);
    hunks.push({
      oldStart,
      oldLines: current.filter((l) => l.kind !== 'add').length,
      newStart,
      newLines: current.filter((l) => l.kind !== 'remove').length,
      lines: current,
    });
    current = [];
  };

  for (let index = 0; index < lines.length; index++) {
    if (!keep[index]) {
      close();
      continue;
    }
    if (shown >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    current.push(lines[index]!);
    shown++;
  }
  close();

  return { hunks, added, removed, truncated };
}

export interface FileChangeInput {
  toolName: string;
  input: Record<string, unknown>;
  workingDirectory: string;
  /** Returns the file's current text, or null when it does not exist. */
  readFile(path: string): Promise<{ text: string; bytes: number } | null>;
}

/**
 * What a tool call would do to a file: the target, and the diff between what
 * is on disk now and what the agent proposes.
 *
 * The edit is applied here only in memory, to be shown. Nothing is written:
 * the runtime performs the operation itself once the operator approves.
 */
export async function previewFileChange(request: FileChangeInput): Promise<ApprovalFileChange | null> {
  const raw = request.input['file_path'] ?? request.input['notebook_path'];
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const path = isAbsolute(raw) ? resolve(raw) : resolve(request.workingDirectory || '.', raw);
  const change: ApprovalFileChange = {
    path,
    display: displayPath(path, request.workingDirectory),
    kind: 'edit',
    hunks: [],
    added: 0,
    removed: 0,
    truncated: false,
    note: null,
  };

  let current: { text: string; bytes: number } | null = null;
  try {
    current = await request.readFile(path);
  } catch (error) {
    change.note = `The file could not be read: ${error instanceof Error ? error.message : String(error)}`;
    return change;
  }

  if (!current) change.kind = 'create';
  else if (current.bytes > MAX_FILE_BYTES) {
    change.note = 'The file is too large to show a diff for.';
    return change;
  } else if (current.text.includes('\u0000')) {
    change.note = 'This looks like a binary file, so there is no diff to show.';
    return change;
  }

  const before = current?.text ?? '';
  const proposed = proposedContent(request.toolName, request.input, before);
  if ('note' in proposed) {
    change.note = proposed.note;
    return change;
  }

  const diff = diffLines(before, proposed.text);
  change.hunks = diff.hunks;
  change.added = diff.added;
  change.removed = diff.removed;
  change.truncated = diff.truncated;
  if (!diff.added && !diff.removed) change.note = 'This would leave the file unchanged.';
  return change;
}

/** The file's text after the tool call, or why it cannot be worked out. */
function proposedContent(
  toolName: string,
  input: Record<string, unknown>,
  before: string,
): { text: string } | { note: string } {
  if (typeof input['content'] === 'string') return { text: input['content'] };

  const edits = readEdits(input);
  if (edits.length) {
    let text = before;
    for (const [index, edit] of edits.entries()) {
      const where = edits.length > 1 ? ` (change ${index + 1} of ${edits.length})` : '';
      if (edit.oldString === '') return { note: `The change has nothing to replace${where}.` };
      const occurrences = countOccurrences(text, edit.oldString);
      if (occurrences === 0) {
        return { note: `The text this change replaces is not in the file${where}.` };
      }
      if (occurrences > 1 && !edit.replaceAll) {
        return { note: `That text appears ${occurrences} times${where}, so the change is ambiguous.` };
      }
      text = edit.replaceAll
        ? text.split(edit.oldString).join(edit.newString)
        : text.replace(edit.oldString, edit.newString);
    }
    return { text };
  }

  // Notebooks and anything else that names a file without saying what it writes.
  return { note: `This ${toolName} call does not say what the file would become, so there is no diff.` };
}

interface Edit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/** Both shapes Claude Code uses: one edit inline, or a list of them. */
function readEdits(input: Record<string, unknown>): Edit[] {
  const list = Array.isArray(input['edits']) ? (input['edits'] as unknown[]) : null;
  const sources = list ?? [input];
  const edits: Edit[] = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const record = source as Record<string, unknown>;
    if (typeof record['old_string'] !== 'string' || typeof record['new_string'] !== 'string') continue;
    edits.push({
      oldString: record['old_string'],
      newString: record['new_string'],
      replaceAll: record['replace_all'] === true,
    });
  }
  return edits;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Inside the working directory, the short path; outside it, the full one. */
function displayPath(path: string, workingDirectory: string): string {
  if (!workingDirectory.trim()) return path;
  const step = relative(resolve(workingDirectory), path);
  if (!step || step.startsWith('..') || isAbsolute(step)) return path;
  return step.split('\\').join('/');
}
