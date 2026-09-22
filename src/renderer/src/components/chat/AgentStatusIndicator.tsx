import { ChevronUp, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, AgentExecution } from '@shared/types';
import { Avatar, PRESENCE_LABEL, type Presence } from '@/components/ui/primitives';
import { agentPresence, describeAgentActivity } from '@/lib/activity';
import { describeActivity, EXECUTION_LABEL, SHIP } from '@/lib/lexicon';
import { cn, formatDuration } from '@/lib/utils';
import { invoke, useApp } from '@/stores/app';

/** One agent at work here: its newest live run and what it is doing. */
interface ActiveAgent {
  execution: AgentExecution;
  agent?: Agent;
  name: string;
  presence: Presence;
  /** "Reading your message", "Working", "Waiting for your approval". */
  status: string;
  /** The tool in use, when there is one: "Running a command". */
  operation: string | null;
}

const PRESENCE_TEXT: Record<Presence, string> = {
  available: 'text-primary-ink',
  working: 'text-primary-ink',
  thinking: 'text-ai-ink',
  waiting: 'text-warning-ink',
  error: 'text-danger-ink',
  offline: 'text-content-faint',
};

/**
 * The line under the composer. It sums up who is working in one sentence
 * ("Claude and Codex are working…"). Clicking it opens a small panel with
 * each agent's state, current operation, elapsed time and a Stop button.
 * It keeps its height when idle, so the composer never jumps.
 */
