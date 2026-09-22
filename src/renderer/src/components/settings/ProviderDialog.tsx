import { ArrowLeft, Check, ExternalLink, Loader2, Plus, Save, X, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ConnectionTestView } from '@shared/ipc';
import type { AuthMethod, ProviderCategory, ProviderHeader, ProviderPreset, ProviderView } from '@shared/integrations';
import { UNKNOWN_CAPABILITIES } from '@shared/integrations';
import { presetById, PROVIDER_PRESETS } from '@shared/provider-presets';
import { Button, Field, Input, Modal } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { invoke } from '@/stores/app';

const CATEGORIES: Array<{ id: ProviderCategory; label: string; detail: string }> = [
  { id: 'builtin', label: 'Built-in provider', detail: 'Well-known services with their settings filled in.' },
  { id: 'openai-compatible', label: 'OpenAI-compatible API', detail: 'Any endpoint that speaks Chat Completions.' },
  { id: 'local', label: 'Local model', detail: 'Models served on this computer.' },
  { id: 'custom', label: 'Custom provider', detail: 'Full control over auth, headers and paths.' },
];

interface Form {
  preset: ProviderPreset;
  name: string;
  baseUrl: string;
  authMethod: AuthMethod;
  authHeaderName: string;
  apiKey: string;
  headers: ProviderHeader[];
  timeoutSec: number;
  chatPath: string;
  modelsPath: string;
  tokenParameter: '' | 'max_tokens' | 'max_completion_tokens';
  modelId: string;
}

function formFromPreset(preset: ProviderPreset): Form {
  return {
    preset,
    name: preset.category === 'openai-compatible' || preset.category === 'custom' ? '' : preset.name,
    baseUrl: preset.baseUrl,
    authMethod: preset.authMethod,
    authHeaderName: preset.authHeaderName ?? '',
    apiKey: '',
    headers: [],
    timeoutSec: 60,
    chatPath: preset.options?.chatPath ?? '',
    modelsPath: preset.options?.modelsPath ?? '',
    tokenParameter: preset.options?.tokenParameter ?? '',
    modelId: '',
  };
}

function formFromProvider(provider: ProviderView): Form {
  const preset = presetById(provider.preset) ?? PROVIDER_PRESETS.find((p) => p.id === 'custom')!;
  return {
    preset,
    name: provider.name,
    baseUrl: provider.baseUrl,
    authMethod: provider.authMethod,
    authHeaderName: provider.authHeaderName ?? '',
    apiKey: '',
    headers: provider.headers,
    timeoutSec: Math.round(provider.timeoutMs / 1000),
    chatPath: provider.options.chatPath ?? '',
    modelsPath: provider.options.modelsPath ?? '',
    tokenParameter: provider.options.tokenParameter ?? '',
    modelId: '',
  };
}

