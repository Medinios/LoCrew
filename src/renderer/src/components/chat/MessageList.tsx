import { ArrowDown } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, AgentExecution, Conversation, Message } from '@shared/types';
import type { MessageActivityRecord, MessageReaction } from '@shared/activity';
import { Avatar, TypingDots } from '@/components/ui/primitives';
import { MessageItem } from '@/components/chat/MessageItem';
import { ChannelIcon } from '@/components/sidebar/ChannelList';
import { buildReplyCounts, type MessageReactionsView } from '@/components/chat/MessageReactions';
import { buildReactionPills } from '@/lib/activity';
import { detectDirection } from '@/lib/direction';
import { EXECUTION_LABEL, SHIP } from '@/lib/lexicon';
import { cn, formatDay } from '@/lib/utils';
import { invoke, useApp } from '@/stores/app';

const NO_MESSAGES: Message[] = [];
const NO_ACTIVITIES: MessageActivityRecord[] = [];
const NO_REACTIONS: MessageReaction[] = [];

/** Kinds of message the user can react to; notices and markers are furniture. */
const REACTABLE = new Set<Message['kind']>(['chat', 'task_update', 'execution_error']);

/** Find-in-conversation results, for marking and scrolling to matches. */
export interface TranscriptSearch {
  matchIds: Set<string>;
  currentId: string | null;
}

/**
 * The scrolling transcript. Messages sit directly on the canvas; the only
 * furniture is a thin line for each day and a teal one for where unread
 * messages begin.
 */
export function MessageList({
  conversation,
  agent,
  search,
}: {
  conversation: Conversation;
  /** The other end of a DM. */
  agent?: Agent;
  search?: TranscriptSearch | null;
}) {
  const conversationId = conversation.id;
  const messages = useApp((s) => s.messages[conversationId]) ?? NO_MESSAGES;
  const agents = useApp((s) => s.agents);
  const executions = useApp((s) => s.executions);
  const streams = useApp((s) => s.streams);
  const newDividerId = useApp((s) => s.newDividerId[conversationId]);
  const activities = useApp((s) => s.activities[conversationId]) ?? NO_ACTIVITIES;
  const reactions = useApp((s) => s.reactions[conversationId]) ?? NO_REACTIONS;
  const toggleReaction = useApp((s) => s.toggleReaction);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const conversationExecutions = useMemo(
    () => executions.filter((e) => e.conversationId === conversationId),
    [executions, conversationId],
  );
  const liveExecutions = useMemo(
    () =>
      conversationExecutions.filter((e) => !['completed', 'failed', 'cancelled'].includes(e.state)),
    [conversationExecutions],
  );
  const reactionViews = useReactionViews({
    messages,
    activities,
    reactions,
    executions: conversationExecutions,
    agentById,
    // In a DM every message is for the one agent and its reply sits right
    // below, so the replies pill only earns its place in channels.
    showReplies: conversation.kind === 'channel',
  });

  // Land at the bottom of every conversation you open.
  useEffect(() => {
    atBottomRef.current = true;
    setShowJump(false);
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [conversationId]);

  // Follow the transcript only when the reader is already at the bottom, so
  // scrolling back through history is not yanked away by a streaming reply.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (atBottomRef.current) element.scrollTop = element.scrollHeight;
    else setShowJump(true);
  }, [messages, streams]);

  // Stay pinned when the view changes size under the reader -- a window
  // resize, the composer growing, a side panel opening, a code block laying out.
  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    atBottomRef.current = atBottom;
    if (atBottom) setShowJump(false);
  };

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    setShowJump(false);
  };

  const jumpToReply = useCallback(
    (messageId: string) => {
      const replyId = reactionViews.get(messageId)?.firstReplyId;
      if (!replyId) return;
      const target = document.getElementById(`msg-${replyId}`);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.remove('animate-flash');
      void target.offsetWidth; // restart the animation
      target.classList.add('animate-flash');
    },
    [reactionViews],
  );

  // Bring the match being shown into view; reading it means leaving the bottom.
  const currentMatch = search?.currentId ?? null;
  useEffect(() => {
    if (!currentMatch) return;
    const target = document.getElementById(`msg-${currentMatch}`);
    if (!target) return;
    atBottomRef.current = false;
    target.scrollIntoView({ block: 'center' });
  }, [currentMatch]);

  const grouped = groupByDay(messages);

  return (
    <div className="relative min-h-0 flex-1">
      <div className="fade-under-header pointer-events-none absolute inset-x-0 top-0 z-10 h-3" />

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto overflow-x-hidden"
      >
        <div ref={contentRef} className="flex min-h-full flex-col justify-end pb-3 pt-2">
          {!messages.length && !liveExecutions.length ? (
            <ConversationIntro conversation={conversation} agent={agent} />
          ) : null}

          {grouped.map(([day, dayMessages], dayIndex) => (
            <section key={day}>
              {/* A day line marks each boundary, and dates any history not from today. */}
              {dayIndex > 0 || day !== 'Today' ? <Divider label={day} /> : null}
              {dayMessages.map((message, index) => (
                <Fragment key={message.id}>
                  {message.id === newDividerId ? <Divider label="New" tone="new" /> : null}
                  <MessageItem
                    message={message}
                    agent={agentById.get(message.senderId)}
                    previous={message.id === newDividerId ? undefined : dayMessages[index - 1]}
                    reactions={reactionViews.get(message.id)}
                    onJumpToReply={jumpToReply}
                    onToggleReaction={REACTABLE.has(message.kind) ? toggleReaction : undefined}
                    highlight={
                      message.id === currentMatch
                        ? 'current'
                        : search?.matchIds.has(message.id)
                          ? 'match'
                          : undefined
                    }
                  />
                </Fragment>
              ))}
            </section>
          ))}

          {/* Before any text streams, the status line under the composer says
              who is working; the transcript only grows once there is a reply. */}
          {liveExecutions
            .filter((execution) => streams[execution.id]?.text)
            .map((execution) => (
            <LiveReply
              key={execution.id}
              execution={execution}
              agent={agentById.get(execution.agentId)}
              text={streams[execution.id]?.text ?? ''}
              activity={streams[execution.id]?.activity ?? null}
            />
            ))}
        </div>
      </div>

      {showJump ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 z-10 flex h-7 -translate-x-1/2 animate-pop-in items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs font-medium text-content-strong shadow-popover transition-colors duration-fast hover:border-primary/50 hover:text-primary-ink"
        >
          <ArrowDown size={13} />
          New messages
        </button>
      ) : null}
    </div>
  );
}

