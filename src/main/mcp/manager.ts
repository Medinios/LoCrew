import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppEvent } from '../../shared/ipc.js';
import type {
  AuthMethod,
  McpPromptInfo,
  McpResourceInfo,
  McpServerInfo,
  McpServerView,
  McpStatus,
  McpToolInfo,
  McpTransport,
  ProviderHeader,
} from '../../shared/integrations.js';
import { checkEndpointUrl } from '../../shared/integrations.js';
import type { IntegrationStore, McpServerRow } from '../db/integration-store.js';
import { isSensitiveHeader, redact, type SecretStore } from '../security/secrets.js';

/**
 * The MCP SDK is ESM-only and the main bundle is CommonJS, so it is loaded
 * with a dynamic import on first use (the same approach as the gateway).
 */
type Sdk = {
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport;
  StreamableHTTPClientTransport: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport;
};

let sdk: Sdk | null = null;

async function loadSdk(): Promise<Sdk> {
  if (!sdk) {
    const [client, stdio, http] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    sdk = {
      Client: client.Client,
      StdioClientTransport: stdio.StdioClientTransport,
      StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
    };
  }
  return sdk;
}

const CLIENT_INFO = { name: 'locrew', version: '0.2.0' };
const STDERR_LINES = 40;
const MAX_LISTED = 1000;

/** What the user typed when adding or editing a server. */
export interface McpServerInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Full environment. Omit to keep the stored one. */
  env?: Record<string, string>;
  url?: string;
  authMethod?: AuthMethod;
  authHeaderName?: string | null;
  /** New token. Omit or leave empty to keep the stored one. */
  token?: string;
  headers?: ProviderHeader[];
  timeoutMs?: number;
  autoConnect?: boolean;
  allowInsecure?: boolean;
}

/** What the launch confirmation must show, untruncated. */
export interface LaunchApprovalRequest {
  serverName: string;
  command: string;
  args: string[];
  cwd: string;
  envKeys: string[];
  warnings: string[];
}

export interface McpManagerDeps {
  integrations: IntegrationStore;
  secrets: SecretStore;
  emit(event: AppEvent): void;
  /** Asks the user to approve starting a local process. */
  approveLaunch(request: LaunchApprovalRequest): Promise<boolean>;
}

interface McpSecret extends Record<string, unknown> {
  token?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface LiveServer {
  client: Client | null;
  status: McpStatus;
  detail: string | null;
  stderr: string[];
  connecting: Promise<void> | null;
  /** Set while we close deliberately, so onclose is not reported as a failure. */
  closing: boolean;
}

/**
 * Owns every connection to a user-configured MCP server.
 *
 * MCP servers are tool providers, not participants: nothing here talks to a
 * conversation. Agents reach these tools only through the gateway's tool
 * proxy, which checks each agent's grants before a call gets this far.
 *
 * Every server is treated as untrusted. A stdio server is a program running
 * with the user's privileges, so it is never launched without the user having
 * approved that exact command line; a remote server must use TLS unless the
 * user opts out explicitly, and never receives our credentials on a redirect.
 */
export class McpClientManager {
  private readonly live = new Map<string, LiveServer>();

  constructor(private readonly deps: McpManagerDeps) {}

  /* ------------------------------------------------------------ inspection */

  list(): McpServerView[] {
    return this.deps.integrations.listMcpServers().map((row) => this.toView(row));
  }

  get(id: string): McpServerView | null {
    const row = this.deps.integrations.getMcpServer(id);
    return row ? this.toView(row) : null;
  }

  /** Tools a server offers: live when connected, otherwise the last discovery. */
  toolsOf(id: string): McpToolInfo[] {
    return this.deps.integrations.getMcpServer(id)?.toolsCache ?? [];
  }

  statusOf(id: string): McpStatus {
    return this.live.get(id)?.status ?? 'disconnected';
  }

  /* ---------------------------------------------------------------- config */

