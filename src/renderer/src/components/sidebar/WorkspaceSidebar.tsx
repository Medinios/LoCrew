import { Plus, ShieldCheck } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { AgentList, busyAgentStates } from '@/components/sidebar/AgentList';
import { ChannelList } from '@/components/sidebar/ChannelList';
import { SectionAction, SidebarSection } from '@/components/sidebar/SidebarParts';
import { SidebarNavigation, SidebarSearch } from '@/components/sidebar/SidebarNavigation';
import { UserProfile } from '@/components/sidebar/UserProfile';
import { WorkspaceHeader } from '@/components/sidebar/WorkspaceHeader';
import { SHIP } from '@/lib/lexicon';
import { findAgentForDm, useApp } from '@/stores/app';

/**
 * The midnight sidebar: the workspace, search, the two destinations, the
 * channels, a direct message per agent, and the person at the bottom.
 */
/**
 * Shown while any agent is writing without being asked. A permission you
 * cannot see is one you forget you granted, so this sits above your own name
 * until the session ends.
 */
function SessionAccessBadge() {
  const sessions = useApp((s) => s.sessionAccess);
  const openSettings = useApp((s) => s.openSettings);
  if (!sessions.length) return null;

  const first = sessions[0]!;
  return (
    <button
      type="button"
      onClick={() => openSettings('access')}
      title="Agents are writing without asking. Open Write access to end it."
      className="mb-1 flex h-8 w-full items-center gap-2 rounded-md border border-warning/40 bg-warning/[0.14] px-2 text-left transition-colors duration-fast hover:bg-warning/[0.2]"
    >
      <ShieldCheck size={13} strokeWidth={2} className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1 truncate text-2xs font-medium text-ink">Write access on</span>
      <span className="shrink-0 truncate text-2xs text-ink-muted">
        {sessions.length === 1 ? first.label : `${sessions.length} sessions`}
      </span>
    </button>
  );
}

export function WorkspaceSidebar({
  onAddAgent,
  onNewChannel,
  onOpenSettings,
}: {
  onAddAgent(): void;
  onNewChannel(): void;
  onOpenSettings(): void;
}) {
  const conversations = useApp((s) => s.conversations);
  const agents = useApp((s) => s.agents);
  const executions = useApp((s) => s.executions);
  const memberIds = useApp((s) => s.conversationMemberIds);
  const select = useApp((s) => s.selectConversation);
  const openAgentDm = useApp((s) => s.openAgentDm);

  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState({ channels: true, dms: true });

  const live = useMemo(
    () => executions.filter((e) => !['completed', 'failed', 'cancelled'].includes(e.state)),
    [executions],
  );
  const busyAgents = useMemo(() => busyAgentStates(live), [live]);
  const busyConversations = useMemo(() => new Set(live.map((e) => e.conversationId)), [live]);

  const needle = query.trim().toLowerCase();
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);

  const channels = conversations.filter((c) => c.kind === 'channel' && matches(c.name));
  const visibleAgents = agents.filter((a) => matches(a.name));
  const orphanDms = conversations.filter(
    (c) => c.kind === 'dm' && !findAgentForDm(c, agents, memberIds) && matches(c.name),
  );

  const openFirstMatch = () => {
    if (!needle) return;
    const channel = channels[0];
    if (channel) void select(channel.id);
    else if (visibleAgents[0]) void openAgentDm(visibleAgents[0].id);
    else if (orphanDms[0]) void select(orphanDms[0].id);
    else return;
    setQuery('');
    searchRef.current?.blur();
  };

  const searching = needle.length > 0;
  const nothingFound = searching && !channels.length && !visibleAgents.length && !orphanDms.length;

  return (
    <aside
      className="flex h-full flex-col pt-[var(--titlebar-h)]"
      // Presence dots are cut out of the avatar in the sidebar's own colour.
      style={{ ['--presence-ring' as string]: 'hsl(var(--shell))' }}
    >
      <div className="space-y-2 px-3 pb-3">
        <WorkspaceHeader onNewChannel={onNewChannel} onAddAgent={onAddAgent} />
        <SidebarSearch ref={searchRef} value={query} onChange={setQuery} onSubmit={openFirstMatch} />
      </div>

      <nav className="shell-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3 [scrollbar-width:thin]">
        {!searching ? <SidebarNavigation /> : null}

        {nothingFound ? (
          <p className="px-2 py-3 text-xs text-ink-faint">No channels or agents match.</p>
        ) : null}

        {!nothingFound ? (
          <div className={searching ? '' : 'mt-5'}>
            <SidebarSection
              label={SHIP.sections.channels}
              open={open.channels || searching}
              onToggle={() => setOpen((o) => ({ ...o, channels: !o.channels }))}
              action={
                <SectionAction label={SHIP.actions.newChannel} onClick={onNewChannel}>
                  <Plus size={14} strokeWidth={2} />
                </SectionAction>
              }
            >
              <ChannelList
                channels={channels}
                busyConversations={busyConversations}
                collapsed={!open.channels && !searching}
              />
              {!channels.length && !searching ? (
                <button
                  type="button"
                  onClick={onNewChannel}
                  className="mb-px flex h-[30px] w-full items-center gap-2.5 rounded-md px-2 text-left text-nav text-ink-faint transition-colors duration-fast hover:bg-shell-hover hover:text-ink-muted"
                >
                  <span className="flex w-4 justify-center">
                    <Plus size={13} strokeWidth={2.2} />
                  </span>
                  {SHIP.actions.newChannel}
                </button>
              ) : null}
            </SidebarSection>

            <SidebarSection
              label={SHIP.sections.dms}
              open={open.dms || searching}
              onToggle={() => setOpen((o) => ({ ...o, dms: !o.dms }))}
              action={
                <SectionAction label={SHIP.actions.createAgent} onClick={onAddAgent}>
                  <Plus size={14} strokeWidth={2} />
                </SectionAction>
              }
            >
              <AgentList
                agents={visibleAgents}
                orphanDms={orphanDms}
                busyAgents={busyAgents}
                collapsed={!open.dms && !searching}
                onAddAgent={onAddAgent}
                showAdd={!searching}
              />
            </SidebarSection>
          </div>
        ) : null}
      </nav>

      <div className="border-t border-shell-line/70 px-3 py-2">
        <SessionAccessBadge />
        <UserProfile onOpenSettings={onOpenSettings} working={busyAgents.size} />
      </div>
    </aside>
  );
}
