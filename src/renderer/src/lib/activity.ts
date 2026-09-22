import type { Agent } from '@shared/types';
import type { Presence } from '@/components/ui/primitives';
import type { AgentActivityState, MessageActivityRecord, MessageReaction } from '@shared/activity';
import { describeActivity } from '@/lib/lexicon';

/** What an agent's activity reads as in a tooltip: a status, plus the tool in use. */
export function describeAgentActivity(
  record: Pick<MessageActivityRecord, 'state' | 'detail'>,
  options: { fromHuman: boolean },
): { status: string; operation: string | null } {
  const { state, detail } = record;
  switch (state) {
    case 'received':
      return { status: detail === 'workspace' ? 'Received — waiting for the workspace' : 'Received', operation: null };
    case 'reading':
      return { status: options.fromHuman ? 'Reading your message' : 'Reading the message', operation: null };
    case 'thinking':
      return { status: detail === 'reasoning' ? 'Thinking' : 'Writing a reply', operation: null };
    case 'working':
      return { status: 'Working', operation: detail ? operationFor(detail) : null };
    case 'processing':
      return { status: 'Processing', operation: null };
    case 'waiting_for_input':
      return {
        status:
          detail === 'approval'
            ? 'Waiting for your approval'
            : detail === 'authorization'
              ? 'Needs authorization'
              : 'Needs more information from you',
        operation: null,
      };
    case 'completed':
      return { status: 'Completed', operation: null };
    case 'failed':
      return { status: detail === 'timeout' ? 'Timed out' : 'Failed', operation: null };
    case 'cancelled':
      return { status: 'Cancelled', operation: null };
    case 'interrupted':
      return { status: 'Interrupted — the app closed during this run', operation: null };
  }
}

/**
 * "Reading files", "Running a command", or "Using search_code" for tools the
 * lexicon does not know. MCP names arrive namespaced (`mcp__tools__notes__echo`,
 * `notes__echo`); only the tool's own name is shown.
 */
function operationFor(tool: string): string {
  return describeActivity(tool) ?? `Using ${tool.split('__').pop() || tool}`;
}

export interface ReactionContributor {
  agentId: string;
  name: string;
  state: AgentActivityState;
  status: string;
  operation: string | null;
}

/** One pill under a message: everyone who reacted with the same emoji. */
export interface ReactionPillView {
  emoji: string;
  count: number;
  agents: ReactionContributor[];
  /** The user reacted with this emoji themselves. */
  mine: boolean;
  /** An agent in this pill is still working on the message. */
  live: boolean;
}

/**
 * Groups a message's agent activity and the user's own reactions into pills,
 * one per emoji. Agents keep their identity inside the pill, so the tooltip
 * can say who is doing what. Agent pills come first, in the order the agents
 * picked the message up; the user's own reactions follow.
 */
export function buildReactionPills(
  activities: MessageActivityRecord[],
  reactions: MessageReaction[],
  agentById: Map<string, Agent>,
  fromHuman: boolean,
): ReactionPillView[] {
  const pills = new Map<string, ReactionPillView>();
  const pillFor = (emoji: string) => {
    let pill = pills.get(emoji);
    if (!pill) {
      pill = { emoji, count: 0, agents: [], mine: false, live: false };
      pills.set(emoji, pill);
    }
    return pill;
  };

  for (const record of [...activities].sort((a, b) => a.createdAt - b.createdAt)) {
    const agent = agentById.get(record.agentId);
    if (!agent) continue;
    const pill = pillFor(record.emoji);
    const { status, operation } = describeAgentActivity(record, { fromHuman });
    pill.agents.push({ agentId: agent.id, name: agent.name, state: record.state, status, operation });
    pill.count += 1;
    if (record.active) pill.live = true;
  }

  for (const reaction of reactions) {
    const pill = pillFor(reaction.emoji);
    if (pill.mine) continue;
    pill.mine = true;
    pill.count += 1;
  }

  return [...pills.values()];
}

/** How far along each state is, so the sidebar shows an agent's most telling one. */
const PRIORITY: Record<AgentActivityState, number> = {
  waiting_for_input: 6,
  working: 5,
  thinking: 4,
  reading: 3,
  processing: 3,
  received: 1,
  completed: 0,
  failed: 0,
  cancelled: 0,
  interrupted: 0,
};

/** The one activity to show next to an agent's name, among its live ones. */
export function leadingActivity(records: MessageActivityRecord[] | undefined): MessageActivityRecord | null {
  if (!records?.length) return null;
  return records.reduce((best, record) => (PRIORITY[record.state] > PRIORITY[best.state] ? record : best));
}

/**
 * The dot next to an agent, from what is actually happening: its most telling
 * live activity first, then whether a run is going at all, then its runtime
 * status. Nothing here is decorative -- each value maps to an observed state.
 */
export function agentPresence(
  agent: Pick<Agent, 'status'>,
  live: MessageActivityRecord[] | undefined,
  running = false,
): Presence {
  const lead = leadingActivity(live);
  if (lead) {
    if (lead.state === 'waiting_for_input') return 'waiting';
    if (lead.state === 'working' || lead.state === 'processing') return 'working';
    if (lead.state === 'thinking' || lead.state === 'reading') return 'thinking';
  }
  if (running) return 'working';
  if (agent.status === 'error') return 'error';
  if (agent.status === 'offline') return 'offline';
  return 'available';
}
