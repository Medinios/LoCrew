import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffLines, previewFileChange } from '../../src/main/approvals/diff';

const DIR = resolve('/work/repo');
const FILE = join(DIR, 'src', 'auth.ts');

/** A reader over a fixed set of files, standing in for the disk. */
function disk(files: Record<string, string>) {
  return async (path: string) => {
    const text = files[path];
    return text === undefined ? null : { text, bytes: Buffer.byteLength(text) };
  };
}

/** "+line" / "-line" / " line", the way a reviewer reads a diff. */
const rendered = (hunks: ReturnType<typeof diffLines>['hunks']) =>
  hunks.flatMap((hunk) => hunk.lines.map((l) => `${l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' '}${l.text}`));

describe('line diff', () => {
  it('shows a changed line as one removal and one addition, in context', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\n';
    const after = 'one\ntwo\nTHREE\nfour\nfive\n';
    const diff = diffLines(before, after);

    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(rendered(diff.hunks)).toEqual([' one', ' two', '-three', '+THREE', ' four', ' five']);
  });

  it('numbers lines on both sides', () => {
    const diff = diffLines('a\nb\n', 'a\nB\n');
    const [hunk] = diff.hunks;

    expect(hunk!.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['context', 1, 1],
      ['remove', 2, null],
      ['add', null, 2],
    ]);
  });

  it('leaves out long stretches of unchanged lines', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const diff = diffLines(`${filler}\nlast\n`, `first\n${filler}\nlast\n`);

    // The addition at the top, its context, and nothing from the middle.
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]!.lines).toHaveLength(4);
    expect(rendered(diff.hunks)[0]).toBe('+first');
  });

  it('counts a new file as all additions', () => {
    const diff = diffLines('', 'alpha\nbeta\n');
    expect(diff).toMatchObject({ added: 2, removed: 0, truncated: false });
  });

  it('cuts off a change too large to read, and says so', () => {
    const before = Array.from({ length: 900 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 900 }, (_, i) => `new ${i}`).join('\n');
    const diff = diffLines(before, after);

    expect(diff.truncated).toBe(true);
    expect(diff.hunks.flatMap((h) => h.lines).length).toBeLessThanOrEqual(400);
  });
});

describe('previewing what a tool would write', () => {
  it('diffs a Write against the file on disk', async () => {
    const change = await previewFileChange({
      toolName: 'Write',
      input: { file_path: FILE, content: 'export const a = 2;\n' },
      workingDirectory: DIR,
      readFile: disk({ [FILE]: 'export const a = 1;\n' }),
    });

    expect(change).toMatchObject({ kind: 'edit', display: 'src/auth.ts', added: 1, removed: 1, note: null });
    expect(rendered(change!.hunks)).toEqual(['-export const a = 1;', '+export const a = 2;']);
  });

  it('marks a file that does not exist yet as a new one', async () => {
    const change = await previewFileChange({
      toolName: 'Write',
      input: { file_path: FILE, content: 'hello\n' },
      workingDirectory: DIR,
      readFile: disk({}),
    });

    expect(change).toMatchObject({ kind: 'create', added: 1, removed: 0 });
  });

  it('applies an Edit to work out the result', async () => {
    const change = await previewFileChange({
      toolName: 'Edit',
      input: { file_path: FILE, old_string: 'const timeout = 30', new_string: 'const timeout = 60' },
      workingDirectory: DIR,
      readFile: disk({ [FILE]: 'start\nconst timeout = 30;\nend\n' }),
    });

    expect(change).toMatchObject({ added: 1, removed: 1, note: null });
    expect(rendered(change!.hunks)).toContain('+const timeout = 60;');
  });

  it('applies several edits in order', async () => {
    const change = await previewFileChange({
      toolName: 'MultiEdit',
      input: {
        file_path: FILE,
        edits: [
          { old_string: 'alpha', new_string: 'ALPHA' },
          { old_string: 'beta', new_string: 'BETA' },
        ],
      },
      workingDirectory: DIR,
      readFile: disk({ [FILE]: 'alpha\nbeta\ngamma\n' }),
    });

    expect(change).toMatchObject({ added: 2, removed: 2 });
    expect(rendered(change!.hunks)).toEqual(['-alpha', '-beta', '+ALPHA', '+BETA', ' gamma']);
  });

  it('says when the text to replace is not there', async () => {
    const change = await previewFileChange({
      toolName: 'Edit',
      input: { file_path: FILE, old_string: 'missing', new_string: 'x' },
      workingDirectory: DIR,
      readFile: disk({ [FILE]: 'nothing like it\n' }),
    });

    expect(change!.note).toMatch(/not in the file/i);
    expect(change!.hunks).toHaveLength(0);
  });

  it('says when the text to replace is ambiguous', async () => {
    const change = await previewFileChange({
      toolName: 'Edit',
      input: { file_path: FILE, old_string: 'dup', new_string: 'x' },
      workingDirectory: DIR,
      readFile: disk({ [FILE]: 'dup\ndup\n' }),
    });

    expect(change!.note).toMatch(/appears 2 times/i);
  });

  it('replaces every occurrence when asked to', async () => {
    const change = await previewFileChange({
      toolName: 'Edit',
      input: { file_path: FILE, old_string: 'dup', new_string: 'x', replace_all: true },
      workingDirectory: DIR,
      readFile: disk({ [FILE]: 'dup\ndup\n' }),
    });

    expect(change).toMatchObject({ added: 2, removed: 2, note: null });
  });

  it('refuses to guess for a binary file', async () => {
    const change = await previewFileChange({
      toolName: 'Write',
      input: { file_path: FILE, content: 'text' },
      workingDirectory: DIR,
      readFile: disk({ [FILE]: 'PNG\u0000\u0000binary' }),
    });

    expect(change!.note).toMatch(/binary/i);
  });

  it('reports a file it cannot read rather than pretending', async () => {
    const change = await previewFileChange({
      toolName: 'Write',
      input: { file_path: FILE, content: 'text' },
      workingDirectory: DIR,
      readFile: async () => {
        throw new Error('EACCES: permission denied');
      },
    });

    expect(change!.note).toMatch(/could not be read/i);
  });

  it('says so when a change would leave the file as it is', async () => {
    const change = await previewFileChange({
      toolName: 'Write',
      input: { file_path: FILE, content: 'same\n' },
      workingDirectory: DIR,
      readFile: disk({ [FILE]: 'same\n' }),
    });

    expect(change!.note).toMatch(/unchanged/i);
  });

  it('keeps the full path for a file outside the working directory', async () => {
    const outside = resolve('/elsewhere/notes.md');
    const change = await previewFileChange({
      toolName: 'Write',
      input: { file_path: outside, content: 'hi\n' },
      workingDirectory: DIR,
      readFile: disk({}),
    });

    expect(change!.display).toBe(outside);
  });

  it('has nothing to preview for a tool that names no file', async () => {
    const change = await previewFileChange({
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      workingDirectory: DIR,
      readFile: disk({}),
    });

    expect(change).toBeNull();
  });

  it('is honest when a notebook edit says nothing about the result', async () => {
    const notebook = join(DIR, 'run.ipynb');
    const change = await previewFileChange({
      toolName: 'NotebookEdit',
      input: { notebook_path: notebook, cell_id: '3', new_source: 'print(1)' },
      workingDirectory: DIR,
      readFile: disk({ [notebook]: '{"cells": []}' }),
    });

    expect(change!.note).toMatch(/no diff/i);
  });
});
