/**
 * Agents reference screenshots by local path. These check that such images are
 * routed through the aw-image scheme instead of being blanked, and that web
 * images are not fetched behind the reader's back.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../../src/shared/ipc.js';

vi.stubGlobal('window', globalThis.window);
Object.defineProperty(globalThis.window, 'api', {
  writable: true,
  value: {
    invoke: () => Promise.resolve([]),
    onEvent: (_l: (e: AppEvent) => void) => () => undefined,
    platform: 'win32' as NodeJS.Platform,
  },
});

const { MessageItem } = await import('../../src/renderer/src/components/chat/MessageItem.js');

function message(body: string) {
  return {
    id: 'msg:1',
    conversationId: 'conv:1',
    senderType: 'agent' as const,
    senderId: 'agent:1',
    kind: 'chat' as const,
    body,
    mentions: [],
    taskId: null,
    executionId: null,
    attachments: [],
    createdAt: 1,
  };
}

const AGENT = {
  id: 'agent:1',
  name: 'That',
  description: '',
  runtimeType: 'claude-code' as const,
  avatar: '',
  avatarColor: '#4A7CB5',
  workingDirectory: 'D:\\Dev',
  status: 'online' as const,
  statusDetail: null,
  permissions: {
    workspaceAccess: 'approval_required' as const,
    allowAgentToAgent: true,
    allowTaskUpdates: true,
    maxCostPerExecutionUsd: 2,
  },
  config: { autoCompact: true, maxTurnsPerExecution: 24, timeoutMs: 600000 },
  createdAt: 1,
  updatedAt: 1,
};

afterEach(() => cleanup());

describe('images in messages', () => {
  it('loads a Windows path through the aw-image scheme', () => {
    const { container } = render(
      <MessageItem message={message('![mobile](D:/Dev/wardogs/docs/screenshots/home-mobile-360.png)')} />,
    );
    const img = container.querySelector('img[alt="mobile"]');
    expect(img?.getAttribute('src')).toBe(
      `aw-image://local/${encodeURIComponent('D:/Dev/wardogs/docs/screenshots/home-mobile-360.png')}`,
    );
  });

  it('resolves a relative path against the agent working directory', () => {
    const { container } = render(
      <MessageItem agent={AGENT} message={message('![shot](docs/shot.png)')} />,
    );
    expect(container.querySelector('img[alt="shot"]')?.getAttribute('src')).toBe(
      `aw-image://local/${encodeURIComponent('D:\\Dev\\docs\\shot.png')}`,
    );
  });

  it('shows a web image as a link instead of fetching it', () => {
    const { container } = render(
      <MessageItem message={message('![badge](https://example.com/badge.png)')} />,
    );
    expect(container.querySelector('img[alt="badge"]')).toBeNull();
    expect(container.querySelector('a[href="https://example.com/badge.png"]')?.textContent).toBe('badge');
  });

  it('turns a link to a local file into a path chip', () => {
    const { container } = render(
      <MessageItem message={message('See [the report](D:/Dev/report.html)')} />,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('button[title^="D:\\\\Dev\\\\report.html"]')).not.toBeNull();
  });
});
