import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Agent, SessionGrantScope, SessionWriteGrant, WorkspaceAccess } from '../../shared/types.js';
import { MAX_SESSION_GRANT_MS } from '../../shared/types.js';

/** What the orchestrator and the approval dialog need to know. */
export interface SessionAccessPolicy {
  covers(agent: Pick<Agent, 'id' | 'workingDirectory'>): boolean;
}

export interface SessionGrantInput {
  scope: SessionGrantScope;
  /** The agent the grant is made from: its id for `agent` scope, its directory for `directory` scope. */
  agent: Pick<Agent, 'id' | 'name' | 'workingDirectory'>;
  /** How long it lasts. `null` means until it is revoked or the app closes. */
  durationMs: number | null;
}

/**
 * Work sessions: temporary write access for agents whose permission is
 * "Ask first".
 *
 * Without one, every write and shell command stops for a dialog, which is
 * right for an occasional change and tiring for an hour of real work. A grant
 * lifts the prompt for one agent, or for every agent working in one
 * directory, until it expires or the operator revokes it.
 *
 * Deliberately in memory only. A permission that survives a restart is one
 * nobody remembers granting, so closing the app always returns to asking. It
 * also never raises an agent set to read-only: that is a decision about the
 * agent, not about this hour's work.
 */
export class SessionAccessManager implements SessionAccessPolicy {
  private grants: SessionWriteGrant[] = [];

  /** @param onChange Called whenever the active set changes, including on expiry. */
  constructor(private readonly onChange: (grants: SessionWriteGrant[]) => void = () => {}) {}

  /** The grants in force, expired ones dropped. */
  list(now = Date.now()): SessionWriteGrant[] {
    this.prune(now);
    return [...this.grants];
  }

  /**
   * Opens a work session. A second grant with the same scope and target
   * replaces the first, so re-granting extends the time instead of piling up.
   */
  grant(input: SessionGrantInput, now = Date.now()): SessionWriteGrant {
    const directory = input.agent.workingDirectory.trim();
    if (input.scope === 'directory' && !directory) {
      throw new Error('That agent has no working directory, so there is nothing to open up.');
    }
    const duration =
      input.durationMs === null ? null : Math.min(Math.max(input.durationMs, 1000), MAX_SESSION_GRANT_MS);

    const grant: SessionWriteGrant = {
      id: randomUUID(),
      scope: input.scope,
      agentId: input.scope === 'agent' ? input.agent.id : null,
      directory: input.scope === 'directory' ? directory : null,
      label: input.scope === 'agent' ? input.agent.name : directory,
      grantedAt: now,
      expiresAt: duration === null ? null : now + duration,
    };

    this.prune(now, { silent: true });
    this.grants = this.grants.filter((existing) => !sameTarget(existing, grant));
    this.grants.push(grant);
    this.onChange([...this.grants]);
    return grant;
  }

  /** Ends one work session. Returns false if it had already lapsed. */
  revoke(id: string, now = Date.now()): boolean {
    const before = this.grants.length;
    this.grants = this.grants.filter((grant) => grant.id !== id);
    const removed = this.grants.length !== before;
    this.prune(now, { silent: true });
    if (removed) this.onChange([...this.grants]);
    return removed;
  }

  /** Ends every work session at once. Returns how many were in force. */
  revokeAll(): number {
    const count = this.grants.length;
    if (!count) return 0;
    this.grants = [];
    this.onChange([]);
    return count;
  }

  /** Whether this agent's writes are covered right now. */
  covers(agent: Pick<Agent, 'id' | 'workingDirectory'>, now = Date.now()): boolean {
    this.prune(now);
    return this.grants.some((grant) => {
      if (grant.scope === 'agent') return grant.agentId === agent.id;
      return !!grant.directory && isWithin(grant.directory, agent.workingDirectory);
    });
  }

  /** Drops lapsed grants, announcing the change unless asked not to. */
  private prune(now: number, options: { silent?: boolean } = {}): void {
    const kept = this.grants.filter((grant) => grant.expiresAt === null || grant.expiresAt > now);
    if (kept.length === this.grants.length) return;
    this.grants = kept;
    if (!options.silent) this.onChange([...this.grants]);
  }
}

/**
 * The access level a run should use: the agent's own setting, raised to
 * read/write while a work session covers it. Read-only agents are never
 * raised, and an agent already at read/write is unaffected.
 */
export function effectiveWorkspaceAccess(
  agent: Pick<Agent, 'id' | 'workingDirectory' | 'permissions'>,
  session: SessionAccessPolicy | undefined,
): WorkspaceAccess {
  const access = agent.permissions.workspaceAccess;
  if (access !== 'approval_required') return access;
  return session?.covers(agent) ? 'read_write' : access;
}

function sameTarget(a: SessionWriteGrant, b: SessionWriteGrant): boolean {
  if (a.scope !== b.scope) return false;
  return a.scope === 'agent' ? a.agentId === b.agentId : samePath(a.directory, b.directory);
}

/** Path comparison as the file system does it: Windows ignores case, others do not. */
function normalise(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return normalise(a) === normalise(b);
}

/** True when `child` is the directory itself or somewhere inside it. */
function isWithin(parent: string, child: string): boolean {
  if (!parent.trim() || !child.trim()) return false;
  const from = normalise(parent);
  const to = normalise(child);
  if (from === to) return true;
  const step = relative(from, to);
  return !!step && !step.startsWith('..') && !isAbsolute(step);
}
