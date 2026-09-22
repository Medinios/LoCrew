import { create } from 'zustand';
import type { AppEvent, CostSummary, InvokeChannel, InvokeResults, WorkspaceLockInfo } from '@shared/ipc';
import type {
  Agent,
  AgentEvent,
  AgentExecution,
  AppSettings,
  Conversation,
  Message,
  Task,
} from '@shared/types';
import type { McpServerView, ProviderView, ToolGrant } from '@shared/integrations';
import type { MessageActivityRecord, MessageReaction } from '@shared/activity';

/** Typed wrapper over the preload bridge. */
export function invoke<C extends InvokeChannel>(
  channel: C,
  payload?: unknown,
): Promise<InvokeResults[C]> {
  return window.api.invoke(channel, payload as never) as Promise<InvokeResults[C]>;
}

export interface Toast {
  id: string;
  level: 'info' | 'warning' | 'error';
  title: string;
  detail: string;
}

/** Text streamed so far for an in-flight execution, keyed by execution id. */
export type StreamBuffer = Record<
  string,
  { text: string; activity: string | null; tool: string | null }
>;

/** What fills the white panel. */
export type MainView = 'conversation' | 'inbox' | 'agents';

/** One stop in the back/forward history. */
export type Location = { view: 'conversation'; id: string } | { view: 'inbox' } | { view: 'agents' };

/** The side panel inside a conversation, if one is open. */
export type SidePanel = 'details' | 'activity';

/** Sections of the Settings dialog, addressable from anywhere in the app. */
export type SettingsSection = 'profile' | 'general' | 'providers' | 'mcp' | 'limits';

const MAX_HISTORY = 50;

interface AppState {
  ready: boolean;
  agents: Agent[];
  conversations: Conversation[];
  view: MainView;
  activeConversationId: string | null;
  messages: Record<string, Message[]>;
  tasks: Record<string, Task[]>;
  executions: AgentExecution[];
  streams: StreamBuffer;
  locks: WorkspaceLockInfo[];
  settings: AppSettings | null;
  costs: CostSummary | null;
  toasts: Toast[];
  panel: SidePanel | null;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** Agent ids per conversation. Shared so the header and panel never disagree. */
  conversationMemberIds: Record<string, string[]>;
  /** Crew member currently open in the editor, if any. */
  editingAgentId: string | null;

  history: Location[];
  historyIndex: number;
  /** Agent messages received this session in conversations not on screen. */
  unread: Record<string, number>;
  /** First unread message per conversation, while it is unread. */
  firstUnreadId: Record<string, string>;
  /** Where the "NEW" line sits in the conversation being read. */
  newDividerId: Record<string, string>;

  providers: ProviderView[];
  mcpServers: McpServerView[];
  /** Every agent's MCP tool grants, keyed by agent id. */
  grants: Record<string, ToolGrant[]>;
  /** The Settings dialog, when open, and which section it shows. */
  settingsSection: SettingsSection | null;
  /** True while the Create Agent wizard is open. */
  wizardOpen: boolean;
  /** Agent activity reactions, per conversation, once that conversation is loaded. */
  activities: Record<string, MessageActivityRecord[]>;
  /** The user's own emoji reactions, per conversation. */
  reactions: Record<string, MessageReaction[]>;
  /** Activity of runs still in progress, per agent, across all conversations. */
  liveActivity: Record<string, MessageActivityRecord[]>;
  /** Final revision of each ended activity, so a stale copy cannot revive it. */
  endedActivity: Record<string, number>;

