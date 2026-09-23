/**
 * The complete contract between the renderer and the main process.
 *
 * Every renderer -> main call is validated in the main process against the Zod
 * schema declared here before it reaches any privileged code. The renderer has
 * no filesystem, shell or database access of its own; this file is the entire
 * surface it can reach.
 */
import { z } from 'zod';
import { MAX_SESSION_GRANT_MS } from './types.js';
import type { InvokeChannelName } from './channels.js';
import { EVENT_CHANNEL } from './channels.js';
import type {
  Agent,
  AgentEvent,
  AgentExecution,
  AppInfo,
  AppSettings,
  ApprovalRequestView,
  Conversation,
  ConversationMember,
  Message,
  RuntimeDetection,
  SessionWriteGrant,
  Task,
} from './types.js';
import type {
  A2ACardSummary,
  McpServerView,
  ProviderModel,
  ProviderView,
  ToolGrant,
} from './integrations.js';
import type { MessageActivityRecord, MessageReaction } from './activity.js';
import { isReactionEmoji } from './activity.js';

export { EVENT_CHANNEL };

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

const id = z.string().min(1).max(128);
const runtimeType = z.enum(['claude-code', 'codex', 'model', 'a2a']);
const authMethod = z.enum(['bearer', 'header', 'none']);
const workspaceAccess = z.enum(['read_only', 'read_write', 'approval_required']);

export const agentPermissionsSchema = z.object({
  workspaceAccess,
  allowAgentToAgent: z.boolean(),
  allowTaskUpdates: z.boolean(),
  maxCostPerExecutionUsd: z.number().min(0).max(1000),
});

const a2aConfigSchema = z.object({
  cardUrl: z.string().min(1).max(2048),
  endpointUrl: z.string().min(1).max(2048),
  authMethod,
  authHeaderName: z.string().max(100).nullable(),
  /** Ignored on input: the main process decides where credentials live. */
  secretId: z.string().max(128).nullable(),
  streaming: z.boolean(),
  allowInsecure: z.boolean(),
  protocolVersion: z.string().max(40).nullable(),
  remoteName: z.string().max(200).nullable(),
});

export const agentConfigSchema = z.object({
  model: z.string().max(300).optional(),
  providerId: z.string().max(128).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
  a2a: a2aConfigSchema.optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  systemPromptAppend: z.string().max(8000).optional(),
  autoCompact: z.boolean().default(true),
  autoCompactWindow: z.number().int().min(1000).max(1_000_000).optional(),
  plugins: z.array(z.string().min(1).max(4096)).max(16).optional(),
  maxTurnsPerExecution: z.number().int().min(1).max(200),
  timeoutMs: z.number().int().min(10_000).max(60 * 60 * 1000),
});

export const executionLimitsSchema = z.object({
  maxAgentToAgentTurns: z.number().int().min(0).max(100),
  maxConsecutiveAutoActivations: z.number().int().min(0).max(50),
  maxTaskDurationMs: z.number().int().min(30_000).max(6 * 60 * 60 * 1000),
  maxPendingMessagesPerAgent: z.number().int().min(1).max(200),
  maxConcurrentExecutions: z.number().int().min(1).max(16),
  maxChainCostUsd: z.number().min(0).max(1000),
  autonomousCommunicationEnabled: z.boolean(),
});

/* -------------------------------------------------------------------------- */
/* Request payloads                                                            */
/* -------------------------------------------------------------------------- */

export const createAgentInput = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(500).default(''),
  runtimeType,
  avatar: z.string().max(16).default(''),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#7C6CF6'),
  /** Required for CLI runtimes (checked in the handler); unused by the others. */
  workingDirectory: z.string().max(4096).default(''),
  permissions: agentPermissionsSchema,
  config: agentConfigSchema,
  /** External agents only: the credential, stored encrypted and never returned. */
  a2aToken: z.string().max(16_000).optional(),
});

