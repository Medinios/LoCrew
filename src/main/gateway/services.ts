import type { Agent, ExecutionState, Message, Task, TaskStatus } from '../../shared/types.js';
import type { AgentToolSurface } from '../mcp/tool-access.js';

/** Where an agent currently is, as far as the orchestrator is concerned. */
export interface ActiveExecutionContext {
  executionId: string;
  conversationId: string;
  chainId: string;
  chainDepth: number;
  taskId: string | null;
}

export interface GatewayMemberView {
  type: 'human' | 'agent';
  id: string;
  name: string;
  runtimeType?: string;
  status?: string;
  executionState?: ExecutionState;
}

export interface SendMessageResult {
  ok: boolean;
  messageId?: string;
  /** Agent ids that were actually woken by this message. */
  delivered: string[];
  /** Agent ids that were addressed but deliberately not woken, with reasons. */
  blocked: Array<{ agentId: string; reason: string }>;
  error?: string;
}

/**
 * Everything the MCP gateway is allowed to do on behalf of an agent.
 *
 * The gateway never touches the database or the orchestrator directly; it goes
 * through this interface, which makes the tool surface easy to test in
 * isolation and keeps the blast radius of a misbehaving agent small.
 */
export interface GatewayServices {
  getActiveContext(agentId: string): ActiveExecutionContext | null;
  getAgent(agentId: string): Agent | null;
  isMember(conversationId: string, agentId: string): boolean;
  listMembers(conversationId: string): GatewayMemberView[];
  readMessages(conversationId: string, limit: number): Message[];
  getConversationContext(conversationId: string): {
    name: string;
    topic: string | null;
    autonomyEnabled: boolean;
    tasks: Task[];
    remainingAgentTurns: number;
    autonomousCommunicationEnabled: boolean;
  } | null;
  sendAgentMessage(input: {
    senderAgentId: string;
    conversationId: string;
    body: string;
    toAgentIds: string[];
  }): Promise<SendMessageResult>;
  updateTask(input: {
    agentId: string;
    taskId: string;
    status: TaskStatus;
    note?: string;
  }): Promise<{ ok: boolean; error?: string }>;
  /**
   * User-configured MCP tools, filtered by each agent's grants. Optional so the
   * gateway still works (with an empty tool endpoint) where none is wired up.
   */
  tools?: AgentToolSurface;
}
