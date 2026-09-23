/**
 * The approval dialog: what an agent is about to change, and the decision the
 * operator makes about it.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../../src/shared/ipc.js';
import type { ApprovalRequestView } from '../../src/shared/types.js';

const invoke = vi.fn(() => Promise.resolve([] as unknown));

vi.stubGlobal('window', globalThis.window);
Object.defineProperty(globalThis.window, 'api', {
  writable: true,
  value: {
    invoke,
    onEvent: (_l: (e: AppEvent) => void) => () => undefined,
    platform: 'win32' as NodeJS.Platform,
  },
});

const { ApprovalDialog } = await import('../../src/renderer/src/components/chat/ApprovalDialog.js');
const { useApp } = await import('../../src/renderer/src/stores/app.js');

afterEach(() => {
  cleanup();
  invoke.mockClear();
  useApp.setState({ approvals: [] });
});

function request(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    id: 'req-1',
    agentId: 'agent-1',
    agentName: 'Builder',
    agentAvatar: '',
    agentColor: '#35D6C1',
    executionId: 'exec-1',
    toolName: 'Edit',
    kind: 'workspace',
    workingDirectory: 'D:/work/repo',
    command: null,
    details: null,
    canOpenSession: true,
    createdAt: 1,
    file: {
      path: 'D:/work/repo/src/auth.ts',
      display: 'src/auth.ts',
      kind: 'edit',
      added: 1,
      removed: 1,
      truncated: false,
      note: null,
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: 'context', text: 'const session = {', oldLine: 1, newLine: 1 },
            { kind: 'remove', text: '  ttl: 30,', oldLine: 2, newLine: null },
            { kind: 'add', text: '  ttl: 60,', oldLine: null, newLine: 2 },
          ],
        },
      ],
    },
    ...overrides,
  };
}

/** Puts a pending request in front of the operator. */
function show(view: ApprovalRequestView) {
  useApp.setState({ approvals: [view] });
  return render(<ApprovalDialog />);
}

describe('approving a change', () => {
  it('shows nothing while no agent is waiting', () => {
    const { container } = render(<ApprovalDialog />);
    expect(container.innerHTML).toBe('');
  });

  it('names the file and shows the diff', () => {
    show(request());

    expect(screen.getByRole('dialog').textContent).toContain('Builder wants to edit src/auth.ts');
    const dialog = screen.getByRole('dialog');
    // Both sides of the change, with their indentation kept as written.
    const asWritten = { normalizer: (text: string) => text };
    expect(within(dialog).getByText('  ttl: 30,', asWritten)).toBeTruthy();
    expect(within(dialog).getByText('  ttl: 60,', asWritten)).toBeTruthy();
    expect(within(dialog).getByText('+1')).toBeTruthy();
    expect(within(dialog).getByText('-1')).toBeTruthy();
  });

  it('marks a file that does not exist yet', () => {
    show(request({ file: { ...request().file!, kind: 'create', removed: 0 } }));

    expect(screen.getByRole('dialog').textContent).toContain('wants to create src/auth.ts');
    expect(screen.getByText('New file')).toBeTruthy();
  });

  it('passes on a note instead of pretending there is a diff', () => {
    show(request({ file: { ...request().file!, hunks: [], added: 0, removed: 0, note: 'This looks like a binary file, so there is no diff to show.' } }));

    expect(screen.getByText(/binary file/)).toBeTruthy();
  });

  it('shows a command on its own', () => {
    show(request({ toolName: 'Bash', file: null, command: 'rm -rf build' }));

    expect(screen.getByRole('dialog').textContent).toContain('wants to run a command');
    expect(screen.getByText('rm -rf build')).toBeTruthy();
  });

  it('shows an MCP tool call with its arguments, and offers no session', () => {
    show(request({ kind: 'tool', toolName: 'notes → append', file: null, details: 'text: hello', canOpenSession: false }));

    expect(screen.getByRole('dialog').textContent).toContain('wants to use notes → append');
    expect(screen.getByText('text: hello')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow for 1 hour' })).toBeNull();
  });

  it('allows once', async () => {
    show(request());
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));

    expect(invoke).toHaveBeenCalledWith('approvals:respond', { id: 'req-1', choice: { decision: 'once' } });
    expect(useApp.getState().approvals).toHaveLength(0);
  });

  it('denies', () => {
    show(request());
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    expect(invoke).toHaveBeenCalledWith('approvals:respond', { id: 'req-1', choice: { decision: 'deny' } });
  });

  it('opens a work session for an hour, for this agent by default', () => {
    show(request());
    fireEvent.click(screen.getByRole('button', { name: 'Allow for 1 hour' }));

    expect(invoke).toHaveBeenCalledWith('approvals:respond', {
      id: 'req-1',
      choice: { decision: 'session', durationMs: 3_600_000, scope: 'agent' },
    });
  });

  it('widens the session to the directory when asked', () => {
    show(request());
    fireEvent.click(screen.getByLabelText(/every agent working in this directory/i));
    fireEvent.click(screen.getByRole('button', { name: 'Until I end it' }));

    expect(invoke).toHaveBeenCalledWith('approvals:respond', {
      id: 'req-1',
      choice: { decision: 'session', durationMs: null, scope: 'directory' },
    });
  });

  it('asks one question at a time and says how many are behind it', () => {
    useApp.setState({ approvals: [request(), request({ id: 'req-2', toolName: 'Write' })] });
    render(<ApprovalDialog />);

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('1 more waiting')).toBeTruthy();
  });
});
