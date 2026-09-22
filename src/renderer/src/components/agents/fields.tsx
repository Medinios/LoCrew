import {
  AlertTriangle,
  Bot,
  Check,
  FolderOpen,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Agent, AgentConfig, AgentPermissions, AppSettings, RuntimeDetection, RuntimeType, WorkspaceAccess } from '@shared/types';
import { DEFAULT_AGENT_CONFIG, DEFAULT_AGENT_PERMISSIONS } from '@shared/types';
import type {
  A2ACardSummary,
  AuthMethod,
  McpServerView,
  ModelCapabilities,
  ProviderView,
  ToolGrant,
  ToolGrantMode,
} from '@shared/integrations';
import { defaultGrantMode, describeToolRisk, effectiveCapabilities, PARAMETER_SPECS } from '@shared/integrations';
import { Avatar, Button, Chip, Field, FieldGroup, Input, StatusDot, Switch } from '@/components/ui/primitives';
import { AGENT_ACCENTS, AGENT_COLORS } from '@/lib/agents';
import { availablePortraits, defaultPortraitFor } from '@/lib/crew';
import { HOLD_ACCESS } from '@/lib/lexicon';
import { cn } from '@/lib/utils';
import { invoke, useApp } from '@/stores/app';

/* -------------------------------------------------------------------------- */
/* The draft both the wizard and the editor work on                             */
/* -------------------------------------------------------------------------- */

export type Engine =
  | { kind: 'model'; providerId: string; model: string }
  | { kind: 'claude-code' }
  | { kind: 'codex' }
  | { kind: 'a2a' };

export interface AgentDraft {
  name: string;
  description: string;
  avatar: string;
  color: string;
  engine: Engine | null;
  instructions: string;
  temperature: number | undefined;
  maxOutputTokens: number | undefined;
  /** CLI agents. */
  workingDirectory: string;
  access: WorkspaceAccess;
  cliModel: string;
  /** External agents. */
  a2a: {
    cardUrl: string;
    authMethod: AuthMethod;
    authHeaderName: string;
    /** New credential; empty keeps the stored one when editing. */
    token: string;
    hasStoredToken: boolean;
    allowInsecure: boolean;
    summary: A2ACardSummary | null;
  };
  grants: Array<{ serverId: string; toolName: string; mode: ToolGrantMode }>;
  allowAgentToAgent: boolean;
  allowTaskUpdates: boolean;
  maxCostPerExecutionUsd: number;
  maxTurnsPerExecution: number;
  timeoutMinutes: number;
}

export function emptyDraft(settings: AppSettings | null): AgentDraft {
  return {
    name: '',
    description: '',
    avatar: defaultPortraitFor('claude-code') ?? '',
    color: AGENT_COLORS[4]!,
    engine: null,
    instructions: '',
    temperature: undefined,
    maxOutputTokens: undefined,
    workingDirectory: settings?.defaultWorkspaceDirectory ?? '',
    access: 'approval_required',
    cliModel: '',
    a2a: { cardUrl: '', authMethod: 'none', authHeaderName: '', token: '', hasStoredToken: false, allowInsecure: false, summary: null },
    grants: [],
    allowAgentToAgent: DEFAULT_AGENT_PERMISSIONS.allowAgentToAgent,
    allowTaskUpdates: DEFAULT_AGENT_PERMISSIONS.allowTaskUpdates,
    maxCostPerExecutionUsd: DEFAULT_AGENT_PERMISSIONS.maxCostPerExecutionUsd,
    maxTurnsPerExecution: DEFAULT_AGENT_CONFIG.maxTurnsPerExecution,
    timeoutMinutes: Math.round(DEFAULT_AGENT_CONFIG.timeoutMs / 60_000),
  };
}

export function draftFromAgent(agent: Agent, grants: ToolGrant[]): AgentDraft {
  const base = emptyDraft(null);
  const engine: Engine =
    agent.runtimeType === 'model'
      ? { kind: 'model', providerId: agent.config.providerId ?? '', model: agent.config.model ?? '' }
      : { kind: agent.runtimeType };
  return {
    ...base,
    name: agent.name,
    description: agent.description,
    avatar: agent.avatar,
    color: agent.avatarColor,
    engine,
    instructions: agent.config.systemPromptAppend ?? '',
    temperature: agent.config.temperature,
    maxOutputTokens: agent.config.maxOutputTokens,
    workingDirectory: agent.workingDirectory,
    access: agent.permissions.workspaceAccess,
    cliModel: agent.runtimeType === 'model' ? '' : (agent.config.model ?? ''),
    a2a: agent.config.a2a
      ? {
          cardUrl: agent.config.a2a.cardUrl,
          authMethod: agent.config.a2a.authMethod,
          authHeaderName: agent.config.a2a.authHeaderName ?? '',
          token: '',
          hasStoredToken: !!agent.config.a2a.secretId,
          allowInsecure: agent.config.a2a.allowInsecure,
          summary: null,
        }
      : base.a2a,
    grants: grants.map((g) => ({ serverId: g.serverId, toolName: g.toolName, mode: g.mode })),
    allowAgentToAgent: agent.permissions.allowAgentToAgent,
    allowTaskUpdates: agent.permissions.allowTaskUpdates,
    maxCostPerExecutionUsd: agent.permissions.maxCostPerExecutionUsd,
    maxTurnsPerExecution: agent.config.maxTurnsPerExecution,
    timeoutMinutes: Math.round(agent.config.timeoutMs / 60_000),
  };
}

