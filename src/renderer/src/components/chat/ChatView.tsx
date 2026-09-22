import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Message } from '@shared/types';
import { AgentStatusIndicator } from '@/components/chat/AgentStatusIndicator';
import { ChannelSettingsDialog } from '@/components/chat/ChannelSettingsDialog';
import { ConversationHeader, type ConversationSearchState } from '@/components/chat/ConversationHeader';
import { MessageComposer } from '@/components/chat/MessageComposer';
import { MessageList, type TranscriptSearch } from '@/components/chat/MessageList';
import { ActivityPanel } from '@/components/layout/ActivityPanel';
import { RightPanel } from '@/components/layout/RightPanel';
import { cn } from '@/lib/utils';
import { findAgentForDm, useApp } from '@/stores/app';

const NO_MESSAGES: Message[] = [];
/** What find-in-conversation looks through: the conversation, not its furniture. */
const SEARCHABLE = new Set<Message['kind']>(['chat', 'task_update', 'execution_error']);

/**
 * One conversation: header, transcript, composer and the status line, with
 * the details or activity drawer opening beside it.
 */
export function ChatView({ conversationId }: { conversationId: string }) {
  const conversation = useApp((s) => s.conversations.find((c) => c.id === conversationId));
  const agents = useApp((s) => s.agents);
  const memberIds = useApp((s) => s.conversationMemberIds);
  const executions = useApp((s) => s.executions);
  const messages = useApp((s) => s.messages[conversationId]) ?? NO_MESSAGES;
  const panel = useApp((s) => s.panel);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The match on screen is counted back from the newest one, so new
  // messages arriving while you search do not move it.
  const [search, setSearch] = useState<{ query: string; fromNewest: number } | null>(null);

  const agent = useMemo(
    () =>
      conversation?.kind === 'dm' ? findAgentForDm(conversation, agents, memberIds) : undefined,
    [conversation, agents, memberIds],
  );

  const liveCount = useMemo(
    () =>
      executions.filter(
        (e) =>
          e.conversationId === conversationId &&
          !['completed', 'failed', 'cancelled'].includes(e.state),
      ).length,
    [executions, conversationId],
  );

  // Each conversation starts without a search.
  useEffect(() => setSearch(null), [conversationId]);

  const matchIds = useMemo(() => {
    const needle = search?.query.trim().toLowerCase();
    if (!needle) return [];
    return messages
      .filter((m) => SEARCHABLE.has(m.kind) && m.body.toLowerCase().includes(needle))
      .map((m) => m.id);
  }, [messages, search?.query]);

  const total = matchIds.length;
  const fromNewest = total ? Math.min(search?.fromNewest ?? 0, total - 1) : 0;
  const current = total ? total - 1 - fromNewest : -1;

  const openSearch = useCallback(() => {
    setSearch((value) => value ?? { query: '', fromNewest: 0 });
    // Already open: bring the caret back to it.
    document.querySelector<HTMLInputElement>('input[aria-label="Find in conversation"]')?.focus();
  }, []);

  // Ctrl+F (Cmd+F) finds in the conversation on screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);

  const headerSearch: ConversationSearchState | null = search
    ? { query: search.query, current, total }
    : null;
  const transcriptSearch: TranscriptSearch | null = useMemo(
    () =>
      total ? { matchIds: new Set(matchIds), currentId: matchIds[current] ?? null } : null,
    [matchIds, current, total],
  );

  if (!conversation) return null;

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col">
        <ConversationHeader
          conversation={conversation}
          agent={agent}
          liveCount={liveCount}
          onOpenSettings={() => setSettingsOpen(true)}
          search={headerSearch}
          onSearchOpen={openSearch}
          onSearchChange={(query) => setSearch({ query, fromNewest: 0 })}
          onSearchStep={(direction) =>
            setSearch((value) =>
              value && total
                ? { ...value, fromNewest: (fromNewest + direction + total) % total }
                : value,
            )
          }
          onSearchClose={() => setSearch(null)}
        />
        <MessageList conversation={conversation} agent={agent} search={transcriptSearch} />
        <MessageComposer conversationId={conversationId} />
        <AgentStatusIndicator conversationId={conversationId} />
      </section>

      <aside
        className={cn(
          'shrink-0 overflow-hidden border-l bg-canvas transition-[width,border-color] duration-base ease-out',
          panel ? 'w-[300px] border-line' : 'w-0 border-transparent',
        )}
      >
        {panel === 'details' ? (
          <RightPanel conversationId={conversationId} />
        ) : panel === 'activity' ? (
          <ActivityPanel conversationId={conversationId} />
        ) : null}
      </aside>

      <ChannelSettingsDialog
        conversation={conversation}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}
