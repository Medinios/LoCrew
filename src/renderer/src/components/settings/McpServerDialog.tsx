import { FolderOpen, Globe, Loader2, Plus, Save, Terminal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AuthMethod, McpServerView, McpTransport, ProviderHeader } from '@shared/integrations';
import { Button, Field, Input, Modal, Switch } from '@/components/ui/primitives';
import { HeadersEditor } from '@/components/settings/ProviderDialog';
import { cn } from '@/lib/utils';
import { invoke } from '@/stores/app';

interface Form {
  name: string;
  transport: McpTransport;
  command: string;
  /** One argument per line, so paths with spaces need no quoting. */
  args: string;
  cwd: string;
  env: Array<{ key: string; value: string; stored: boolean }>;
  url: string;
  authMethod: AuthMethod;
  authHeaderName: string;
  token: string;
  headers: ProviderHeader[];
  timeoutSec: number;
  autoConnect: boolean;
  allowInsecure: boolean;
}

const EMPTY: Form = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  cwd: '',
  env: [],
  url: '',
  authMethod: 'none',
  authHeaderName: '',
  token: '',
  headers: [],
  timeoutSec: 30,
  autoConnect: false,
  allowInsecure: false,
};

function formFromServer(server: McpServerView): Form {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args.join('\n'),
    cwd: server.cwd,
    env: server.envKeys.map((key) => ({ key, value: '', stored: true })),
    url: server.url,
    authMethod: server.authMethod,
    authHeaderName: server.authHeaderName ?? '',
    token: '',
    headers: server.headers,
    timeoutSec: Math.round(server.timeoutMs / 1000),
    autoConnect: server.autoConnect,
    allowInsecure: server.allowInsecure,
  };
}

