import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  AgentConfig,
  AgentEventType,
  AgentPermissions,
  AgentStatus,
  ConversationKind,
  ExecutionState,
  MemberType,
  MessageAttachment,
  MessageKind,
  RuntimeType,
  TaskStatus,
  WorkspaceAccess,
} from '../../shared/types.js';
import type {
  AuthMethod,
  McpPromptInfo,
  McpResourceInfo,
  McpServerInfo,
  McpToolInfo,
  McpTransport,
  ProviderCategory,
  ProviderCheck,
  ProviderKind,
  ProviderModel,
  ProviderOptions,
  ToolGrantMode,
} from '../../shared/integrations.js';
import type { AgentActivityState } from '../../shared/activity.js';

const ts = () => Date.now();

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    runtimeType: text('runtime_type').$type<RuntimeType>().notNull(),
    avatar: text('avatar').notNull().default(''),
    avatarColor: text('avatar_color').notNull().default('#7C6CF6'),
    workingDirectory: text('working_directory').notNull(),
    status: text('status').$type<AgentStatus>().notNull().default('offline'),
    statusDetail: text('status_detail'),
    permissions: text('permissions', { mode: 'json' }).$type<AgentPermissions>().notNull(),
    config: text('config', { mode: 'json' }).$type<AgentConfig>().notNull(),
    createdAt: integer('created_at').notNull().$defaultFn(ts),
    updatedAt: integer('updated_at').notNull().$defaultFn(ts),
  },
  (t) => ({ nameIdx: uniqueIndex('agents_name_idx').on(t.name) }),
);

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    createdAt: integer('created_at').notNull().$defaultFn(ts),
  },
  (t) => ({ pathIdx: uniqueIndex('workspaces_path_idx').on(t.path) }),
);

export const workspacePermissions = sqliteTable(
  'workspace_permissions',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    access: text('access').$type<WorkspaceAccess>().notNull(),
    createdAt: integer('created_at').notNull().$defaultFn(ts),
  },
  (t) => ({ pk: primaryKey({ columns: [t.agentId, t.workspaceId] }) }),
);

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<ConversationKind>().notNull(),
  name: text('name').notNull(),
  topic: text('topic'),
  /** An optional emoji shown in place of the channel's #. */
  icon: text('icon'),
  autonomyEnabled: integer('autonomy_enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull().$defaultFn(ts),
  updatedAt: integer('updated_at').notNull().$defaultFn(ts),
});

export const conversationMembers = sqliteTable(
  'conversation_members',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    memberType: text('member_type').$type<MemberType>().notNull(),
    memberId: text('member_id').notNull(),
    joinedAt: integer('joined_at').notNull().$defaultFn(ts),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.memberType, t.memberId] }),
    memberIdx: index('conv_members_member_idx').on(t.memberType, t.memberId),
  }),
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderType: text('sender_type').$type<MemberType>().notNull(),
    senderId: text('sender_id').notNull(),
    kind: text('kind').$type<MessageKind>().notNull().default('chat'),
    body: text('body').notNull(),
    mentions: text('mentions', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    taskId: text('task_id'),
    executionId: text('execution_id'),
    createdAt: integer('created_at').notNull().$defaultFn(ts),
  },
  (t) => ({
    convIdx: index('messages_conv_idx').on(t.conversationId, t.createdAt),
    execIdx: index('messages_exec_idx').on(t.executionId),
  }),
);

/**
 * Native runtime session ids, scoped to (agent, conversation). Keeping that pair
 * unique is what stops one agent resuming another agent's session, and stops a
 * DM session leaking into a channel.
 */
export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    runtimeType: text('runtime_type').$type<RuntimeType>().notNull(),
    /** Claude Code session UUID, or Codex thread id. */
    runtimeSessionId: text('runtime_session_id'),
    lastUsedAt: integer('last_used_at').notNull().$defaultFn(ts),
  },
  (t) => ({
    pairIdx: uniqueIndex('agent_sessions_pair_idx').on(t.agentId, t.conversationId),
  }),
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').$type<TaskStatus>().notNull().default('pending'),
    createdAt: integer('created_at').notNull().$defaultFn(ts),
    updatedAt: integer('updated_at').notNull().$defaultFn(ts),
    completedAt: integer('completed_at'),
  },
  (t) => ({ convIdx: index('tasks_conv_idx').on(t.conversationId) }),
);

