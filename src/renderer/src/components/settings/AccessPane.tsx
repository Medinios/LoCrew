import { FolderOpen, ShieldCheck, Timer, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Agent, SessionGrantScope, SessionWriteGrant } from '@shared/types';
import { PaneHeader } from '@/components/settings/SettingsDialog';
import { Avatar, Button, Chip, Field } from '@/components/ui/primitives';
import { HOLD_ACCESS } from '@/lib/lexicon';
import { cn } from '@/lib/utils';
import { useApp } from '@/stores/app';

/** How long a work session can be opened for, from this pane. */
const DURATIONS: Array<{ label: string; ms: number | null }> = [
  { label: '15 minutes', ms: 15 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '4 hours', ms: 4 * 60 * 60 * 1000 },
  { label: 'Until I end it', ms: null },
];

/**
 * Work sessions: write access for a while, instead of a dialog per file.
 *
 * Only agents set to "Ask first" appear here. A read-only agent is not raised
 * by a session -- that is a decision about the agent itself -- and an agent
 * that already has full access has nothing to lift.
 */
export function AccessPane() {
  const agents = useApp((s) => s.agents);
  const sessions = useApp((s) => s.sessionAccess);
  const grantSessionAccess = useApp((s) => s.grantSessionAccess);
  const revokeSessionAccess = useApp((s) => s.revokeSessionAccess);

  const eligible = useMemo(
    () => agents.filter((a) => a.permissions.workspaceAccess === 'approval_required'),
    [agents],
  );

  const [agentId, setAgentId] = useState('');
  const [scope, setScope] = useState<SessionGrantScope>('agent');
  const [durationIndex, setDurationIndex] = useState(1);

  // Keep the picker on a real agent as the list changes.
  useEffect(() => {
    if (!eligible.some((a) => a.id === agentId)) setAgentId(eligible[0]?.id ?? '');
  }, [eligible, agentId]);

  const agent = eligible.find((a) => a.id === agentId);
  const directory = agent?.workingDirectory ?? '';
  const scopeForGrant: SessionGrantScope = scope === 'directory' && directory ? 'directory' : 'agent';

  return (
    <div className="space-y-5">
      <PaneHeader
        title="Write access"
        detail="An agent set to Ask first stops for approval at every write. A work session lifts that for a set time, for one agent or for everyone working in its directory. Sessions are never saved to disk: closing LoCrew always returns to asking."
      />

      <section className="space-y-3 rounded-lg border border-line bg-surface p-3">
        <p className="text-xs font-semibold text-content-strong">Open a work session</p>

        {eligible.length ? (
          <>
            <div className="grid grid-cols-[1fr_170px] gap-3">
              <Field label="Agent">
                <select
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  className="h-8 w-full rounded-md border border-line bg-surface px-2 text-xs text-content focus:border-primary focus:shadow-focus focus:outline-none"
                >
                  {eligible.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Lasts">
                <select
                  value={durationIndex}
                  onChange={(e) => setDurationIndex(Number(e.target.value))}
                  className="h-8 w-full rounded-md border border-line bg-surface px-2 text-xs text-content focus:border-primary focus:shadow-focus focus:outline-none"
                >
                  {DURATIONS.map((option, index) => (
                    <option key={option.label} value={index}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="space-y-1.5">
              <span className="text-xs font-medium text-content">Covers</span>
              <div className="grid gap-1.5 sm:grid-cols-2">
                <ScopeChoice
                  selected={scopeForGrant === 'agent'}
                  onSelect={() => setScope('agent')}
                  icon={<UserRound size={14} />}
                  title={agent ? agent.name : 'This agent'}
                  detail="This agent only."
                />
                <ScopeChoice
                  selected={scopeForGrant === 'directory'}
                  onSelect={() => setScope('directory')}
                  disabled={!directory}
                  icon={<FolderOpen size={14} />}
                  title="Its working directory"
                  detail={directory || 'This agent has no working directory.'}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-0.5">
              <p className="text-2xs text-content-muted">
                While it is open, {agent?.name ?? 'the agent'} writes and runs commands without asking.
              </p>
              <Button
                variant="primary"
                size="sm"
                disabled={!agent}
                onClick={() =>
                  agent && void grantSessionAccess(agent.id, scopeForGrant, DURATIONS[durationIndex]!.ms)
                }
              >
                <ShieldCheck size={14} />
                Start session
              </Button>
            </div>
          </>
        ) : (
          <p className="text-2xs leading-relaxed text-content-muted">
            No agent is set to <strong className="font-medium text-content">{HOLD_ACCESS.approval_required.label}</strong>.
            Sessions apply only to those; change an agent's access level in its settings to use one.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <p className="text-xs font-semibold text-content-strong">
          Open now {sessions.length ? <span className="tabular-nums text-content-faint">{sessions.length}</span> : null}
        </p>

        {sessions.length ? (
          <>
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
              {sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  agents={agents}
                  onRevoke={() => void revokeSessionAccess(session.id)}
                />
              ))}
            </ul>
            {sessions.length > 1 ? (
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => void revokeSessionAccess(null)}>
                  End all sessions
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-2xs leading-relaxed text-content-muted">
            No session is open. Every write is being approved one at a time.
          </p>
        )}
      </section>
    </div>
  );
}

function ScopeChoice({
  selected,
  disabled,
  onSelect,
  icon,
  title,
  detail,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect(): void;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors duration-fast',
        selected && !disabled
          ? 'border-primary bg-primary/[0.06] shadow-[0_0_0_1px_hsl(var(--primary)/0.35)]'
          : 'border-line hover:bg-subtle',
        disabled && 'cursor-not-allowed opacity-55 hover:bg-transparent',
      )}
    >
      <span className="mt-0.5 text-content-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold text-content-strong">{title}</span>
        <span className="block truncate font-mono text-2xs text-content-muted" title={detail}>
          {detail}
        </span>
      </span>
    </button>
  );
}

function SessionRow({
  session,
  agents,
  onRevoke,
}: {
  session: SessionWriteGrant;
  agents: Agent[];
  onRevoke(): void;
}) {
  const now = useNow(session.expiresAt !== null);
  const agent = session.agentId ? agents.find((a) => a.id === session.agentId) : undefined;
  const covered =
    session.scope === 'directory'
      ? agents.filter((a) => a.workingDirectory && session.directory && isWithin(session.directory, a.workingDirectory))
      : [];

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      {session.scope === 'agent' ? (
        <Avatar name={session.label} color={agent?.avatarColor} emoji={agent?.avatar} size={28} agent />
      ) : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-subtle text-content-muted">
          <FolderOpen size={14} />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-nav font-semibold text-content-strong" title={session.label}>
          {session.label}
        </p>
        <p className="truncate text-2xs text-content-muted">
          {session.scope === 'agent'
            ? 'This agent writes without asking'
            : `Every agent working here writes without asking${covered.length ? `: ${covered.map((a) => a.name).join(', ')}` : ''}`}
        </p>
      </div>

      <Chip tone={session.expiresAt === null ? 'warning' : 'neutral'} className="shrink-0">
        <Timer size={10} />
        {remaining(session, now)}
      </Chip>

      <Button variant="ghost" size="sm" onClick={onRevoke} className="shrink-0">
        End
      </Button>
    </li>
  );
}

/** "41m left", "6s left", or that it has no end until the operator says so. */
function remaining(session: SessionWriteGrant, now: number): string {
  if (session.expiresAt === null) return 'Until ended';
  const ms = session.expiresAt - now;
  if (ms <= 0) return 'Ending';
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
  if (minutes >= 1) return `${minutes}m left`;
  return `${Math.ceil(ms / 1000)}s left`;
}

/** A clock that ticks only while something on screen counts down. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** Mirrors the main process's rule: the directory itself, or anything inside it. */
function isWithin(parent: string, child: string): boolean {
  const normalise = (path: string) => path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const from = normalise(parent);
  const to = normalise(child);
  return to === from || to.startsWith(`${from}/`);
}
