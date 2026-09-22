/**
 * How agent activity and the user's reactions appear under a message: grouped
 * by emoji, with each agent's identity kept, and with stale copies of a
 * reaction never replacing newer ones in the store.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../../src/shared/ipc.js';
import type { Agent } from '../../src/shared/types.js';
import type { MessageActivityRecord, MessageReaction } from '../../src/shared/activity.js';
import { ACTIVITY_EMOJI } from '../../src/shared/activity.js';

vi.stubGlobal('window', globalThis.window);
Object.defineProperty(globalThis.window, 'api', {
  writable: true,
  value: {
    invoke: () => Promise.resolve([]),
    onEvent: (_l: (e: AppEvent) => void) => () => undefined,
    platform: 'win32' as NodeJS.Platform,
  },
});

const { buildReactionPills, describeAgentActivity, leadingActivity } = await import('../../src/renderer/src/lib/activity.js');
const { MessageReactions } = await import('../../src/renderer/src/components/chat/MessageReactions.js');
const { upsertActivity, applyLiveActivity } = await import('../../src/renderer/src/stores/app.js');

afterEach(cleanup);

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: '',
    runtimeType: 'claude-code',
    avatar: '',
    avatarColor: '#7C6CF6',
    workingDirectory: '',
    status: 'online',
    statusDetail: null,
    permissions: { workspaceAccess: 'read_only', allowAgentToAgent: true, allowTaskUpdates: true, maxCostPerExecutionUsd: 0 },
    config: { autoCompact: true, maxTurnsPerExecution: 10, timeoutMs: 60_000 },
    createdAt: 1,
    updatedAt: 1,
  };
}

const CLAUDE = agent('agent:claude', 'Claude');
const CODEX = agent('agent:codex', 'Codex');
const GEMINI = agent('agent:gemini', 'Gemini');
const AGENTS = new Map([CLAUDE, CODEX, GEMINI].map((a) => [a.id, a]));

function activity(
  agentId: string,
  state: MessageActivityRecord['state'],
  extra: Partial<MessageActivityRecord> = {},
): MessageActivityRecord {
  return {
    id: `act:${agentId}`,
    messageId: 'msg:1',
    conversationId: 'conv:1',
    agentId,
    executionId: `exec:${agentId}`,
    state,
    emoji: ACTIVITY_EMOJI[state],
    detail: null,
    active: !['completed', 'failed', 'cancelled', 'interrupted'].includes(state),
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

const mine = (emoji: string): MessageReaction => ({
  id: `rx:${emoji}`,
  messageId: 'msg:1',
  conversationId: 'conv:1',
  emoji,
  userId: 'user:local',
  createdAt: 2,
});

describe('grouping reactions into pills', () => {
  it('groups agents in the same state and keeps who is who', () => {
    const pills = buildReactionPills(
      [activity(CLAUDE.id, 'reading'), activity(CODEX.id, 'reading'), activity(GEMINI.id, 'working', { detail: 'Read' })],
      [],
      AGENTS,
      true,
    );
    expect(pills.map((p) => [p.emoji, p.count])).toEqual([
      ['👀', 2],
      ['⚙️', 1],
    ]);
    expect(pills[0]!.agents.map((a) => `${a.name} — ${a.status}`)).toEqual([
      'Claude — Reading your message',
      'Codex — Reading your message',
    ]);
    expect(pills[1]!.agents[0]).toMatchObject({ name: 'Gemini', status: 'Working', operation: 'Reading files' });
    expect(pills.every((p) => p.live)).toBe(true);
  });

  it('adds the user\'s own reaction to a matching pill without merging identities', () => {
    const pills = buildReactionPills([activity(CLAUDE.id, 'completed')], [mine('✅'), mine('🔥')], AGENTS, true);
    expect(pills).toMatchObject([
      { emoji: '✅', count: 2, mine: true, live: false },
      { emoji: '🔥', count: 1, mine: true, agents: [] },
    ]);
    expect(pills[0]!.agents.map((a) => a.name)).toEqual(['Claude']);
  });

  it('describes MCP tools by their own name, and never beyond it', () => {
    expect(describeAgentActivity({ state: 'working', detail: 'mcp__tools__files__search_code' }, { fromHuman: true }).operation).toBe(
      'Using search_code',
    );
    expect(describeAgentActivity({ state: 'failed', detail: 'timeout' }, { fromHuman: true }).status).toBe('Timed out');
    expect(describeAgentActivity({ state: 'reading', detail: null }, { fromHuman: false }).status).toBe('Reading the message');
  });

  it('picks the most telling live state for the sidebar', () => {
    expect(leadingActivity([activity(CLAUDE.id, 'received'), activity(CLAUDE.id, 'working', { id: 'act:2' })])?.state).toBe('working');
    expect(leadingActivity([])).toBeNull();
  });
});

describe('keeping the newest copy', () => {
  it('never lets an older revision replace a newer one', () => {
    const newer = activity(CLAUDE.id, 'completed', { revision: 5 });
    const older = activity(CLAUDE.id, 'working', { revision: 3 });
    expect(upsertActivity([newer], older)).toEqual([newer]);
    expect(upsertActivity([older], newer)).toEqual([newer]);
  });

  it('drops an agent from the live list when its run ends, and a stale copy cannot revive it', () => {
    const empty = { liveActivity: {}, endedActivity: {} };
    const thinking = applyLiveActivity(empty, activity(CLAUDE.id, 'thinking', { revision: 2 }));
    expect(Object.keys(thinking.liveActivity)).toEqual([CLAUDE.id]);

    const ended = applyLiveActivity(thinking, activity(CLAUDE.id, 'completed', { revision: 3 }));
    expect(ended.liveActivity).toEqual({});

    // A late "thinking" (say, from a snapshot taken before completion) is ignored.
    expect(applyLiveActivity(ended, activity(CLAUDE.id, 'thinking', { revision: 2 })).liveActivity).toEqual({});

    // A new run claiming the same message and agent is newer, and does show.
    const again = applyLiveActivity(ended, activity(CLAUDE.id, 'received', { revision: 4, executionId: 'exec:2' }));
    expect(again.liveActivity[CLAUDE.id]?.[0]?.state).toBe('received');
  });
});

describe('the reaction bar', () => {
  const renderBar = (pills: ReturnType<typeof buildReactionPills>, onToggle = vi.fn()) =>
    render(
      <Tooltip.Provider>
        <MessageReactions view={{ pills, replies: 0, firstReplyId: null }} onToggle={onToggle} />
      </Tooltip.Provider>,
    );

  it('names every agent on the pill for assistive technology', () => {
    renderBar(buildReactionPills([activity(CLAUDE.id, 'thinking', { detail: 'reasoning' }), activity(CODEX.id, 'working', { detail: 'Bash' })], [], AGENTS, true));
    expect(screen.getByRole('img', { name: /Claude: Thinking/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Codex: Working, Running a command/ })).toBeTruthy();
  });

  it('toggles only the user\'s own reaction; agent activity cannot be clicked away', () => {
    const onToggle = vi.fn();
    renderBar(buildReactionPills([activity(CLAUDE.id, 'completed')], [mine('👍')], AGENTS, true), onToggle);

    // The agent-only ✅ pill is not a button.
    expect(screen.queryByRole('button', { name: /✅/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /👍/ }));
    expect(onToggle).toHaveBeenCalledWith('👍');
  });
});