export const updateAgentInput = z.object({
  id,
  patch: z
    .object({
      name: z.string().min(1).max(64),
      description: z.string().max(500),
      avatar: z.string().max(16),
      avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      workingDirectory: z.string().max(4096),
      permissions: agentPermissionsSchema,
      config: agentConfigSchema,
    })
    .partial(),
  /** New credential for an external agent; omit to keep the stored one. */
  a2aToken: z.string().max(16_000).optional(),
});

/* ------------------------------------------------------------ integrations */

const headerSchema = z.object({
  name: z.string().max(200),
  value: z.string().max(8000),
  secret: z.boolean(),
  hasValue: z.boolean().optional(),
});

const capabilitiesSchema = z.object({
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  tools: z.boolean().nullable(),
  vision: z.boolean().nullable(),
  streaming: z.boolean().nullable(),
  structuredOutput: z.boolean().nullable(),
});

const providerModelSchema = z.object({
  id: z.string().min(1).max(300),
  label: z.string().max(300).optional(),
  source: z.enum(['discovered', 'manual']),
  capabilities: capabilitiesSchema,
  overrides: capabilitiesSchema.partial(),
});

export const providerInput = z.object({
  name: z.string().min(1).max(80),
  preset: z.string().min(1).max(64),
  kind: z.enum(['openai-compatible', 'anthropic', 'gemini', 'ollama']),
  category: z.enum(['builtin', 'openai-compatible', 'local', 'custom']),
  baseUrl: z.string().min(1).max(2048),
  authMethod,
  authHeaderName: z.string().max(100).nullable().optional(),
  apiKey: z.string().max(8000).nullable().optional(),
  headers: z.array(headerSchema).max(32).optional(),
  options: z
    .object({
      tokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
      chatPath: z.string().max(500).optional(),
      modelsPath: z.string().max(500).optional(),
      anthropicVersion: z.string().max(40).optional(),
    })
    .optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  models: z.array(providerModelSchema).max(2000).optional(),
});

export const mcpServerInput = z.object({
  name: z.string().min(1).max(80),
  transport: z.enum(['stdio', 'streamable-http']),
  command: z.string().max(4096).optional(),
  args: z.array(z.string().max(4096)).max(64).optional(),
  cwd: z.string().max(4096).optional(),
  /** Full environment; an empty value keeps the stored value for that key. */
  env: z.record(z.string().min(1).max(256), z.string().max(16_000)).optional(),
  url: z.string().max(2048).optional(),
  authMethod: authMethod.optional(),
  authHeaderName: z.string().max(100).nullable().optional(),
  token: z.string().max(16_000).optional(),
  headers: z.array(headerSchema).max(32).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  autoConnect: z.boolean().optional(),
  allowInsecure: z.boolean().optional(),
});

const grantSchema = z.object({
  serverId: id,
  toolName: z.string().min(1).max(256),
  mode: z.enum(['allow', 'ask']),
});

const channelIcon = z.string().refine(isReactionEmoji, 'A channel icon must be a single emoji.').nullable();

export const createConversationInput = z.object({
  kind: z.enum(['dm', 'channel']),
  name: z.string().min(1).max(80),
  topic: z.string().max(500).nullable().default(null),
  icon: channelIcon.optional(),
  memberAgentIds: z.array(id).max(32).default([]),
});

export const updateConversationInput = z.object({
  id,
  patch: z
    .object({
      name: z.string().min(1).max(80),
      topic: z.string().max(500).nullable(),
      icon: channelIcon,
      autonomyEnabled: z.boolean(),
    })
    .partial(),
});

export const membershipInput = z.object({ conversationId: id, agentId: id });

/**
 * Base64 of one image. The bound is loose on purpose (a 10 MB image is about
 * 14 M characters); the main process decodes and checks the real limits.
 */
const imageInput = z.object({
  name: z.string().max(260),
  data: z.string().min(1).max(14_500_000).regex(/^[A-Za-z0-9+/]+=*$/, 'Images must be base64.'),
});

export const sendMessageInput = z
  .object({
    conversationId: id,
    body: z.string().max(100_000),
    images: z.array(imageInput).max(8).default([]),
  })
  .refine((input) => input.body.trim().length > 0 || input.images.length > 0, 'A message needs text or an image.');

