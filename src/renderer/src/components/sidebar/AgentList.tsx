import { Plus } from 'lucide-react';
import type { Agent, Conversation } from '@shared/types';
import { Avatar, PRESENCE_LABEL } from '@/components/ui/primitives';
import { SidebarRow, UnreadBadge } from '@/components/sidebar/SidebarParts';
import { agentPresence, describeAgentActivity, leadingActivity } from '@/lib/activity';
import { EXECUTION_LABEL, SHIP } from '@/lib/lexicon';
import { findDmForAgent, useApp } from '@/stores/app';

/**
 * Direct messages, one per agent -- the way a messaging app lists people.
 * Each agent's dot says what it is actually doing (available, thinking,
 * working, waiting for you, offline, error), from its live activity.
 * Selecting an agent opens (or recreates) its DM. DMs whose agent has since
 * been deleted stay listed so their history is still reachable.
 */
export function AgentList({
  agents,
  orphanDms,
  busyAgents,
  collapsed,
  onAddAgent,
  showAdd,
}: {
  agents: Agent[];
  orphanDms: Conversation[];
  busyAgents: Map<string, string>;
  collapsed: boolean;
  onAddAgent(): void;
  showAdd: boolean;
}) {
  const view = useApp((s) => s.view);
  const activeId = useApp((s) => s.activeConversationId);
  const unread = useApp((s) => s.unread);
  const conversations = useApp((s) => s.conversations);
  const memberIds = useApp((s) => s.conversationMemberIds);
  const allAgents = useApp((s) => s.agents);
  const openAgentDm = useApp((s) => s.openAgentDm);
  const select = useApp((s) => s.selectConversation);
  const liveActivity = useApp((s) => s.liveActivity);

  return (
    <>
      {agents.map((agent) => {
        const dm = findDmForAgent(agent.id, conversations, memberIds, allAgents);
        const active = view === 'conversation' && !!dm && dm.id === activeId;
        const count = dm ? (unread[dm.id] ?? 0) : 0;
        if (collapsed && !active && !count) return null;
        const live = liveActivity[agent.id];
        const presence = agentPresence(agent, live, busyAgents.has(agent.id));
        const lead = leadingActivity(live);
        const status = lead ? describeAgentActivity(lead, { fromHuman: true }).status : PRESENCE_LABEL[presence];
        return (
          <SidebarRow
            key={agent.id}
            active={active}
            unread={count > 0}
            onClick={() => void openAgentDm(agent.id)}
            icon={
              <Avatar
                name={agent.name}
                color={agent.avatarColor}
                emoji={agent.avatar}
                size={20}
                agent
                presence={presence}
              />
            }
            label={agent.name}
            title={`${agent.name}: ${status}`}
            trailing={count > 0 && !active ? <UnreadBadge count={count} /> : null}
          />
        );
      })}

      {orphanDms.map((dm) => {
        const active = view === 'conversation' && dm.id === activeId;
        const count = unread[dm.id] ?? 0;
        if (collapsed && !active && !count) return null;
        return (
          <SidebarRow
            key={dm.id}
            active={active}
            unread={count > 0}
            muted
            onClick={() => void select(dm.id)}
            icon={<Avatar name={dm.name} size={20} agent />}
            label={dm.name}
            title="This agent no longer exists. The conversation is kept."
            trailing={count > 0 && !active ? <UnreadBadge count={count} /> : null}
          />
        );
      })}

      {showAdd && !collapsed ? (
        <SidebarRow
          muted
          onClick={onAddAgent}
          icon={
            <span className="flex h-5 w-5 items-center justify-center rounded-[6px] border border-dashed border-shell-line">
              <Plus size={12} strokeWidth={2.2} />
            </span>
          }
          label={SHIP.actions.createAgent}
        />
      ) : null}
    </>
  );
}

/** Live state label per busy agent, for tooltips and presence. */
export function busyAgentStates(
  executions: { agentId: string; state: keyof typeof EXECUTION_LABEL }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const execution of executions) {
    if (['completed', 'failed', 'cancelled', 'idle'].includes(execution.state)) continue;
    map.set(execution.agentId, EXECUTION_LABEL[execution.state]);
  }
  return map;
}