export const taskAssignees = sqliteTable(
  'task_assignees',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.taskId, t.agentId] }) }),
);

export const agentExecutions = sqliteTable(
  'agent_executions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    taskId: text('task_id'),
    state: text('state').$type<ExecutionState>().notNull().default('queued'),
    trigger: text('trigger').$type<'human' | 'agent' | 'system'>().notNull(),
    triggeredByMessageId: text('triggered_by_message_id'),
    /** Correlates every execution spawned by one human instruction. */
    chainId: text('chain_id').notNull(),
    chainDepth: integer('chain_depth').notNull().default(0),
    turns: integer('turns').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    error: text('error'),
    startedAt: integer('started_at').notNull().$defaultFn(ts),
    endedAt: integer('ended_at'),
  },
  (t) => ({
    agentIdx: index('exec_agent_idx').on(t.agentId, t.startedAt),
    convIdx: index('exec_conv_idx').on(t.conversationId, t.startedAt),
    chainIdx: index('exec_chain_idx').on(t.chainId),
  }),
);

export const agentEvents = sqliteTable(
  'agent_events',
  {
    id: text('id').primaryKey(),
    executionId: text('execution_id')
      .notNull()
      .references(() => agentExecutions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').$type<AgentEventType>().notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer('created_at').notNull().$defaultFn(ts),
  },
  (t) => ({ execIdx: index('events_exec_idx').on(t.executionId, t.seq) }),
);

export const appSettings = sqliteTable('application_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull().$defaultFn(ts),
});

/**
 * Encrypted credential blobs. `ciphertext` is the OS keychain's output
 * (Electron safeStorage), base64-encoded; nothing here is ever plaintext.
 */
export const secrets = sqliteTable('secrets', {
  id: text('id').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  createdAt: integer('created_at').notNull().$defaultFn(ts),
  updatedAt: integer('updated_at').notNull().$defaultFn(ts),
});

/** User-configured model providers. The API key lives in `secrets`. */
export const providers = sqliteTable(
  'providers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind').$type<ProviderKind>().notNull(),
    preset: text('preset').notNull(),
    category: text('category').$type<ProviderCategory>().notNull(),
    baseUrl: text('base_url').notNull(),
    authMethod: text('auth_method').$type<AuthMethod>().notNull(),
    authHeaderName: text('auth_header_name'),
    /** API key and sensitive header values, encrypted. */
    secretId: text('secret_id'),
    /** Non-sensitive custom headers only. */
    headers: text('headers', { mode: 'json' })
      .$type<Record<string, string>>()
      .notNull()
      .$defaultFn(() => ({})),
    /** Names of the sensitive headers held in the secret. */
    secretHeaderNames: text('secret_header_names', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    options: text('options', { mode: 'json' })
      .$type<ProviderOptions>()
      .notNull()
      .$defaultFn(() => ({})),
    timeoutMs: integer('timeout_ms').notNull().default(60_000),
    models: text('models', { mode: 'json' })
      .$type<ProviderModel[]>()
      .notNull()
      .$defaultFn(() => []),
    lastCheck: text('last_check', { mode: 'json' }).$type<ProviderCheck | null>(),
    createdAt: integer('created_at').notNull().$defaultFn(ts),
    updatedAt: integer('updated_at').notNull().$defaultFn(ts),
  },
  (t) => ({ nameIdx: uniqueIndex('providers_name_idx').on(t.name) }),
);

/**
 * User-configured MCP servers. For stdio servers `approvedFingerprint` records
 * the exact command line the user approved; any change to it needs approval
 * again before a process is launched.
 */
