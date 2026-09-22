import { Bot, Copy, MessageSquare, Plus, Search, Settings2, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Agent } from '@shared/types';
import { Avatar, Button, Chip, EmptyState, PanelHeader, PRESENCE_LABEL, type Presence } from '@/components/ui/primitives';
import { agentPresence } from '@/lib/activity';
import { engineKind, engineLabel } from '@/lib/agents';
import { HOLD_ACCESS, SHIP } from '@/lib/lexicon';
import { cn } from '@/lib/utils';
import { invoke, useApp } from '@/stores/app';

type Filter = 'all' | ReturnType<typeof engineKind>;
const FILTERS: Filter[] = ['all', 'Local CLI', 'AI model', 'External agent'];

/** The agent directory: every agent, what it runs on, and what you can do with it. */
export function AgentsView({ onAddAgent }: { onAddAgent(): void }) {
  const agents = useApp((s) => s.agents);
  const executions = useApp((s) => s.executions);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const liveActivity = useApp((s) => s.liveActivity);
  const running = useMemo(
    () =>
      new Set(
        executions
          .filter((e) => !['completed', 'failed', 'cancelled'].includes(e.state))
          .map((e) => e.agentId),
      ),
    [executions],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter(
      (a) =>
        (filter === 'all' || engineKind(a) === filter) &&
        (!q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)),
    );
  }, [agents, query, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        actions={
          agents.length ? (
            <Button variant="primary" size="sm" onClick={onAddAgent}>
              <Plus size={13} />
              {SHIP.actions.createAgent}
            </Button>
          ) : null
        }
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface text-content-muted">
          <Bot size={15} strokeWidth={1.9} />
        </span>
        <h1 className="text-title font-semibold text-content-strong">{SHIP.nav.agents}</h1>
        {agents.length ? <span className="text-xs tabular-nums text-content-faint">{agents.length}</span> : null}
      </PanelHeader>

      {agents.length ? (
        <div className="flex items-center gap-2 px-5 pb-3 pt-3">
          <div className="relative w-60">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find an agent"
              aria-label="Find an agent"
              className="h-8 w-full rounded-md border border-line bg-surface pl-7 pr-2 text-xs text-content-strong placeholder:text-content-faint transition-[border-color,box-shadow] duration-fast hover:border-line-strong focus:border-primary focus:shadow-focus focus:outline-none"
            />
          </div>
          <div className="flex gap-0.5 rounded-md border border-line bg-surface p-0.5" role="tablist" aria-label="Filter by engine">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'h-[26px] rounded-[6px] px-2.5 text-xs font-medium transition-colors duration-fast',
                  filter === f ? 'bg-shell text-ink' : 'text-content-muted hover:bg-subtle hover:text-content-strong',
                )}
              >
                {f === 'all' ? 'All' : f === 'Local CLI' ? 'Local CLI' : f === 'AI model' ? 'AI models' : 'External'}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {agents.length ? (
          visible.length ? (
            <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {visible.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  presence={agentPresence(agent, liveActivity[agent.id], running.has(agent.id))}
                />
              ))}
            </div>
          ) : (
            <p className="px-4 py-6 text-center text-xs text-content-faint">No agents match.</p>
          )
        ) : (
          <EmptyState
            icon={<Bot size={20} />}
            title={SHIP.empty.noAgents}
            detail={SHIP.empty.noAgentsDetail}
            action={
              <Button variant="primary" onClick={onAddAgent}>
                <Plus size={14} />
                {SHIP.empty.firstAgent}
              </Button>
            }
          />
        )}
      </div>
    </div>
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

function AgentRow({ agent, presence }: { agent: Agent; presence: Presence }) {
  const providers = useApp((s) => s.providers);
  const grants = useApp((s) => s.grants[agent.id]);
  const openAgentDm = useApp((s) => s.openAgentDm);
  const setEditingAgent = useApp((s) => s.setEditingAgent);
  const pushToast = useApp((s) => s.pushToast);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const duplicate = async () => {
    setBusy(true);
    try {
      await invoke('agents:duplicate', { id: agent.id });
    } catch (e) {
      pushToast({ level: 'error', title: `Couldn't duplicate ${agent.name}`, detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      await invoke('agents:delete', { id: agent.id });
    } catch (e) {
      pushToast({ level: 'error', title: `Couldn't delete ${agent.name}`, detail: e instanceof Error ? e.message : String(e) });
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const toolCount = grants?.length ?? 0;
  const summary = agent.description;

  return (
    <div className="group flex items-center gap-3.5 px-4 py-3 transition-colors duration-fast hover:bg-subtle/60" onMouseLeave={() => setConfirmDelete(false)}>
      <Avatar name={agent.name} color={agent.avatarColor} emoji={agent.avatar} size={38} agent ring presence={presence} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <bdi className="truncate text-nav font-semibold text-content-strong">{agent.name}</bdi>
          <span className={cn('shrink-0 text-2xs font-medium', PRESENCE_TEXT[presence])}>{PRESENCE_LABEL[presence]}</span>
          <span className="min-w-0 truncate text-2xs text-content-faint">{engineLabel(agent, providers)}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-content-muted">
          {summary ? <span className="truncate">{summary}</span> : null}
          {agent.workingDirectory ? (
            <span className="shrink-0 truncate font-mono text-2xs text-content-faint" title={agent.workingDirectory}>
              {summary ? '· ' : ''}
              {agent.workingDirectory}
            </span>
          ) : null}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <Chip>{engineKind(agent)}</Chip>
          {agent.runtimeType === 'claude-code' || agent.runtimeType === 'codex' ? <Chip>{HOLD_ACCESS[agent.permissions.workspaceAccess].label}</Chip> : null}
          {toolCount ? <Chip tone="primary">{toolCount} MCP tool{toolCount === 1 ? '' : 's'}</Chip> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="surface" size="sm" onClick={() => void openAgentDm(agent.id)}>
          <MessageSquare size={13} />
          Message
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setEditingAgent(agent.id)} aria-label={`Edit ${agent.name}`} title="Edit" className="px-2">
          <Settings2 size={14} />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void duplicate()} disabled={busy} aria-label={`Duplicate ${agent.name}`} title="Duplicate" className="px-2">
          <Copy size={13} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void remove()}
          disabled={busy}
          aria-label={`Delete ${agent.name}`}
          title={confirmDelete ? 'Click again to delete' : 'Delete'}
          className={cn('px-2', confirmDelete && 'text-danger')}
        >
          {confirmDelete ? 'Delete?' : <Trash2 size={13} />}
        </Button>
      </div>
    </div>
  );
}
