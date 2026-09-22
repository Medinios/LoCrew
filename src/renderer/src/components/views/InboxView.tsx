import { Inbox } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Message } from '@shared/types';
import { ChannelIcon } from '@/components/sidebar/ChannelList';
import { Avatar, EmptyState, PanelHeader } from '@/components/ui/primitives';
import { SHIP } from '@/lib/lexicon';
import { cn, formatWhen, plainPreview } from '@/lib/utils';
import { findAgentForDm, invoke, useApp } from '@/stores/app';

/** How far back each conversation is read for the inbox. */
const PER_CONVERSATION = 25;
const LIMIT = 80;

/**
 * Replies from agents across every channel and DM, newest first, with the
 * ones you have not seen marked. Selecting one opens its conversation.
 */
export function InboxView() {
  const conversations = useApp((s) => s.conversations);
  const agents = useApp((s) => s.agents);
  const memberIds = useApp((s) => s.conversationMemberIds);
  const liveMessages = useApp((s) => s.messages);
  const unread = useApp((s) => s.unread);
  const firstUnreadId = useApp((s) => s.firstUnreadId);
  const select = useApp((s) => s.selectConversation);

  const [fetched, setFetched] = useState<Message[] | null>(null);

  // One recent page per conversation. Messages that arrive afterwards come in
  // through the store, so this only runs when the set of conversations changes.
  const conversationKey = conversations.map((c) => c.id).join(',');
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      conversations.map((c) =>
        invoke('messages:list', { conversationId: c.id, limit: PER_CONVERSATION }).catch(
          () => [] as Message[],
        ),
      ),
    ).then((pages) => {
      if (!cancelled) setFetched(pages.flat());
    });
    return () => {
      cancelled = true;
    };
    // Keyed on the id list, not the array, so a renamed channel does not refetch.
  }, [conversationKey]);

  const items = useMemo(() => {
    const byId = new Map<string, Message>();
    for (const message of fetched ?? []) byId.set(message.id, message);
    for (const list of Object.values(liveMessages)) for (const m of list) byId.set(m.id, m);
    return [...byId.values()]
      .filter(
        (m) =>
          m.senderType === 'agent' &&
          (m.kind === 'chat' || m.kind === 'task_update' || m.kind === 'execution_error'),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, LIMIT);
  }, [fetched, liveMessages]);

  // A message is unread when it is at or after its conversation's first unread one.
  const unreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [conversationId, anchorId] of Object.entries(firstUnreadId)) {
      if (!unread[conversationId]) continue;
      const anchor = items.find((m) => m.id === anchorId);
      for (const m of items) {
        if (m.conversationId === conversationId && anchor && m.createdAt >= anchor.createdAt) ids.add(m.id);
      }
    }
    return ids;
  }, [items, firstUnreadId, unread]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const conversationById = useMemo(
    () => new Map(conversations.map((c) => [c.id, c])),
    [conversations],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader>
        <span className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface text-content-muted">
          <Inbox size={15} strokeWidth={1.9} />
        </span>
        <h1 className="text-title font-semibold text-content-strong">{SHIP.nav.inbox}</h1>
        {unreadIds.size ? (
          <span className="rounded-sm bg-primary/[0.12] px-1.5 py-px text-2xs font-semibold text-primary-ink">
            {unreadIds.size} new
          </span>
        ) : null}
      </PanelHeader>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4 pt-2">
        {fetched === null ? null : items.length ? (
          items.map((message) => {
            const agent = agentById.get(message.senderId);
            const conversation = conversationById.get(message.conversationId);
            if (!conversation) return null;
            const dmAgent =
              conversation.kind === 'dm' ? findAgentForDm(conversation, agents, memberIds) : undefined;
            const isUnread = unreadIds.has(message.id);
            return (
              <button
                key={message.id}
                type="button"
                onClick={() => void select(conversation.id)}
                className="group flex w-full animate-fade-in gap-3 px-5 py-2.5 text-left transition-colors duration-fast hover:bg-subtle/70"
              >
                <Avatar
                  name={agent?.name ?? 'Agent'}
                  color={agent?.avatarColor}
                  emoji={agent?.avatar}
                  size={32}
                  agent
                  ring
                />
                <span className="min-w-0 flex-1">
                  <span className="flex h-5 items-baseline gap-1.5">
                    <bdi className="text-nav font-semibold text-content-strong">
                      {agent?.name ?? 'Agent'}
                    </bdi>
                    <span className="flex min-w-0 items-center gap-1 truncate text-2xs text-content-muted">
                      {conversation.kind === 'channel' ? (
                        <>
                          in
                          <span className="inline-flex items-center gap-1 rounded-sm bg-subtle px-1 py-px text-content">
                            <ChannelIcon channel={conversation} size={11} />
                            <bdi className="truncate">{conversation.name}</bdi>
                          </span>
                        </>
                      ) : (
                        <>in your DM{dmAgent && dmAgent.id !== agent?.id ? ` with ${dmAgent.name}` : ''}</>
                      )}
                    </span>
                    <time className="ml-auto shrink-0 text-2xs tabular-nums text-content-faint">
                      {formatWhen(message.createdAt)}
                    </time>
                  </span>
                  <span
                    className={cn(
                      'line-clamp-2 text-body',
                      isUnread ? 'text-content-strong' : 'text-content-muted',
                      message.kind === 'execution_error' && 'text-danger-ink',
                    )}
                  >
                    {plainPreview(message.body)}
                  </span>
                </span>
                <span className="flex w-2 shrink-0 justify-center pt-[5px]">
                  {isUnread ? <span className="h-[7px] w-[7px] rounded-full bg-primary" /> : null}
                </span>
              </button>
            );
          })
        ) : (
          <EmptyState icon={<Inbox size={20} />} title={SHIP.empty.inbox} detail={SHIP.empty.inboxDetail} />
        )}
      </div>
    </div>
  );
}
