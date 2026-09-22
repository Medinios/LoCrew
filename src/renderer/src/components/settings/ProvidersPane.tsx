import { Bot, Check, ChevronRight, KeyRound, Loader2, Pencil, Plus, RefreshCw, Trash2, X, Zap } from 'lucide-react';
import { useState } from 'react';
import type { ModelCapabilities, ProviderModel, ProviderView } from '@shared/integrations';
import { effectiveCapabilities, UNKNOWN_CAPABILITIES } from '@shared/integrations';
import { presetById } from '@shared/provider-presets';
import { Button, Chip, Input, StatusDot } from '@/components/ui/primitives';
import { CapabilityBadges, formatTokens } from '@/components/agents/fields';
import { PaneHeader } from '@/components/settings/SettingsDialog';
import { ProviderDialog } from '@/components/settings/ProviderDialog';
import { cn, formatWhen } from '@/lib/utils';
import { invoke, useApp } from '@/stores/app';

/** Settings → AI Providers. */
export function ProvidersPane() {
  const providers = useApp((s) => s.providers);
  const agents = useApp((s) => s.agents);
  const [dialog, setDialog] = useState<{ provider: ProviderView | null } | null>(null);

  return (
    <div>
      <PaneHeader
        title="AI Providers"
        detail="Connect any model provider: hosted APIs, OpenAI-compatible servers, or models running on this computer. Keys are encrypted with your operating system's keychain and never leave the main process."
        action={
          <Button variant="primary" size="sm" onClick={() => setDialog({ provider: null })}>
            <Plus size={13} />
            Add provider
          </Button>
        }
      />

      {providers.length ? (
        <div className="space-y-2.5">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              usedBy={agents.filter((a) => a.runtimeType === 'model' && a.config.providerId === provider.id).map((a) => a.name)}
              onEdit={() => setDialog({ provider })}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-subtle text-content-muted">
            <Bot size={18} />
          </div>
          <p className="text-[13px] font-semibold text-content-strong">No providers yet</p>
          <p className="mx-auto mt-1 max-w-sm text-2xs leading-relaxed text-content-muted">
            Add OpenAI, Anthropic, Gemini, OpenRouter, a local Ollama or LM Studio, or any OpenAI-compatible endpoint. Then create agents on any of their models.
          </p>
          <Button variant="primary" size="sm" className="mt-4" onClick={() => setDialog({ provider: null })}>
            <Plus size={13} />
            Add provider
          </Button>
        </div>
      )}

      <ProviderDialog open={dialog !== null} provider={dialog?.provider ?? null} onOpenChange={(open) => !open && setDialog(null)} />
    </div>
  );
}