export function runtimeOf(engine: Engine | null): RuntimeType | null {
  return engine?.kind ?? null;
}

/** The permissions and config an agent would be saved with. */
export function draftToAgentFields(
  draft: AgentDraft,
  previous?: AgentConfig,
): { runtimeType: RuntimeType; workingDirectory: string; permissions: AgentPermissions; config: AgentConfig } {
  const engine = draft.engine!;
  const common: AgentConfig = {
    ...(previous ?? DEFAULT_AGENT_CONFIG),
    maxTurnsPerExecution: draft.maxTurnsPerExecution,
    timeoutMs: draft.timeoutMinutes * 60_000,
    systemPromptAppend: draft.instructions.trim() || undefined,
  };
  const permissions: AgentPermissions = {
    workspaceAccess: draft.access,
    allowAgentToAgent: draft.allowAgentToAgent,
    allowTaskUpdates: draft.allowTaskUpdates,
    maxCostPerExecutionUsd: draft.maxCostPerExecutionUsd,
  };

  if (engine.kind === 'model') {
    return {
      runtimeType: 'model',
      workingDirectory: '',
      permissions: { ...permissions, workspaceAccess: 'read_only' },
      config: {
        ...common,
        providerId: engine.providerId,
        model: engine.model.trim(),
        temperature: draft.temperature,
        maxOutputTokens: draft.maxOutputTokens,
      },
    };
  }
  if (engine.kind === 'a2a') {
    return {
      runtimeType: 'a2a',
      workingDirectory: '',
      permissions: { ...permissions, workspaceAccess: 'read_only' },
      config: {
        ...common,
        a2a: {
          cardUrl: draft.a2a.cardUrl.trim(),
          endpointUrl: draft.a2a.summary?.endpointUrl ?? previous?.a2a?.endpointUrl ?? draft.a2a.cardUrl.trim(),
          authMethod: draft.a2a.authMethod,
          authHeaderName: draft.a2a.authMethod === 'header' ? draft.a2a.authHeaderName.trim() : null,
          secretId: null,
          streaming: draft.a2a.summary?.streaming ?? previous?.a2a?.streaming ?? false,
          allowInsecure: draft.a2a.allowInsecure,
          protocolVersion: draft.a2a.summary?.protocolVersion ?? null,
          remoteName: draft.a2a.summary?.name ?? null,
        },
      },
    };
  }
  return {
    runtimeType: engine.kind,
    workingDirectory: draft.workingDirectory.trim(),
    permissions,
    config: { ...common, model: draft.cliModel.trim() || undefined },
  };
}

/* -------------------------------------------------------------------------- */
/* Shared building blocks                                                       */
/* -------------------------------------------------------------------------- */

const textareaClass =
  'w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-[13px] leading-5 text-content placeholder:text-content-faint focus:border-primary focus:shadow-focus focus:outline-none';

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-2">
      <h3 className="text-[12.5px] font-semibold text-content-strong">{children}</h3>
      {hint ? <p className="mt-0.5 text-2xs leading-relaxed text-content-muted">{hint}</p> : null}
    </div>
  );
}

