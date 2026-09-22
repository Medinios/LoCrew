/**
 * Verifies that detected direction actually reaches the DOM.
 *
 * The detection itself is unit-tested in direction.test.ts; this checks the
 * wiring, because a correct helper that nobody applies is worth nothing.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../../src/shared/ipc.js';
import { DEFAULT_LIMITS } from '../../src/shared/types.js';

vi.stubGlobal('window', globalThis.window);
Object.defineProperty(globalThis.window, 'api', {
  writable: true,
  value: {
    invoke: () => Promise.resolve([]),
    onEvent: (_l: (e: AppEvent) => void) => () => undefined,
    platform: 'win32' as NodeJS.Platform,
  },
});

const { useApp } = await import('../../src/renderer/src/stores/app.js');
const { MessageItem } = await import('../../src/renderer/src/components/chat/MessageItem.js');
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

function message(body: string, id = 'msg:1') {
  return {
    id,
    conversationId: CONVERSATION.id,
    senderType: 'human' as const,
    senderId: 'user:local',
    kind: 'chat' as const,
    body,
    mentions: [],
    taskId: null,
    executionId: null,
    attachments: [],
    createdAt: 1,
  };
}

function seed(messages: ReturnType<typeof message>[]) {
  useApp.setState({
    ready: true,
    agents: [],
    conversations: [CONVERSATION],
    activeConversationId: CONVERSATION.id,
    messages: { [CONVERSATION.id]: messages },
    tasks: {},
    executions: [],
    streams: {},
    locks: [],
    costs: null,
    toasts: [],
    conversationMemberIds: {},
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
 * The element carrying the rendered markdown for a message.
 *
 * Looked up by container rather than by text, because mention isolation splits
 * a line across several nodes and a whole-string text match would miss it.
 */
function bodyOf(container: HTMLElement): HTMLElement {
  const node =
    container.querySelector('.prose-message') ?? container.querySelector('p[dir]');
  return node as HTMLElement;
}

afterEach(() => cleanup());

describe('message direction', () => {
  it('renders a Hebrew message right-to-left', () => {
    const { container } = render(<MessageItem message={message('שלום, מה מצב המשימה?')} />);
    expect(bodyOf(container).getAttribute('dir')).toBe('rtl');
  });

  it('renders an English message left-to-right', () => {
    const { container } = render(
      <MessageItem message={message('What is the status of the task?')} />,
    );
    expect(bodyOf(container).getAttribute('dir')).toBe('ltr');
  });

  it('keeps a Hebrew message RTL despite a leading mention', () => {
    const { container } = render(
      <MessageItem message={message('@Roger למה התיאום ביניכם סגור?')} />,
    );
    expect(bodyOf(container).getAttribute('dir')).toBe('rtl');
  });

  it('marks an error message with its own direction', () => {
    const body = 'ההרצה נכשלה בגלל שגיאת הרשאות';
    render(<MessageItem message={{ ...message(body), kind: 'execution_error' as const }} />);
    expect(screen.getByText(body).getAttribute('dir')).toBe('rtl');
  });

  it('marks a system notice with its own direction', () => {
    const body = 'נעצר כאן: הגעת למכסת ההודעות';
    render(<MessageItem message={{ ...message(body), kind: 'limit_notice' as const }} />);
    expect(screen.getByText(body).getAttribute('dir')).toBe('rtl');
  });

  it('gives each message its own direction in one transcript', () => {
    seed([
      message('Build the authentication endpoints.', 'msg:1'),
      message('קיבלתי, מתחיל לעבוד על זה', 'msg:2'),
    ]);
    const { container } = render(<ChatView conversationId={CONVERSATION.id} />);

    const bodies = [...container.querySelectorAll('.prose-message')];
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.getAttribute('dir')).toBe('ltr');
    expect(bodies[1]?.getAttribute('dir')).toBe('rtl');
  });

  it('does not flip the surrounding chrome for an RTL message', () => {
    seed([message('שלום לכולם', 'msg:1')]);
    const { container } = render(<ChatView conversationId={CONVERSATION.id} />);

    // Only the message body carries a direction; the app frame stays LTR.
    const header = container.querySelector('header');
    expect(header?.getAttribute('dir')).toBeNull();
  });
});

describe('mention isolation', () => {
  it('keeps the @ attached to the name inside RTL text', () => {
    render(<MessageItem message={message('@Roger תבדוק את הקוד')} />);

    // Left alone, the neutral "@" takes the paragraph direction and renders
    // after the name, reading as "Roger@".
    expect(screen.getByText('@Roger').tagName.toLowerCase()).toBe('bdi');
  });

  it('isolates channel tokens too', () => {
    render(<MessageItem message={message('העבר את זה ל #development בבקשה')} />);
    expect(screen.getByText('#development').tagName.toLowerCase()).toBe('bdi');
  });

  it('leaves an email address alone', () => {
    render(<MessageItem message={message('write to sam@example.com about it')} />);
    expect(screen.queryByText('@example.com')).toBeNull();
  });

  it('does not rewrite a mention inside inline code', () => {
    const body = 'run ' + '`npm i @openai/codex-sdk`' + ' first';
    render(<MessageItem message={message(body)} />);
    expect(screen.queryByText('@openai')).toBeNull();
  });

  it('still isolates a mention in an otherwise LTR message', () => {
    render(<MessageItem message={message('Please ask @Roger about the API contract.')} />);
    expect(screen.getByText('@Roger').tagName.toLowerCase()).toBe('bdi');
  });
});