function ProviderCard({ provider, usedBy, onEdit }: { provider: ProviderView; usedBy: string[]; onEdit(): void }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<'test' | 'discover' | 'delete' | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const preset = presetById(provider.preset);

  const run = async (kind: 'test' | 'discover') => {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === 'test') {
        const result = await invoke('providers:test', { id: provider.id });
        setNotice({ ok: result.ok, text: result.ok ? `${result.message} (${result.latencyMs} ms)` : result.message });
      } else {
        const view = await invoke('providers:discover', { id: provider.id });
        setNotice({ ok: true, text: view.lastCheck?.message ?? 'Models refreshed.' });
        setExpanded(true);
      }
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy('delete');
    try {
      await invoke('providers:delete', { id: provider.id });
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) });
      setConfirmDelete(false);
    } finally {
      setBusy(null);
    }
  };

  const check = provider.lastCheck;
  return (
    <div className="rounded-xl border border-line">
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-[13px] font-semibold text-content-strong">
          {provider.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-content-strong">{provider.name}</span>
            <Chip>{preset?.name ?? provider.kind}</Chip>
            {check ? <StatusDot status={check.ok ? 'online' : 'error'} /> : null}
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-content-faint">{provider.baseUrl}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-content-muted">
            <span className="flex items-center gap-1">
              <KeyRound size={11} />
              {provider.authMethod === 'none' ? 'No authentication' : provider.hasApiKey ? 'Key stored (encrypted)' : 'No key set'}
            </span>
            <span>
              {provider.models.length} model{provider.models.length === 1 ? '' : 's'}
            </span>
            {usedBy.length ? <span>Used by {usedBy.join(', ')}</span> : null}
            {check ? (
              <span className={check.ok ? '' : 'text-danger'} title={check.message}>
                {check.ok ? 'Checked' : 'Check failed'} {formatWhen(check.at)}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="surface" onClick={() => void run('test')} disabled={busy !== null}>
            {busy === 'test' ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            Test connection
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void run('discover')} disabled={busy !== null} title="Fetch the model list">
            {busy === 'discover' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${provider.name}`} title="Edit">
            <Pencil size={12} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void remove()}
            disabled={busy !== null}
            className={cn(confirmDelete && 'text-danger')}
            aria-label={`Remove ${provider.name}`}
            title={confirmDelete ? 'Click again to remove' : 'Remove'}
          >
            {confirmDelete ? 'Remove?' : <Trash2 size={12} />}
          </Button>
        </div>
      </div>

      {notice ? (
        <p className={cn('mx-4 mb-3 rounded-lg px-3 py-2 text-2xs', notice.ok ? 'bg-success/[0.07] text-success-ink' : 'bg-danger/[0.06] text-danger')}>
          {notice.text}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 border-t border-line px-4 py-2 text-left text-2xs font-medium text-content-muted hover:text-content"
        aria-expanded={expanded}
      >
        <ChevronRight size={12} className={cn('transition-transform', expanded && 'rotate-90')} />
        Models and capabilities
      </button>
      {expanded ? <ModelTable provider={provider} /> : null}
    </div>
  );
}

/** The provider's models, with the capabilities it reported and the user's corrections. */
function ModelTable({ provider }: { provider: ProviderView }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = async (models: ProviderModel[]) => {
    setError(null);
    try {
      await invoke('providers:setModels', { id: provider.id, models });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addManual = async () => {
    const id = manual.trim();
    if (!id || provider.models.some((m) => m.id === id)) return;
    await save([...provider.models, { id, source: 'manual', capabilities: { ...UNKNOWN_CAPABILITIES }, overrides: {} }]);
    setManual('');
  };

  return (
    <div className="border-t border-line px-4 pb-3 pt-2">
      {provider.models.length ? (
        <div className="max-h-[320px] overflow-y-auto">
          {provider.models.map((model) => (
            <div key={model.id} className="border-b border-line py-1.5 last:border-0">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-content-strong" title={model.label}>
                  {model.id}
                </span>
                {model.source === 'manual' ? <Chip>manual</Chip> : null}
                <CapabilityBadges capabilities={effectiveCapabilities(model)} />
                <button
                  type="button"
                  onClick={() => setEditing(editing === model.id ? null : model.id)}
                  className="text-2xs font-medium text-content-muted hover:text-content"
                >
                  {editing === model.id ? 'Done' : 'Edit'}
                </button>
                {model.source === 'manual' ? (
                  <button
                    type="button"
                    onClick={() => void save(provider.models.filter((m) => m.id !== model.id))}
                    className="text-content-faint hover:text-danger"
                    aria-label={`Remove ${model.id}`}
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </div>
              {editing === model.id ? (
                <CapabilityEditor
                  model={model}
                  onChange={(overrides) => void save(provider.models.map((m) => (m.id === model.id ? { ...m, overrides } : m)))}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="py-2 text-2xs text-content-faint">No models yet. Refresh to discover them, or add one by id below.</p>
      )}
      <div className="mt-2 flex gap-2">
        <Input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addManual()}
          placeholder="Add a model id manually, e.g. my-custom-model"
          className="h-7 font-mono text-[11.5px]"
        />
        <Button size="sm" variant="surface" onClick={() => void addManual()} disabled={!manual.trim()}>
          <Plus size={12} />
          Add
        </Button>
      </div>
      {error ? <p className="mt-2 text-2xs text-danger">{error}</p> : null}
    </div>
  );
}

/**
 * Lets the user correct what a provider reported (or fill in what it did
 * not). Overrides always win over discovered and learned values.
 */
function CapabilityEditor({ model, onChange }: { model: ProviderModel; onChange(overrides: Partial<ModelCapabilities>): void }) {
  const reported = model.capabilities;
  const flags: Array<[keyof ModelCapabilities, string]> = [
    ['tools', 'Tool calling'],
    ['vision', 'Vision'],
    ['streaming', 'Streaming'],
    ['structuredOutput', 'Structured output'],
  ];
  const setFlag = (key: keyof ModelCapabilities, value: boolean | null | undefined) => {
    const next = { ...model.overrides };
    if (value === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
    onChange(next);
  };
  const setNumber = (key: 'contextWindow' | 'maxOutputTokens', text: string) => {
    const next = { ...model.overrides };
    const n = Number(text);
    if (!text) delete next[key];
    else if (Number.isInteger(n) && n > 0) next[key] = n;
    onChange(next);
  };

  return (
    <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg bg-subtle p-3">
      {flags.map(([key, label]) => {
        const override = model.overrides[key];
        const value = override !== undefined ? override : null;
        return (
          <div key={key} className="flex items-center justify-between gap-2">
            <span className="text-2xs text-content">
              {label}
              <span className="ml-1 text-content-faint">(reported: {reported[key] === null ? 'unknown' : reported[key] ? 'yes' : 'no'})</span>
            </span>
            <span className="flex overflow-hidden rounded-md border border-line bg-surface text-[10.5px]">
              {([['auto', undefined], ['yes', true], ['no', false]] as const).map(([text, v]) => (
                <button
                  key={text}
                  type="button"
                  onClick={() => setFlag(key, v)}
                  className={cn('px-2 py-0.5', (override === undefined ? v === undefined : value === v) ? 'bg-primary text-primary-foreground' : 'text-content-muted hover:bg-subtle')}
                >
                  {text}
                </button>
              ))}
            </span>
          </div>
        );
      })}
      {(['contextWindow', 'maxOutputTokens'] as const).map((key) => (
        <label key={key} className="flex items-center justify-between gap-2">
          <span className="text-2xs text-content">
            {key === 'contextWindow' ? 'Context window' : 'Max output tokens'}
            <span className="ml-1 text-content-faint">
              (reported: {reported[key] ? formatTokens(reported[key] as number) : 'unknown'})
            </span>
          </span>
          <input
            type="number"
            min={1}
            defaultValue={model.overrides[key] ?? ''}
            onBlur={(e) => setNumber(key, e.target.value)}
            placeholder="auto"
            className="w-24 rounded-md border border-line bg-surface px-2 py-0.5 text-right font-mono text-[11px] focus:outline-none"
          />
        </label>
      ))}
      <p className="col-span-2 flex items-center gap-1 text-[10.5px] text-content-faint">
        <Check size={10} />
        “auto” uses what the provider reported or what the app learned from its answers.
      </p>
    </div>
  );
}
