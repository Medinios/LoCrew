import { ArrowLeft, ArrowRight, Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { effectiveCapabilities } from '@shared/integrations';
import { Avatar, Button, Modal } from '@/components/ui/primitives';
import {
  CliFields,
  EngineChooser,
  IdentityFields,
  InstructionsField,
  ModelSettings,
  PermissionToggles,
  SectionTitle,
  ToolGrantsEditor,
  draftToAgentFields,
  emptyDraft,
  toolsUnavailableReason,
  useStepProblem,
  type AgentDraft,
} from '@/components/agents/fields';
import { HOLD_ACCESS } from '@/lib/lexicon';
import { cn } from '@/lib/utils';
import { invoke, useApp } from '@/stores/app';

const STEPS = [
  { id: 'identity', label: 'Name & avatar' },
  { id: 'engine', label: 'Provider & model' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'tools', label: 'Tools' },
  { id: 'review', label: 'Review' },
] as const;

/**
 * Creates an agent of any kind: a model from any configured provider, a local
 * coding CLI, or an external A2A agent. A model is not an agent -- the same
 * model can back many agents, each with its own name, instructions, tools and
 * conversation memory.
 */
export function AgentWizard({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);
  const refreshAgents = useApp((s) => s.refreshAgents);
  const refreshConversations = useApp((s) => s.refreshConversations);
  const openAgentDm = useApp((s) => s.openAgentDm);

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<AgentDraft>(() => emptyDraft(settings));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start fresh each time it opens -- but not when settings change while it
  // is open, which happens when the user adds a provider mid-wizard.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setDraft(emptyDraft(settingsRef.current));
    setError(null);
  }, [open]);

  const update = (patch: Partial<AgentDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const identityProblem = useStepProblem(draft, 'identity');
  const engineProblem = useStepProblem(draft, 'engine');
  const instructionsProblem = useStepProblem(draft, 'instructions');
  const problem = [identityProblem, engineProblem, instructionsProblem, null, null][step] ?? null;

  const kind = draft.engine?.kind;
  const toolsBlocked = toolsUnavailableReason(draft, providers);

  const create = async () => {
    if (!draft.engine) return;
    setCreating(true);
    setError(null);
    try {
      const fields = draftToAgentFields(draft);
      const agent = await invoke('agents:create', {
        name: draft.name.trim(),
        description: draft.description.trim(),
        avatar: draft.avatar,
        avatarColor: draft.color,
        ...fields,
        ...(kind === 'a2a' && draft.a2a.authMethod !== 'none' ? { a2aToken: draft.a2a.token } : {}),
      });
      if (draft.grants.length && !toolsBlocked) {
        await invoke('grants:set', { agentId: agent.id, grants: draft.grants });
      }
      await Promise.all([refreshAgents(), refreshConversations()]);
      onOpenChange(false);
      // Start talking to it straight away.
      await openAgentDm(agent.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Create agent" width={640}>
      <ol className="mb-5 grid grid-cols-5 gap-1.5">
        {STEPS.map((s, index) => (
          <li key={s.id}>
            <button
              type="button"
              disabled={index > step}
              onClick={() => setStep(index)}
              className="w-full text-left disabled:cursor-default"
            >
              <span className={cn('block h-1 rounded-full transition-colors', index <= step ? 'bg-primary' : 'bg-line')} />
              <span className={cn('mt-1.5 block truncate text-[10.5px] font-medium', index === step ? 'text-content-strong' : 'text-content-faint')}>
                {s.label}
              </span>
            </button>
          </li>
        ))}
      </ol>

      <div className="min-h-[300px]">
        {step === 0 ? <IdentityFields draft={draft} onChange={update} /> : null}

        {step === 1 ? <EngineChooser draft={draft} onChange={update} /> : null}

        {step === 2 ? (
          <div className="space-y-5">
            {kind === 'claude-code' || kind === 'codex' ? <CliFields draft={draft} onChange={update} /> : null}
            <InstructionsField
              value={draft.instructions}
              onChange={(instructions) => update({ instructions })}
              placeholder={kind === 'a2a' ? 'Optional. Sent to the external agent with the first message of each conversation.' : undefined}
            />
            {kind === 'model' ? <ModelSettings draft={draft} onChange={update} /> : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-5">
            <div>
              <SectionTitle hint="Agents get no MCP tools unless you grant them here. “Ask first” shows you every call before it runs.">
                MCP servers & tools
              </SectionTitle>
              <ToolGrantsEditor grants={draft.grants} onChange={(grants) => update({ grants })} disabledReason={toolsBlocked} />
            </div>
            <div>
              <SectionTitle>Conversation permissions</SectionTitle>
              <PermissionToggles draft={draft} onChange={update} showSpend={kind === 'claude-code' || kind === 'codex'} />
            </div>
          </div>
        ) : null}

        {step === 4 ? <Review draft={draft} toolsBlocked={toolsBlocked} /> : null}
      </div>

      {error ? <p className="mt-4 rounded-lg bg-danger/[0.06] px-3 py-2 text-2xs text-danger">{error}</p> : null}

      <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 border-t border-line bg-surface px-5 pb-5 pt-4 mt-5 flex items-center justify-between">
        <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          <ArrowLeft size={14} />
          Back
        </Button>
        <div className="flex items-center gap-3">
          {problem ? <span className="text-2xs text-content-faint">{problem}</span> : null}
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={() => setStep((s) => s + 1)} disabled={!!problem}>
              Continue
              <ArrowRight size={14} />
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void create()} disabled={creating}>
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Create agent
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Review({ draft, toolsBlocked }: { draft: AgentDraft; toolsBlocked: string | null }) {
  const providers = useApp((s) => s.providers);
  const servers = useApp((s) => s.mcpServers);
  const engine = draft.engine!;

  let engineText = '';
  if (engine.kind === 'model') {
    const provider = providers.find((p) => p.id === engine.providerId);
    const caps = effectiveCapabilities(provider?.models.find((m) => m.id === engine.model));
    engineText = `${provider?.name ?? 'Provider'} · ${engine.model}${caps.contextWindow ? ` · ${caps.contextWindow.toLocaleString()} token context` : ''}`;
  } else if (engine.kind === 'a2a') {
    engineText = `External A2A agent · ${draft.a2a.summary?.endpointUrl ?? draft.a2a.cardUrl}`;
  } else {
    engineText = `${engine.kind === 'claude-code' ? 'Claude Code' : 'OpenAI Codex'} in ${draft.workingDirectory} · ${HOLD_ACCESS[draft.access].label}`;
  }

  const grantsByServer = servers
    .map((server) => ({ server, tools: draft.grants.filter((g) => g.serverId === server.id) }))
    .filter((entry) => entry.tools.length);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg bg-subtle p-3">
        <Avatar name={draft.name || 'Agent'} color={draft.color} emoji={draft.avatar} size={44} agent ring />
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-content-strong">{draft.name}</p>
          {draft.description ? <p className="text-2xs text-content-muted">{draft.description}</p> : null}
        </div>
      </div>
      <dl className="divide-y divide-line rounded-lg border border-line text-[12px]">
        <Row label="Runs on" value={engineText} />
        <Row
          label="Instructions"
          value={draft.instructions.trim() ? `${draft.instructions.trim().slice(0, 160)}${draft.instructions.length > 160 ? '…' : ''}` : 'None beyond the workspace rules'}
        />
        {engine.kind === 'model' ? (
          <Row
            label="Settings"
            value={`Temperature ${draft.temperature?.toFixed(2) ?? 'default'} · max output ${draft.maxOutputTokens?.toLocaleString() ?? 'default'}`}
          />
        ) : null}
        <Row
          label="MCP tools"
          value={
            toolsBlocked
              ? 'Not available for this agent'
              : grantsByServer.length
                ? grantsByServer
                    .map(({ server, tools }) => `${server.name}: ${tools.map((t) => `${t.toolName}${t.mode === 'allow' ? '' : ' (ask)'}`).join(', ')}`)
                    .join(' · ')
                : 'None'
          }
        />
        <Row
          label="Permissions"
          value={`${draft.allowAgentToAgent ? 'Other agents can hand it work' : 'Only you can wake it'} · up to ${draft.maxTurnsPerExecution} turns per message`}
        />
      </dl>
      <p className="text-2xs leading-relaxed text-content-faint">
        It gets its own direct message right away, and you can add it to any channel from the channel's member list.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 px-3 py-2">
      <dt className="text-content-faint">{label}</dt>
      <dd className="selectable min-w-0 break-words text-content">{value}</dd>
    </div>
  );
}