export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    transport: text('transport').$type<McpTransport>().notNull(),
    command: text('command').notNull().default(''),
    args: text('args', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    cwd: text('cwd').notNull().default(''),
    /** Environment variable names; values are in the secret. */
    envKeys: text('env_keys', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    url: text('url').notNull().default(''),
    authMethod: text('auth_method').$type<AuthMethod>().notNull().default('none'),
    authHeaderName: text('auth_header_name'),
    /** Token, sensitive headers and environment values, encrypted. */
    secretId: text('secret_id'),
    headers: text('headers', { mode: 'json' })
      .$type<Record<string, string>>()
      .notNull()
      .$defaultFn(() => ({})),
    secretHeaderNames: text('secret_header_names', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    timeoutMs: integer('timeout_ms').notNull().default(30_000),
    autoConnect: integer('auto_connect', { mode: 'boolean' }).notNull().default(false),
    allowInsecure: integer('allow_insecure', { mode: 'boolean' }).notNull().default(false),
    approvedFingerprint: text('approved_fingerprint'),
    /** Last discovery results, so tools can be granted while disconnected. */
    toolsCache: text('tools_cache', { mode: 'json' })
      .$type<McpToolInfo[]>()
      .notNull()
      .$defaultFn(() => []),
    resourcesCache: text('resources_cache', { mode: 'json' })
      .$type<McpResourceInfo[]>()
      .notNull()
      .$defaultFn(() => []),
    promptsCache: text('prompts_cache', { mode: 'json' })
      .$type<McpPromptInfo[]>()
      .notNull()
      .$defaultFn(() => []),
    serverInfo: text('server_info', { mode: 'json' }).$type<McpServerInfo | null>(),
    createdAt: integer('created_at').notNull().$defaultFn(ts),
    updatedAt: integer('updated_at').notNull().$defaultFn(ts),
  },
  (t) => ({ nameIdx: uniqueIndex('mcp_servers_name_idx').on(t.name) }),
);

/**
 * Which agent may call which MCP tool. Absent means denied: connecting a
 * server grants nothing to anyone.
 */
export const agentToolGrants = sqliteTable(
  'agent_tool_grants',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    mode: text('mode').$type<ToolGrantMode>().notNull().default('ask'),
    createdAt: integer('created_at').notNull().$defaultFn(ts),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agentId, t.serverId, t.toolName] }),
    serverIdx: index('tool_grants_server_idx').on(t.serverId),
  }),
);

/**
 * Agent activity reactions: one row per (message, agent), updated in place as
 * the agent's run moves through its states. The row belongs to one execution;
 * updates from any other execution are rejected by the activity manager.
 */
export const messageActivities = sqliteTable(
  'message_activities',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    executionId: text('execution_id')
      .notNull()
      .references(() => agentExecutions.id, { onDelete: 'cascade' }),
    state: text('state').$type<AgentActivityState>().notNull(),
    emoji: text('emoji').notNull(),
    detail: text('detail'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    revision: integer('revision').notNull().default(1),
    createdAt: integer('created_at').notNull().$defaultFn(ts),
    updatedAt: integer('updated_at').notNull().$defaultFn(ts),
  },
  (t) => ({
    messageAgentIdx: uniqueIndex('message_activities_message_agent_idx').on(t.messageId, t.agentId),
    convIdx: index('message_activities_conv_idx').on(t.conversationId),
    execIdx: index('message_activities_exec_idx').on(t.executionId),
  }),
);

/** Emoji reactions the user added by hand. Never read by the orchestrator. */
export const messageReactions = sqliteTable(
  'message_reactions',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: integer('created_at').notNull().$defaultFn(ts),
  },
  (t) => ({
    uniqueIdx: uniqueIndex('message_reactions_unique_idx').on(t.messageId, t.userId, t.emoji),
    convIdx: index('message_reactions_conv_idx').on(t.conversationId),
  }),
);

/**
 * Files sent with a message. The bytes live under the app's data folder; this
 * row says where, what they are (detected from the bytes) and what the user
 * called them.
 */
export const messageAttachments = sqliteTable(
  'message_attachments',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'image'>().notNull(),
    mimeType: text('mime_type').$type<MessageAttachment['mimeType']>().notNull(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: integer('created_at').notNull().$defaultFn(ts),
  },
  (t) => ({
    messageIdx: index('message_attachments_message_idx').on(t.messageId),
    convIdx: index('message_attachments_conv_idx').on(t.conversationId),
  }),
);

export type AgentRow = typeof agents.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ExecutionRow = typeof agentExecutions.$inferSelect;
export type AgentEventRow = typeof agentEvents.$inferSelect;
export type MessageActivityRow = typeof messageActivities.$inferSelect;
export type MessageReactionRow = typeof messageReactions.$inferSelect;
