import { AlertTriangle, Copy, Loader2, Puzzle, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DiscoveredPluginView } from '@shared/ipc';
import type { ToolGrant } from '@shared/integrations';
import { isCliRuntime } from '@shared/types';
import { Avatar, Button, Chip, Modal, StatusDot, Switch } from '@/components/ui/primitives';
import {
  CliFields,
  EngineChooser,
  IdentityFields,
  InstructionsField,
  ModelSettings,
  PermissionToggles,
  SectionTitle,
  ToolGrantsEditor,
  draftFromAgent,
  draftToAgentFields,
  toolsUnavailableReason,
  type AgentDraft,
} from '@/components/agents/fields';
import { engineLabel } from '@/lib/agents';
import { CREW_STATUS, EXECUTION_LABEL } from '@/lib/lexicon';
import { cn } from '@/lib/utils';
import { invoke, useApp } from '@/stores/app';

const NO_GRANTS: ToolGrant[] = [];

/**
 * Edits any agent: identity, what it runs on, instructions, MCP tools and
 * permissions.
 *
 * Changes take effect on the agent's next run, never mid-execution: the
 * orchestrator reads the agent row when it starts a job, so a run already in
 * flight keeps the settings it began with. The dialog says so when the agent
 * is busy rather than pretending the change is immediate.
 */