/** Add or edit an MCP server. */
export function McpServerDialog({
  open,
  server,
  onOpenChange,
}: {
  open: boolean;
  server: McpServerView | null;
  onOpenChange(open: boolean): void;
}) {
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(server ? formFromServer(server) : EMPTY);
    setError(null);
  }, [open, server]);

  const set = (patch: Partial<Form>) => setForm((current) => ({ ...current, ...patch }));

  /** Splits a pasted full command line into command + arguments. */
  const pasteCommand = (text: string) => {
    const parts = text.match(/"[^"]*"|'[^']*'|\S+/g)?.map((p) => p.replace(/^["']|["']$/g, '')) ?? [];
    if (parts.length > 1) set({ command: parts[0]!, args: parts.slice(1).join('\n') });
    else set({ command: text });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input = {
        name: form.name.trim(),
        transport: form.transport,
        command: form.command.trim(),
        args: form.args.split('\n').map((a) => a.trim()).filter(Boolean),
        cwd: form.cwd.trim(),
        env: Object.fromEntries(form.env.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value])),
        url: form.url.trim(),
        authMethod: form.authMethod,
        authHeaderName: form.authMethod === 'header' ? form.authHeaderName.trim() : null,
        ...(form.token.trim() ? { token: form.token.trim() } : {}),
        headers: form.headers.filter((h) => h.name.trim()),
        timeoutMs: form.timeoutSec * 1000,
        autoConnect: form.autoConnect,
        allowInsecure: form.allowInsecure,
      };
      if (server) {
        await invoke('mcp:update', { id: server.id, input });
        onOpenChange(false);
      } else {
        const created = await invoke('mcp:create', input);
        onOpenChange(false);
        // Connect straight away; a local server shows its launch approval first.
        void invoke('mcp:connect', { id: created.id }).catch(() => undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const stdio = form.transport === 'stdio';

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={server ? `Edit ${server.name}` : 'Add MCP server'}
      description="MCP servers give agents tools. Grant them per agent afterwards."
      width={600}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['stdio', 'Local server', 'A program started on this computer (stdio).', <Terminal key="t" size={15} />],
              ['streamable-http', 'Remote server', 'An endpoint reached over Streamable HTTP.', <Globe key="g" size={15} />],
            ] as const
          ).map(([id, title, detail, icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => set({ transport: id })}
              className={cn(
                'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
                form.transport === id ? 'border-primary bg-primary/[0.06] shadow-[0_0_0_1px_hsl(var(--primary)/0.35)]' : 'border-line hover:bg-subtle',
              )}
            >
              <span className="mt-0.5 text-content-muted">{icon}</span>
              <span>
                <span className="block text-[12.5px] font-semibold text-content-strong">{title}</span>
                <span className="block text-2xs text-content-muted">{detail}</span>
              </span>
            </button>
          ))}
        </div>

        <Field label="Name">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={stdio ? 'Filesystem MCP' : 'Remote Tools'} autoFocus />
        </Field>

        {stdio ? (
          <>
            <Field label="Command" hint="Paste a full command line and it is split into the command and its arguments.">
              <Input
                value={form.command}
                onChange={(e) => set({ command: e.target.value })}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text');
                  if (/\s/.test(text.trim())) {
                    e.preventDefault();
                    pasteCommand(text.trim());
                  }
                }}
                placeholder="npx"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Arguments" hint="One per line.">
              <textarea
                value={form.args}
                onChange={(e) => set({ args: e.target.value })}
                rows={3}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:\\workspace'}
                className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-[12px] leading-5 text-content placeholder:text-content-faint focus:border-primary focus:shadow-focus focus:outline-none"
              />
            </Field>
            <Field label="Working directory (optional)">
              <div className="flex gap-2">
                <Input value={form.cwd} onChange={(e) => set({ cwd: e.target.value })} className="font-mono text-xs" />
                <Button
                  variant="surface"
                  className="shrink-0"
                  onClick={async () => {
                    const result = await invoke('workspace:pickDirectory');
                    if (result.path) set({ cwd: result.path });
                  }}
                >
                  <FolderOpen size={14} />
                  Browse
                </Button>
              </div>
            </Field>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-content">Environment variables</span>
                <button
                  type="button"
                  onClick={() => set({ env: [...form.env, { key: '', value: '', stored: false }] })}
                  className="flex items-center gap-1 text-2xs font-medium text-content-muted hover:text-content"
                >
                  <Plus size={11} />
                  Add variable
                </button>
              </div>
              {form.env.length ? (
                <div className="space-y-1.5">
                  {form.env.map((entry, index) => (
                    <div key={index} className="grid grid-cols-[1fr_1.4fr_auto] items-center gap-2">
                      <Input
                        value={entry.key}
                        onChange={(e) => set({ env: form.env.map((x, i) => (i === index ? { ...x, key: e.target.value } : x)) })}
                        placeholder="GITHUB_TOKEN"
                        className="h-7 font-mono text-[11.5px]"
                      />
                      <Input
                        type="password"
                        value={entry.value}
                        onChange={(e) => set({ env: form.env.map((x, i) => (i === index ? { ...x, value: e.target.value } : x)) })}
                        placeholder={entry.stored ? 'Stored — leave empty to keep' : 'value (stored encrypted)'}
                        className="h-7 font-mono text-[11.5px]"
                        autoComplete="off"
                      />
                      <button type="button" onClick={() => set({ env: form.env.filter((_, i) => i !== index) })} className="text-content-faint hover:text-danger" aria-label="Remove variable">
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-2xs text-content-faint">Credentials for local servers belong here. Values are encrypted and never shown again.</p>
              )}
            </div>
            <p className="rounded-lg bg-warning/[0.07] px-3 py-2 text-2xs leading-relaxed text-warning-ink">
              A local server runs with your user account's permissions. The first time it starts — and whenever the command changes — you will see the exact command and must approve it.
            </p>
          </>
        ) : (
          <>
            <Field label="URL">
              <Input value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com/mcp" className="font-mono text-xs" />
            </Field>
            <div className="grid grid-cols-[170px_1fr] gap-3">
              <Field label="Authentication">
                <select
                  value={form.authMethod}
                  onChange={(e) => set({ authMethod: e.target.value as AuthMethod })}
                  className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[12.5px] text-content focus:outline-none"
                >
                  <option value="none">None</option>
                  <option value="bearer">Bearer token</option>
                  <option value="header">Custom header</option>
                </select>
              </Field>
              {form.authMethod !== 'none' ? (
                <div className={cn('grid gap-2', form.authMethod === 'header' ? 'grid-cols-[1fr_1.5fr]' : 'grid-cols-1')}>
                  {form.authMethod === 'header' ? (
                    <Field label="Header name">
                      <Input value={form.authHeaderName} onChange={(e) => set({ authHeaderName: e.target.value })} placeholder="X-API-Key" />
                    </Field>
                  ) : null}
                  <Field label="Token">
                    <Input
                      type="password"
                      value={form.token}
                      onChange={(e) => set({ token: e.target.value })}
                      placeholder={server?.hasToken ? 'Stored — leave empty to keep' : 'Stored encrypted'}
                      autoComplete="off"
                    />
                  </Field>
                </div>
              ) : null}
            </div>
            <HeadersEditor headers={form.headers} onChange={(headers) => set({ headers })} />
            <label className="flex items-center gap-2 text-2xs text-content-muted">
              <input type="checkbox" checked={form.allowInsecure} onChange={(e) => set({ allowInsecure: e.target.checked })} />
              Allow plain http:// to a non-local host (not recommended)
            </label>
          </>
        )}

        <div className="grid grid-cols-2 gap-3">
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
          <div className="flex items-end justify-between gap-3 rounded-lg border border-line px-3 py-2">
            <span>
              <span className="block text-xs font-medium text-content">Connect on startup</span>
              <span className="block text-[10.5px] text-content-muted">Never re-prompts; unapproved commands wait.</span>
            </span>
            <Switch checked={form.autoConnect} onCheckedChange={(v) => set({ autoConnect: v })} label="Connect on startup" />
          </div>
        </div>

        {error ? <p className="rounded-lg bg-danger/[0.06] px-3 py-2 text-2xs text-danger">{error}</p> : null}

        <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 border-t border-line bg-surface px-5 pb-5 pt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving || !form.name.trim() || (stdio ? !form.command.trim() : !form.url.trim())}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {server ? 'Save changes' : 'Add and connect'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
