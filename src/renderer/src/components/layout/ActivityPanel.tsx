import { Check, ChevronRight, Loader2, Square, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Agent, AgentEvent, AgentExecution, Message } from '@shared/types';
import { Avatar, PRESENCE_LABEL, StatusDot, isTerminal, type Presence } from '@/components/ui/primitives';
import { SidePanelHeader } from '@/components/layout/RightPanel';
import { agentPresence, describeAgentActivity } from '@/lib/activity';
import { describeActivity, EXECUTION_LABEL, SHIP } from '@/lib/lexicon';
import { cn, formatDuration, formatUsd, formatWhen, plainPreview } from '@/lib/utils';
import { invoke, useApp } from '@/stores/app';

const NO_MESSAGES: Message[] = [];

/**
 * The agents at work in this conversation right now -- their task, state
 * and latest tool steps -- and below them every earlier run, newest first.
 * Everything comes from the orchestrator's event log; nothing here shows a
 * model's private reasoning.
 */
export function ActivityPanel({ conversationId }: { conversationId: string }) {
  const executions = useApp((s) => s.executions);
  const agents = useApp((s) => s.agents);
  const messages = useApp((s) => s.messages[conversationId]) ?? NO_MESSAGES;
  const setPanel = useApp((s) => s.setPanel);
  const [openId, setOpenId] = useState<string | null>(null);

  const runs = useMemo(
    () =>
      executions
        .filter((e) => e.conversationId === conversationId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 50),
    [executions, conversationId],
  );
  const live = runs.filter((run) => !isTerminal(run.state));
  const past = runs.filter((run) => isTerminal(run.state));
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const messageById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  return (
    <div className="flex h-full w-[300px] flex-col">
      <SidePanelHeader title={SHIP.panel.activity} onClose={() => setPanel(null)} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {live.length ? (
          <section className="px-3 pb-3">
            <SectionLabel count={live.length}>Active now</SectionLabel>
            <div className="space-y-2">
              {live.map((run) => (
                <LiveRunCard
                  key={run.id}
                  run={run}
                  agent={agentById.get(run.agentId)}
                  task={run.triggeredByMessageId ? messageById.get(run.triggeredByMessageId) : undefined}
                />
              ))}
            </div>
          </section>
        ) : null}

        <section className="px-3">
          <SectionLabel count={past.length || undefined}>{live.length ? 'Recent runs' : 'Runs'}</SectionLabel>
          {past.length ? (
            <div className="-mx-1">
              {past.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  agent={agentById.get(run.agentId)}
                  open={openId === run.id}
                  onToggle={() => setOpenId((current) => (current === run.id ? null : run.id))}
                />
              ))}
            </div>
          ) : (
            <p className="py-1 text-xs leading-relaxed text-content-faint">
              {live.length
                ? 'Finished runs appear here.'
                : 'No agent runs yet. Mention an agent to put it to work; each run shows up here.'}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function SectionLabel({ children, count }: { children: string; count?: number }) {
  return (
    <p className="flex h-8 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-label text-content-faint">
      {children}
      {count ? <span className="tabular-nums text-content-faint/80">{count}</span> : null}
    </p>
  );
}

const PRESENCE_TEXT: Record<Presence, string> = {
  available: 'text-primary-ink',
  working: 'text-primary-ink',
  thinking: 'text-ai-ink',
  waiting: 'text-warning-ink',
  error: 'text-danger-ink',
  offline: 'text-content-faint',
};

/** One agent at work: what it was asked, what it is doing, its last steps. */
function LiveRunCard({ run, agent, task }: { run: AgentExecution; agent?: Agent; task?: Message }) {
  const record = useApp((s) => s.liveActivity[run.agentId]?.find((r) => r.executionId === run.id));
  const tool = useApp((s) => s.streams[run.id]?.tool);
  const events = useRunEvents(run.id, true);
  const now = useNow(true);
  const name = agent?.name ?? 'Agent';

  const described = record ? describeAgentActivity(record, { fromHuman: run.trigger === 'human' }) : null;
  const presence: Presence = agent ? agentPresence(agent, record ? [record] : undefined, true) : 'working';
  const operation = described?.operation ?? describeActivity(tool) ?? null;
  const steps = useMemo(() => toolSteps(events ?? []), [events]);
  const recent = steps.slice(-3);

  return (
    <article className="animate-fade-in rounded-lg border border-line bg-surface p-3 shadow-[0_1px_2px_rgb(15_23_42/0.04)]">
      <div className="flex items-center gap-2.5">
        <Avatar name={name} color={agent?.avatarColor} emoji={agent?.avatar} size={28} agent presence={presence} />
        <div className="min-w-0 flex-1">
          <bdi className="block truncate text-nav font-semibold text-content-strong">{name}</bdi>
          <p className={cn('truncate text-2xs font-medium', PRESENCE_TEXT[presence])}>
            {presence === 'waiting' ? described?.status : PRESENCE_LABEL[presence]}
            <span className="font-normal text-content-faint"> · {formatDuration(Math.max(0, now - run.startedAt))}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => void invoke('executions:cancel', { executionId: run.id })}
          aria-label={`Stop ${name}`}
          title={`Stop ${name}`}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors duration-fast hover:bg-danger/[0.08] hover:text-danger-ink"
        >
          <Square size={9} fill="currentColor" strokeWidth={0} />
        </button>
      </div>

      {task ? (
        <p className="mt-2.5 rounded-md bg-subtle px-2 py-1.5 text-2xs leading-4 text-content" title={task.body}>
          <span className="line-clamp-2">{plainPreview(task.body, 160)}</span>
        </p>
      ) : null}

      {recent.length || operation ? (
        <ol className="mt-2.5 space-y-1" aria-label="Recent steps">
          {recent.map((step) => (
            <StepLine key={step.id} label={step.label} done={step.done} failed={step.failed} />
          ))}
          {/* Until the event log catches up, the live activity names the tool in use. */}
          {operation && !recent.length ? <StepLine label={operation} done={false} /> : null}
        </ol>
      ) : null}
    </article>
  );
}

/** One tool step: a check once it returned, a teal dot while it runs. */
function StepLine({ label, done, failed }: { label: string; done: boolean; failed?: boolean }) {
  return (
    <li
      className={cn(
        'flex min-w-0 items-center gap-1.5 text-2xs',
        done ? 'text-content-muted' : 'font-medium text-content-strong',
      )}
    >
      <span className="flex h-[11px] w-[11px] shrink-0 items-center justify-center">
        {done && failed ? (
          <X size={11} strokeWidth={2.4} className="text-danger" aria-label="Failed" />
        ) : done ? (
          <Check size={11} strokeWidth={2.4} className="text-success" aria-label="Done" />
        ) : (
          <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-primary" aria-label="In progress" />
        )}
      </span>
      <span className="truncate" title={label}>
        {label}
      </span>
    </li>
  );
}

/**
 * Tool calls from the event log, each marked done once its result arrived.
 * Results name the call they answer; runtimes that give no id answer the
 * oldest open call.
 */
function toolSteps(events: AgentEvent[]): Array<{ id: string; label: string; done: boolean; failed: boolean }> {
  const steps: Array<{ id: string; toolUseId: unknown; label: string; done: boolean; failed: boolean }> = [];
  for (const event of events) {
    if (event.type === 'tool_use') {
      const raw = String(event.payload['name'] ?? 'tool');
      const name = raw.split('__').pop() || raw;
      steps.push({
        id: event.id,
        toolUseId: event.payload['toolUseId'] ?? null,
        label: describeActivity(raw) ? `${describeActivity(raw)} · ${name}` : `Using ${name}`,
        done: false,
        failed: false,
      });
    } else if (event.type === 'tool_result') {
      const id = event.payload['toolUseId'];
      const step =
        (id ? steps.find((s) => !s.done && s.toolUseId === id) : undefined) ?? steps.find((s) => !s.done);
      if (step) {
        step.done = true;
        step.failed = event.payload['isError'] === true;
      }
    }
  }
  return steps;
}

function RunRow({
  run,
  agent,
  open,
  onToggle,
}: {
  run: AgentExecution;
  agent?: Agent;
  open: boolean;
  onToggle(): void;
}) {
  const name = agent?.name ?? 'Agent';
  const duration = (run.endedAt ?? run.startedAt) - run.startedAt;

  return (
    <div className="border-b border-line last:border-0">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="group flex w-full items-center gap-2.5 rounded-md px-1 py-2 text-left transition-colors duration-fast hover:bg-subtle/70"
      >
        <Avatar name={name} color={agent?.avatarColor} emoji={agent?.avatar} size={24} agent />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <bdi className="truncate text-xs font-semibold text-content-strong">{name}</bdi>
            <StatusDot state={run.state} />
            <span className="truncate text-2xs text-content-muted">{EXECUTION_LABEL[run.state]}</span>
          </span>
          <span className="block truncate text-2xs text-content-faint">
            {formatWhen(run.startedAt)} · {formatDuration(Math.max(0, duration))}
            {run.turns ? ` · ${run.turns} turns` : ''}
            {run.costUsd ? ` · ${formatUsd(run.costUsd)}` : ''}
            {run.trigger === 'agent' ? ' · by an agent' : ''}
          </span>
        </span>
        <ChevronRight
          size={13}
          className={cn('shrink-0 text-content-faint transition-transform duration-base', open && 'rotate-90')}
        />
      </button>

      {open ? <RunDetail run={run} /> : null}
    </div>
  );
}

function RunDetail({ run }: { run: AgentExecution }) {
  const events = useRunEvents(run.id, false);
  const steps = useMemo(() => (events ?? []).map(describeEvent).filter(Boolean) as Step[], [events]);

  return (
    <div className="animate-fade-in pb-2.5 pl-[38px] pr-1">
      {run.error ? (
        <p className="selectable mb-1.5 rounded-md border border-danger/20 bg-danger/[0.05] px-2 py-1.5 text-2xs leading-relaxed text-danger-ink">
          {run.error}
        </p>
      ) : null}

      {events === null ? (
        <p className="flex items-center gap-1.5 py-1 text-2xs text-content-faint">
          <Loader2 size={11} className="animate-spin" /> Loading steps
        </p>
      ) : steps.length ? (
        <ol className="space-y-1 border-s border-line ps-2.5">
          {steps.slice(-40).map((step, index) => (
            <li key={index} className="min-w-0">
              <span
                className={cn(
                  'block truncate text-2xs',
                  step.tone === 'error' ? 'text-danger-ink' : 'text-content',
                )}
                title={step.detail ?? step.label}
              >
                {step.label}
              </span>
              {step.detail ? (
                <span className="block truncate font-mono text-[10.5px] leading-4 text-content-faint">
                  {step.detail}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="py-1 text-2xs text-content-faint">No tool calls recorded.</p>
      )}
    </div>
  );
}

/** A run's event log; a live run keeps writing events, so it is polled gently until it ends. */
function useRunEvents(executionId: string, live: boolean): AgentEvent[] | null {
  const [events, setEvents] = useState<AgentEvent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      invoke('executions:events', { executionId })
        .then((list) => !cancelled && setEvents(list))
        .catch(() => !cancelled && setEvents([]));
    void load();
    const timer = live ? setInterval(() => void load(), 2000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [executionId, live]);
  return events;
}

/** The current time, refreshed each second while `running`: for elapsed-time labels. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

interface Step {
  label: string;
  detail?: string;
  tone?: 'error';
}

function describeEvent(event: AgentEvent): Step | null {
  const payload = event.payload;
  switch (event.type) {
    case 'tool_use': {
      const raw = String(payload['name'] ?? 'tool');
      const name = raw.startsWith('mcp__') ? (raw.split('__').pop() ?? raw) : raw;
      const input = (payload['input'] ?? {}) as Record<string, unknown>;
      const detail =
        typeof input['command'] === 'string'
          ? input['command']
          : typeof input['file_path'] === 'string'
            ? input['file_path']
            : typeof input['pattern'] === 'string'
              ? input['pattern']
              : undefined;
      return { label: name, detail: detail as string | undefined };
    }
    case 'error':
      return { label: String(payload['message'] ?? 'Error'), tone: 'error' };
    case 'compaction':
      return { label: 'Compacted its context' };
    default:
      return null;
  }
}
