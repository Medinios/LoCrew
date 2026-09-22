/**
 * Domain types shared across the Electron main process, the preload bridge and
 * the React renderer. This module must stay free of Node and DOM imports so it
 * can be loaded from any of the three.
 */

import type { A2AConfig } from './integrations.js';

/**
 * How an agent runs.
 *
 *  - `claude-code`, `codex`: a local coding CLI driven through its official SDK.
 *  - `model`: any model from a configured provider (OpenAI-compatible, Anthropic,
 *    Gemini, Ollama, ...), driven by the app's own tool loop.
 *  - `a2a`: an external agent reached over the Agent2Agent protocol.
 */
export type RuntimeType = 'claude-code' | 'codex' | 'model' | 'a2a';

/** Runtimes that run a local CLI inside a working directory. */
export function isCliRuntime(runtimeType: RuntimeType): boolean {
  return runtimeType === 'claude-code' || runtimeType === 'codex';
}

/** Lifecycle of an agent's runtime, independent of any single execution. */
export type AgentStatus = 'online' | 'offline' | 'error' | 'unverified';

/**
 * Execution states surfaced in the UI. `waiting_for_agent` means this agent has
 * addressed another agent and is parked until that agent replies.
 */
export type ExecutionState =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'working'
  | 'waiting_for_agent'
  | 'waiting_for_human'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TERMINAL_EXECUTION_STATES: ExecutionState[] = [
  'completed',
  'failed',
  'cancelled',
];

/**
 * How much of the working directory an agent may touch. This is an application
 * level policy; see docs/ARCHITECTURE.md for why it is not a sandbox.
 */
export type WorkspaceAccess = 'read_only' | 'read_write' | 'approval_required';

export type ConversationKind = 'dm' | 'channel';
export type MemberType = 'human' | 'agent';

export type MessageKind =
  | 'chat'
  | 'system'
  | 'task_update'
  | 'execution_error'
  | 'limit_notice'
  /** The runtime compacted its own history at this point in the transcript. */
  | 'compaction';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentPermissions {
  workspaceAccess: WorkspaceAccess;
  /** May this agent be woken by another agent's @mention? */
  allowAgentToAgent: boolean;
  /** May this agent open/append to tasks through gateway tools? */
  allowTaskUpdates: boolean;
  /** Hard ceiling for a single execution, in USD. 0 disables the check. */
  maxCostPerExecutionUsd: number;
}

export interface AgentConfig {
  /**
   * Let the runtime compact its own conversation when the window fills.
   *
   * Claude Code summarises older turns in place, so the agent keeps working
   * past the context limit. The app's transcript is unaffected: SQLite still
   * holds every message, and the UI still renders them all. Only what the
   * model sees is condensed.
   */
  autoCompact: boolean;
  /** Compaction window size. Omitted leaves the runtime's own default. */
  autoCompactWindow?: number;
  /**
   * Local plugin directories to load into this agent, e.g. an installed copy
   * of ponytail. Loaded through the runtime's own plugin mechanism rather than
   * by copying anyone's ruleset into this repository.
   */
  plugins?: string[];
  /**
   * Model id. For CLI runtimes an optional override ("whatever the CLI is
   * configured for" when empty); for `model` agents, the provider's model id.
   */
  model?: string;
  /** `model` agents: which configured provider serves the model. */
  providerId?: string;
  /** `model` agents: sampling temperature, within the provider's range. */
  temperature?: number;
  /** `model` agents: output cap per model turn. */
  maxOutputTokens?: number;
  /** `a2a` agents: how to reach the external agent. */
  a2a?: A2AConfig;
  /** Claude Code only. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * The agent's own instructions. Appended to the workspace persona block, so
   * the house rules (trust boundary, how to reach other agents) always apply.
   */
  systemPromptAppend?: string;
  maxTurnsPerExecution: number;
  timeoutMs: number;
}

