import { Activity, ChevronDown, ChevronUp, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { Agent, Conversation } from '@shared/types';
import { ChannelIcon } from '@/components/sidebar/ChannelList';
import { Avatar, Chip, IconButton, PanelHeader, PRESENCE_LABEL } from '@/components/ui/primitives';
import { agentPresence } from '@/lib/activity';
import { engineLabel } from '@/lib/agents';
import { SHIP } from '@/lib/lexicon';
import { cn } from '@/lib/utils';
import { useApp } from '@/stores/app';

const NO_IDS: string[] = [];

/** Find-in-conversation, while it is open. */
export interface ConversationSearchState {
  query: string;
  /** Position of the match being shown, 0-based; -1 with no matches. */
  current: number;
  total: number;
}

/**
 * The channel's icon, name and topic on the left; members, agent activity,
 * search and channel settings on the right, as compact icon buttons.
 */
export function ConversationHeader({
  conversation,
  agent,
  liveCount,
  onOpenSettings,
  search,
  onSearchOpen,
  onSearchChange,
  onSearchStep,
  onSearchClose,
}: {
  conversation: Conversation;
  /** The other end of a DM. */
  agent?: Agent;
  /** Agents working in this conversation right now. */
  liveCount: number;
  onOpenSettings(): void;
  search: ConversationSearchState | null;
  onSearchOpen(): void;
  onSearchChange(query: string): void;
  /** 1 moves to the older match, -1 to the newer one. */
  onSearchStep(direction: 1 | -1): void;
  onSearchClose(): void;
}) {
  const panel = useApp((s) => s.panel);
  const togglePanel = useApp((s) => s.togglePanel);
  const agents = useApp((s) => s.agents);
  const liveActivity = useApp((s) => s.liveActivity);
  const providers = useApp((s) => s.providers);
  const memberIds = useApp((s) => s.conversationMemberIds[conversation.id]) ?? NO_IDS;
  const isChannel = conversation.kind === 'channel';

  const members = useMemo(() => {
    const ids = new Set(memberIds);
    return agents.filter((a) => ids.has(a.id));
  }, [agents, memberIds]);
  // The human is always a member.
  const memberCount = members.length + 1;
  const title = isChannel ? conversation.name : (agent?.name ?? conversation.name);
  const presence = agent ? agentPresence(agent, liveActivity[agent.id], liveCount > 0) : undefined;
  const subtitle = isChannel
    ? conversation.topic
    : agent
      ? agent.description || engineLabel(agent, providers)
      : null;

  return (
    <PanelHeader
      actions={
        <>
          {search ? (
            <SearchField
              search={search}
              onChange={onSearchChange}
              onStep={onSearchStep}
              onClose={onSearchClose}
            />
          ) : (
            <IconButton label="Search this conversation (Ctrl+F)" onClick={onSearchOpen}>
              <Search size={15} strokeWidth={1.8} />
            </IconButton>
          )}
          <IconButton
            label={`${SHIP.panel.members}: ${memberCount}`}
            active={panel === 'details'}
            onClick={() => togglePanel('details')}
            className="gap-2 pl-1.5 pr-2"
          >
            <MemberStack members={members} />
            <span className="text-xs font-semibold tabular-nums">{memberCount}</span>
          </IconButton>
          <IconButton
            label={liveCount ? `${SHIP.panel.activity}: ${liveCount} working` : SHIP.panel.activity}
            active={panel === 'activity'}
            onClick={() => togglePanel('activity')}
            className="relative"
          >
            <Activity size={15} strokeWidth={1.8} />
            {liveCount > 0 ? (
              <span className="absolute right-[6px] top-[6px] flex h-[7px] w-[7px]" aria-hidden>
                <span className="absolute inset-0 animate-pulse-ring rounded-full bg-primary" />
                <span className="relative h-[7px] w-[7px] rounded-full bg-primary ring-2 ring-canvas" />
              </span>
            ) : null}
          </IconButton>
          <IconButton label={SHIP.actions.channelSettings} onClick={onOpenSettings}>
            <SlidersHorizontal size={15} strokeWidth={1.8} />
          </IconButton>
        </>
      }
    >
      {isChannel ? (
        <span
          aria-hidden
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-content-muted"
        >
          <ChannelIcon channel={conversation} size={14} />
        </span>
      ) : (
        <Avatar
          name={title}
          color={agent?.avatarColor}
          emoji={agent?.avatar}
          size={26}
          agent={!!agent}
          presence={presence}
        />
      )}
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="shrink-0 truncate text-title font-semibold text-content-strong">
          <bdi>{title}</bdi>
        </h1>
        {presence ? <span className="sr-only">{PRESENCE_LABEL[presence]}</span> : null}
        {subtitle ? (
          <p className="min-w-0 truncate border-l border-line pl-2.5 text-xs text-content-muted" title={subtitle}>
            {subtitle}
          </p>
        ) : null}
      </div>
      {!conversation.autonomyEnabled ? (
        <Chip title="Agents here only act when you mention them.">Agent-to-agent off</Chip>
      ) : null}
    </PanelHeader>
  );
}

/** Up to three member avatars, overlapping. */
function MemberStack({ members }: { members: Agent[] }) {
  if (!members.length) return null;
  return (
    <span className="flex items-center" aria-hidden>
      {members.slice(0, 3).map((member, index) => (
        <span
          key={member.id}
          className={cn('rounded-[6px] ring-2 ring-canvas', index > 0 && '-ml-1.5')}
          style={{ zIndex: 3 - index }}
        >
          <Avatar name={member.name} color={member.avatarColor} emoji={member.avatar} size={18} agent />
        </span>
      ))}
    </span>
  );
}

/** The find field that replaces the search button while open. */
function SearchField({
  search,
  onChange,
  onStep,
  onClose,
}: {
  search: ConversationSearchState;
  onChange(query: string): void;
  onStep(direction: 1 | -1): void;
  onClose(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const hasQuery = search.query.trim().length > 0;
  return (
    <div
      role="search"
      className="mr-1 flex h-8 w-[260px] animate-fade-in items-center gap-1 rounded-md border border-primary bg-surface pl-2.5 pr-1 shadow-focus"
    >
      <Search size={13} strokeWidth={2} className="shrink-0 text-content-faint" aria-hidden />
      <input
        ref={inputRef}
        value={search.query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        className="min-w-0 flex-1 bg-transparent text-xs text-content-strong placeholder:text-content-faint focus:outline-none"
      />
      {hasQuery ? (
        <span className="shrink-0 px-1 text-2xs tabular-nums text-content-faint" aria-live="polite">
          {search.total ? `${search.current + 1} of ${search.total}` : 'No matches'}
        </span>
      ) : null}
      <FindButton label="Older match (Enter)" disabled={!search.total} onClick={() => onStep(1)}>
        <ChevronUp size={14} />
      </FindButton>
      <FindButton label="Newer match (Shift+Enter)" disabled={!search.total} onClick={() => onStep(-1)}>
        <ChevronDown size={14} />
      </FindButton>
      <FindButton label="Close search (Esc)" onClick={onClose}>
        <X size={13} />
      </FindButton>
    </div>
  );
}

function FindButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-content-muted transition-colors duration-fast hover:bg-subtle hover:text-content-strong disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}
