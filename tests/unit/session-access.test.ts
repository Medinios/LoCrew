import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SESSION_GRANT_MS, type Agent } from '../../src/shared/types';
import { SessionAccessManager, effectiveWorkspaceAccess } from '../../src/main/security/session-access';

const REPO = resolve('/work/repo');
const OTHER = resolve('/work/other');

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Builder',
    workingDirectory: REPO,
    permissions: { workspaceAccess: 'approval_required' },
    ...overrides,
  } as Agent;
}

describe('work sessions', () => {
  it('covers the one agent it was granted to', () => {
    const sessions = new SessionAccessManager();
    sessions.grant({ scope: 'agent', agent: agent(), durationMs: null });

    expect(sessions.covers(agent())).toBe(true);
    expect(sessions.covers(agent({ id: 'agent-2' }))).toBe(false);
  });

  it('covers every agent in the directory, including subdirectories', () => {
    const sessions = new SessionAccessManager();
    sessions.grant({ scope: 'directory', agent: agent(), durationMs: null });

    expect(sessions.covers(agent({ id: 'other-agent' }))).toBe(true);
    expect(sessions.covers(agent({ id: 'nested', workingDirectory: join(REPO, 'packages', 'api') }))).toBe(true);
    expect(sessions.covers(agent({ id: 'elsewhere', workingDirectory: OTHER }))).toBe(false);
    // An agent with no directory of its own is never covered by a directory grant.
    expect(sessions.covers(agent({ id: 'model-agent', workingDirectory: '' }))).toBe(false);
  });

  it('refuses a directory grant for an agent that has no directory', () => {
    const sessions = new SessionAccessManager();
    expect(() => sessions.grant({ scope: 'directory', agent: agent({ workingDirectory: '' }), durationMs: null }))
      .toThrow(/no working directory/i);
  });

  it('lapses when its time is up', () => {
    const sessions = new SessionAccessManager();
    const start = 1_000_000;
    sessions.grant({ scope: 'agent', agent: agent(), durationMs: 60_000 }, start);

    expect(sessions.covers(agent(), start + 59_000)).toBe(true);
    expect(sessions.covers(agent(), start + 61_000)).toBe(false);
    expect(sessions.list(start + 61_000)).toHaveLength(0);
  });

  it('caps how long a session can last', () => {
    const sessions = new SessionAccessManager();
    const start = 1_000_000;
    const granted = sessions.grant({ scope: 'agent', agent: agent(), durationMs: 10 * MAX_SESSION_GRANT_MS }, start);

    expect(granted.expiresAt).toBe(start + MAX_SESSION_GRANT_MS);
  });

  it('replaces a grant on the same target instead of stacking them', () => {
    const sessions = new SessionAccessManager();
    const start = 1_000_000;
    sessions.grant({ scope: 'agent', agent: agent(), durationMs: 60_000 }, start);
    sessions.grant({ scope: 'agent', agent: agent(), durationMs: 600_000 }, start);

    const active = sessions.list(start);
    expect(active).toHaveLength(1);
    expect(active[0]!.expiresAt).toBe(start + 600_000);
    // A different scope for the same agent is a separate grant.
    sessions.grant({ scope: 'directory', agent: agent(), durationMs: null }, start);
    expect(sessions.list(start)).toHaveLength(2);
  });

  it('can be revoked, one at a time or all at once', () => {
    const sessions = new SessionAccessManager();
    const first = sessions.grant({ scope: 'agent', agent: agent(), durationMs: null });
    sessions.grant({ scope: 'directory', agent: agent(), durationMs: null });

    expect(sessions.revoke(first.id)).toBe(true);
    expect(sessions.revoke(first.id)).toBe(false);
    expect(sessions.revokeAll()).toBe(1);
    expect(sessions.covers(agent())).toBe(false);
  });

  it('announces every change, including a lapse', () => {
    const seen: number[] = [];
    const sessions = new SessionAccessManager((grants) => seen.push(grants.length));
    const start = 1_000_000;

    sessions.grant({ scope: 'agent', agent: agent(), durationMs: 60_000 }, start);
    sessions.list(start + 61_000);
    sessions.list(start + 62_000);

    // Granted, then lapsed. The second read has nothing left to report.
    expect(seen).toEqual([1, 0]);
  });
});

describe('effective workspace access', () => {
  const sessions = new SessionAccessManager();
  sessions.grant({ scope: 'agent', agent: agent(), durationMs: null });

  it('raises "ask first" to read/write while a session is open', () => {
    expect(effectiveWorkspaceAccess(agent(), sessions)).toBe('read_write');
  });

  it('never raises a read-only agent', () => {
    const readOnly = agent({ permissions: { workspaceAccess: 'read_only' } as Agent['permissions'] });
    expect(effectiveWorkspaceAccess(readOnly, sessions)).toBe('read_only');
  });

  it('leaves agents alone when no session covers them', () => {
    expect(effectiveWorkspaceAccess(agent({ id: 'agent-2' }), sessions)).toBe('approval_required');
    expect(effectiveWorkspaceAccess(agent(), undefined)).toBe('approval_required');
  });
});
