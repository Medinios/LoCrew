/**
 * Agent activity reactions: what each agent is doing about a message, shown as
 * an emoji on that message.
 *
 * Every state is set from an event the runtime actually produced -- never from
 * a timer, and never inferred from the orchestrator's coarse execution state.
 * See docs/ARCHITECTURE.md, "Activity reactions".
 */

export type AgentActivityState =
  /** The message was routed to the agent; its run is queued. */
  | 'received'
  /** The runtime has the message and has produced no output yet. */
  | 'reading'
  /** The runtime is producing output: reasoning, or the reply itself. */
  | 'thinking'
  /** The runtime invoked a tool (including MCP tools). */
  | 'working'
  /** A runtime that reports no finer detail (external agents) is running. */
  | 'processing'
  /** The run is paused on the user (an approval), or ended asking for input. */
  | 'waiting_for_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** The app stopped while the run was in progress. */
  | 'interrupted';

export const ACTIVITY_EMOJI: Record<AgentActivityState, string> = {
  received: '📨',
  reading: '👀',
  thinking: '💭',
  working: '⚙️',
  processing: '⏳',
  waiting_for_input: '❓',
  completed: '✅',
  failed: '❌',
  cancelled: '🚫',
  interrupted: '⚠️',
};

export const TERMINAL_ACTIVITY_STATES: readonly AgentActivityState[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

/**
 * How much of its work a runtime lets us observe.
 *
 * - `detailed`: it streams output and reports tool calls, so reading,
 *   thinking and working can each be told apart (Claude Code, Codex, agents
 *   on a model provider).
 * - `basic`: it only reports that it is running and how it ended (external
 *   A2A agents). Its internal steps are never guessed.
 */
export type ActivityProfile = 'detailed' | 'basic';

/**
 * Extra, non-sensitive context for a state, used in tooltips:
 * - `thinking`: `reasoning` or `responding`
 * - `working`: the tool's name -- never its arguments or output
 * - `waiting_for_input`: `approval`, `input` or `authorization`
 * - `received`: `workspace` while waiting for the workspace lock
 * - `failed`: `timeout` when the run hit its time limit
 */
export type ActivityDetail = string | null;

/** One agent's activity on one message. At most one per (message, agent). */
export interface MessageActivityRecord {
  id: string;
  messageId: string;
  conversationId: string;
  agentId: string;
  /** The run this reaction belongs to. Updates from any other run are ignored. */
  executionId: string;
  state: AgentActivityState;
  emoji: string;
  detail: ActivityDetail;
  /** True while the run is in progress; false once it has ended. */
  active: boolean;
  /** Increases with every change, so an out-of-date copy never wins. */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** A reaction the user added by hand. Entirely separate from agent activity. */
export interface MessageReaction {
  id: string;
  messageId: string;
  conversationId: string;
  emoji: string;
  userId: string;
  createdAt: number;
}

export function isTerminalActivity(state: AgentActivityState): boolean {
  return TERMINAL_ACTIVITY_STATES.includes(state);
}

/**
 * True for one emoji (including ZWJ sequences, flags, keycaps and skin-tone
 * modifiers) and nothing else, so a reaction can never carry arbitrary text.
 */
export function isReactionEmoji(value: string): boolean {
  if (!value || value.length > 32) return false;
  return /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[#*0-9‍️⃣])+$/u.test(value)
    && /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(value);
}
