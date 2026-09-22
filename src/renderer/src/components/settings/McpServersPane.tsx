import { ChevronRight, Globe, Loader2, Pencil, Plug, PlugZap, Plus, RotateCw, ShieldCheck, ShieldAlert, Terminal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { McpServerView, McpStatus } from '@shared/integrations';
import { describeToolRisk } from '@shared/integrations';
import { Button, Chip } from '@/components/ui/primitives';
import { McpServerDialog } from '@/components/settings/McpServerDialog';
import { PaneHeader } from '@/components/settings/SettingsDialog';
import { cn } from '@/lib/utils';
import { invoke, useApp } from '@/stores/app';

const STATUS: Record<McpStatus, { label: string; dot: string }> = {
  connected: { label: 'Connected', dot: 'bg-success' },
  connecting: { label: 'Connecting', dot: 'bg-warning animate-pulse-soft' },
  disconnected: { label: 'Disconnected', dot: 'bg-content-faint' },
  error: { label: 'Error', dot: 'bg-danger' },
};

/** Settings → MCP Servers. */
export function McpServersPane() {
  const servers = useApp((s) => s.mcpServers);
  const [dialog, setDialog] = useState<{ server: McpServerView | null } | null>(null);

  return (
    <div>
      <PaneHeader
        title="MCP Servers"
        detail="Tool servers speaking the Model Context Protocol. Connecting a server grants nothing: you choose which agents may use which tools, in each agent's settings. Servers are treated as untrusted; local ones never start without your approval of the exact command."
        action={
          <Button variant="primary" size="sm" onClick={() => setDialog({ server: null })}>
            <Plus size={13} />
            Add MCP server
          </Button>
        }
      />
      {servers.length ? (
        <div className="space-y-2.5">
          {servers.map((server) => (
            <ServerCard key={server.id} server={server} onEdit={() => setDialog({ server })} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-subtle text-content-muted">
            <Plug size={18} />
          </div>
          <p className="text-[13px] font-semibold text-content-strong">No MCP servers yet</p>
          <p className="mx-auto mt-1 max-w-sm text-2xs leading-relaxed text-content-muted">
            Add a local server (a command such as <code className="font-mono">npx -y @modelcontextprotocol/server-filesystem</code>) or a remote Streamable HTTP endpoint.
          </p>
          <Button variant="primary" size="sm" className="mt-4" onClick={() => setDialog({ server: null })}>
            <Plus size={13} />
            Add MCP server
          </Button>
        </div>
      )}
      <McpServerDialog open={dialog !== null} server={dialog?.server ?? null} onOpenChange={(open) => !open && setDialog(null)} />
    </div>
  );
}

function ServerCard({ server, onEdit }: { server: McpServerView; onEdit(): void }) {
  const agents = useApp((s) => s.agents);
  const grants = useApp((s) => s.grants);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<'tools' | 'resources' | 'prompts' | 'server'>('tools');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const usersOf = (toolName?: string) =>
    agents.filter((a) => (grants[a.id] ?? []).some((g) => g.serverId === server.id && (!toolName || g.toolName === toolName)));
  const assigned = usersOf();

  const act = async (action: 'mcp:connect' | 'mcp:disconnect' | 'mcp:reconnect' | 'mcp:delete') => {
    if (action === 'mcp:delete' && !confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await invoke(action, { id: server.id });
      if ((action === 'mcp:connect' || action === 'mcp:reconnect') && 'status' in result && result.status === 'connected') {
        const counts = [
          plural(result.tools.length, 'tool'),
          plural(result.resources.length, 'resource'),
          plural(result.prompts.length, 'prompt'),
        ].join(', ');
        setNotice(`Connection works. Found ${counts}.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const status = STATUS[server.status];
  const commandLine = [server.command, ...server.args].join(' ');

  return (
    <div className="rounded-xl border border-line">
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-content-muted">
          {server.transport === 'stdio' ? <Terminal size={15} /> : <Globe size={15} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-content-strong">{server.name}</span>
            <Chip>{server.transport === 'stdio' ? 'stdio' : 'Streamable HTTP'}</Chip>
            <span className="flex items-center gap-1.5 text-2xs text-content-muted">
              <span className={cn('h-[7px] w-[7px] rounded-full', status.dot)} />
              {status.label}
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-content-faint" title={server.transport === 'stdio' ? commandLine : server.url}>
            {server.transport === 'stdio' ? commandLine : server.url}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-content-muted">
            {server.transport === 'stdio' ? (
              server.launchApproved ? (
                <span className="flex items-center gap-1">
                  <ShieldCheck size={11} /> Launch approved
                </span>
              ) : (
                <span className="flex items-center gap-1 text-warning-ink">
                  <ShieldAlert size={11} /> You'll review the command on connect
                </span>
              )
            ) : null}
            <span>
              {server.tools.length} tool{server.tools.length === 1 ? '' : 's'}
            </span>
            <span>{assigned.length ? `Assigned to ${assigned.map((a) => a.name).join(', ')}` : 'Not assigned to any agent'}</span>
            {server.autoConnect ? <span>Connects on startup</span> : null}
          </p>
          {server.statusDetail ? <p className="mt-1 text-2xs text-danger">{server.statusDetail}</p> : null}
          {error ? <p className="mt-1 text-2xs text-danger">{error}</p> : null}
          {notice && server.status === 'connected' ? <p className="mt-1 text-2xs text-success-ink">{notice}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {server.status === 'connected' ? (
            <>
              <Button size="sm" variant="surface" onClick={() => void act('mcp:reconnect')} disabled={busy} title="Reconnect and rediscover">
                {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
                Test
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void act('mcp:disconnect')} disabled={busy}>
                Disconnect
              </Button>
            </>
          ) : (
            <Button size="sm" variant="surface" onClick={() => void act('mcp:connect')} disabled={busy || server.status === 'connecting'}>
              {busy || server.status === 'connecting' ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />}
              {server.status === 'error' ? 'Retry' : 'Connect'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${server.name}`} title="Edit">
            <Pencil size={12} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void act('mcp:delete')}
            disabled={busy}
            className={cn(confirmDelete && 'text-danger')}
            aria-label={`Remove ${server.name}`}
            title={confirmDelete ? 'Click again to remove' : 'Remove'}
          >
            {confirmDelete ? 'Remove?' : <Trash2 size={12} />}
          </Button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 border-t border-line px-4 py-2 text-left text-2xs font-medium text-content-muted hover:text-content"
        aria-expanded={expanded}
      >
        <ChevronRight size={12} className={cn('transition-transform', expanded && 'rotate-90')} />
        Tools, resources and capabilities
      </button>

      {expanded ? (
        <div className="border-t border-line px-4 pb-3 pt-2">
          <div className="mb-2 flex gap-1">
            {(['tools', 'resources', 'prompts', 'server'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn('rounded-md px-2 py-1 text-2xs font-medium capitalize', tab === t ? 'bg-subtle text-content-strong' : 'text-content-muted hover:text-content')}
              >
                {t === 'server' ? 'Server' : `${t} (${server[t].length})`}
              </button>
            ))}
          </div>

          {tab === 'tools' ? (
            server.tools.length ? (
              <div className="max-h-[300px] divide-y divide-line overflow-y-auto">
                {server.tools.map((tool) => {
                  const users = usersOf(tool.name);
                  const risk = describeToolRisk(tool);
                  return (
                    <div key={tool.name} className="py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11.5px] text-content-strong">{tool.name}</span>
                        <Chip tone={risk === 'read-only' ? 'neutral' : risk === 'writes' ? 'warning' : 'danger'} title="As described by the server; not verified.">
                          {risk}
                        </Chip>
                        <span className="ml-auto text-[10.5px] text-content-faint">{users.length ? users.map((u) => u.name).join(', ') : 'no agents'}</span>
                      </div>
                      {tool.description ? <p className="mt-0.5 text-2xs leading-relaxed text-content-muted">{tool.description}</p> : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-2xs text-content-faint">{server.status === 'connected' ? 'This server offers no tools.' : 'Connect to discover tools.'}</p>
            )
          ) : null}

          {tab === 'resources' ? (
            server.resources.length ? (
              <div className="max-h-[260px] divide-y divide-line overflow-y-auto">
                {server.resources.map((r) => (
                  <div key={r.uri} className="py-1.5">
                    <span className="text-[12px] font-medium text-content">{r.name}</span>
                    <span className="ml-2 font-mono text-[10.5px] text-content-faint">{r.uri}</span>
                    {r.mimeType ? <Chip className="ml-2">{r.mimeType}</Chip> : null}
                    {r.description ? <p className="text-2xs text-content-muted">{r.description}</p> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-2xs text-content-faint">No resources.</p>
            )
          ) : null}

          {tab === 'prompts' ? (
            server.prompts.length ? (
              <div className="divide-y divide-line">
                {server.prompts.map((p) => (
                  <div key={p.name} className="py-1.5">
                    <span className="font-mono text-[11.5px] text-content-strong">{p.name}</span>
                    {p.arguments?.length ? (
                      <span className="ml-2 text-[10.5px] text-content-faint">({p.arguments.map((a) => `${a.name}${a.required ? '' : '?'}`).join(', ')})</span>
                    ) : null}
                    {p.description ? <p className="text-2xs text-content-muted">{p.description}</p> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-2xs text-content-faint">No prompts.</p>
            )
          ) : null}

          {tab === 'server' ? (
            <div className="space-y-2 text-2xs">
              {server.serverInfo ? (
                <>
                  <p className="text-content">
                    <span className="font-medium">{server.serverInfo.name}</span> {server.serverInfo.version}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(server.serverInfo.capabilities).map(([key, on]) => (
                      <Chip key={key} tone={on ? 'success' : 'neutral'} className={cn(!on && 'line-through')}>
                        {key}
                      </Chip>
                    ))}
                  </div>
                  {server.serverInfo.instructions ? (
                    <p className="selectable rounded-lg bg-subtle px-3 py-2 leading-relaxed text-content-muted">{server.serverInfo.instructions}</p>
                  ) : null}
                </>
              ) : (
                <p className="text-content-faint">Connect once to read the server's identity and capabilities.</p>
              )}
              {server.stderrTail.length ? (
                <div>
                  <p className="mb-1 font-medium text-content">Recent output (stderr)</p>
                  <pre className="selectable max-h-[140px] overflow-auto rounded-lg bg-subtle p-2 font-mono text-[10.5px] leading-relaxed text-content-muted">
                    {server.stderrTail.join('\n')}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