/** Add or edit a model provider. */
export function ProviderDialog({
  open,
  provider,
  onOpenChange,
}: {
  open: boolean;
  provider: ProviderView | null;
  onOpenChange(open: boolean): void;
}) {
  const [category, setCategory] = useState<ProviderCategory>('builtin');
  const [form, setForm] = useState<Form | null>(null);
  const [test, setTest] = useState<ConnectionTestView | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(provider ? formFromProvider(provider) : null);
    setCategory(provider?.category ?? 'builtin');
    setTest(null);
    setError(null);
  }, [open, provider]);

  const set = (patch: Partial<Form>) => {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setTest(null);
  };

  const input = () => {
    if (!form) throw new Error('No form');
    const options = {
      ...(form.preset.options ?? {}),
      ...(form.chatPath.trim() ? { chatPath: form.chatPath.trim() } : {}),
      ...(form.modelsPath.trim() || form.preset.options?.modelsPath === '' ? { modelsPath: form.modelsPath.trim() } : {}),
      ...(form.tokenParameter ? { tokenParameter: form.tokenParameter } : {}),
    };
    const manual = form.modelId.trim();
    return {
      name: form.name.trim(),
      preset: form.preset.id,
      kind: form.preset.kind,
      category: form.preset.category,
      baseUrl: form.baseUrl.trim(),
      authMethod: form.authMethod,
      authHeaderName: form.authMethod === 'header' ? form.authHeaderName.trim() : null,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      headers: form.headers.filter((h) => h.name.trim()),
      options,
      timeoutMs: form.timeoutSec * 1000,
      ...(manual ? { models: [{ id: manual, source: 'manual' as const, capabilities: { ...UNKNOWN_CAPABILITIES }, overrides: {} }] } : {}),
    };
  };

  const runTest = async () => {
    setTesting(true);
    setError(null);
    try {
      setTest(await invoke('providers:test', { draft: input(), ...(provider ? { id: provider.id } : {}) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const payload = input();
      if (provider) {
        await invoke('providers:update', { id: provider.id, input: { ...payload, models: mergeManual(provider, payload.models?.[0]?.id) } });
      } else {
        // A successful test already fetched the model list; keep it.
        const models = test?.ok && test.models.length ? [...test.models, ...(payload.models ?? []).filter((m) => !test.models.some((t) => t.id === m.id))] : payload.models;
        const created = await invoke('providers:create', { ...payload, ...(models ? { models } : {}) });
        if (!models?.length && form.preset.options?.modelsPath !== '') {
          await invoke('providers:discover', { id: created.id }).catch(() => undefined);
        }
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const presets = PROVIDER_PRESETS.filter((p) => p.category === category);
  const needsKey = form?.authMethod !== 'none';
  const custom = form?.preset.category === 'custom';

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? `Edit ${provider.name}` : form ? `Add ${form.preset.name}` : 'Add provider'}
      description={form ? form.preset.description : 'Choose what you are connecting.'}
      width={600}
    >
      {!form ? (
        <div>
          <div className="mb-4 grid grid-cols-4 gap-1.5">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                className={cn(
                  'rounded-lg border px-2.5 py-2 text-left transition-colors',
                  category === c.id ? 'border-primary bg-primary/[0.06] shadow-[0_0_0_1px_hsl(var(--primary)/0.35)]' : 'border-line hover:bg-subtle',
                )}
              >
                <span className="block text-[12px] font-semibold text-content-strong">{c.label}</span>
                <span className="mt-0.5 block text-[10.5px] leading-snug text-content-muted">{c.detail}</span>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => setForm(formFromPreset(preset))}
                className="rounded-lg border border-line px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-subtle"
              >
                <span className="block text-[12.5px] font-semibold text-content-strong">{preset.name}</span>
                <span className="mt-0.5 line-clamp-2 block text-2xs leading-snug text-content-muted">{preset.description}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider name">
              <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="My Local AI" autoFocus />
            </Field>
            <Field label="Request timeout (seconds)">
              <Input
                type="number"
                min={1}
                max={600}
                value={form.timeoutSec}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 1 && n <= 600) set({ timeoutSec: n });
                }}
              />
            </Field>
          </div>

          <Field label="Base URL" hint={form.preset.baseUrlEditable ? undefined : 'The standard endpoint for this provider.'}>
            <Input
              value={form.baseUrl}
              onChange={(e) => set({ baseUrl: e.target.value })}
              placeholder="http://localhost:1234/v1"
              className="font-mono text-xs"
              disabled={!form.preset.baseUrlEditable && !custom}
            />
          </Field>

          <div className="grid grid-cols-[170px_1fr] gap-3">
            <Field label="Authentication">
              <select
                value={form.authMethod}
                onChange={(e) => set({ authMethod: e.target.value as AuthMethod })}
                className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[12.5px] text-content focus:outline-none"
              >
                <option value="bearer">Bearer token</option>
                <option value="header">API key header</option>
                <option value="none">None</option>
              </select>
            </Field>
            {needsKey ? (
              <div className={cn('grid gap-2', form.authMethod === 'header' ? 'grid-cols-[1fr_1.5fr]' : 'grid-cols-1')}>
                {form.authMethod === 'header' ? (
                  <Field label="Header name">
                    <Input value={form.authHeaderName} onChange={(e) => set({ authHeaderName: e.target.value })} placeholder="api-key" />
                  </Field>
                ) : null}
                <Field label={`API key${form.preset.apiKeyRequired ? '' : ' (optional)'}`}>
                  <Input
                    type="password"
                    value={form.apiKey}
                    onChange={(e) => set({ apiKey: e.target.value })}
                    placeholder={provider?.hasApiKey ? 'Stored — leave empty to keep' : 'Encrypted with your OS keychain'}
                    autoComplete="off"
                  />
                </Field>
              </div>
            ) : (
              <p className="self-end pb-2 text-2xs text-content-faint">No credential is sent.</p>
            )}
          </div>

          <HeadersEditor headers={form.headers} onChange={(headers) => set({ headers })} />

          {custom ? (
            <div className="grid grid-cols-3 gap-3">
              <Field label="Chat path">
                <Input value={form.chatPath} onChange={(e) => set({ chatPath: e.target.value })} placeholder="/chat/completions" className="font-mono text-xs" />
              </Field>
              <Field label="Models path" hint="Empty = /models.">
                <Input value={form.modelsPath} onChange={(e) => set({ modelsPath: e.target.value })} placeholder="/models" className="font-mono text-xs" />
              </Field>
              <Field label="Output cap field">
                <select
                  value={form.tokenParameter}
                  onChange={(e) => set({ tokenParameter: e.target.value as Form['tokenParameter'] })}
                  className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[12.5px] text-content focus:outline-none"
                >
                  <option value="">max_tokens</option>
                  <option value="max_completion_tokens">max_completion_tokens</option>
                </select>
              </Field>
            </div>
          ) : null}

          <Field label="Model ID (optional)" hint="Models are discovered automatically where the provider lists them. Add one here if it does not, or to start with a specific model.">
            <Input value={form.modelId} onChange={(e) => set({ modelId: e.target.value })} placeholder="my-custom-model" className="font-mono text-xs" />
          </Field>

          <div className="flex items-center gap-3">
            <Button variant="surface" onClick={() => void runTest()} disabled={testing || !form.baseUrl.trim()}>
              {testing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
              Test connection
            </Button>
            <a href={form.preset.docsUrl} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1 text-2xs text-content-muted hover:text-content">
              <ExternalLink size={11} />
              Provider docs
            </a>
          </div>

          {test ? (
            <div className={cn('rounded-lg px-3 py-2 text-2xs leading-relaxed', test.ok ? 'bg-success/[0.07] text-success-ink' : 'bg-danger/[0.06] text-danger')}>
              <span className="flex items-center gap-1.5 font-medium">
                {test.ok ? <Check size={12} /> : <X size={12} />}
                {test.ok ? 'Connection works' : 'Connection failed'}
                {test.ok ? <span className="font-normal text-content-muted">· {test.latencyMs} ms</span> : null}
              </span>
              <span className="selectable mt-0.5 block">{test.message}</span>
              {test.ok && test.models.length ? (
                <span className="mt-1 block text-content-muted">
                  {test.models.slice(0, 6).map((m) => m.id).join(', ')}
                  {test.models.length > 6 ? ` and ${test.models.length - 6} more` : ''}
                </span>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="rounded-lg bg-danger/[0.06] px-3 py-2 text-2xs text-danger">{error}</p> : null}

          <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 border-t border-line bg-surface px-5 pb-5 pt-4 flex items-center justify-between">
            {!provider ? (
              <Button variant="ghost" onClick={() => setForm(null)}>
                <ArrowLeft size={14} />
                Back
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void save()} disabled={saving || !form.name.trim() || !form.baseUrl.trim()}>
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {provider ? 'Save changes' : 'Add provider'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function mergeManual(provider: ProviderView, manual: string | undefined) {
  if (!manual || provider.models.some((m) => m.id === manual)) return provider.models;
  return [...provider.models, { id: manual, source: 'manual' as const, capabilities: { ...UNKNOWN_CAPABILITIES }, overrides: {} }];
}

/** Custom headers. Credential-looking ones are stored encrypted and shown blank afterwards. */
export function HeadersEditor({ headers, onChange }: { headers: ProviderHeader[]; onChange(headers: ProviderHeader[]): void }) {
  const update = (index: number, patch: Partial<ProviderHeader>) => onChange(headers.map((h, i) => (i === index ? { ...h, ...patch } : h)));
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-content">Custom headers</span>
        <button
          type="button"
          onClick={() => onChange([...headers, { name: '', value: '', secret: false }])}
          className="flex items-center gap-1 text-2xs font-medium text-content-muted hover:text-content"
        >
          <Plus size={11} />
          Add header
        </button>
      </div>
      {headers.length ? (
        <div className="space-y-1.5">
          {headers.map((header, index) => (
            <div key={index} className="grid grid-cols-[1fr_1.4fr_auto_auto] items-center gap-2">
              <Input value={header.name} onChange={(e) => update(index, { name: e.target.value })} placeholder="HTTP-Referer" className="h-7 font-mono text-[11.5px]" />
              <Input
                type={header.secret ? 'password' : 'text'}
                value={header.value}
                onChange={(e) => update(index, { value: e.target.value })}
                placeholder={header.secret && header.hasValue ? 'Stored — leave empty to keep' : 'value'}
                className="h-7 font-mono text-[11.5px]"
              />
              <label className="flex items-center gap-1 text-[10.5px] text-content-muted" title="Store encrypted and never show again">
                <input type="checkbox" checked={header.secret} onChange={(e) => update(index, { secret: e.target.checked })} />
                secret
              </label>
              <button type="button" onClick={() => onChange(headers.filter((_, i) => i !== index))} className="text-content-faint hover:text-danger" aria-label="Remove header">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-2xs text-content-faint">None. Headers whose names look like credentials are always stored encrypted.</p>
      )}
    </div>
  );
}