export const listMessagesInput = z.object({
  conversationId: id,
  limit: z.number().int().min(1).max(1000).default(200),
  before: z.number().int().optional(),
});

export const createTaskInput = z.object({
  conversationId: id,
  title: z.string().min(1).max(200),
  description: z.string().max(10_000).default(''),
  assignedAgentIds: z.array(id).max(32).default([]),
});

export const updateTaskInput = z.object({
  id,
  patch: z
    .object({
      title: z.string().min(1).max(200),
      description: z.string().max(10_000),
      status: z.enum([
        'pending',
        'in_progress',
        'waiting',
        'completed',
        'failed',
        'cancelled',
      ]),
      assignedAgentIds: z.array(id).max(32),
    })
    .partial(),
});

export const setGrantsInput = z.object({ agentId: id, grants: z.array(grantSchema).max(2000) });
export const listGrantsInput = z.object({ agentId: id.optional(), serverId: id.optional() });
export const providerTestInput = z.object({ id: id.optional(), draft: providerInput.optional() });
export const setModelsInput = z.object({ id, models: z.array(providerModelSchema).max(2000) });
/** The operator's answer to one pending operation. */
export const approvalResponseInput = z.object({
  id: z.string().min(1).max(128),
  choice: z.discriminatedUnion('decision', [
    z.object({ decision: z.literal('deny') }),
    z.object({ decision: z.literal('once') }),
    z.object({
      decision: z.literal('session'),
      durationMs: z.number().int().min(60_000).max(MAX_SESSION_GRANT_MS).nullable(),
      scope: z.enum(['agent', 'directory']),
    }),
  ]),
});

/**
 * Opening a work session: temporary write access for an agent, or for every
 * agent in its working directory. The directory is taken from the agent, so
 * the renderer can never name a path of its own.
 */
export const sessionGrantInput = z.object({
  agentId: id,
  scope: z.enum(['agent', 'directory']),
  /** `null` lasts until it is revoked or the app closes. */
  durationMs: z.number().int().min(60_000).max(MAX_SESSION_GRANT_MS).nullable(),
});

/** Ending one work session, or every one of them when `id` is null. */
export const sessionRevokeInput = z.object({ id: z.string().min(1).max(128).nullable() });

export const a2aInspectInput = z.object({
  cardUrl: z.string().min(1).max(2048),
  allowInsecure: z.boolean().optional(),
});

/** Upper bound for a profile photo. The renderer sends 256 px images, well under this. */
export const MAX_AVATAR_IMAGE_CHARS = 400_000;

export const settingsInput = z
  .object({
    displayName: z.string().trim().min(1).max(64),
    workspaceName: z.string().trim().min(1).max(64),
    // Raster formats only: no SVG, which can carry script and external references.
    avatarImage: z
      .string()
      .max(MAX_AVATAR_IMAGE_CHARS)
      .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/, 'Unsupported image')
      .nullable(),
    avatarPortrait: z.string().max(64),
    avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    defaultWorkspaceDirectory: z.string().max(4096),
    limits: executionLimitsSchema,
    notifyOnAgentReply: z.boolean(),
    notifyOnLimitReached: z.boolean(),
    developerMode: z.boolean(),
  })
  .partial();

export const toggleReactionInput = z.object({
  messageId: id,
  emoji: z.string().refine(isReactionEmoji, 'Reactions must be a single emoji.'),
});

export const detectRuntimeInput = z.object({ runtimeType });
export const conversationIdInput = z.object({ conversationId: id });
export const executionIdInput = z.object({ executionId: id });
export const agentIdInput = z.object({ agentId: id });
export const idInput = z.object({ id });

/* -------------------------------------------------------------------------- */
/* Channel map                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Maps every invokable channel to its input schema. `main` registers a handler
 * for each key and rejects anything that fails the schema. Adding a channel
 * without adding it here makes it unreachable, which is the intent.
 */