  create(input: McpServerInput): McpServerView {
    const name = input.name.trim();
    if (this.deps.integrations.getMcpServerByName(name)) {
      throw new Error(`An MCP server named "${name}" already exists.`);
    }
    this.validate(input);

    const { plain, secret: secretHeaders, secretNames } = splitHeaders(input.headers ?? [], {});
    const secretValue: McpSecret = {
      token: input.token?.trim() || undefined,
      headers: secretHeaders,
      env: input.env ?? {},
    };
    const secretId = hasSecretMaterial(secretValue) ? this.deps.secrets.create(secretValue) : null;

    const row = this.deps.integrations.createMcpServer({
      name,
      transport: input.transport,
      command: input.command?.trim() ?? '',
      args: input.args ?? [],
      cwd: input.cwd?.trim() ?? '',
      envKeys: Object.keys(input.env ?? {}),
      url: input.url?.trim() ?? '',
      authMethod: input.authMethod ?? 'none',
      authHeaderName: input.authHeaderName?.trim() || null,
      secretId,
      headers: plain,
      secretHeaderNames: secretNames,
      timeoutMs: input.timeoutMs ?? 30_000,
      autoConnect: input.autoConnect ?? false,
      allowInsecure: input.allowInsecure ?? false,
      approvedFingerprint: null,
      toolsCache: [],
      resourcesCache: [],
      promptsCache: [],
      serverInfo: null,
    });
    return this.publish(row);
  }

  async update(id: string, input: McpServerInput): Promise<McpServerView> {
    const current = this.requireRow(id);
    const name = input.name.trim();
    const clash = this.deps.integrations.getMcpServerByName(name);
    if (clash && clash.id !== id) throw new Error(`An MCP server named "${name}" already exists.`);
    this.validate(input);

    const stored = this.deps.secrets.read<McpSecret>(current.secretId);
    const { plain, secret: secretHeaders, secretNames } = splitHeaders(
      input.headers ?? [],
      stored.headers ?? {},
    );
    // An empty value in the submitted environment means "keep what is stored":
    // the renderer only ever sees variable names, never their values.
    const env = input.env
      ? Object.fromEntries(Object.entries(input.env).map(([key, value]) => [key, value || stored.env?.[key] || '']))
      : (stored.env ?? {});
    const secretValue: McpSecret = {
      token: input.token?.trim() ? input.token.trim() : stored.token,
      headers: secretHeaders,
      env,
    };
    const secretId = hasSecretMaterial(secretValue)
      ? this.deps.secrets.put(current.secretId, secretValue)
      : (this.deps.secrets.delete(current.secretId), null);

    // Changing how a server is reached means the old connection is stale.
    await this.disconnect(id, { silent: true });

    const row = this.deps.integrations.updateMcpServer(id, {
      name,
      transport: input.transport,
      command: input.command?.trim() ?? '',
      args: input.args ?? [],
      cwd: input.cwd?.trim() ?? '',
      envKeys: Object.keys(secretValue.env ?? {}),
      url: input.url?.trim() ?? '',
      authMethod: input.authMethod ?? 'none',
      authHeaderName: input.authHeaderName?.trim() || null,
      secretId,
      headers: plain,
      secretHeaderNames: secretNames,
      timeoutMs: input.timeoutMs ?? current.timeoutMs,
      autoConnect: input.autoConnect ?? current.autoConnect,
      allowInsecure: input.allowInsecure ?? current.allowInsecure,
      // approvedFingerprint is kept: if the command line changed, it simply
      // no longer matches and the next launch asks again.
    });
    return this.publish(row);
  }