/** A thin rule across the transcript with a small centred label. */
function Divider({ label, tone = 'day' }: { label: string; tone?: 'day' | 'new' }) {
  return (
    <div className="flex items-center gap-3 px-5 py-2.5" role="separator" aria-label={label}>
      <span className={cn('h-px flex-1', tone === 'new' ? 'bg-primary/60' : 'bg-line')} />
      <span
        className={cn(
          'rounded-sm text-[10px] font-semibold uppercase tracking-label',
          tone === 'new'
            ? 'bg-primary/[0.12] px-1.5 py-px text-primary-ink'
            : 'border border-line bg-surface px-2 py-px text-content-muted',
        )}
      >
        {label}
      </span>
      <span className={cn('h-px flex-1', tone === 'new' ? 'bg-primary/60' : 'bg-line')} />
    </div>
  );
}

/** The top of an empty conversation: what this is and how to begin. */
function ConversationIntro({ conversation, agent }: { conversation: Conversation; agent?: Agent }) {
  const isChannel = conversation.kind === 'channel';
  return (
    <div className="mt-auto animate-fade-in px-5 pb-4 pt-8">
      {isChannel ? (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface text-content-muted shadow-panel">
          <ChannelIcon channel={conversation} size={22} />
        </div>
      ) : (
        <div className="mb-3">
          <Avatar
            name={agent?.name ?? conversation.name}
            color={agent?.avatarColor}
            emoji={agent?.avatar}
            size={48}
            agent={!!agent}
            ring={!!agent}
          />
        </div>
      )}
      <p className="text-[17px] font-semibold tracking-[-0.01em] text-content-strong">
        {isChannel ? `#${conversation.name}` : (agent?.name ?? conversation.name)}
      </p>
      {conversation.topic ? (
        <p className="mt-1 text-body text-content">{conversation.topic}</p>
      ) : null}
      <p className="mt-1 max-w-lg text-body text-content-muted">
        {isChannel ? SHIP.empty.channelSilent : SHIP.empty.dmSilent}
      </p>
    </div>
  );
}

