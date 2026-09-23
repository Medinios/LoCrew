import type { AgentStatus, ExecutionState, TaskStatus } from '@shared/types';

/**
 * The app's vocabulary.
 *
 * Plain, familiar messaging language -- channels, direct messages, agents.
 * Keeping every user-facing word here means the tone stays consistent and can
 * be changed by editing one file rather than hunting strings through the
 * components.
 *
 * Functional affordances keep their familiar names -- `#` prefixes a channel,
 * `@` mentions an agent -- because a theme should not cost muscle memory.
 */
export const SHIP = {
  appName: 'LoCrew',
  tagline: 'Your local agent team.',

  sections: {
    channels: 'Channels',
    dms: 'Direct messages',
  },

  nav: {
    inbox: 'Inbox',
    agents: 'Agents',
    search: 'Search everything',
  },

  panel: {
    title: 'Details',
    activity: 'Activity',
    members: 'Members',
    tasks: 'Tasks',
    directories: 'Working directories',
    spend: 'Spend',
    about: 'About',
  },

  actions: {
    newChannel: 'Create channel',
    addAgent: 'Add an agent',
    createAgent: 'Create agent',
    removeAgent: 'Remove from channel',
    stop: 'Stop',
    settings: 'Settings',
    profile: 'Profile and settings',
    channelSettings: 'Channel settings',
  },

  empty: {
    welcome: 'Welcome to LoCrew',
    welcomeDetail:
      'Create an agent, then open a channel to put several of them to work together. Nothing runs until you send a message.',
    noConversation: 'Pick up where you left off',
    noConversationDetail: 'Choose a channel or an agent from the sidebar.',
    firstAgent: 'Create your first agent',
    noChannels: 'No channels yet',
    channelSilent: 'This is the very beginning of the channel. Mention an agent with @ to put them to work.',
    dmSilent: 'This is the very beginning of your conversation. Send a message to put this agent to work.',
    inbox: "You're all caught up",
    inboxDetail: 'Replies from your agents across every channel and direct message land here.',
    noAgents: 'No agents yet',
    noAgentsDetail:
      'An agent runs on Claude Code or Codex on this machine, on any AI model you have connected, or on an external agent service.',
  },
} as const;

/** How an agent's availability reads. */
export const CREW_STATUS: Record<AgentStatus, { label: string; hint: string }> = {
  online: { label: 'Online', hint: 'Has completed work this session.' },
  unverified: { label: 'Ready', hint: 'Runtime found, but nothing has run yet.' },
  offline: { label: 'Unavailable', hint: 'Runtime could not be found on this machine.' },
  error: { label: 'Needs attention', hint: 'Last run failed.' },
};

/** What an agent is doing right now. */
export const EXECUTION_LABEL: Record<ExecutionState, string> = {
  idle: 'Idle',
  queued: 'Queued',
  // Set as soon as a run starts, before any output: it means "running", and
  // claiming more would be a guess. Activity reactions say what is verified.
  thinking: 'Running',
  working: 'Working',
  waiting_for_agent: 'Waiting on an agent',
  waiting_for_human: 'Waiting for you',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
};

export const TASK_LABEL: Record<TaskStatus, string> = {
  pending: 'To do',
  in_progress: 'In progress',
  waiting: 'Waiting',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Workspace access levels. */
export const HOLD_ACCESS = {
  read_only: { label: 'Read only', detail: 'May read files but change nothing.' },
  approval_required: {
    label: 'Ask first',
    detail:
      'Reads freely. Every write waits for your approval, unless you open a work session under Settings → Write access.',
  },
  read_write: { label: 'Full access', detail: 'May change files without asking.' },
} as const;

/**
 * A friendly verb for the tool an agent is using, for the status line under
 * the composer. Unknown tools fall back to the execution state.
 */
export function describeActivity(tool: string | null | undefined): string | null {
  if (!tool) return null;
  const name = tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool;
  const key = name.toLowerCase();
  if (/(edit|write|patch|file_change|notebook)/.test(key)) return 'Writing code';
  if (/^(read|glob|grep|ls|list|view|search_files)/.test(key)) return 'Reading files';
  if (/(bash|shell|command|exec|powershell)/.test(key)) return 'Running a command';
  if (/(web|fetch|browse)/.test(key)) return 'Searching the web';
  if (/todo|plan/.test(key)) return 'Planning';
  if (key === 'send_message') return 'Writing a reply';
  if (/(read_messages|channel_context|context)/.test(key)) return 'Reading the conversation';
  if (key === 'task' || key === 'agent') return 'Delegating to a subagent';
  if (/task/.test(key)) return 'Updating tasks';
  if (key === 'thinking') return 'Thinking';
  return null;
}
