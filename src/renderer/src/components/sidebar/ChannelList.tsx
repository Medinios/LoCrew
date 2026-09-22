import { Hash } from 'lucide-react';
import type { Conversation } from '@shared/types';
import { SidebarRow, UnreadBadge, WorkingIndicator } from '@/components/sidebar/SidebarParts';
import { useApp } from '@/stores/app';

/**
 * The workspace's channels. Unread ones read brighter and carry a compact
 * teal count; a channel where an agent is working shows it quietly.
 */
export function ChannelList({
  channels,
  busyConversations,
  collapsed,
}: {
  channels: Conversation[];
  busyConversations: Set<string>;
  /** Folded: only the open channel and unread ones stay visible. */
  collapsed: boolean;
}) {
  const view = useApp((s) => s.view);
  const activeId = useApp((s) => s.activeConversationId);
  const unread = useApp((s) => s.unread);
  const select = useApp((s) => s.selectConversation);

  return (
    <>
      {channels.map((channel) => {
        const active = view === 'conversation' && channel.id === activeId;
        const count = unread[channel.id] ?? 0;
        if (collapsed && !active && !count) return null;
        return (
          <SidebarRow
            key={channel.id}
            active={active}
            unread={count > 0}
            onClick={() => void select(channel.id)}
            icon={<ChannelIcon channel={channel} />}
            label={channel.name}
            title={channel.topic ?? undefined}
            trailing={
              <>
                {busyConversations.has(channel.id) ? <WorkingIndicator /> : null}
                {count > 0 && !active ? <UnreadBadge count={count} /> : null}
              </>
            }
          />
        );
      })}
    </>
  );
}

/** A channel's own emoji, or the hash. Always the same footprint. */
export function ChannelIcon({ channel, size = 14 }: { channel: Pick<Conversation, 'icon'>; size?: number }) {
  return channel.icon ? (
    <span className="font-emoji leading-none" style={{ fontSize: size - 1 }} aria-hidden>
      {channel.icon}
    </span>
  ) : (
    <Hash size={size} strokeWidth={2.2} aria-hidden />
  );
}
