import {
  ChevronRight,
  FolderOpen,
  Lock,
  Plus,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  RefreshCw,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { RuntimeType, Task } from '@shared/types';
import type { QuotaSnapshot } from '@shared/quota';
import {
  Avatar,
  Button,
  Chip,
  Field,
  Input,
  Modal,
  PRESENCE_LABEL,
} from '@/components/ui/primitives';
import { agentPresence, describeAgentActivity } from '@/lib/activity';
import { RUNTIME_LABEL, engineLabel } from '@/lib/agents';
import { HOLD_ACCESS, SHIP, TASK_LABEL } from '@/lib/lexicon';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { displayNameOf } from '@/lib/people';
import { cn, formatUsd } from '@/lib/utils';
import { invoke, useApp } from '@/stores/app';
import { QuotaSection } from '@/components/usage/QuotaBars';
import { UsageChips, describeTotal } from '@/components/usage/RecordedUsage';

/** Before the first summary arrives there is nothing known to be missing. */
const NO_COVERAGE = { unverifiedExecutions: 0, unavailableExecutions: 0, unpricedExecutions: 0 };

/** Shared empty arrays so selectors never hand React a new reference. */
const NO_TASKS: Task[] = [];
const NO_IDS: string[] = [];

/** Who is here, what they have been asked to do, where they work, what it cost. */
export function RightPanel({ conversationId }: { conversationId: string }) {
  const conversation = useApp((s) => s.conversations.find((c) => c.id === conversationId));
  const agents = useApp((s) => s.agents);
  const providers = useApp((s) => s.providers);
  // The fallback must be a stable reference: a fresh `[]` inside the selector
  // fails zustand's Object.is check on every render and loops forever.
  // tests/renderer/selector-stability.test.tsx fails if this regresses.
  const tasks = useApp((s) => s.tasks[conversationId]) ?? NO_TASKS;
  const executions = useApp((s) => s.executions);
  const locks = useApp((s) => s.locks);
  const costs = useApp((s) => s.costs);
  const settings = useApp((s) => s.settings);
  const refreshCosts = useApp((s) => s.refreshCosts);
  const quota = useApp((s) => s.quota);
  const quotaRefreshing = useApp((s) => s.quotaRefreshing);
  const refreshQuota = useApp((s) => s.refreshQuota);
  const setEditingAgent = useApp((s) => s.setEditingAgent);
  const setPanel = useApp((s) => s.setPanel);
  const liveActivity = useApp((s) => s.liveActivity);

  // Membership lives in the store so the channel header and this panel can
  // never disagree about who is here.
  const memberIds = useApp((s) => s.conversationMemberIds[conversationId]) ?? NO_IDS;
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  // Keyed on what actually changes when spend changes, not on how many runs
  // exist: a cost update, or a run finishing without the list length moving,
  // still has to reach the chips.
  const executionSignature = useMemo(
    () => executions.map((e) => `${e.id}:${e.state}:${e.costUsd}`).join('|'),
    [executions],
  );

  useEffect(() => {
    void refreshCosts();
  }, [executionSignature, refreshCosts]);

  // Recorded totals are attributed by the day a run started, so they change
  // when local midnight passes even if nothing ran. Refreshing on focus is what
  // keeps "Today" from staying on yesterday's number in a window left open.
  useEffect(() => {
    const onFocus = () => {
      void refreshCosts();
      // Not forced: an unexpired reading is returned from cache, so returning
      // to the window does not hit a provider.
      void refreshQuota(false);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshCosts, refreshQuota]);

  // "Today" is a local calendar window, so it changes at midnight even when
  // nothing ran and nobody touched the window. A focused app left open would
  // otherwise keep showing yesterday.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const scheduleMidnight = () => {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      timer = setTimeout(() => {
        void refreshCosts();
        scheduleMidnight();
      }, Math.max(1000, midnight - now.getTime()));
    };
    scheduleMidnight();
    return () => clearTimeout(timer);
  }, [refreshCosts]);

  // Opening the panel is what triggers the first read: an app whose panel is
  // never opened never asks a provider anything.
  //
  // The interval then keeps a panel left open from silently ageing. It is not
  // forced, so it costs nothing until the cache expires -- main answers from
  // cache and the provider is only asked once the TTL is past.
  useEffect(() => {
    void refreshQuota(false);
    const timer = setInterval(() => void refreshQuota(false), 60_000);
    return () => clearInterval(timer);
  }, [refreshQuota]);

  const members = useMemo(
    () => agents.filter((a) => memberIds.includes(a.id)),
    [agents, memberIds],
  );
  const localMembers = useMemo(() => members.filter((a) => a.workingDirectory), [members]);

  /** Agents that exist but are not in this conversation yet. */
  const available = useMemo(
    () => agents.filter((a) => !memberIds.includes(a.id)),
    [agents, memberIds],
  );

  const stateByAgent = useMemo(() => {
    const map = new Map<string, (typeof executions)[number]>();
    for (const execution of executions) {
      if (execution.conversationId !== conversationId) continue;
      if (['completed', 'failed', 'cancelled'].includes(execution.state)) continue;
      map.set(execution.agentId, execution);
    }
    return map;
  }, [executions, conversationId]);

  /**
   * Quota is per login, so it is shown once per runtime present here, never
   * once per agent. The count is how many LoCrew agents share it -- not a count
   * of everything drawing on the account, which we cannot know.
   */
  const quotaRuntimes = useMemo(() => {
    const counts = new Map<RuntimeType, number>();
    for (const agent of members) counts.set(agent.runtimeType, (counts.get(agent.runtimeType) ?? 0) + 1);
    return [...counts.entries()]
      .map(([runtimeType, agentCount]) => ({ runtimeType, agentCount, snapshot: quota[runtimeType] }))
      .filter(
        (entry): entry is { runtimeType: RuntimeType; agentCount: number; snapshot: QuotaSnapshot } =>
          entry.snapshot !== undefined,
      );
  }, [members, quota]);

  /**
   * Measured spend in this conversation, on the same basis as every other
   * figure on screen. A run whose spend was never established contributes
   * nothing to the number and is counted separately, so the row can say it is a
   * floor rather than quietly reading as a total.
   */
  const conversationSpend = useMemo(() => {
    let measuredUsd = 0;
    let unverified = 0;
    let unavailable = 0;
    let unpriced = 0;
    for (const execution of executions) {
      if (execution.conversationId !== conversationId) continue;
      if (execution.costProvenance === 'measured') measuredUsd += execution.costUsd;
      else if (execution.costProvenance === 'unpriced') unpriced += 1;
      else if (execution.costProvenance === 'unreported') {
        // Counted once the run is over. Tokens cannot be the test: they are
        // written by the same event as the cost, so their absence is the same
        // absence rather than evidence about it.
        if (execution.endedAt !== null) unavailable += 1;
      } else unverified += 1;
    }
    return {
      measuredUsd,
      coverage: {
        unverifiedExecutions: unverified,
        unavailableExecutions: unavailable,
        unpricedExecutions: unpriced,
      },
    };
  }, [executions, conversationId]);

  if (!conversation) return null;
  const isChannel = conversation.kind === 'channel';
  const humanName = displayNameOf(settings);

  return (
    <div className="flex h-full w-[300px] flex-col">
      <SidePanelHeader title={SHIP.panel.title} onClose={() => setPanel(null)} />

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {conversation.topic ? (
          <Group title={SHIP.panel.about}>
            <p className="bidi-isolate selectable px-1 text-xs leading-[19px] text-content">
              {conversation.topic}
            </p>
          </Group>
        ) : null}

        <Group
          title={SHIP.panel.members}
          count={members.length + 1}
          action={
            isChannel && available.length ? (
              <GroupAction label={SHIP.actions.addAgent} onClick={() => setAddOpen(true)}>
                <UserPlus size={13} />
              </GroupAction>
            ) : null
          }
        >
          <div className="flex h-10 items-center gap-2.5 rounded-md px-1.5">
            <UserAvatar size={26} presence="available" />
            <span className="bidi-isolate flex-1 truncate text-xs font-medium text-content-strong">
              {humanName}
            </span>
            <span className="text-2xs text-content-faint">you</span>
          </div>
          {members.map((agent) => {
            const execution = stateByAgent.get(agent.id);
            // What it is doing here, from its live activity in this conversation.
            const record = execution
              ? liveActivity[agent.id]?.find((r) => r.executionId === execution.id)
              : undefined;
            const presence = agentPresence(agent, record ? [record] : undefined, !!execution);
            const doing = record
              ? describeAgentActivity(record, { fromHuman: execution?.trigger === 'human' })
              : null;
            return (
              <div
                key={agent.id}
                className="group flex min-h-10 items-start gap-2.5 rounded-md px-1.5 py-1.5 transition-colors duration-fast hover:bg-subtle"
              >
                <Avatar
                  name={agent.name}
                  color={agent.avatarColor}
                  emoji={agent.avatar}
                  size={26}
                  agent
                  presence={presence}
                />
                <button
                  onClick={() => setEditingAgent(agent.id)}
                  className="min-w-0 flex-1 text-left"
                  title={`Edit ${agent.name}`}
                >
                  <bdi className="block truncate text-xs font-medium text-content-strong">
                    {agent.name}
                  </bdi>
                  <p
                    className={cn(
                      'truncate text-2xs leading-4',
                      presence === 'working' ? 'text-primary-ink'
                        : presence === 'thinking' ? 'text-ai-ink'
                          : presence === 'waiting' ? 'text-warning-ink'
                            : presence === 'error' ? 'text-danger-ink'
                              : 'text-content-faint',
                    )}
                  >
                    {doing ? (doing.operation ?? doing.status) : PRESENCE_LABEL[presence]}
                  </p>
                  {/* Recorded consumption, not this agent's share of the quota
                      above: an agent has no private slice of an account-wide
                      allowance, so no bar is drawn here. */}
                  <UsageChips agent={agent} windows={costs?.windows} className="mt-1" />
                </button>
                {isChannel ? (
                  <button
                    onClick={() =>
                      void invoke('conversations:removeAgent', { conversationId, agentId: agent.id })
                    }
                    className="flex h-6 w-6 items-center justify-center rounded-md text-content-faint opacity-0 transition-[opacity,color] duration-fast hover:bg-danger/[0.07] hover:text-danger-ink focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={`${SHIP.actions.removeAgent}: ${agent.name}`}
                    title={SHIP.actions.removeAgent}
                  >
                    <UserMinus size={12} />
                  </button>
                ) : null}
              </div>
            );
          })}
          {!members.length ? (
            <Hint>
              {isChannel ? 'No agents here yet. Use + to add one.' : 'No agent in this conversation.'}
            </Hint>
          ) : null}
        </Group>

        <Group
          title={SHIP.panel.tasks}
          count={tasks.length}
          action={
            <GroupAction label="New task" onClick={() => setTaskDialogOpen(true)}>
              <Plus size={13} />
            </GroupAction>
          }
        >
          {tasks.length ? (
            tasks.map((task) => <TaskRow key={task.id} task={task} />)
          ) : (
            <Hint>No tasks yet. Create one to track work across agents.</Hint>
          )}
        </Group>

        <Group title={SHIP.panel.directories} count={localMembers.length}>
          {localMembers.map((agent) => {
            const lock = locks.find((l) => l.agentId === agent.id);
            return (
              <div key={agent.id} className="px-1.5 py-1.5">
                <div className="flex items-center gap-1.5">
                  <FolderOpen size={12} className="shrink-0 text-content-faint" />
                  <span
                    className="truncate font-mono text-2xs text-content-muted"
                    title={agent.workingDirectory}
                  >
                    {agent.workingDirectory}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 pl-[18px]">
                  <Chip
                    tone={
                      agent.permissions.workspaceAccess === 'read_write'
                        ? 'warning'
                        : agent.permissions.workspaceAccess === 'read_only'
                          ? 'neutral'
                          : 'primary'
                    }
                  >
                    <ShieldCheck size={10} />
                    {HOLD_ACCESS[agent.permissions.workspaceAccess].label}
                  </Chip>
                  {lock ? (
                    <Chip tone="warning">
                      <Lock size={9} />
                      writing
                    </Chip>
                  ) : null}
                </div>
              </div>
            );
          })}
          {!localMembers.length ? (
            <Hint>{members.length ? 'Only Claude Code and Codex agents work in a directory.' : 'No agents, so no directories.'}</Hint>
          ) : null}
          {locks.length ? (
            <Hint>Only one agent may write to a directory at a time.</Hint>
          ) : null}
        </Group>

        <Group
          title="Provider usage"
          action={
            <GroupAction
              label={quotaRefreshing ? 'Refreshing usage' : 'Refresh usage'}
              onClick={() => void refreshQuota(true)}
            >
              <RefreshCw size={12} className={quotaRefreshing ? 'animate-spin' : undefined} />
            </GroupAction>
          }
        >
          {quotaRuntimes.length ? (
            quotaRuntimes.map(({ runtimeType, snapshot, agentCount }) => (
              <QuotaSection
                key={runtimeType}
                title={RUNTIME_LABEL[runtimeType]}
                snapshot={snapshot}
                agentCount={agentCount}
              />
            ))
          ) : (
            <Hint>
              No agent here runs on a subscription plan, so there is no provider quota to show.
            </Hint>
          )}
        </Group>

        <Group title={SHIP.panel.spend}>
          <SpendRow
            label={isChannel ? 'This channel' : 'This conversation'}
            {...describeTotal(conversationSpend.measuredUsd, conversationSpend.coverage)}
          />
          <SpendRow
            label="Last 24 hours"
            {...describeTotal(costs?.last24hUsd ?? 0, costs?.last24hCoverage ?? NO_COVERAGE)}
          />
          <SpendRow
            label="All time"
            {...describeTotal(costs?.totalUsd ?? 0, costs?.totalCoverage ?? NO_COVERAGE)}
          />
          <Hint>
            Recorded by LoCrew and estimated from runtime reports, not a billing statement. Separate
            from the provider percentages above, which measure a plan allowance this app does not
            control.
          </Hint>
        </Group>
      </div>

      <NewTaskDialog
        open={taskDialogOpen}
        onOpenChange={setTaskDialogOpen}
        conversationId={conversationId}
        members={members}
      />

      <Modal
        open={addOpen}
        onOpenChange={setAddOpen}
        title={`Add an agent to #${conversation.name}`}
        description="Agents you add can be mentioned here and can address the other agents in this channel."
        width={420}
      >
        <div className="space-y-1">
          {available.map((agent) => (
            <button
              key={agent.id}
              onClick={async () => {
                await invoke('conversations:addAgent', { conversationId, agentId: agent.id });
                setAddOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors duration-fast hover:bg-subtle"
            >
              <Avatar name={agent.name} color={agent.avatarColor} emoji={agent.avatar} size={28} agent />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-content-strong">
                  {agent.name}
                </span>
                <span className="block truncate text-2xs text-content-faint">
                  {engineLabel(agent, providers)}
                  {agent.workingDirectory ? ` · ${agent.workingDirectory}` : ''}
                </span>
              </span>
              <Plus size={14} className="text-content-faint" />
            </button>
          ))}
          {!available.length ? (
            <p className="py-3 text-center text-xs text-content-faint">
              Every agent is already in this channel.
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}

/** Title row shared by the side panels: same height as the conversation header. */
export function SidePanelHeader({ title, onClose }: { title: string; onClose(): void }) {
  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-line pl-4 pr-3">
      <h2 className="text-nav font-semibold text-content-strong">{title}</h2>
      <button
        onClick={onClose}
        aria-label={`Close ${title.toLowerCase()}`}
        className="flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors duration-fast hover:bg-subtle hover:text-content-strong"
      >
        <X size={15} />
      </button>
    </header>
  );
}

/** A collapsible panel section with a count on the right. */
function Group({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="px-2.5 pb-2 pt-2">
      <div className="group/g flex h-7 items-center justify-between gap-1">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex h-7 flex-1 items-center gap-1 rounded-md px-1.5 text-left"
        >
          <span className="text-[10px] font-semibold uppercase tracking-label text-content-faint">{title}</span>
          {count !== undefined ? (
            <span className="text-[10px] font-semibold tabular-nums text-content-faint/80">{count}</span>
          ) : null}
          <ChevronRight
            size={11}
            className={cn(
              'text-content-faint opacity-0 transition-[transform,opacity] duration-base group-hover/g:opacity-100',
              open && 'rotate-90',
            )}
          />
        </button>
        {action}
      </div>
      {open ? <div className="mt-0.5">{children}</div> : null}
    </section>
  );
}

function GroupAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 items-center justify-center rounded-md text-content-muted transition-colors duration-fast hover:bg-subtle hover:text-content-strong"
    >
      {children}
    </button>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="px-1.5 py-1.5 text-2xs leading-relaxed text-content-faint">{children}</p>;
}

/** A spend figure that can say what it does not cover. */
function SpendRow({ label, text, note }: { label: string; text: string; note: string | null }) {
  return (
    <div className="flex h-7 items-center justify-between px-1.5" title={note ?? undefined}>
      <span className="text-xs text-content-muted">{label}</span>
      <span
        className={cn(
          'text-xs font-medium tabular-nums',
          note ? 'text-warning-ink' : 'text-content-strong',
        )}
      >
        {text}
      </span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-7 items-center justify-between px-1.5">
      <span className="text-xs text-content-muted">{label}</span>
      <span className="text-xs font-medium tabular-nums text-content-strong">{value}</span>
    </div>
  );
}

const TASK_TONE = {
  pending: 'neutral',
  in_progress: 'primary',
  waiting: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
} as const;

function TaskRow({ task }: { task: Task }) {
  const agents = useApp((s) => s.agents);
  const assignees = agents.filter((a) => task.assignedAgentIds.includes(a.id));

  return (
    <div className="group rounded-md px-1.5 py-1.5 transition-colors duration-fast hover:bg-subtle">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <bdi
            className={cn(
              'block truncate text-xs text-content-strong',
              task.status === 'completed' && 'text-content-muted line-through',
            )}
          >
            {task.title}
          </bdi>
          <div className="mt-1 flex items-center gap-1.5">
            <Chip tone={TASK_TONE[task.status]}>{TASK_LABEL[task.status]}</Chip>
            <div className="flex -space-x-1">
              {assignees.map((agent) => (
                <Avatar
                  key={agent.id}
                  name={agent.name}
                  color={agent.avatarColor}
                  emoji={agent.avatar}
                  size={16}
                  agent
                  className="ring-[1.5px] ring-canvas"
                />
              ))}
            </div>
          </div>
        </div>
        <button
          onClick={() => void invoke('tasks:delete', { id: task.id })}
          className="flex h-6 w-6 items-center justify-center rounded-md text-content-faint opacity-0 transition-[opacity,color] duration-fast hover:bg-danger/[0.07] hover:text-danger-ink focus-visible:opacity-100 group-hover:opacity-100"
          aria-label="Delete task"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function NewTaskDialog({
  open,
  onOpenChange,
  conversationId,
  members,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  conversationId: string;
  members: ReturnType<typeof useApp.getState>['agents'];
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigned, setAssigned] = useState<string[]>([]);

  const create = async () => {
    if (!title.trim()) return;
    await invoke('tasks:create', {
      conversationId,
      title: title.trim(),
      description: description.trim(),
      assignedAgentIds: assigned,
    });
    setTitle('');
    setDescription('');
    setAssigned([]);
    onOpenChange(false);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="New task" width={460}>
      <div className="space-y-4">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Build authentication" />
        </Field>
        <Field label="Description" hint="Shown to agents through the get_channel_context tool.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-md border border-line bg-surface px-3 py-2 text-nav text-content-strong placeholder:text-content-faint transition-[border-color,box-shadow] duration-fast hover:border-line-strong focus:border-primary focus:shadow-focus focus:outline-none"
            placeholder="What done looks like"
          />
        </Field>
        <Field label="Assign to">
          <div className="flex flex-wrap gap-1.5">
            {members.map((agent) => {
              const on = assigned.includes(agent.id);
              return (
                <button
                  key={agent.id}
                  onClick={() =>
                    setAssigned((prev) =>
                      on ? prev.filter((id) => id !== agent.id) : [...prev, agent.id],
                    )
                  }
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-md border pl-1 pr-2.5 text-xs transition-colors duration-fast',
                    on
                      ? 'border-primary bg-primary/[0.08] text-content-strong'
                      : 'border-line text-content-muted hover:border-line-strong hover:text-content',
                  )}
                  aria-pressed={on}
                >
                  <Avatar name={agent.name} color={agent.avatarColor} emoji={agent.avatar} size={20} agent />
                  {agent.name}
                </button>
              );
            })}
            {!members.length ? (
              <span className="text-xs text-content-faint">No agents in this conversation.</span>
            ) : null}
          </div>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} disabled={!title.trim()}>
            Create task
          </Button>
        </div>
      </div>
    </Modal>
  );
}