export function AgentEditor({ agentId, onOpenChange }: { agentId: string | null; onOpenChange(open: boolean): void }) {
  const agent = useApp((s) => s.agents.find((a) => a.id === agentId));
  const grants = useApp((s) => (agentId ? s.grants[agentId] : undefined)) ?? NO_GRANTS;
  const providers = useApp((s) => s.providers);
  const executions = useApp((s) => s.executions);
  const refreshAgents = useApp((s) => s.refreshAgents);
  const refreshConversations = useApp((s) => s.refreshConversations);

  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [autoCompact, setAutoCompact] = useState(true);
  const [plugins, setPlugins] = useState<string[]>([]);
  const [available, setAvailable] = useState<DiscoveredPluginView[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset only when a different agent is opened, not on every background update.
  useEffect(() => {
    if (!agent) {
      setDraft(null);
      return;
    }
    setDraft(draftFromAgent(agent, grants));
    setAutoCompact(agent.config.autoCompact);
    setPlugins(agent.config.plugins ?? []);
    setConfirmDelete(false);
    setError(null);
    if (agent.runtimeType === 'claude-code') void invoke('agents:plugins').then(setAvailable);
  }, [agent?.id]);

  const original = useMemo(() => (agent ? draftFromAgent(agent, grants) : null), [agent, grants]);

  if (!agent || !draft || !original) return null;

  const update = (patch: Partial<AgentDraft>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const running = executions.find((e) => e.agentId === agent.id && !['completed', 'failed', 'cancelled'].includes(e.state));
  const toolsBlocked = toolsUnavailableReason(draft, providers);
  const grantsChanged = JSON.stringify(draft.grants) !== JSON.stringify(original.grants);
  const dirty =
    grantsChanged ||
    JSON.stringify({ ...draft, grants: [] }) !== JSON.stringify({ ...original, grants: [] }) ||
    autoCompact !== agent.config.autoCompact ||
    JSON.stringify(plugins) !== JSON.stringify(agent.config.plugins ?? []);

  const problem = !draft.name.trim()
    ? 'Give the agent a name.'
    : isCliRuntime(agent.runtimeType) && !draft.workingDirectory.trim()
      ? 'Choose a working directory.'
      : draft.engine?.kind === 'model' && !draft.engine.model.trim()
        ? 'Choose a model.'
        : draft.engine?.kind === 'a2a' && draft.a2a.summary?.problem
          ? draft.a2a.summary.problem
          : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const fields = draftToAgentFields(draft, agent.config);
      await invoke('agents:update', {
        id: agent.id,
        patch: {
          name: draft.name.trim(),
          description: draft.description.trim(),
          avatar: draft.avatar,
          avatarColor: draft.color,
          workingDirectory: fields.workingDirectory,
          permissions: fields.permissions,
          config: {
            ...fields.config,
            autoCompact,
            ...(agent.runtimeType === 'claude-code' ? { plugins } : {}),
          },
        },
        ...(agent.runtimeType === 'a2a' && draft.a2a.token ? { a2aToken: draft.a2a.token } : {}),
        ...(agent.runtimeType === 'a2a' && draft.a2a.authMethod === 'none' ? { a2aToken: '' } : {}),
      });
      if (grantsChanged) await invoke('grants:set', { agentId: agent.id, grants: toolsBlocked ? [] : draft.grants });
      await refreshAgents();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async () => {
    setSaving(true);
    try {
      await invoke('agents:duplicate', { id: agent.id });
      await Promise.all([refreshAgents(), refreshConversations()]);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    try {
      await invoke('agents:delete', { id: agent.id });
      await refreshAgents();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Modal open={Boolean(agentId)} onOpenChange={onOpenChange} title={`Edit ${agent.name}`} description={engineLabel(agent, providers)} width={640}>
      <div className="space-y-6">
        <div className="flex items-center gap-3 rounded-lg bg-subtle p-3">
          <Avatar name={draft.name || agent.name} color={draft.color} emoji={draft.avatar} size={40} agent ring />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-content">{draft.name || agent.name}</p>
            <p className="flex items-center gap-1.5 text-2xs text-content-muted">
              <StatusDot status={agent.status} state={running?.state ?? 'idle'} />
              {running ? EXECUTION_LABEL[running.state] : CREW_STATUS[agent.status].label}
              {agent.statusDetail && !running ? <span className="truncate text-content-faint">· {agent.statusDetail}</span> : null}
            </p>
          </div>
          {running ? <Chip tone="warning">Working</Chip> : null}
        </div>

        {running ? (
          <p className="flex items-start gap-1.5 rounded-md border border-warning/25 bg-warning/[0.07] px-3 py-2 text-2xs leading-relaxed text-content-muted">
            <AlertTriangle size={11} className="mt-0.5 shrink-0 text-warning" />
            This agent is working right now. Changes apply to its next run, not the one in progress.
          </p>
        ) : null}

        <section>
          <SectionTitle>Identity</SectionTitle>
          <IdentityFields draft={draft} onChange={update} />
        </section>

        <section>
          <SectionTitle>{agent.runtimeType === 'a2a' ? 'Connection' : agent.runtimeType === 'model' ? 'Provider & model' : 'Runtime'}</SectionTitle>
          <EngineChooser draft={draft} onChange={update} lockedKind={agent.runtimeType} />
        </section>

        <section className="space-y-5">
          {isCliRuntime(agent.runtimeType) ? <CliFields draft={draft} onChange={update} /> : null}
          <InstructionsField value={draft.instructions} onChange={(instructions) => update({ instructions })} />
          {agent.runtimeType === 'model' ? <ModelSettings draft={draft} onChange={update} /> : null}
        </section>

        <section>
          <SectionTitle hint="Nothing is granted by default. “Ask first” shows you every call before it runs.">MCP servers & tools</SectionTitle>
          <ToolGrantsEditor grants={draft.grants} onChange={(g) => update({ grants: g })} disabledReason={toolsBlocked} />
        </section>

        <section>
          <SectionTitle>Conversation permissions</SectionTitle>
          <PermissionToggles draft={draft} onChange={update} showSpend={isCliRuntime(agent.runtimeType)} />
        </section>

        {agent.runtimeType === 'claude-code' ? (
          <section className="space-y-2">
            <SectionTitle>Claude Code</SectionTitle>
            <div className="flex items-start justify-between gap-4 rounded-lg border border-line px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-xs font-medium text-content">Let it compact its own history</span>
                <span className="mt-0.5 block text-2xs leading-relaxed text-content-muted">
                  When the context window fills, the runtime summarises older turns so the agent can keep working. This transcript is never touched.
                </span>
              </span>
              <Switch checked={autoCompact} onCheckedChange={setAutoCompact} label="Auto-compact" />
            </div>
            {available.length ? (
              <div className="space-y-1.5 rounded-lg bg-subtle p-3">
                <p className="text-xs font-medium text-content">Plugins</p>
                {available.map((plugin) => {
                  const on = plugins.includes(plugin.path);
                  return (
                    <button
                      key={plugin.id}
                      type="button"
                      onClick={() => setPlugins(on ? plugins.filter((p) => p !== plugin.path) : [...plugins, plugin.path])}
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-md border bg-surface p-2.5 text-left transition-colors',
                        on ? 'border-primary/40 shadow-[0_0_0_1px_hsl(var(--primary)/0.15)]' : 'border-line',
                      )}
                    >
                      <Puzzle size={13} className={cn('mt-0.5 shrink-0', on ? 'text-content-strong' : 'text-content-faint')} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-content">{plugin.name}</span>
                        <span className="mt-0.5 block text-2xs leading-relaxed text-content-muted">{plugin.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </section>
        ) : null}

        {error ? <p className="rounded-lg bg-danger/[0.06] px-3 py-2 text-2xs text-danger">{error}</p> : null}

        <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 border-t border-line bg-surface px-5 pb-5 pt-4 flex items-center justify-between">
          <div className="flex gap-1">
            <Button variant="ghost" className="text-content-faint hover:text-danger" onClick={() => void remove()} disabled={saving}>
              <Trash2 size={14} />
              {confirmDelete ? 'Click again to delete' : 'Delete'}
            </Button>
            <Button variant="ghost" onClick={() => void duplicate()} disabled={saving} title="A copy with its own identity and memory">
              <Copy size={14} />
              Duplicate
            </Button>
          </div>
          <div className="flex items-center gap-2">
            {problem ? <span className="text-2xs text-content-faint">{problem}</span> : null}
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving || !!problem}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save changes
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
