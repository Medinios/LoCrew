import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestView } from '../../src/shared/types';
import { ApprovalManager, type ApprovalEvent } from '../../src/main/approvals/manager';

function setup() {
  const events: ApprovalEvent[] = [];
  const sessions: Array<{ id: string; durationMs: number | null; scope: string }> = [];
  const manager = new ApprovalManager({
    emit: (event) => events.push(event),
    openSession: (view, choice) =>
      sessions.push({ id: view.id, durationMs: choice.durationMs, scope: choice.scope }),
  });
  return { manager, events, sessions };
}

function view(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    id: 'req-1',
    agentId: 'agent-1',
    agentName: 'Builder',
    agentAvatar: '',
    agentColor: '#35D6C1',
    executionId: 'exec-1',
    toolName: 'Write',
    kind: 'workspace',
    workingDirectory: 'D:/work/repo',
    command: null,
    file: null,
    details: null,
    canOpenSession: true,
    createdAt: 1,
    ...overrides,
  };
}

describe('pending approvals', () => {
  it('resolves when the operator allows it, and tells the renderer both times', async () => {
    const { manager, events } = setup();
    const answer = manager.ask(view());

    expect(manager.list().map((v) => v.id)).toEqual(['req-1']);
    expect(manager.respond('req-1', { decision: 'once' })).toBe(true);

    await expect(answer).resolves.toEqual({ approved: true });
    expect(events.map((e) => e.type)).toEqual(['approval', 'approval-resolved']);
    expect(manager.size).toBe(0);
  });

  it('resolves as denied, with a reason the agent can read', async () => {
    const { manager } = setup();
    const answer = manager.ask(view());
    manager.respond('req-1', { decision: 'deny' });

    await expect(answer).resolves.toMatchObject({ approved: false, reason: expect.stringContaining('denied') });
  });

  it('opens a work session when the operator asks to stop being asked', async () => {
    const { manager, sessions } = setup();
    const answer = manager.ask(view());
    manager.respond('req-1', { decision: 'session', durationMs: 3_600_000, scope: 'directory' });

    await expect(answer).resolves.toEqual({ approved: true });
    expect(sessions).toEqual([{ id: 'req-1', durationMs: 3_600_000, scope: 'directory' }]);
  });

  it('allows once, without a session, when the request cannot carry one', async () => {
    const { manager, sessions } = setup();
    const answer = manager.ask(view({ kind: 'tool', canOpenSession: false }));
    manager.respond('req-1', { decision: 'session', durationMs: null, scope: 'agent' });

    await expect(answer).resolves.toEqual({ approved: true });
    expect(sessions).toEqual([]);
  });

  it('denies when the run is stopped while the question is open', async () => {
    const { manager, events } = setup();
    const controller = new AbortController();
    const answer = manager.ask(view(), controller.signal);

    controller.abort();

    await expect(answer).resolves.toMatchObject({ approved: false, reason: expect.stringContaining('stopped') });
    expect(events.at(-1)).toEqual({ type: 'approval-resolved', id: 'req-1' });
    expect(manager.size).toBe(0);
  });

  it('denies a request whose run was already stopped, without asking', async () => {
    const { manager, events } = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(manager.ask(view(), controller.signal)).resolves.toMatchObject({ approved: false });
    expect(events).toEqual([]);
  });

  it('answers only once, however many times the answer arrives', async () => {
    const { manager } = setup();
    const answer = manager.ask(view());

    expect(manager.respond('req-1', { decision: 'once' })).toBe(true);
    expect(manager.respond('req-1', { decision: 'deny' })).toBe(false);
    await expect(answer).resolves.toEqual({ approved: true });
  });

  it('keeps several questions in the order they arrived', async () => {
    const { manager } = setup();
    const first = manager.ask(view({ id: 'a' }));
    const second = manager.ask(view({ id: 'b' }));

    expect(manager.list().map((v) => v.id)).toEqual(['a', 'b']);
    manager.respond('b', { decision: 'deny' });
    expect(manager.list().map((v) => v.id)).toEqual(['a']);

    manager.respond('a', { decision: 'once' });
    await expect(first).resolves.toEqual({ approved: true });
    await expect(second).resolves.toMatchObject({ approved: false });
  });

  it('denies everything waiting when nothing can answer any more', async () => {
    const { manager } = setup();
    const answer = manager.ask(view());

    manager.clear('The window was closed.');

    await expect(answer).resolves.toMatchObject({ approved: false, reason: 'The window was closed.' });
    expect(manager.size).toBe(0);
  });

  it('does not leak abort listeners once answered', async () => {
    const { manager } = setup();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');

    const answer = manager.ask(view(), controller.signal);
    manager.respond('req-1', { decision: 'once' });
    await answer;

    expect(remove).toHaveBeenCalled();
  });
});