export const INVOKE_SCHEMAS = {
  'agents:list': z.void(),
  'agents:create': createAgentInput,
  'agents:update': updateAgentInput,
  'agents:delete': idInput,
  'agents:detectRuntime': detectRuntimeInput,
  'agents:plugins': z.void(),

  'conversations:list': z.void(),
  'conversations:create': createConversationInput,
  'conversations:update': updateConversationInput,
  'conversations:delete': idInput,
  'conversations:members': conversationIdInput,
  'conversations:addAgent': membershipInput,
  'conversations:removeAgent': membershipInput,

  'messages:list': listMessagesInput,
  'messages:send': sendMessageInput,

  'tasks:list': conversationIdInput,
  'tasks:create': createTaskInput,
  'tasks:update': updateTaskInput,
  'tasks:delete': idInput,

  'executions:active': z.void(),
  'executions:forConversation': conversationIdInput,
  'executions:events': executionIdInput,

  'activity:list': conversationIdInput,
  'activity:live': z.void(),
  'reactions:toggle': toggleReactionInput,
  'executions:cancel': executionIdInput,
  'executions:cancelConversation': conversationIdInput,

  'workspace:pickDirectory': z.void(),
  'workspace:pickFiles': z.void(),
  'workspace:locks': z.void(),

  'settings:get': z.void(),
  'settings:update': settingsInput,

  'costs:summary': z.void(),

  'agents:duplicate': idInput,

  'providers:list': z.void(),
  'providers:create': providerInput,
  'providers:update': z.object({ id, input: providerInput }),
  'providers:delete': idInput,
  'providers:test': providerTestInput,
  'providers:discover': idInput,
  'providers:setModels': setModelsInput,

  'mcp:list': z.void(),
  'mcp:create': mcpServerInput,
  'mcp:update': z.object({ id, input: mcpServerInput }),
  'mcp:delete': idInput,
  'mcp:connect': idInput,
  'mcp:disconnect': idInput,
  'mcp:reconnect': idInput,

  'grants:list': listGrantsInput,
  'grants:set': setGrantsInput,

  'app:info': z.void(),

  'approvals:list': z.void(),
  'approvals:respond': approvalResponseInput,

  'access:list': z.void(),
  'access:grant': sessionGrantInput,
  'access:revoke': sessionRevokeInput,

  'a2a:inspect': a2aInspectInput,
} as const;

export type InvokeChannel = keyof typeof INVOKE_SCHEMAS;

/**
 * Compile-time guarantee that the schema map and the preload allowlist describe
 * exactly the same set of channels. If they drift, one of these two lines fails
 * to typecheck rather than leaving a channel silently unreachable or unvalidated.
 */
type _SchemasCoverAllowlist = InvokeChannelName extends InvokeChannel ? true : never;
type _AllowlistCoversSchemas = InvokeChannel extends InvokeChannelName ? true : never;
const _channelParity: [_SchemasCoverAllowlist, _AllowlistCoversSchemas] = [true, true];
void _channelParity;

/** Return type for each invokable channel. */
export interface InvokeResults {
  'agents:list': Agent[];
  'agents:create': Agent;
  'agents:update': Agent;
  'agents:delete': { ok: true };
  'agents:detectRuntime': RuntimeDetection;
  'agents:plugins': DiscoveredPluginView[];

  'conversations:list': Conversation[];
  'conversations:create': Conversation;
  'conversations:update': Conversation;
  'conversations:delete': { ok: true };
  'conversations:members': ConversationMember[];
  'conversations:addAgent': { ok: true };
  'conversations:removeAgent': { ok: true };

  'messages:list': Message[];
  'messages:send': Message;

  'tasks:list': Task[];
  'tasks:create': Task;
  'tasks:update': Task;
  'tasks:delete': { ok: true };

  'executions:active': AgentExecution[];
  'executions:forConversation': AgentExecution[];
  'executions:events': AgentEvent[];