  bootstrap(): Promise<void>;
  loadMembers(conversationId: string): Promise<void>;
  selectConversation(id: string | null, options?: { record?: boolean }): Promise<void>;
  openView(view: 'inbox' | 'agents', options?: { record?: boolean }): void;
  openAgentDm(agentId: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  /** Sends the user's message, with any images as base64. */
  sendMessage(body: string, images?: Array<{ name: string; data: string }>): Promise<void>;
  refreshAgents(): Promise<void>;
  refreshConversations(): Promise<void>;
  refreshCosts(): Promise<void>;
  refreshSettings(): Promise<void>;
  applyEvent(event: AppEvent): void;
  dismissToast(id: string): void;
  pushToast(toast: Omit<Toast, 'id'>): void;
  setEditingAgent(agentId: string | null): void;
  setPanel(panel: SidePanel | null): void;
  togglePanel(panel: SidePanel): void;
  setSidebarWidth(width: number): void;
  toggleSidebar(): void;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  setWizardOpen(open: boolean): void;
  toggleReaction(messageId: string, emoji: string): Promise<void>;
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  agents: [],
  conversations: [],
  view: 'conversation',
  activeConversationId: null,
  messages: {},
  tasks: {},
  executions: [],
  streams: {},
  locks: [],
  settings: null,
  costs: null,
  toasts: [],
  panel: null,
  sidebarWidth: 260,
  sidebarCollapsed: false,
  conversationMemberIds: {},
  editingAgentId: null,
  history: [],
  historyIndex: -1,
  unread: {},
  firstUnreadId: {},
  newDividerId: {},
  providers: [],
  mcpServers: [],
  grants: {},
  settingsSection: null,
  wizardOpen: false,
  activities: {},
  reactions: {},
  liveActivity: {},
  endedActivity: {},

  async bootstrap() {
    const [agents, conversations, settings, locks, executions, costs, providers, mcpServers, grants, live] =
      await Promise.all([
        invoke('agents:list'),
        invoke('conversations:list'),
        invoke('settings:get'),
        invoke('workspace:locks'),
        invoke('executions:active'),
        invoke('costs:summary'),
        invoke('providers:list'),
        invoke('mcp:list'),
        invoke('grants:list', {}),
        invoke('activity:live'),
      ]);

    set({
      agents,
      conversations,
      settings,
      locks,
      executions,
      costs,
      providers,
      mcpServers,
      grants: groupGrants(grants),
      // Events may have arrived while this snapshot loaded; newer copies win.
      ...live.reduce(
        (acc, record) => applyLiveActivity(acc, record),
        { liveActivity: get().liveActivity, endedActivity: get().endedActivity },
      ),
      ready: true,
    });

    // DM membership is what ties a direct message to its agent, so it is
    // loaded up front rather than when each DM is first opened.
    await Promise.all(
      conversations.filter((c) => c.kind === 'dm').map((c) => get().loadMembers(c.id)),
    );

    const first = conversations.find((c) => c.kind === 'channel') ?? conversations[0];
    if (first && !get().activeConversationId) await get().selectConversation(first.id);
  },

  async selectConversation(id, options) {
    const state = get();
    const leaving = state.activeConversationId;
    const record = options?.record ?? true;

    // The "NEW" line belongs to one visit: it clears when you leave, and a
    // conversation with unread messages gets a fresh one when you arrive.
    const newDividerId = { ...state.newDividerId };
    if (leaving && leaving !== id) delete newDividerId[leaving];
    const unread = { ...state.unread };
    const firstUnreadId = { ...state.firstUnreadId };
    if (id) {
      const anchor = firstUnreadId[id];
      if (anchor) newDividerId[id] = anchor;
      delete unread[id];
      delete firstUnreadId[id];
    }

    set({
      activeConversationId: id,
      view: 'conversation',
      newDividerId,
      unread,
      firstUnreadId,
      ...(record && id ? pushHistory(state, { view: 'conversation', id }) : {}),
    });
    if (!id) return;

    const [messages, tasks, executions, activity] = await Promise.all([
      invoke('messages:list', { conversationId: id, limit: 300 }),
      invoke('tasks:list', { conversationId: id }),
      invoke('executions:forConversation', { conversationId: id }),
      invoke('activity:list', { conversationId: id }),
      get().loadMembers(id),
    ]);

    set((current) => ({
      messages: { ...current.messages, [id]: messages },
      tasks: { ...current.tasks, [id]: tasks },
      executions: mergeExecutions(current.executions, executions),
      // Live events may have landed while this was loading; the newer copy of
      // each reaction wins.
      activities: {
        ...current.activities,
        [id]: activity.activities.reduce(upsertActivity, current.activities[id] ?? []),
      },
      reactions: { ...current.reactions, [id]: activity.reactions },
    }));
  },

  openView(view, options) {
    const record = options?.record ?? true;
    set((state) => ({ view, ...(record ? pushHistory(state, { view }) : {}) }));
  },

  async openAgentDm(agentId) {
    const { conversations, conversationMemberIds, agents } = get();
    const existing = findDmForAgent(agentId, conversations, conversationMemberIds, agents);
    if (existing) {
      await get().selectConversation(existing.id);
      return;
    }
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    // Agents get a DM when they are created; this only recreates one that was
    // deleted, so the sidebar entry always leads somewhere.
    const conversation = await invoke('conversations:create', {
      kind: 'dm',
      name: agent.name,
      topic: null,
      memberAgentIds: [agent.id],
    });
    set((state) => ({ conversations: upsert(state.conversations, conversation, (c) => c.id) }));
    await get().selectConversation(conversation.id);
  },

  goBack() {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const index = historyIndex - 1;
    set({ historyIndex: index });
    applyLocation(history[index]);
  },

  goForward() {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const index = historyIndex + 1;
    set({ historyIndex: index });
    applyLocation(history[index]);
  },

  async loadMembers(conversationId) {
    const members = await invoke('conversations:members', { conversationId });
    set((state) => ({
      conversationMemberIds: {
        ...state.conversationMemberIds,
        [conversationId]: members
          .filter((m) => m.memberType === 'agent')
          .map((m) => m.memberId),
      },
    }));
  },

  async sendMessage(body, images = []) {
    const conversationId = get().activeConversationId;
    if (!conversationId || (!body.trim() && !images.length)) return;
    // Replying means you have read what came before, so the NEW line goes.
    set((state) => {
      if (!state.newDividerId[conversationId]) return state;
      const newDividerId = { ...state.newDividerId };
      delete newDividerId[conversationId];
      return { newDividerId };
    });
    // The message arrives back through the event stream, so nothing is
    // appended optimistically here -- the transcript has a single source.
    await invoke('messages:send', { conversationId, body, images });
  },

  async refreshAgents() {
    set({ agents: await invoke('agents:list') });
  },

  async refreshConversations() {
    set({ conversations: await invoke('conversations:list') });
  },

  async refreshCosts() {
    set({ costs: await invoke('costs:summary') });
  },

  async refreshSettings() {
    set({ settings: await invoke('settings:get') });
  },

  applyEvent(event) {
    switch (event.type) {
      case 'message': {
        const { message } = event;
        set((state) => {
          const existing = state.messages[message.conversationId] ?? [];
          if (existing.some((m) => m.id === message.id)) return state;

          const next: Partial<AppState> = {
            messages: {
              ...state.messages,
              [message.conversationId]: [...existing, message],
            },
          };

          const onScreen =
            state.view === 'conversation' && state.activeConversationId === message.conversationId;
          if (!onScreen && countsAsUnread(message)) {
            next.unread = {
              ...state.unread,
              [message.conversationId]: (state.unread[message.conversationId] ?? 0) + 1,
            };
            if (!state.firstUnreadId[message.conversationId]) {
              next.firstUnreadId = { ...state.firstUnreadId, [message.conversationId]: message.id };
            }
          }
          return next;
        });
        break;
      }

      case 'agent':
        set((state) => ({
          agents: upsert(state.agents, event.agent, (a) => a.id),
        }));
        break;

      case 'agent-deleted':
        set((state) => {
          const liveActivity = { ...state.liveActivity };
          delete liveActivity[event.agentId];
          return {
            agents: state.agents.filter((a) => a.id !== event.agentId),
            liveActivity,
            // The database removed the agent's reactions with it.
            activities: Object.fromEntries(
              Object.entries(state.activities).map(([key, list]) => [
                key,
                list.filter((r) => r.agentId !== event.agentId),
              ]),
            ),
          };
        });
        break;

      case 'conversation': {
        const isNew = !get().conversations.some((c) => c.id === event.conversation.id);
        set((state) => ({
          conversations: upsert(state.conversations, event.conversation, (c) => c.id),
        }));
        if (isNew && event.conversation.kind === 'dm') void get().loadMembers(event.conversation.id);
        break;
      }

      case 'conversation-deleted':
        set((state) => {
          const history = state.history.filter(
            (l) => !(l.view === 'conversation' && l.id === event.conversationId),
          );
          const activities = { ...state.activities };
          const reactions = { ...state.reactions };
          delete activities[event.conversationId];
          delete reactions[event.conversationId];
          return {
            activities,
            reactions,
            conversations: state.conversations.filter((c) => c.id !== event.conversationId),
            activeConversationId:
              state.activeConversationId === event.conversationId
                ? null
                : state.activeConversationId,
            history,
            historyIndex: Math.min(state.historyIndex, history.length - 1),
          };
        });
        break;

      case 'execution': {
        const { execution } = event;
        set((state) => {
          const streams = { ...state.streams };
          // A finished execution's buffered text has been committed as a real
          // message by the main process, so the buffer is dropped.
          if (['completed', 'failed', 'cancelled'].includes(execution.state)) {
            delete streams[execution.id];
          }
          return {
            executions: upsert(state.executions, execution, (e) => e.id),
            streams,
          };
        });
        break;
      }

      case 'agent-event':
        set((state) => ({ streams: applyStreamEvent(state.streams, event.event) }));
        break;

      case 'activity': {
        const record = event.activity;
        set((state) => {
          const next: Partial<AppState> = applyLiveActivity(state, record);
          const list = state.activities[record.conversationId];
          // Conversations not loaded yet fetch their reactions when opened.
          if (list) {
            next.activities = { ...state.activities, [record.conversationId]: upsertActivity(list, record) };
          }
          return next;
        });
        break;
      }

      case 'reactions':
        set((state) => {
          const list = state.reactions[event.conversationId];
          if (!list) return state;
          return {
            reactions: {
              ...state.reactions,
              [event.conversationId]: [...list.filter((r) => r.messageId !== event.messageId), ...event.reactions],
            },
          };
        });
        break;

      case 'task':
        set((state) => ({
          tasks: {
            ...state.tasks,
            [event.task.conversationId]: upsert(
              state.tasks[event.task.conversationId] ?? [],
              event.task,
              (t) => t.id,
            ),
          },
        }));
        break;

      case 'task-deleted':
        set((state) => ({
          tasks: Object.fromEntries(
            Object.entries(state.tasks).map(([key, list]) => [
              key,
              list.filter((t) => t.id !== event.taskId),
            ]),
          ),
        }));
        break;

      case 'locks':
        set({ locks: event.locks });
        break;

      case 'members-changed':
        void get().loadMembers(event.conversationId);
        void get().refreshConversations();
        break;

      case 'notice':
        get().pushToast({ level: event.level, title: event.title, detail: event.detail });
        break;

      case 'provider':
        set((state) => ({ providers: upsert(state.providers, event.provider, (p) => p.id) }));
        break;

      case 'provider-deleted':
        set((state) => ({ providers: state.providers.filter((p) => p.id !== event.providerId) }));
        break;

      case 'mcp-server':
        set((state) => ({ mcpServers: upsert(state.mcpServers, event.server, (s) => s.id) }));
        break;

      case 'mcp-server-deleted':
        set((state) => ({ mcpServers: state.mcpServers.filter((s) => s.id !== event.serverId) }));
        break;

      case 'grants':
        set((state) => ({ grants: { ...state.grants, [event.agentId]: event.grants } }));
        break;
    }
  },

  pushToast(toast) {
    const id = `toast:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    setTimeout(() => get().dismissToast(id), 7000);
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  setEditingAgent(agentId) {
    set({ editingAgentId: agentId });
  },

  setPanel(panel) {
    set({ panel });
  },

  togglePanel(panel) {
    set((state) => ({ panel: state.panel === panel ? null : panel }));
  },

  setSidebarWidth(width) {
    set({ sidebarWidth: Math.min(420, Math.max(220, width)) });
  },

  toggleSidebar() {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
  },

  openSettings(section = 'general') {
    // Opens above whatever dialog asked for it (the agent wizard, say), so
    // closing Settings returns there with nothing lost.
    set({ settingsSection: section });
  },

  closeSettings() {
    set({ settingsSection: null });
  },

  setWizardOpen(open) {
    set({ wizardOpen: open });
  },

  async toggleReaction(messageId, emoji) {
    try {
      await invoke('reactions:toggle', { messageId, emoji });
    } catch (error) {
      get().pushToast({
        level: 'error',
        title: 'Could not add the reaction',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));

function groupGrants(grants: ToolGrant[]): Record<string, ToolGrant[]> {
  const result: Record<string, ToolGrant[]> = {};
  for (const grant of grants) (result[grant.agentId] ??= []).push(grant);
  return result;
}

/* -------------------------------------------------------------------------- */

/** Finds the DM that belongs to an agent: by membership, then by name. */
export function findDmForAgent(
  agentId: string,
  conversations: Conversation[],
  memberIds: Record<string, string[]>,
  agents: Agent[],
): Conversation | undefined {
  const dms = conversations.filter((c) => c.kind === 'dm');
  const byMember = dms.find((c) => memberIds[c.id]?.includes(agentId));
  if (byMember) return byMember;
  const name = agents.find((a) => a.id === agentId)?.name;
  return name ? dms.find((c) => c.name === name && !memberIds[c.id]?.length) : undefined;
}

/** The agent on the other end of a DM, if it still exists. */
export function findAgentForDm(
  conversation: Conversation,
  agents: Agent[],
  memberIds: Record<string, string[]>,
): Agent | undefined {
  const members = memberIds[conversation.id];
  if (members?.length) return agents.find((a) => members.includes(a.id));
  return agents.find((a) => a.name === conversation.name);
}

function countsAsUnread(message: Message): boolean {
  return (
    message.senderType === 'agent' &&
    (message.kind === 'chat' || message.kind === 'task_update' || message.kind === 'execution_error')
  );
}

function pushHistory(
  state: Pick<AppState, 'history' | 'historyIndex'>,
  location: Location,
): Pick<AppState, 'history' | 'historyIndex'> {
  const current = state.history[state.historyIndex];
  if (current && sameLocation(current, location)) return state;
  const history = [...state.history.slice(0, state.historyIndex + 1), location].slice(-MAX_HISTORY);
  return { history, historyIndex: history.length - 1 };
}

function sameLocation(a: Location, b: Location): boolean {
  if (a.view !== b.view) return false;
  return a.view !== 'conversation' || a.id === (b as { id: string }).id;
}

function applyLocation(location: Location | undefined): void {
  if (!location) return;
  const { selectConversation, openView } = useApp.getState();
  if (location.view === 'conversation') void selectConversation(location.id, { record: false });
  else openView(location.view, { record: false });
}

/**
 * Adds or replaces an activity record, but never with an older copy: each
 * change bumps the record's revision, so a late or duplicated event loses.
 */
export function upsertActivity(list: MessageActivityRecord[], record: MessageActivityRecord): MessageActivityRecord[] {
  const index = list.findIndex((r) => r.id === record.id);
  if (index < 0) return [...list, record];
  if (list[index]!.revision >= record.revision) return list;
  const next = [...list];
  next[index] = record;
  return next;
}

/** How many ended activities to remember; enough to outlast any late event. */
const ENDED_MEMORY = 500;

/**
 * Keeps each agent's in-progress activity, dropping runs that have ended. An
 * ended run's final revision is remembered, so a late or snapshotted copy of
 * an earlier state cannot put it back.
 */
export function applyLiveActivity(
  state: { liveActivity: Record<string, MessageActivityRecord[]>; endedActivity: Record<string, number> },
  record: MessageActivityRecord,
): { liveActivity: Record<string, MessageActivityRecord[]>; endedActivity: Record<string, number> } {
  const unchanged = { liveActivity: state.liveActivity, endedActivity: state.endedActivity };
  const endedAt = state.endedActivity[record.id];
  if (endedAt !== undefined && endedAt >= record.revision) return unchanged;

  const current = state.liveActivity[record.agentId] ?? [];
  const existing = current.find((r) => r.id === record.id);
  if (existing && existing.revision >= record.revision) return unchanged;

  const others = current.filter((r) => r.id !== record.id);
  const nextList = record.active ? [...others, record] : others;
  const liveActivity = { ...state.liveActivity };
  if (nextList.length) liveActivity[record.agentId] = nextList;
  else delete liveActivity[record.agentId];

  let endedActivity = state.endedActivity;
  if (!record.active) {
    endedActivity = { ...state.endedActivity, [record.id]: record.revision };
    const ids = Object.keys(endedActivity);
    if (ids.length > ENDED_MEMORY) {
      endedActivity = Object.fromEntries(ids.slice(-ENDED_MEMORY).map((id) => [id, endedActivity[id]!]));
    }
  }
  return { liveActivity, endedActivity };
}

function upsert<T>(list: T[], item: T, key: (value: T) => string): T[] {
  const index = list.findIndex((existing) => key(existing) === key(item));
  if (index < 0) return [...list, item];
  const next = [...list];
  next[index] = item;
  return next;
}

function mergeExecutions(current: AgentExecution[], incoming: AgentExecution[]): AgentExecution[] {
  let result = current;
  for (const execution of incoming) result = upsert(result, execution, (e) => e.id);
  return result;
}

/** Accumulates streamed deltas into a per-execution buffer for live rendering. */
function applyStreamEvent(streams: StreamBuffer, event: AgentEvent): StreamBuffer {
  const current = streams[event.executionId] ?? { text: '', activity: null, tool: null };

  switch (event.type) {
    case 'text_delta': {
      const text = String(event.payload['text'] ?? '');
      return {
        ...streams,
        [event.executionId]: { text: current.text + text, activity: null, tool: null },
      };
    }
    case 'tool_use': {
      const name = String(event.payload['name'] ?? 'a tool');
      return {
        ...streams,
        [event.executionId]: {
          ...current,
          activity: describeTool(name, event.payload['input']),
          tool: name,
        },
      };
    }
    case 'tool_result':
      return { ...streams, [event.executionId]: { ...current, activity: null, tool: null } };
    case 'thinking':
      return {
        ...streams,
        [event.executionId]: { ...current, activity: 'Thinking', tool: 'thinking' },
      };
    default:
      return streams;
  }
}

function describeTool(name: string, input: unknown): string {
  const short = name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name;
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (typeof record['command'] === 'string') return `Running ${short}: ${record['command']}`;
    if (typeof record['file_path'] === 'string') return `${short} ${record['file_path']}`;
  }
  return `Running ${short}`;
}