export interface Agent {
  id: string;
  name: string;
  /** What this agent is for, shown in the directory. */
  description: string;
  runtimeType: RuntimeType;
  avatar: string;
  avatarColor: string;
  workingDirectory: string;
  status: AgentStatus;
  statusDetail: string | null;
  permissions: AgentPermissions;
  config: AgentConfig;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  name: string;
  topic: string | null;
  /** An optional emoji shown in place of the channel's #. */
  icon: string | null;
  /** Autonomous agent-to-agent routing, per conversation. */
  autonomyEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMember {
  conversationId: string;
  memberType: MemberType;
  memberId: string;
  joinedAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  senderType: MemberType;
  /** Stable id. For humans this is the local user id, for agents the agent id. */
  senderId: string;
  kind: MessageKind;
  body: string;
  /** Agent ids this message explicitly addresses. Resolved at insert time. */
  mentions: string[];
  taskId: string | null;
  executionId: string | null;
  /** Images sent with the message (pasted or dropped into the composer). */
  attachments: MessageAttachment[];
  createdAt: number;
}

/**
 * A file sent with a message. Stored by the main process under the app's own
 * data folder; `path` is where, so local agents can open it directly.
 */
export interface MessageAttachment {
  id: string;
  messageId: string;
  kind: 'image';
  /** Detected from the file's bytes, never taken from the sender's word. */
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Display name only; the stored file has a generated name. */
  name: string;
  path: string;
  sizeBytes: number;
  createdAt: number;
}

export interface Task {
  id: string;
  conversationId: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedAgentIds: string[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface AgentExecution {
  id: string;
  agentId: string;
  conversationId: string;
  taskId: string | null;
  state: ExecutionState;
  /** Why the orchestrator started this run. */
  trigger: 'human' | 'agent' | 'system';
  triggeredByMessageId: string | null;
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

/** One streamed item from a runtime, normalised across adapters. */
export type AgentEventType =
  | 'compaction'
  | 'state'
  | 'text_delta'
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'cost'
  | 'error'
  | 'awaiting_input'
  | 'session';

export interface AgentEvent {
  id: string;
  executionId: string;
  seq: number;
  type: AgentEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

/** Global safety rails. Every field is enforced in the orchestrator. */
export interface ExecutionLimits {
  /** Agent-to-agent hops allowed before a chain is stopped. */
  maxAgentToAgentTurns: number;
  /** Consecutive automatic activations of one agent without human input. */
  maxConsecutiveAutoActivations: number;
  maxTaskDurationMs: number;
  maxPendingMessagesPerAgent: number;
  maxConcurrentExecutions: number;
  /** Spend ceiling for one agent-to-agent chain, in USD. 0 disables. */
  maxChainCostUsd: number;
  /** Master switch for autonomous agent-to-agent routing. */
  autonomousCommunicationEnabled: boolean;
}

export interface AppSettings {
  /** How the local human is shown in the sidebar and on their messages. */
  displayName?: string;
  /** The workspace's name, shown at the top of the sidebar. */
  workspaceName?: string;
  /**
   * The local human's photo: a small square PNG, JPEG or WebP as a data URL.
   * Wins over `avatarPortrait` when set.
   */
  avatarImage?: string | null;
  /** A bundled portrait id; empty means initials. */
  avatarPortrait?: string;
  /** Plate colour behind the initials. */
  avatarColor?: string;
  defaultWorkspaceDirectory: string;
  limits: ExecutionLimits;
  notifyOnAgentReply: boolean;
  notifyOnLimitReached: boolean;
  developerMode: boolean;
}

export interface RuntimeDetection {
  runtimeType: RuntimeType;
  installed: boolean;
  version: string | null;
  /** Path of the binary or package that was found. */
  location: string | null;
  authenticated: boolean;
  /** Human readable next step when something is missing. */
  message: string;
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  maxAgentToAgentTurns: 6,
  maxConsecutiveAutoActivations: 3,
  maxTaskDurationMs: 15 * 60 * 1000,
  maxPendingMessagesPerAgent: 10,
  maxConcurrentExecutions: 2,
  maxChainCostUsd: 5,
  autonomousCommunicationEnabled: true,
};

export const DEFAULT_AGENT_PERMISSIONS: AgentPermissions = {
  workspaceAccess: 'approval_required',
  allowAgentToAgent: true,
  allowTaskUpdates: true,
  maxCostPerExecutionUsd: 2,
};

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  autoCompact: true,
  maxTurnsPerExecution: 24,
  timeoutMs: 10 * 60 * 1000,
};

/** The single local human participant. */
export const LOCAL_USER_ID = 'user:local';