function Choice({
  selected,
  onClick,
  icon,
  title,
  detail,
  trailing,
}: {
  selected: boolean;
  onClick(): void;
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        selected ? 'border-primary bg-primary/[0.06] shadow-[0_0_0_1px_hsl(var(--primary)/0.35)]' : 'border-line hover:bg-subtle',
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-subtle text-content-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-content-strong">{title}</span>
        {detail ? <span className="mt-0.5 block truncate text-2xs text-content-muted">{detail}</span> : null}
      </span>
      {trailing}
      {selected ? <Check size={15} className="shrink-0 text-content-strong" /> : null}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 1: identity                                                             */
/* -------------------------------------------------------------------------- */

export function IdentityFields({ draft, onChange }: { draft: AgentDraft; onChange(patch: Partial<AgentDraft>): void }) {
  const portraits = availablePortraits();
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Avatar name={draft.name || 'Agent'} color={draft.color} emoji={draft.avatar} size={48} agent ring />
        <div className="min-w-0 flex-1 space-y-3">
          <Field label="Agent name" hint="Used for @mentions. Messages are always routed by id, so renaming is safe.">
            <Input
              value={draft.name}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder="Security Architect"
              maxLength={64}
              autoFocus
            />
          </Field>
          <Field label="Description" hint="Optional. Shown in the directory and told to the agent as its role.">
            <Input
              value={draft.description}
              onChange={(e) => onChange({ description: e.target.value })}
              placeholder="Reviews proposed implementations for security risks"
              maxLength={500}
            />
          </Field>
        </div>
      </div>

      <FieldGroup label="Accent colour">
        <div className="flex flex-wrap items-center gap-2">
          {AGENT_ACCENTS.map(({ name, color }) => (
            <button
              key={color}
              type="button"
              onClick={() => onChange({ color })}
              style={{ background: color }}
              className={cn(
                'h-6 w-6 rounded-[7px] transition-[transform,box-shadow] duration-fast',
                draft.color === color
                  ? 'shadow-[0_0_0_2px_hsl(var(--surface)),0_0_0_3.5px_hsl(var(--text-strong))]'
                  : 'hover:scale-110',
              )}
              aria-label={`Accent ${name}`}
              aria-pressed={draft.color === color}
              title={name}
            />
          ))}
          <span className="ml-1 text-2xs text-content-muted">
            {AGENT_ACCENTS.find((accent) => accent.color === draft.color)?.name ?? 'Custom'}
          </span>
        </div>
      </FieldGroup>

      {portraits.length ? (
        <FieldGroup label="Avatar">
          <div className="grid max-h-[176px] grid-cols-9 gap-1.5 overflow-y-auto pr-1">
            <button
              type="button"
              onClick={() => onChange({ avatar: '' })}
              title="Initials"
              className={cn(
                'flex aspect-square items-center justify-center rounded-[28%] border text-2xs transition-colors',
                draft.avatar === '' ? 'border-primary bg-primary/[0.06] text-content' : 'border-line text-content-faint hover:bg-subtle',
              )}
            >
              Aa
            </button>
            {portraits.map((portrait) => (
              <button
                key={portrait.id}
                type="button"
                onClick={() => onChange({ avatar: portrait.id })}
                title={portrait.name}
                className={cn(
                  'aspect-square overflow-hidden rounded-[28%] ring-offset-2 ring-offset-surface transition-all',
                  draft.avatar === portrait.id ? 'ring-2 ring-primary' : 'opacity-70 hover:opacity-100',
                )}
              >
                <Avatar name={portrait.name} emoji={portrait.id} fill agent />
              </button>
            ))}
          </div>
        </FieldGroup>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 2: engine                                                               */
/* -------------------------------------------------------------------------- */

export function EngineChooser({
  draft,
  onChange,
  lockedKind,
}: {
  draft: AgentDraft;
  onChange(patch: Partial<AgentDraft>): void;
  /** Editing: the runtime kind cannot change, only its settings. */
  lockedKind?: RuntimeType;
}) {
  const providers = useApp((s) => s.providers);
  const openSettings = useApp((s) => s.openSettings);
  const engine = draft.engine;

  const pickProvider = (provider: ProviderView) => {
    if (engine?.kind === 'model' && engine.providerId === provider.id) return;
    const first = provider.models[0]?.id ?? '';
    onChange({ engine: { kind: 'model', providerId: provider.id, model: first }, temperature: undefined, maxOutputTokens: undefined });
  };

  const showGroup = (kind: RuntimeType) => !lockedKind || lockedKind === kind;

  return (
    <div className="space-y-5">
      {showGroup('model') ? (
        <div>
          <SectionTitle hint="Any model from a provider you connected: hosted APIs, OpenAI-compatible servers, or local models.">
            AI providers
          </SectionTitle>
          {providers.length ? (
            <div className="space-y-1.5">
              {providers.map((provider) => (
                <Choice
                  key={provider.id}
                  selected={engine?.kind === 'model' && engine.providerId === provider.id}
                  onClick={() => pickProvider(provider)}
                  icon={<Bot size={15} />}
                  title={provider.name}
                  detail={`${provider.models.length} model${provider.models.length === 1 ? '' : 's'} · ${provider.baseUrl}`}
                  trailing={
                    provider.lastCheck ? (
                      <StatusDot status={provider.lastCheck.ok ? 'online' : 'error'} className="mr-1" />
                    ) : null
                  }
                />
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-subtle px-3 py-2.5">
              <p className="text-2xs leading-relaxed text-content-muted">No AI providers yet. Connect OpenAI, Anthropic, Ollama or any compatible API first.</p>
              <Button size="sm" variant="surface" className="shrink-0" onClick={() => openSettings('providers')}>
                <Plus size={13} />
                Add provider
              </Button>
            </div>
          )}

          {engine?.kind === 'model' ? (
            <div className="mt-3">
              <ModelPicker
                provider={providers.find((p) => p.id === engine.providerId)}
                value={engine.model}
                onChange={(model) => onChange({ engine: { ...engine, model } })}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {showGroup('claude-code') || showGroup('codex') ? (
        <div>
          <SectionTitle hint="A coding CLI installed on this computer, working in a directory you choose.">Local coding agents</SectionTitle>
          <div className="space-y-1.5">
            {showGroup('claude-code') ? (
              <Choice
                selected={engine?.kind === 'claude-code'}
                onClick={() => onChange({ engine: { kind: 'claude-code' }, avatar: draft.avatar || (defaultPortraitFor('claude-code') ?? '') })}
                icon={<Terminal size={15} />}
                title="Claude Code"
                detail="Runs through the official Claude Agent SDK and your own login."
              />
            ) : null}
            {showGroup('codex') ? (
              <Choice
                selected={engine?.kind === 'codex'}
                onClick={() => onChange({ engine: { kind: 'codex' } })}
                icon={<Terminal size={15} />}
                title="OpenAI Codex"
                detail="Runs through the official Codex SDK and your own login."
              />
            ) : null}
          </div>
          {engine?.kind === 'claude-code' || engine?.kind === 'codex' ? (
            <div className="mt-3">
              <RuntimeCheck runtimeType={engine.kind} />
            </div>
          ) : null}
        </div>
      ) : null}

      {showGroup('a2a') ? (
        <div>
          <SectionTitle hint="An agent running elsewhere -- another computer, a server, another framework -- reached over the Agent2Agent (A2A) protocol.">
            External agent
          </SectionTitle>
          <Choice
            selected={engine?.kind === 'a2a'}
            onClick={() => onChange({ engine: { kind: 'a2a' } })}
            icon={<Globe size={15} />}
            title="Connect an A2A agent"
            detail="Paste its URL; the app reads its Agent Card."
          />
          {engine?.kind === 'a2a' ? (
            <div className="mt-3">
              <A2AFields draft={draft} onChange={onChange} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Model list with capability badges, search, refresh and manual entry. */
export function ModelPicker({
  provider,
  value,
  onChange,
}: {
  provider: ProviderView | undefined;
  value: string;
  onChange(model: string): void;
}) {
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!provider) return null;

  const models = provider.models.filter((m) => !query || m.id.toLowerCase().includes(query.toLowerCase()) || m.label?.toLowerCase().includes(query.toLowerCase()));
  const known = provider.models.some((m) => m.id === value);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await invoke('providers:discover', { id: provider.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-2">
        <Search size={13} className="shrink-0 text-content-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={provider.models.length ? `Search ${provider.models.length} models` : 'No models discovered yet'}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-content placeholder:text-content-faint focus:outline-none"
        />
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={refreshing} className="h-6 px-2" title="Fetch the model list">
          {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Refresh
        </Button>
      </div>
      {provider.models.length ? (
        <div className="max-h-[188px] overflow-y-auto p-1">
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => onChange(model.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                value === model.id ? 'bg-subtle' : 'hover:bg-subtle',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[11.5px] text-content-strong">{model.id}</span>
                {model.label ? <span className="block truncate text-[10.5px] text-content-faint">{model.label}</span> : null}
              </span>
              <CapabilityBadges capabilities={effectiveCapabilities(model)} compact />
              {value === model.id ? <Check size={13} className="shrink-0" /> : null}
            </button>
          ))}
          {!models.length ? <p className="px-2 py-2 text-2xs text-content-faint">No model matches “{query}”.</p> : null}
        </div>
      ) : null}
      <div className="border-t border-line px-2.5 py-2">
        <label className="flex items-center gap-2">
          <span className="shrink-0 text-2xs text-content-muted">Model id</span>
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Type any model id the provider accepts"
            className="min-w-0 flex-1 rounded-md border border-line px-2 py-1 font-mono text-[11.5px] text-content focus:border-primary focus:shadow-focus focus:outline-none"
          />
        </label>
        {value && !known ? <p className="mt-1 text-[10.5px] text-content-faint">Not in the discovered list; it will be used as typed.</p> : null}
        {error ? <p className="mt-1 text-[10.5px] text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

export function CapabilityBadges({ capabilities, compact }: { capabilities: ModelCapabilities; compact?: boolean }) {
  const items: Array<[string, boolean | null]> = [
    ['tools', capabilities.tools],
    ['vision', capabilities.vision],
    ['json', capabilities.structuredOutput],
  ];
  return (
    <span className="flex shrink-0 items-center gap-1">
      {capabilities.contextWindow ? (
        <Chip className="font-mono">{formatTokens(capabilities.contextWindow)}</Chip>
      ) : null}
      {items
        .filter(([, v]) => (compact ? v === true : v !== null))
        .map(([label, v]) => (
          <Chip key={label} tone={v ? 'success' : 'neutral'} className={cn(!v && 'line-through')}>
            {label}
          </Chip>
        ))}
    </span>
  );
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** Install and sign-in check for a local CLI runtime. */
export function RuntimeCheck({ runtimeType }: { runtimeType: 'claude-code' | 'codex' }) {
  const [detection, setDetection] = useState<RuntimeDetection | null>(null);
  const [checking, setChecking] = useState(false);
  const name = runtimeType === 'claude-code' ? 'Claude Code' : 'Codex';

  const run = async () => {
    setChecking(true);
    setDetection(null);
    try {
      setDetection(await invoke('agents:detectRuntime', { runtimeType }));
    } catch (e) {
      setDetection({ runtimeType, installed: false, version: null, location: null, authenticated: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void run();
    // Re-run when switching between the two CLIs.
  }, [runtimeType]);

  if (checking || !detection) {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-subtle px-3 py-2 text-2xs text-content-muted">
        <Loader2 size={12} className="animate-spin" />
        Looking for {name} and checking its sign-in…
      </p>
    );
  }
  const ok = detection.installed && detection.authenticated;
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-2xs leading-relaxed',
        ok ? 'border-success/30 bg-success/[0.06]' : 'border-warning/30 bg-warning/[0.07]',
      )}
    >
      {ok ? <Check size={13} className="mt-0.5 shrink-0 text-success" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning-ink" />}
      <span className="selectable min-w-0 flex-1 text-content-muted">
        <span className="font-medium text-content">{ok ? `${name} found` : detection.installed ? `${name} found, not signed in` : `${name} not found`}</span>
        {' — '}
        {detection.message}
      </span>
      <button type="button" onClick={() => void run()} className="shrink-0 font-medium text-content hover:underline">
        Check again
      </button>
    </div>
  );
}

/** URL, credential and a live read of the external agent's card. */
export function A2AFields({ draft, onChange }: { draft: AgentDraft; onChange(patch: Partial<AgentDraft>): void }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a2a = draft.a2a;
  const set = (patch: Partial<AgentDraft['a2a']>) => onChange({ a2a: { ...a2a, ...patch } });

  const inspect = async () => {
    setChecking(true);
    setError(null);
    try {
      const summary = await invoke('a2a:inspect', { cardUrl: a2a.cardUrl.trim(), allowInsecure: a2a.allowInsecure });
      // Borrow the remote agent's own name and description when none is set yet.
      const patch: Partial<AgentDraft> = { a2a: { ...a2a, summary } };
      if (!draft.name.trim() && summary.name) patch.name = summary.name.slice(0, 64);
      if (!draft.description.trim() && summary.description) patch.description = summary.description.slice(0, 500);
      onChange(patch);
    } catch (e) {
      set({ summary: null });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const summary = a2a.summary;
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <Field label="Agent URL" hint="Its base URL (the card is read from /.well-known/agent-card.json) or the full URL of its Agent Card.">
        <div className="flex gap-2">
          <Input
            value={a2a.cardUrl}
            onChange={(e) => set({ cardUrl: e.target.value, summary: null })}
            placeholder="https://research.example.com"
            className="font-mono text-xs"
          />
          <Button variant="surface" className="shrink-0" onClick={() => void inspect()} disabled={!a2a.cardUrl.trim() || checking}>
            {checking ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
            Test connection
          </Button>
        </div>
      </Field>

      <div className="grid grid-cols-[140px_1fr] gap-3">
        <Field label="Authentication">
          <select
            value={a2a.authMethod}
            onChange={(e) => set({ authMethod: e.target.value as AuthMethod })}
            className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[12.5px] text-content focus:outline-none"
          >
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="header">Custom header</option>
          </select>
        </Field>
        {a2a.authMethod !== 'none' ? (
          <div className="grid grid-cols-[1fr_1.4fr] gap-2">
            {a2a.authMethod === 'header' ? (
              <Field label="Header name">
                <Input value={a2a.authHeaderName} onChange={(e) => set({ authHeaderName: e.target.value })} placeholder="X-API-Key" />
              </Field>
            ) : (
              <span />
            )}
            <Field label={a2a.hasStoredToken ? 'Credential (stored)' : 'Credential'}>
              <Input
                type="password"
                value={a2a.token}
                onChange={(e) => set({ token: e.target.value })}
                placeholder={a2a.hasStoredToken ? 'Leave empty to keep' : 'Stored encrypted'}
                autoComplete="off"
              />
            </Field>
          </div>
        ) : null}
      </div>

      <label className="flex items-center gap-2 text-2xs text-content-muted">
        <input type="checkbox" checked={a2a.allowInsecure} onChange={(e) => set({ allowInsecure: e.target.checked, summary: null })} />
        Allow plain http:// to a non-local host (not recommended)
      </label>

      {error ? <p className="rounded-md bg-danger/[0.06] px-2.5 py-2 text-2xs text-danger">{error}</p> : null}

      {summary ? (
        <div className={cn('rounded-lg px-3 py-2.5', summary.problem ? 'bg-danger/[0.05]' : 'bg-subtle')}>
          <div className="flex items-center gap-2">
            {summary.problem ? <AlertTriangle size={13} className="text-danger" /> : <Check size={13} className="text-success" />}
            <span className="text-[12.5px] font-semibold text-content-strong">{summary.name}</span>
            <span className="text-2xs text-content-faint">v{summary.version}</span>
            {summary.protocolVersion ? <Chip>A2A {summary.protocolVersion}</Chip> : null}
            {summary.streaming ? <Chip tone="success">streaming</Chip> : null}
          </div>
          {summary.description ? <p className="mt-1 text-2xs leading-relaxed text-content-muted">{summary.description}</p> : null}
          <p className="mt-1.5 break-all font-mono text-[10.5px] text-content-faint">
            {summary.transport} · {summary.endpointUrl}
          </p>
          {summary.crossOrigin ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-2xs text-warning-ink">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              The endpoint is on a different host than the card. Credentials will be sent to that endpoint; only continue if you trust it.
            </p>
          ) : null}
          {summary.skills.length ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {summary.skills.slice(0, 8).map((skill) => (
                <Chip key={skill.id} title={skill.description}>
                  {skill.name}
                </Chip>
              ))}
            </div>
          ) : null}
          {summary.problem ? <p className="mt-1.5 text-2xs text-danger">{summary.problem}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 3: instructions and settings                                            */
/* -------------------------------------------------------------------------- */

export function InstructionsField({ value, onChange, placeholder }: { value: string; onChange(v: string): void; placeholder?: string }) {
  return (
    <Field label="Instructions" hint="The agent's system prompt. The workspace's own rules (trust boundary, how to reach other agents) always apply on top.">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        maxLength={8000}
        placeholder={placeholder ?? 'You are an experienced cybersecurity architect. Review proposed implementations, identify security risks, and provide actionable recommendations.'}
        className={textareaClass}
      />
    </Field>
  );
}

/** Temperature and output cap, only where the provider accepts them, in its own ranges. */
export function ModelSettings({ draft, onChange }: { draft: AgentDraft; onChange(patch: Partial<AgentDraft>): void }) {
  const providers = useApp((s) => s.providers);
  const engine = draft.engine;
  if (engine?.kind !== 'model') return null;
  const provider = providers.find((p) => p.id === engine.providerId);
  if (!provider) return null;
  const spec = PARAMETER_SPECS[provider.kind];
  const caps = effectiveCapabilities(provider.models.find((m) => m.id === engine.model));

  return (
    <div className="grid grid-cols-2 gap-4">
      {spec.temperature ? (
        <Field
          label={`Temperature${draft.temperature === undefined ? ' (provider default)' : `: ${draft.temperature.toFixed(2)}`}`}
          hint={`${spec.temperature.min}–${spec.temperature.max} on ${provider.name}. Lower is more focused.`}
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={spec.temperature.min}
              max={spec.temperature.max}
              step={0.05}
              value={draft.temperature ?? spec.temperature.default}
              onChange={(e) => onChange({ temperature: Number(e.target.value) })}
              className="flex-1 accent-[hsl(var(--primary))]"
              aria-label="Temperature"
            />
            {draft.temperature !== undefined ? (
              <button type="button" onClick={() => onChange({ temperature: undefined })} className="text-2xs text-content-muted hover:text-content">
                Reset
              </button>
            ) : null}
          </div>
        </Field>
      ) : null}
      {spec.maxOutputTokens ? (
        <Field
          label="Max output tokens"
          hint={caps.maxOutputTokens ? `This model allows up to ${caps.maxOutputTokens.toLocaleString()}.` : spec.maxOutputTokens.required ? 'Required by this provider; 4096 if left empty.' : 'Empty uses the provider default.'}
        >
          <Input
            type="number"
            min={1}
            max={caps.maxOutputTokens ?? spec.maxOutputTokens.max}
            value={draft.maxOutputTokens ?? ''}
            placeholder="default"
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({ maxOutputTokens: e.target.value && Number.isInteger(n) && n > 0 ? n : undefined });
            }}
          />
        </Field>
      ) : null}
      <div className="col-span-2 flex flex-wrap items-center gap-2 rounded-lg bg-subtle px-3 py-2">
        <span className="text-2xs text-content-muted">Model capabilities:</span>
        <CapabilityBadges capabilities={caps} />
        {caps.tools === null ? <span className="text-2xs text-content-faint">Tool support not reported; it will be tried and learned.</span> : null}
      </div>
    </div>
  );
}

export function CliFields({ draft, onChange }: { draft: AgentDraft; onChange(patch: Partial<AgentDraft>): void }) {
  return (
    <div className="space-y-4">
      <Field label="Working directory" hint="The agent runs with this as its current directory.">
        <div className="flex gap-2">
          <Input
            value={draft.workingDirectory}
            onChange={(e) => onChange({ workingDirectory: e.target.value })}
            placeholder="C:\\projects\\my-app"
            className="font-mono text-xs"
          />
          <Button
            variant="surface"
            className="shrink-0"
            onClick={async () => {
              const result = await invoke('workspace:pickDirectory');
              if (result.path) onChange({ workingDirectory: result.path });
            }}
          >
            <FolderOpen size={14} />
            Browse
          </Button>
        </div>
      </Field>
      <Field label="Workspace access">
        <div className="space-y-1.5">
          {(['approval_required', 'read_only', 'read_write'] as WorkspaceAccess[]).map((id) => (
            <Choice
              key={id}
              selected={draft.access === id}
              onClick={() => onChange({ access: id })}
              icon={<ShieldCheck size={15} />}
              title={HOLD_ACCESS[id].label}
              detail={HOLD_ACCESS[id].detail}
            />
          ))}
        </div>
      </Field>
      <Field label="Model override" hint="Optional. Blank uses whatever the CLI is configured for.">
        <Input value={draft.cliModel} onChange={(e) => onChange({ cliModel: e.target.value })} placeholder="default" className="font-mono text-xs" />
      </Field>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 4: tools and permissions                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which MCP tools this agent may call, per server, and whether each call needs
 * confirmation. Nothing is granted by default; "Allow without asking" is a
 * deliberate per-tool choice.
 */
export function ToolGrantsEditor({
  grants,
  onChange,
  disabledReason,
}: {
  grants: AgentDraft['grants'];
  onChange(grants: AgentDraft['grants']): void;
  disabledReason?: string | null;
}) {
  const servers = useApp((s) => s.mcpServers);
  const openSettings = useApp((s) => s.openSettings);

  if (disabledReason) {
    return <p className="rounded-lg bg-subtle px-3 py-2.5 text-2xs leading-relaxed text-content-muted">{disabledReason}</p>;
  }
  if (!servers.length) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg bg-subtle px-3 py-2.5">
        <p className="text-2xs leading-relaxed text-content-muted">No MCP servers connected yet. Add one to give agents tools like file access or GitHub.</p>
        <Button size="sm" variant="surface" className="shrink-0" onClick={() => openSettings('mcp')}>
          <Plus size={13} />
          Add MCP server
        </Button>
      </div>
    );
  }

  const has = (serverId: string, toolName: string) => grants.find((g) => g.serverId === serverId && g.toolName === toolName);
  const toggle = (server: McpServerView, toolName: string) => {
    const existing = has(server.id, toolName);
    if (existing) onChange(grants.filter((g) => g !== existing));
    else onChange([...grants, { serverId: server.id, toolName, mode: defaultGrantMode(server.tools.find((t) => t.name === toolName)) }]);
  };
  const setMode = (serverId: string, toolName: string, mode: ToolGrantMode) =>
    onChange(grants.map((g) => (g.serverId === serverId && g.toolName === toolName ? { ...g, mode } : g)));

  return (
    <div className="space-y-2.5">
      {servers.map((server) => {
        const granted = grants.filter((g) => g.serverId === server.id);
        return (
          <div key={server.id} className="rounded-lg border border-line">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <Wrench size={13} className="text-content-muted" />
              <span className="text-[12.5px] font-semibold text-content-strong">{server.name}</span>
              <StatusDot status={server.status === 'connected' ? 'online' : server.status === 'error' ? 'error' : 'offline'} />
              <span className="flex-1 text-2xs text-content-faint">
                {granted.length}/{server.tools.length} granted
              </span>
              {server.tools.length ? (
                <button
                  type="button"
                  onClick={() =>
                    onChange(
                      granted.length === server.tools.length
                        ? grants.filter((g) => g.serverId !== server.id)
                        : [
                            ...grants.filter((g) => g.serverId !== server.id),
                            ...server.tools.map((t) => ({ serverId: server.id, toolName: t.name, mode: 'ask' as const })),
                          ],
                    )
                  }
                  className="text-2xs font-medium text-content-muted hover:text-content"
                >
                  {granted.length === server.tools.length ? 'Clear' : 'Grant all'}
                </button>
              ) : null}
            </div>
            {server.tools.length ? (
              <div className="max-h-[220px] overflow-y-auto p-1">
                {server.tools.map((tool) => {
                  const grant = has(server.id, tool.name);
                  const risk = describeToolRisk(tool);
                  return (
                    <div key={tool.name} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-subtle">
                      <input
                        type="checkbox"
                        checked={!!grant}
                        onChange={() => toggle(server, tool.name)}
                        aria-label={`Grant ${tool.name}`}
                        className="accent-[hsl(var(--primary))]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="font-mono text-[11.5px] text-content-strong">{tool.name}</span>
                          <Chip tone={risk === 'read-only' ? 'neutral' : risk === 'writes' ? 'warning' : 'danger'} title="As described by the server; not verified.">
                            {risk}
                          </Chip>
                        </span>
                        {tool.description ? <span className="block truncate text-[10.5px] text-content-faint">{tool.description}</span> : null}
                      </span>
                      {grant ? (
                        <span className="flex shrink-0 overflow-hidden rounded-md border border-line text-[10.5px]">
                          {(['ask', 'allow'] as ToolGrantMode[]).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => setMode(server.id, tool.name, mode)}
                              className={cn('px-2 py-0.5', grant.mode === mode ? 'bg-primary text-primary-foreground' : 'text-content-muted hover:bg-subtle')}
                            >
                              {mode === 'ask' ? 'Ask first' : 'Allow'}
                            </button>
                          ))}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="px-3 py-2 text-2xs text-content-faint">
                {server.status === 'connected' ? 'This server offers no tools.' : 'Connect this server once to discover its tools.'}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function PermissionToggles({
  draft,
  onChange,
  showSpend,
}: {
  draft: AgentDraft;
  onChange(patch: Partial<AgentDraft>): void;
  showSpend: boolean;
}) {
  return (
    <div className="space-y-2">
      <Toggle
        label="Other agents can hand work to it"
        detail="When off, another agent's message is posted but never wakes this one."
        checked={draft.allowAgentToAgent}
        onChange={(v) => onChange({ allowAgentToAgent: v })}
      />
      <Toggle
        label="Can update tasks it is assigned"
        detail="Allows the update_task tool."
        checked={draft.allowTaskUpdates}
        onChange={(v) => onChange({ allowTaskUpdates: v })}
      />
      <div className="grid grid-cols-3 gap-3 pt-1">
        <Field label="Max turns per message">
          <Input
            type="number"
            min={1}
            max={200}
            value={draft.maxTurnsPerExecution}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 200) onChange({ maxTurnsPerExecution: n });
            }}
          />
        </Field>
        <Field label="Timeout (minutes)">
          <Input
            type="number"
            min={1}
            max={60}
            value={draft.timeoutMinutes}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 60) onChange({ timeoutMinutes: n });
            }}
          />
        </Field>
        {showSpend ? (
          <Field label="Spend ceiling (USD)" hint="0 removes it.">
            <Input
              type="number"
              min={0}
              max={1000}
              step={0.5}
              value={draft.maxCostPerExecutionUsd}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n) && n >= 0) onChange({ maxCostPerExecutionUsd: n });
              }}
            />
          </Field>
        ) : null}
      </div>
    </div>
  );
}

function Toggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-line px-3 py-2.5">
      <span className="min-w-0">
        <span className="block text-xs font-medium text-content">{label}</span>
        <span className="mt-0.5 block text-2xs leading-relaxed text-content-muted">{detail}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} label={label} />
    </div>
  );
}

/** Why an agent cannot use MCP tools, if it cannot. */
export function toolsUnavailableReason(draft: AgentDraft, providers: ProviderView[]): string | null {
  if (draft.engine?.kind === 'a2a') {
    return 'External agents run on their own infrastructure with their own tools. MCP servers connected here are not shared with them.';
  }
  if (draft.engine?.kind === 'model') {
    const engine = draft.engine;
    const model = providers.find((p) => p.id === engine.providerId)?.models.find((m) => m.id === engine.model);
    if (model && effectiveCapabilities(model).tools === false) {
      return `${engine.model} does not accept tools, so it can chat but cannot use MCP tools or hand work to other agents. Choose a model with tool support to grant tools.`;
    }
  }
  return null;
}

/** Validation per step; returns a reason when the step is not complete. */
export function useStepProblem(draft: AgentDraft, step: 'identity' | 'engine' | 'instructions'): string | null {
  return useMemo(() => {
    if (step === 'identity') return draft.name.trim() ? null : 'Give the agent a name.';
    if (step === 'engine') {
      const engine = draft.engine;
      if (!engine) return 'Choose what powers this agent.';
      if (engine.kind === 'model' && !engine.model.trim()) return 'Choose or type a model id.';
      if (engine.kind === 'a2a') {
        if (!draft.a2a.summary) return 'Test the connection to read the agent card.';
        if (draft.a2a.summary.problem) return draft.a2a.summary.problem;
        if (draft.a2a.authMethod === 'header' && !draft.a2a.authHeaderName.trim()) return 'Name the credential header.';
      }
      return null;
    }
    if ((draft.engine?.kind === 'claude-code' || draft.engine?.kind === 'codex') && !draft.workingDirectory.trim()) {
      return 'Choose a working directory.';
    }
    return null;
  }, [draft, step]);
}
