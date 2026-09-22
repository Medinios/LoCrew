/**
 * Types for the universal integration layer: model providers, MCP servers,
 * per-agent tool grants and external (A2A) agents.
 *
 * Shared by the main process and the renderer, so like `types.ts` this module
 * must stay free of Node and DOM imports. Nothing here ever carries a secret:
 * views sent to the renderer report `hasApiKey`-style booleans instead.
 */

/* -------------------------------------------------------------------------- */
/* Model providers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The wire protocol a provider speaks. Most of the ecosystem speaks OpenAI
 * Chat Completions, so one adapter covers it; the others differ enough in
 * request shape, auth or discovery to need their own.
 */
export type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama';

/** How the Add Provider dialog groups presets. */
export type ProviderCategory = 'builtin' | 'openai-compatible' | 'local' | 'custom';

/**
 * How a credential is sent. `header` covers every non-bearer scheme
 * (`x-api-key`, `api-key`, `x-goog-api-key`, ...) via `authHeaderName`.
 */
export type AuthMethod = 'bearer' | 'header' | 'none';

/**
 * What a model can do. `null` means "not reported by the provider": the app
 * then tries the feature and learns from the answer instead of assuming.
 */
export interface ModelCapabilities {
  contextWindow: number | null;
  maxOutputTokens: number | null;
  tools: boolean | null;
  vision: boolean | null;
  streaming: boolean | null;
  structuredOutput: boolean | null;
}

export const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  contextWindow: null,
  maxOutputTokens: null,
  tools: null,
  vision: null,
  streaming: null,
  structuredOutput: null,
};

export interface ProviderModel {
  id: string;
  /** Display name when the provider reports one. */
  label?: string;
  source: 'discovered' | 'manual';
  /** As reported by the provider (or learned at runtime). */
  capabilities: ModelCapabilities;
  /** The user's corrections, which always win. */
  overrides: Partial<ModelCapabilities>;
}

/** Discovered capabilities with the user's overrides applied. */
export function effectiveCapabilities(model: ProviderModel | undefined): ModelCapabilities {
  if (!model) return { ...UNKNOWN_CAPABILITIES };
  const result = { ...UNKNOWN_CAPABILITIES, ...model.capabilities };
  for (const [key, value] of Object.entries(model.overrides)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

/** A custom header. Sensitive ones are stored encrypted and never sent back. */
export interface ProviderHeader {
  name: string;
  /** Empty for a secret header whose value is already stored. */
  value: string;
  secret: boolean;
  /** For secret headers: whether a value is stored. */
  hasValue?: boolean;
}

export interface ProviderOptions {
  /** Which request field carries the output cap; OpenAI's own API prefers the newer one. */
  tokenParameter?: 'max_tokens' | 'max_completion_tokens';
  /** Chat path relative to the base URL. Defaults per kind. */
  chatPath?: string;
  /** Model list path relative to the base URL. Empty string disables discovery. */
  modelsPath?: string;
  /** Anthropic API version header. */
  anthropicVersion?: string;
}

export interface ProviderCheck {
  ok: boolean;
  message: string;
  at: number;
  latencyMs?: number;
  modelCount?: number;
}

/** A provider as the renderer sees it. */
export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderKind;
  preset: string;
  category: ProviderCategory;
  baseUrl: string;
  authMethod: AuthMethod;
  authHeaderName: string | null;
  hasApiKey: boolean;
  headers: ProviderHeader[];
  options: ProviderOptions;
  timeoutMs: number;
  models: ProviderModel[];
  lastCheck: ProviderCheck | null;
  createdAt: number;
  updatedAt: number;
}

/** Tuning knobs a provider accepts, and their ranges. Absent means unsupported. */
export interface ParameterSpec {
  temperature?: { min: number; max: number; default: number };
  maxOutputTokens?: { min: number; max: number; required: boolean };
}

export interface ProviderPreset {
  id: string;
  name: string;
  category: ProviderCategory;
  kind: ProviderKind;
  baseUrl: string;
  /** Whether the user is expected to change the base URL (Azure, self-hosted). */
  baseUrlEditable: boolean;
  authMethod: AuthMethod;
  authHeaderName?: string;
  apiKeyRequired: boolean;
  docsUrl: string;
  description: string;
  options?: ProviderOptions;
}

/**
 * Parameter ranges by wire protocol. The same idea ("temperature") has
 * different ranges and field names per provider, so the UI reads these rather
 * than assuming one shape.
 */
export const PARAMETER_SPECS: Record<ProviderKind, ParameterSpec> = {
  'openai-compatible': {
    temperature: { min: 0, max: 2, default: 1 },
    maxOutputTokens: { min: 1, max: 1_000_000, required: false },
  },
  anthropic: {
    temperature: { min: 0, max: 1, default: 1 },
    maxOutputTokens: { min: 1, max: 1_000_000, required: true },
  },
  gemini: {
    temperature: { min: 0, max: 2, default: 1 },
    maxOutputTokens: { min: 1, max: 1_000_000, required: false },
  },
  ollama: {
    temperature: { min: 0, max: 2, default: 0.8 },
    maxOutputTokens: { min: 1, max: 1_000_000, required: false },
  },
};

/* -------------------------------------------------------------------------- */
/* MCP servers                                                                 */
/* -------------------------------------------------------------------------- */

export type McpTransport = 'stdio' | 'streamable-http';

export type McpStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion?: string;
  instructions?: string;
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
    logging: boolean;
    completions: boolean;
  };
}