  async delete(id: string): Promise<void> {
    const row = this.requireRow(id);
    await this.disconnect(id, { silent: true });
    this.live.delete(id);
    this.deps.secrets.delete(row.secretId);
    this.deps.integrations.deleteMcpServer(id);
    this.deps.emit({ type: 'mcp-server-deleted', serverId: id });
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Connects and discovers. `interactive` allows asking the user to approve a
   * stdio launch; background reconnects never prompt, they just fail.
   */
  async connect(id: string, options: { interactive: boolean }): Promise<McpServerView> {
    const existing = this.live.get(id);
    if (existing?.connecting) {
      await existing.connecting.catch(() => undefined);
      return this.get(id)!;
    }
    if (existing?.status === 'connected' && existing.client) return this.get(id)!;

    const state: LiveServer = existing ?? {
      client: null,
      status: 'disconnected',
      detail: null,
      stderr: [],
      connecting: null,
      closing: false,
    };
    this.live.set(id, state);

    state.connecting = this.doConnect(id, state, options.interactive).finally(() => {
      state.connecting = null;
    });
    await state.connecting.catch(() => undefined);
    return this.get(id)!;
  }

  async disconnect(id: string, options: { silent?: boolean } = {}): Promise<void> {
    const state = this.live.get(id);
    if (!state?.client) {
      if (state) this.setStatus(id, state, 'disconnected', null, options.silent);
      return;
    }
    state.closing = true;
    try {
      await state.client.close();
    } catch {
      // Already gone.
    } finally {
      state.client = null;
      state.closing = false;
      this.setStatus(id, state, 'disconnected', null, options.silent);
    }
  }

  async reconnect(id: string): Promise<McpServerView> {
    await this.disconnect(id, { silent: true });
    return this.connect(id, { interactive: true });
  }

  /** Connects every server marked auto-connect. Never prompts. */
  async autoConnect(): Promise<void> {
    const rows = this.deps.integrations.listMcpServers().filter((r) => r.autoConnect);
    await Promise.all(rows.map((r) => this.connect(r.id, { interactive: false })));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id, { silent: true })));
  }

  /* ---------------------------------------------------------------- calls */

  /**
   * Calls a tool. Permission checks happen before this (in the tool proxy);
   * this layer enforces liveness, timeouts and output bounds only.
   */
  async callTool(
    id: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<CallToolResult> {
    const row = this.requireRow(id);
    let state = this.live.get(id);

    if (!state?.client || state.status !== 'connected') {
      // One quiet attempt to come back, without prompting the user mid-run.
      await this.connect(id, { interactive: false });
      state = this.live.get(id);
    }
    if (!state?.client || state.status !== 'connected') {
      return errorResult(
        `The MCP server "${row.name}" is not connected${state?.detail ? `: ${state.detail}` : ''}. Ask the operator to reconnect it in Settings → MCP Servers.`,
      );
    }

    try {
      const result = (await state.client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: row.timeoutMs,
        maxTotalTimeout: row.timeoutMs * 4,
        resetTimeoutOnProgress: true,
        signal: options.signal,
      })) as CallToolResult;
      return result;
    } catch (error) {
      return errorResult(
        `The MCP server "${row.name}" failed to run ${toolName}: ${this.clean(row, error)}`,
      );
    }
  }

  async readResource(id: string, uri: string): Promise<string> {
    const row = this.requireRow(id);
    const state = this.live.get(id);
    if (!state?.client) throw new Error(`"${row.name}" is not connected.`);
    const result = await state.client.readResource({ uri }, { timeout: row.timeoutMs });
    return result.contents
      .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : `[binary ${c.mimeType ?? 'content'}]`))
      .join('\n');
  }

  /* -------------------------------------------------------------- internal */

  private async doConnect(id: string, state: LiveServer, interactive: boolean): Promise<void> {
    const row = this.requireRow(id);
    this.setStatus(id, state, 'connecting', null);

    try {
      if (row.transport === 'stdio') {
        const fingerprint = launchFingerprint(row);
        if (row.approvedFingerprint !== fingerprint) {
          if (!interactive) {
            throw new Error('Launching this server needs your approval. Click Connect to review the command.');
          }
          const approved = await this.deps.approveLaunch({
            serverName: row.name,
            command: row.command,
            args: row.args,
            cwd: row.cwd,
            envKeys: row.envKeys,
            warnings: launchWarnings(row.command, row.args),
          });
          if (!approved) throw new Error('Launch was not approved.');
          this.deps.integrations.updateMcpServer(id, { approvedFingerprint: fingerprint });
        }
      } else {
        const problem = checkEndpointUrl(row.url, row.allowInsecure);
        if (problem) throw new Error(problem);
      }

      const { Client } = await loadSdk();
      const client = new Client(CLIENT_INFO, {
        capabilities: {},
        // Keep the discovery cache fresh when a server announces changes.
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (!error && tools) this.storeDiscovery(id, { tools: tools.map(toToolInfo) });
            },
          },
          resources: {
            onChanged: (error, resources) => {
              if (!error && resources) this.storeDiscovery(id, { resources: resources.map(toResourceInfo) });
            },
          },
          prompts: {
            onChanged: (error, prompts) => {
              if (!error && prompts) this.storeDiscovery(id, { prompts: prompts.map(toPromptInfo) });
            },
          },
        },
      });

      const transport = await this.buildTransport(row, state);
      client.onclose = () => {
        if (state.closing || state.client !== client) return;
        state.client = null;
        const tail = state.stderr.slice(-3).join(' ').trim();
        this.setStatus(
          id,
          state,
          'error',
          `The server closed the connection.${tail ? ` Last output: ${this.clean(row, tail)}` : ''}`,
        );
      };

      await withTimeout(client.connect(transport), row.timeoutMs, 'Timed out while connecting.');
      state.client = client;

      await this.discover(id, client);
      this.setStatus(id, state, 'connected', null);
    } catch (error) {
      state.client = null;
      const tail = state.stderr.slice(-3).join(' ').trim();
      const message = this.clean(row, error);
      this.setStatus(id, state, 'error', tail && !message.includes(tail) ? `${message} (${this.clean(row, tail)})` : message);
      throw error;
    }
  }

  private async buildTransport(row: McpServerRow, state: LiveServer) {
    const { StdioClientTransport, StreamableHTTPClientTransport } = await loadSdk();
    const secret = this.deps.secrets.read<McpSecret>(row.secretId);

    if (row.transport === 'stdio') {
      state.stderr = [];
      // The SDK merges only a safe default environment (PATH, HOME, ...) with
      // what we pass, so this app's own environment never leaks to the server.
      const transport = new StdioClientTransport({
        command: row.command,
        args: row.args,
        ...(row.cwd ? { cwd: row.cwd } : {}),
        env: secret.env ?? {},
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean);
        state.stderr.push(...lines);
        if (state.stderr.length > STDERR_LINES) state.stderr.splice(0, state.stderr.length - STDERR_LINES);
      });
      return transport;
    }

    const headers: Record<string, string> = { ...row.headers, ...(secret.headers ?? {}) };
    if (row.authMethod === 'bearer' && secret.token) headers.Authorization = `Bearer ${secret.token}`;
    if (row.authMethod === 'header' && row.authHeaderName && secret.token) {
      headers[row.authHeaderName] = secret.token;
    }

    return new StreamableHTTPClientTransport(new URL(row.url), {
      requestInit: { headers },
      // Credentials are attached to every request, so a redirect must never be
      // followed silently to wherever the server points.
      fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
    });
  }

  private async discover(id: string, client: Client): Promise<void> {
    const capabilities = client.getServerCapabilities() ?? {};
    const version = client.getServerVersion();
    const row = this.requireRow(id);
    const options = { timeout: row.timeoutMs };

    const tools: McpToolInfo[] = [];
    if (capabilities.tools) {
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, options);
        tools.push(...page.tools.map(toToolInfo));
        cursor = page.nextCursor;
      } while (cursor && tools.length < MAX_LISTED);
    }

    const resources: McpResourceInfo[] = [];
    if (capabilities.resources) {
      let cursor: string | undefined;
      do {
        const page = await client.listResources(cursor ? { cursor } : undefined, options);
        resources.push(...page.resources.map(toResourceInfo));
        cursor = page.nextCursor;
      } while (cursor && resources.length < MAX_LISTED);
    }

    const prompts: McpPromptInfo[] = [];
    if (capabilities.prompts) {
      let cursor: string | undefined;
      do {
        const page = await client.listPrompts(cursor ? { cursor } : undefined, options);
        prompts.push(...page.prompts.map(toPromptInfo));
        cursor = page.nextCursor;
      } while (cursor && prompts.length < MAX_LISTED);
    }

    const serverInfo: McpServerInfo = {
      name: version?.name ?? 'unknown',
      version: version?.version ?? '',
      instructions: client.getInstructions(),
      capabilities: {
        tools: !!capabilities.tools,
        resources: !!capabilities.resources,
        prompts: !!capabilities.prompts,
        logging: !!capabilities.logging,
        completions: !!capabilities.completions,
      },
    };

    this.deps.integrations.updateMcpServer(id, {
      toolsCache: tools,
      resourcesCache: resources,
      promptsCache: prompts,
      serverInfo,
    });
  }

  private storeDiscovery(
    id: string,
    patch: { tools?: McpToolInfo[]; resources?: McpResourceInfo[]; prompts?: McpPromptInfo[] },
  ): void {
    if (!this.deps.integrations.getMcpServer(id)) return;
    const row = this.deps.integrations.updateMcpServer(id, {
      ...(patch.tools ? { toolsCache: patch.tools } : {}),
      ...(patch.resources ? { resourcesCache: patch.resources } : {}),
      ...(patch.prompts ? { promptsCache: patch.prompts } : {}),
    });
    this.publish(row);
  }

  private setStatus(
    id: string,
    state: LiveServer,
    status: McpStatus,
    detail: string | null,
    silent = false,
  ): void {
    state.status = status;
    state.detail = detail;
    if (silent) return;
    const row = this.deps.integrations.getMcpServer(id);
    if (row) this.publish(row);
  }

  private publish(row: McpServerRow): McpServerView {
    const view = this.toView(row);
    this.deps.emit({ type: 'mcp-server', server: view });
    return view;
  }

  private toView(row: McpServerRow): McpServerView {
    const state = this.live.get(row.id);
    const secret = this.deps.secrets.read<McpSecret>(row.secretId);
    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      command: row.command,
      args: row.args,
      cwd: row.cwd,
      envKeys: row.envKeys,
      url: row.url,
      authMethod: row.authMethod,
      authHeaderName: row.authHeaderName,
      hasToken: !!secret.token,
      headers: [
        ...Object.entries(row.headers).map(([name, value]) => ({ name, value, secret: false })),
        ...row.secretHeaderNames.map((name) => ({
          name,
          value: '',
          secret: true,
          hasValue: !!secret.headers?.[name],
        })),
      ],
      timeoutMs: row.timeoutMs,
      autoConnect: row.autoConnect,
      allowInsecure: row.allowInsecure,
      launchApproved: row.transport === 'stdio' && row.approvedFingerprint === launchFingerprint(row),
      status: state?.status ?? 'disconnected',
      statusDetail: state?.detail ?? null,
      serverInfo: row.serverInfo,
      tools: row.toolsCache,
      resources: row.resourcesCache,
      prompts: row.promptsCache,
      stderrTail: (state?.stderr ?? []).map((line) => this.clean(row, line)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private validate(input: McpServerInput): void {
    if (!input.name.trim()) throw new Error('Give the server a name.');
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) throw new Error('Enter the command that starts the server.');
    } else {
      const problem = checkEndpointUrl(input.url?.trim() ?? '', input.allowInsecure);
      if (problem) throw new Error(problem);
    }
  }

  private requireRow(id: string): McpServerRow {
    const row = this.deps.integrations.getMcpServer(id);
    if (!row) throw new Error('That MCP server no longer exists.');
    return row;
  }

  /** Error text with every secret this server holds scrubbed out. */
  private clean(row: McpServerRow, error: unknown): string {
    const secret = this.deps.secrets.read<McpSecret>(row.secretId);
    const text = error instanceof Error ? error.message : String(error);
    return redact(text, [
      secret.token,
      ...Object.values(secret.headers ?? {}),
      ...Object.values(secret.env ?? {}),
    ]);
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Identity of a stdio launch: what runs, where, and which variables it gets.
 * Environment values are excluded so rotating a token does not re-prompt, but
 * adding a variable (which can change what a program does) does.
 */
export function launchFingerprint(row: Pick<McpServerRow, 'command' | 'args' | 'cwd' | 'envKeys'>): string {
  return createHash('sha256')
    .update(JSON.stringify([row.command, row.args, row.cwd, [...row.envKeys].sort()]))
    .digest('hex');
}

/** Patterns the security guidance says to call out before launching. */
export function launchWarnings(command: string, args: string[]): string[] {
  const line = [command, ...args].join(' ');
  const warnings: string[] = [];
  if (/\bsudo\b|\brunas\b/i.test(line)) warnings.push('It asks for elevated privileges.');
  if (/\brm\s+-[a-z]*r[a-z]*f|\bdel\s+\/[sq]|\bformat\b|\bmkfs\b/i.test(line)) {
    warnings.push('It contains a destructive file command.');
  }
  if (/\b(curl|wget|iwr|invoke-webrequest)\b.*\|\s*(sh|bash|iex|powershell)/i.test(line)) {
    warnings.push('It downloads and runs a script.');
  }
  if (/-e(nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{20,}/i.test(line)) {
    warnings.push('It runs an encoded command.');
  }
  if (/\b(npx|uvx|pipx|bunx|dlx)\b/i.test(command) || args.some((a) => a === '-y' || a === '--yes')) {
    warnings.push('It downloads a package from a registry the first time it runs.');
  }
  return warnings;
}

function splitHeaders(
  headers: ProviderHeader[],
  storedSecret: Record<string, string>,
): { plain: Record<string, string>; secret: Record<string, string>; secretNames: string[] } {
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.trim();
    if (!name) continue;
    if (header.secret || isSensitiveHeader(name)) {
      const value = header.value || storedSecret[name];
      if (value) secret[name] = value;
    } else {
      plain[name] = header.value;
    }
  }
  return { plain, secret, secretNames: Object.keys(secret) };
}

function hasSecretMaterial(value: McpSecret): boolean {
  return (
    !!value.token ||
    Object.keys(value.headers ?? {}).length > 0 ||
    Object.keys(value.env ?? {}).length > 0
  );
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function toToolInfo(tool: {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}): McpToolInfo {
  const a = tool.annotations ?? {};
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    annotations: {
      ...(typeof a.title === 'string' ? { title: a.title } : {}),
      ...(typeof a.readOnlyHint === 'boolean' ? { readOnlyHint: a.readOnlyHint } : {}),
      ...(typeof a.destructiveHint === 'boolean' ? { destructiveHint: a.destructiveHint } : {}),
      ...(typeof a.idempotentHint === 'boolean' ? { idempotentHint: a.idempotentHint } : {}),
      ...(typeof a.openWorldHint === 'boolean' ? { openWorldHint: a.openWorldHint } : {}),
    },
  };
}

function toResourceInfo(resource: {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}): McpResourceInfo {
  return {
    uri: resource.uri,
    name: resource.name,
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
  };
}

function toPromptInfo(prompt: {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}): McpPromptInfo {
  return {
    name: prompt.name,
    ...(prompt.description ? { description: prompt.description } : {}),
    ...(prompt.arguments ? { arguments: prompt.arguments } : {}),
  };
}