export function AgentStatusIndicator({ conversationId }: { conversationId: string }) {
  const executions = useApp((s) => s.executions);
  const agents = useApp((s) => s.agents);
  const streams = useApp((s) => s.streams);
  const liveActivity = useApp((s) => s.liveActivity);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const active = useMemo<ActiveAgent[]>(() => {
    // One entry per agent: its most recent live run.
    const byAgent = new Map<string, AgentExecution>();
    for (const execution of executions) {
      if (execution.conversationId !== conversationId) continue;
      if (['completed', 'failed', 'cancelled'].includes(execution.state)) continue;
      const current = byAgent.get(execution.agentId);
      if (!current || current.startedAt < execution.startedAt) byAgent.set(execution.agentId, execution);
    }
    return [...byAgent.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((execution) => {
        const agent = agents.find((a) => a.id === execution.agentId);
        const records = liveActivity[execution.agentId];
        // Prefer the verified activity (the same one shown on the message);
        // runs not triggered by a message fall back to the execution state.
        const record = records?.find((r) => r.executionId === execution.id);
        const described = record
          ? describeAgentActivity(record, { fromHuman: execution.trigger === 'human' })
          : null;
        const tool = describeActivity(streams[execution.id]?.tool);
        return {
          execution,
          agent,
          name: agent?.name ?? 'Agent',
          presence: agent ? agentPresence(agent, record ? [record] : undefined, true) : 'working',
          status: described?.status ?? EXECUTION_LABEL[execution.state],
          operation: described?.operation ?? tool ?? null,
        };
      });
  }, [executions, agents, streams, liveActivity, conversationId]);

  // Nothing left to show: fold the panel away with it.
  useEffect(() => {
    if (!active.length) setOpen(false);
  }, [active.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const stopAll = () => void invoke('executions:cancelConversation', { conversationId });
  const waiting = active.filter((a) => a.presence === 'waiting');

  return (
    <div ref={rootRef} className="relative flex h-9 shrink-0 items-center gap-3 px-5" aria-live="polite">
      {active.length ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(
              '-ml-1.5 flex h-7 min-w-0 animate-fade-in items-center gap-2 rounded-md pl-1.5 pr-2 text-left transition-colors duration-fast hover:bg-subtle',
              open && 'bg-subtle',
            )}
          >
            <span className="flex shrink-0 items-center" aria-hidden>
              {active.slice(0, 3).map(({ execution, agent, name }, index) => (
                <span
                  key={execution.id}
                  className={cn('rounded-[5px] ring-2 ring-canvas', index > 0 && '-ml-1')}
                  style={{ zIndex: 3 - index }}
                >
                  <Avatar name={name} color={agent?.avatarColor} emoji={agent?.avatar} size={16} agent />
                </span>
              ))}
            </span>
            <LiveDot presence={waiting.length === active.length ? 'waiting' : active[0]!.presence} />
            <span className="truncate text-xs text-content-muted">{summarise(active)}</span>
            {waiting.length && waiting.length < active.length ? (
              <span className="shrink-0 text-xs font-medium text-warning-ink">
                · {waiting.length === 1 ? `${waiting[0]!.name} needs you` : `${waiting.length} need you`}
              </span>
            ) : null}
            <ChevronUp
              size={13}
              className={cn('shrink-0 text-content-faint transition-transform duration-base', !open && 'rotate-180')}
              aria-hidden
            />
          </button>

          <button
            type="button"
            onClick={stopAll}
            className="ml-auto flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-content-muted transition-colors duration-fast hover:bg-danger/[0.07] hover:text-danger-ink"
            title="Stop every agent working in this conversation"
          >
            <Square size={8} fill="currentColor" strokeWidth={0} />
            {active.length > 1 ? 'Stop all' : SHIP.actions.stop}
          </button>

          {open ? <ActivityPopover active={active} onStopAll={stopAll} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** "Codex is running a command…", "Claude and Codex are working…". */
export function summarise(active: Array<Pick<ActiveAgent, 'name' | 'status' | 'operation' | 'presence'>>): string {
  if (active.length === 1) {
    const only = active[0]!;
    const doing = only.operation ?? only.status;
    if (doing.startsWith('Needs ')) return `${only.name} ${lowerFirst(doing)}`;
    const phrase = doing.startsWith('Received')
      ? doing.includes('workspace')
        ? 'waiting for the workspace'
        : 'starting'
      : doing === EXECUTION_LABEL.thinking
        ? 'working'
        : lowerFirst(doing);
    return `${only.name} is ${phrase}${only.presence === 'waiting' ? '' : '…'}`;
  }
  const names = active.map((a) => a.name);
  const list =
    names.length === 2
      ? `${names[0]} and ${names[1]}`
      : names.length === 3
        ? `${names[0]}, ${names[1]} and ${names[2]}`
        : `${names[0]}, ${names[1]} and ${names.length - 2} more`;
  return `${list} are working…`;
}

function lowerFirst(text: string): string {
  // "Waiting for your approval" -> "waiting for your approval"; leave "MCP" alone.
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/** A small dot in the state's colour; it pulses only while work is happening. */
function LiveDot({ presence }: { presence: Presence }) {
  const colour = presence === 'waiting' ? 'bg-warning' : presence === 'thinking' ? 'bg-ai' : 'bg-primary';
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
      {presence === 'working' ? <span className={cn('absolute inset-0 animate-pulse-ring rounded-full', colour)} /> : null}
      <span className={cn('relative h-1.5 w-1.5 rounded-full', colour)} />
    </span>
  );
}

/** Each active agent: state, operation, how long it has been going, and Stop. */
function ActivityPopover({ active, onStopAll }: { active: ActiveAgent[]; onStopAll(): void }) {
  const now = useNow(1000);
  return (
    <div
      role="dialog"
      aria-label="Agents working here"
      className="absolute bottom-full left-4 z-dropdown mb-1 w-[380px] animate-pop-in overflow-hidden rounded-lg border border-line bg-surface shadow-popover"
    >
      <div className="flex h-9 items-center justify-between border-b border-line px-3">
        <p className="text-[10px] font-semibold uppercase tracking-label text-content-faint">Working here</p>
        <span className="text-2xs tabular-nums text-content-faint">
          {active.length} {active.length === 1 ? 'agent' : 'agents'}
        </span>
      </div>
      <ul className="max-h-[280px] overflow-y-auto p-1">
        {active.map(({ execution, agent, name, presence, status, operation }) => (
          <li key={execution.id} className="flex items-center gap-2.5 rounded-md px-2 py-2 hover:bg-subtle/70">
            <Avatar
              name={name}
              color={agent?.avatarColor}
              emoji={agent?.avatar}
              size={28}
              agent
              presence={presence}
            />
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-1.5">
                <bdi className="truncate text-nav font-semibold text-content-strong">{name}</bdi>
                <span className={cn('shrink-0 text-2xs font-medium', PRESENCE_TEXT[presence])}>
                  {presence === 'waiting' ? status : PRESENCE_LABEL[presence]}
                </span>
              </p>
              <p className="truncate text-2xs text-content-muted" title={operation ?? status}>
                {operation ?? status}
              </p>
            </div>
            <span className="shrink-0 text-2xs tabular-nums text-content-faint" title="Time since this run started">
              {formatDuration(Math.max(0, now - execution.startedAt))}
            </span>
            <button
              type="button"
              onClick={() => void invoke('executions:cancel', { executionId: execution.id })}
              aria-label={`Stop ${name}`}
              title={`Stop ${name}`}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors duration-fast hover:bg-danger/[0.08] hover:text-danger-ink"
            >
              <Square size={9} fill="currentColor" strokeWidth={0} />
            </button>
          </li>
        ))}
      </ul>
      {active.length > 1 ? (
        <div className="flex justify-end border-t border-line px-2 py-1.5">
          <button
            type="button"
            onClick={onStopAll}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-danger-ink transition-colors duration-fast hover:bg-danger/[0.07]"
          >
            <Square size={8} fill="currentColor" strokeWidth={0} />
            Stop all
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The current time, refreshed on an interval while mounted: for elapsed-time labels. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
