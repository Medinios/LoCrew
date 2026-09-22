import type { ActivityDetail, ActivityProfile, AgentActivityState } from '../../shared/activity.js';

/**
 * Something that actually happened during a run, as reported by the
 * orchestrator. Each maps to at most one activity change.
 */
export type ActivitySignal =
  /** The run could not start yet: another agent holds the workspace lock. */
  | { type: 'waiting_for_workspace' }
  /** The runtime was handed the message. `profile` says what it can report. */
  | { type: 'started'; profile: ActivityProfile }
  /** The runtime produced output: reasoning, or text of the reply. */
  | { type: 'output'; kind: 'reasoning' | 'text' }
  /** The runtime invoked a tool. Only the name travels, never the input. */
  | { type: 'tool'; name: string }
  /** The run is paused until the user approves or denies something. */
  | { type: 'approval_requested' }
  /** The user answered the approval; the run continues. */
  | { type: 'approval_resolved' }
  /** The runtime says its answer ends with a question for the user. */
  | { type: 'awaiting_input'; reason: 'input' | 'authorization' }
  /** The run ended. */
  | { type: 'finished'; outcome: RunOutcome };

export type RunOutcome = 'completed' | 'failed' | 'timeout' | 'cancelled' | 'interrupted';

/** The machine's full state for one run. `state`/`detail`/`active` are what is shown. */
export interface ActivityMachine {
  state: AgentActivityState;
  detail: ActivityDetail;
  active: boolean;
  profile: ActivityProfile;
  /** Where to return once a pending approval is answered. */
  resume: { state: AgentActivityState; detail: ActivityDetail } | null;
  /** Set when the runtime reported that its final answer is a question. */
  awaitingInput: 'input' | 'authorization' | null;
}

/** Tool names are untrusted text from runtimes and MCP servers: bound them. */
const MAX_TOOL_NAME = 80;

export function initialMachine(): ActivityMachine {
  return { state: 'received', detail: null, active: true, profile: 'detailed', resume: null, awaitingInput: null };
}

/**
 * The single place activity rules live. Returns the next machine, or null
 * when the signal changes nothing visible (most output events do nothing: only
 * the first one of a phase moves the state).
 *
 * Rules that keep the display honest:
 * - Nothing changes once the run has ended.
 * - A `basic` runtime shows `processing` for its whole run; output and tool
 *   signals cannot promote it to states it cannot report.
 * - `reading` means "has the message, produced nothing yet"; `thinking` needs
 *   actual output; `working` needs an actual tool call.
 */
export function transition(machine: ActivityMachine, signal: ActivitySignal): ActivityMachine | null {
  if (!machine.active) return null;

  switch (signal.type) {
    case 'waiting_for_workspace':
      if (machine.state !== 'received' || machine.detail === 'workspace') return null;
      return { ...machine, detail: 'workspace' };

    case 'started':
      if (machine.state !== 'received') return null;
      return {
        ...machine,
        profile: signal.profile,
        state: signal.profile === 'basic' ? 'processing' : 'reading',
        detail: null,
      };

    case 'output': {
      if (machine.profile === 'basic') return null;
      if (machine.state === 'waiting_for_input' || machine.state === 'received') return null;
      const detail = signal.kind === 'reasoning' ? 'reasoning' : 'responding';
      if (machine.state === 'thinking' && machine.detail === detail) return null;
      return { ...machine, state: 'thinking', detail };
    }

    case 'tool': {
      if (machine.profile === 'basic') return null;
      if (machine.state === 'received') return null;
      const name = sanitizeToolName(signal.name);
      if (machine.state === 'waiting_for_input') {
        // The approval is still open; remember the tool for when it closes.
        return { ...machine, resume: { state: 'working', detail: name } };
      }
      if (machine.state === 'working' && machine.detail === name) return null;
      return { ...machine, state: 'working', detail: name };
    }

    case 'approval_requested':
      if (machine.state === 'waiting_for_input') return null;
      return {
        ...machine,
        state: 'waiting_for_input',
        detail: 'approval',
        resume: { state: machine.state, detail: machine.detail },
      };

    case 'approval_resolved': {
      if (machine.state !== 'waiting_for_input') return null;
      // An approval gates a tool, and an approved tool then runs, so the
      // honest state afterwards is `working` -- keeping the tool name if known.
      const resume = machine.resume;
      const detail = resume?.state === 'working' ? resume.detail : null;
      const state: AgentActivityState = machine.profile === 'basic' ? 'processing' : 'working';
      return { ...machine, state, detail: state === 'working' ? detail : null, resume: null };
    }

    case 'awaiting_input':
      if (machine.awaitingInput === signal.reason) return null;
      return { ...machine, awaitingInput: signal.reason };

    case 'finished':
      return finish(machine, signal.outcome);
  }
}

function finish(machine: ActivityMachine, outcome: RunOutcome): ActivityMachine {
  const ended = { ...machine, active: false, resume: null };
  switch (outcome) {
    case 'completed':
      return machine.awaitingInput
        ? { ...ended, state: 'waiting_for_input', detail: machine.awaitingInput }
        : { ...ended, state: 'completed', detail: null };
    case 'failed':
      return { ...ended, state: 'failed', detail: null };
    case 'timeout':
      return { ...ended, state: 'failed', detail: 'timeout' };
    case 'cancelled':
      return { ...ended, state: 'cancelled', detail: null };
    case 'interrupted':
      return { ...ended, state: 'interrupted', detail: null };
  }
}

export function sanitizeToolName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (clean || 'tool').slice(0, MAX_TOOL_NAME);
}
