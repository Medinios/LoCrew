/**
 * Regression tests for unstable Zustand selectors.
 *
 * A selector that builds a new object or array on every call -- the classic
 * `s.tasks[id] ?? []` -- fails zustand's Object.is comparison, so the store
 * reports a change on every render and React loops until it throws
 * "Maximum update depth exceeded".
 *
 * TypeScript cannot see this and the main-process tests cannot either: it only
 * appears once a component is actually mounted. That is what these tests do.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { AppEvent } from '../../src/shared/ipc.js';
import { DEFAULT_LIMITS } from '../../src/shared/types.js';

// The renderer talks to main only through window.api; a stub is enough here.
const invokeResults: Record<string, unknown> = {
  'conversations:members': [],
  'costs:summary': { totalUsd: 0, last24hUsd: 0, byAgent: [] },
  'tasks:list': [],
  'messages:list': [],
  'executions:forConversation': [],
};

vi.stubGlobal('window', globalThis.window);
Object.defineProperty(globalThis.window, 'api', {
  writable: true,
  value: {
    invoke: (channel: string) => Promise.resolve(invokeResults[channel] ?? []),
    onEvent: (_listener: (event: AppEvent) => void) => () => undefined,
    platform: 'win32' as NodeJS.Platform,
  },
});

const { SHIP } = await import('../../src/renderer/src/lib/lexicon.js');
const { useApp } = await import('../../src/renderer/src/stores/app.js');
const { RightPanel } = await import('../../src/renderer/src/components/layout/RightPanel.js');
const { ChatView } = await import('../../src/renderer/src/components/chat/ChatView.js');

const CONVERSATION = {
  id: 'conv:1',
  kind: 'channel' as const,
  name: 'development',
  topic: null,
  icon: null,
  autonomyEnabled: true,
  createdAt: 1,
  updatedAt: 1,
};

function seedStore() {
  useApp.setState({
    ready: true,
    agents: [],
    conversations: [CONVERSATION],
    activeConversationId: CONVERSATION.id,
    // Deliberately empty: this is the state that triggered the original bug,
    // because the conversation has no entry in `tasks` or `messages` at all.
    messages: {},
    tasks: {},
    executions: [],
    streams: {},
    locks: [],
    costs: null,
    toasts: [],
    settings: {
      defaultWorkspaceDirectory: '/tmp',
      limits: { ...DEFAULT_LIMITS },
      notifyOnAgentReply: false,
      notifyOnLimitReached: true,
      developerMode: false,
    },
  });
}

/**
 * Renders a component and fails if React re-renders runaway.
 *
 * An unstable selector produces an unbounded render loop, which React aborts
 * with error #185. Catching the throw is the assertion.
 */
function renderWithoutLooping(element: ReactElement): void {
  expect(() => render(element)).not.toThrow();
}

afterEach(() => {
  cleanup();
});

describe('renderer selector stability', () => {
  it('renders the right panel for a conversation with no tasks', () => {
    seedStore();
    renderWithoutLooping(<RightPanel conversationId={CONVERSATION.id} />);
    expect(screen.getByText(SHIP.panel.title)).toBeDefined();
  });

  it('renders the chat view for a conversation with no messages', () => {
    seedStore();
    renderWithoutLooping(<ChatView conversationId={CONVERSATION.id} />);
    expect(screen.getByText('development')).toBeDefined();
  });

  it('keeps the tasks selector referentially stable across reads', () => {
    seedStore();
    const read = () => useApp.getState().tasks[CONVERSATION.id];

    // Both are undefined, and the component-side default must be a shared
    // constant rather than a fresh [] built inside the selector.
    expect(read()).toBe(read());
  });

  it('keeps every store-slice selector referentially stable', () => {
    seedStore();
    const state = useApp.getState();

    // Reading the same slice twice must yield the same reference, or any
    // component subscribing to it re-renders forever.
    for (const key of ['agents', 'conversations', 'executions', 'streams', 'locks', 'toasts'] as const) {
      expect(useApp.getState()[key]).toBe(state[key]);
    }
  });

  it('survives a task list appearing for the conversation', () => {
    seedStore();
    const { rerender } = render(<RightPanel conversationId={CONVERSATION.id} />);

    useApp.setState({
      tasks: {
        [CONVERSATION.id]: [
          {
            id: 'task:1',
            conversationId: CONVERSATION.id,
            title: 'Build auth',
            description: '',
            status: 'pending',
            assignedAgentIds: [],
            createdAt: 1,
            updatedAt: 1,
            completedAt: null,
          },
        ],
      },
    });

    expect(() => rerender(<RightPanel conversationId={CONVERSATION.id} />)).not.toThrow();
    expect(screen.getByText('Build auth')).toBeDefined();
  });
});