  'activity:list': { activities: MessageActivityRecord[]; reactions: MessageReaction[] };
  'activity:live': MessageActivityRecord[];
  'reactions:toggle': MessageReaction[];
  'executions:cancel': { ok: true };
  'executions:cancelConversation': { cancelled: number };

  'workspace:pickDirectory': { path: string | null };
  'workspace:pickFiles': { paths: string[] };
  'workspace:locks': WorkspaceLockInfo[];

  'settings:get': AppSettings;
  'settings:update': AppSettings;

  'costs:summary': CostSummary;

  'agents:duplicate': Agent;

  'providers:list': ProviderView[];
  'providers:create': ProviderView;
  'providers:update': ProviderView;
  'providers:delete': { ok: true };
  'providers:test': ConnectionTestView;
  'providers:discover': ProviderView;
  'providers:setModels': ProviderView;

  'mcp:list': McpServerView[];
  'mcp:create': McpServerView;
  'mcp:update': McpServerView;
  'mcp:delete': { ok: true };
  'mcp:connect': McpServerView;
  'mcp:disconnect': McpServerView;
  'mcp:reconnect': McpServerView;

  'grants:list': ToolGrant[];
  'grants:set': ToolGrant[];

  'app:info': AppInfo;

  'approvals:list': ApprovalRequestView[];
  'approvals:respond': { ok: true };

  'access:list': SessionWriteGrant[];
  'access:grant': SessionWriteGrant[];
  'access:revoke': SessionWriteGrant[];

  'a2a:inspect': A2ACardSummary;
}

/** Result of a provider connection test. */
export interface ConnectionTestView {
  ok: boolean;
  message: string;
  latencyMs: number;
  models: ProviderModel[];
}

/** A Claude Code plugin found on this machine, offered per crew member. */
export interface DiscoveredPluginView {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
}

export interface WorkspaceLockInfo {
  path: string;
  agentId: string;
  executionId: string;
  acquiredAt: number;
}

export interface CostSummary {
  totalUsd: number;
  byAgent: Array<{ agentId: string; costUsd: number; executions: number }>;
  last24hUsd: number;
}

/* -------------------------------------------------------------------------- */
/* Events (main -> renderer)                                                   */
/* -------------------------------------------------------------------------- */

export type AppEvent =
  | { type: 'message'; message: Message }
  | { type: 'agent'; agent: Agent }
  | { type: 'agent-deleted'; agentId: string }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'conversation-deleted'; conversationId: string }
  | { type: 'members-changed'; conversationId: string }
  | { type: 'execution'; execution: AgentExecution }
  | { type: 'agent-event'; event: AgentEvent }
  | { type: 'task'; task: Task }
  | { type: 'task-deleted'; taskId: string }
  | { type: 'locks'; locks: WorkspaceLockInfo[] }
  | { type: 'provider'; provider: ProviderView }
  | { type: 'provider-deleted'; providerId: string }
  | { type: 'mcp-server'; server: McpServerView }
  | { type: 'mcp-server-deleted'; serverId: string }
  | { type: 'grants'; agentId: string; grants: ToolGrant[] }
  /** Work sessions started, lapsed or revoked. */
  | { type: 'session-access'; grants: SessionWriteGrant[] }
  /** An agent is waiting for the operator to allow or deny an operation. */
  | { type: 'approval'; request: ApprovalRequestView }
  /** That question is settled, by an answer or because the run ended. */
  | { type: 'approval-resolved'; id: string }
  /** An agent's activity on a message changed. */
  | { type: 'activity'; activity: MessageActivityRecord }
  /** The user's own reactions on a message changed. */
  | { type: 'reactions'; conversationId: string; messageId: string; reactions: MessageReaction[] }
  | {
      type: 'notice';
      level: 'info' | 'warning' | 'error';
      title: string;
      detail: string;
    };


/** Shape exposed on `window.api` by the preload script. */
export interface RendererApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    payload?: z.input<(typeof INVOKE_SCHEMAS)[C]>,
  ): Promise<InvokeResults[C]>;
  onEvent(listener: (event: AppEvent) => void): () => void;
  platform: NodeJS.Platform;
}