/** An MCP server as the renderer sees it. */
export interface McpServerView {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  cwd: string;
  /** Names only: values are secret. */
  envKeys: string[];
  url: string;
  authMethod: AuthMethod;
  authHeaderName: string | null;
  hasToken: boolean;
  headers: ProviderHeader[];
  timeoutMs: number;
  autoConnect: boolean;
  allowInsecure: boolean;
  /** For stdio: the exact command line has been approved by the user. */
  launchApproved: boolean;
  status: McpStatus;
  statusDetail: string | null;
  serverInfo: McpServerInfo | null;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  /** Last lines a stdio server wrote to stderr, for diagnosing launch failures. */
  stderrTail: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Permission for one agent to call one MCP tool. `ask` puts a confirmation in
 * front of every call; `allow` runs it without asking.
 */
export type ToolGrantMode = 'allow' | 'ask';

export interface ToolGrant {
  agentId: string;
  serverId: string;
  toolName: string;
  mode: ToolGrantMode;
}

/**
 * The mode a new grant starts in: always `ask`. The MCP spec says clients MUST
 * treat annotations from untrusted servers as untrusted and should never make
 * tool-use decisions from them, so a server claiming `readOnlyHint` does not
 * earn silent execution. Running without confirmation is always an explicit
 * choice the user makes per tool.
 */
export function defaultGrantMode(_tool?: McpToolInfo): ToolGrantMode {
  return 'ask';
}

/**
 * How a tool describes itself, for display only. Missing hints take the
 * spec's defaults: not read-only, destructive, open-world.
 */
export function describeToolRisk(tool: McpToolInfo): 'read-only' | 'destructive' | 'writes' {
  const a = tool.annotations ?? {};
  if (a.readOnlyHint === true) return 'read-only';
  if (a.destructiveHint === false) return 'writes';
  return 'destructive';
}

/* -------------------------------------------------------------------------- */
/* External agents (A2A)                                                       */
/* -------------------------------------------------------------------------- */

/** Stored on an `a2a` agent. The credential itself lives in the secret store. */
export interface A2AConfig {
  /** Where the Agent Card was fetched from. */
  cardUrl: string;
  /**
   * The JSON-RPC endpoint the user approved when registering the agent. Pinned
   * here so a card that later points somewhere else cannot silently redirect
   * our credentials.
   */
  endpointUrl: string;
  authMethod: AuthMethod;
  authHeaderName: string | null;
  secretId: string | null;
  streaming: boolean;
  allowInsecure: boolean;
  protocolVersion: string | null;
  remoteName: string | null;
}

export interface A2ASkillSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

/** What a card says, as far as the registration dialog needs to know. */
export interface A2ACardSummary {
  name: string;
  description: string;
  version: string;
  protocolVersion: string | null;
  endpointUrl: string;
  transport: string;
  streaming: boolean;
  skills: A2ASkillSummary[];
  securitySchemes: string[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  /** Why this card cannot be used, if it cannot. */
  problem: string | null;
  /** The endpoint lives on a different origin than the card; the user should know. */
  crossOrigin: boolean;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** True for loopback hosts, where plain HTTP is expected (Ollama, LM Studio, ...). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * Remote endpoints must use TLS unless the user explicitly allowed otherwise.
 * Returns a human-readable reason when the URL is refused.
 */
export function checkEndpointUrl(url: string, allowInsecure = false): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Enter a full URL, including http:// or https://.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only http:// and https:// URLs are supported.';
  }
  if (parsed.username || parsed.password) {
    return 'Put credentials in the key field, not in the URL.';
  }
  if (parsed.protocol === 'http:' && !isLoopbackUrl(url) && !allowInsecure) {
    return 'Remote endpoints must use https://. Plain http:// is only allowed for localhost unless you explicitly allow it.';
  }
  return null;
}