/** A reply that is still arriving: streamed text, or a typing indicator. */
function LiveReply({
  execution,
  agent,
  text,
  activity,
}: {
  execution: AgentExecution;
  agent?: Agent;
  text: string;
  activity: string | null;
}) {
  const name = agent?.name ?? 'Agent';
  return (
    <article className="group/live flex animate-message-in gap-3 px-5 pb-1 pt-2">
      <Avatar name={name} color={agent?.avatarColor} emoji={agent?.avatar} size={32} agent ring />
      <div className="min-w-0 flex-1">
        <div className="flex h-5 items-baseline gap-1.5">
          <bdi className="text-nav font-semibold text-content-strong">{name}</bdi>
          <span className="translate-y-[-1px] text-[10px] leading-none text-ai-ink" aria-hidden>
            ✦
          </span>
          <span className="ml-0.5 text-2xs text-primary-ink">{EXECUTION_LABEL[execution.state]}</span>
          <button
            type="button"
            onClick={() => void invoke('executions:cancel', { executionId: execution.id })}
            className="text-2xs text-content-faint opacity-0 transition-[opacity,color] duration-fast hover:text-danger group-hover/live:opacity-100 focus-visible:opacity-100"
          >
            Stop
          </button>
        </div>

        <div
          className="prose-message selectable whitespace-pre-wrap"
          dir={detectDirection(text)}
        >
          {text}
          <TypingDots className="ms-1.5 align-middle text-content-faint" />
        </div>

        {activity ? (
          <p className="mt-1 truncate font-mono text-2xs text-content-faint" title={activity}>
            {activity}
          </p>
        ) : null}
      </div>
    </article>
  );
}

/**
 * The reactions view for every message, rebuilt when activity arrives but
 * reusing each message's previous object when nothing about it changed. The
 * messages are memoised, so an agent moving from 👀 to 💭 re-renders the one
 * message it is working on, not the whole transcript.
 */
function useReactionViews(input: {
  messages: Message[];
  activities: MessageActivityRecord[];
  reactions: MessageReaction[];
  executions: AgentExecution[];
  agentById: Map<string, Agent>;
  showReplies: boolean;
}): Map<string, MessageReactionsView> {
  const cache = useRef(new Map<string, { signature: string; view: MessageReactionsView }>());
  const { messages, activities, reactions, executions, agentById, showReplies } = input;

  return useMemo(() => {
    const activityByMessage = groupBy(activities, (r) => r.messageId);
    const reactionsByMessage = groupBy(reactions, (r) => r.messageId);
    const replies = showReplies ? buildReplyCounts(messages, executions) : null;

    const views = new Map<string, MessageReactionsView>();
    const seen = new Set<string>();
    for (const message of messages) {
      const messageActivity = activityByMessage.get(message.id) ?? [];
      const messageReactions = reactionsByMessage.get(message.id) ?? [];
      const reply = replies?.get(message.id);
      if (!messageActivity.length && !messageReactions.length && !reply) continue;

      const view: MessageReactionsView = {
        pills: buildReactionPills(messageActivity, messageReactions, agentById, message.senderType === 'human'),
        replies: reply?.count ?? 0,
        firstReplyId: reply?.first ?? null,
      };
      const signature = JSON.stringify(view);
      const cached = cache.current.get(message.id);
      if (cached?.signature === signature) {
        views.set(message.id, cached.view);
      } else {
        cache.current.set(message.id, { signature, view });
        views.set(message.id, view);
      }
      seen.add(message.id);
    }
    for (const id of cache.current.keys()) if (!seen.has(id)) cache.current.delete(id);
    return views;
  }, [messages, activities, reactions, executions, agentById, showReplies]);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = groups.get(k);
    if (bucket) bucket.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function groupByDay<T extends { createdAt: number }>(items: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const day = formatDay(item.createdAt);
    const bucket = groups.get(day);
    if (bucket) bucket.push(item);
    else groups.set(day, [item]);
  }
  return [...groups.entries()];
}
