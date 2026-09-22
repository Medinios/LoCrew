import type { AppEvent } from '../../shared/ipc.js';
import type { MessageActivityRecord } from '../../shared/activity.js';
import type { ActivityStore } from '../db/activity-store.js';
import {
  initialMachine,
  transition,
  type ActivityMachine,
  type ActivitySignal,
  type RunOutcome,
} from './state-machine.js';

interface LiveActivity {
  recordId: string;
  machine: ActivityMachine;
}

export interface AgentActivityManagerDeps {
  store: ActivityStore;
  emit(event: AppEvent): void;
  now?: () => number;
}

/**
 * Turns orchestrator events into activity reactions.
 *
 * One machine per running execution, keyed by execution id. A signal for an
 * execution the manager is not tracking -- finished, cancelled, or from before
 * a restart -- is dropped, and the store refuses writes to a row that another
 * execution has since claimed. Together these are what stop a delayed update
 * from an old run overwriting what a newer run shows.
 */
export class AgentActivityManager {
  private readonly live = new Map<string, LiveActivity>();
  private readonly now: () => number;

  constructor(private readonly deps: AgentActivityManagerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * The message was routed to the agent and its execution queued. Only runs
   * triggered by a message get a reaction; there is nothing to attach one to
   * otherwise.
   */
  received(input: { executionId: string; messageId: string | null; conversationId: string; agentId: string }): void {
    if (!input.messageId) return;
    const machine = initialMachine();
    const record = this.deps.store.claim({
      messageId: input.messageId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      executionId: input.executionId,
      state: machine.state,
      detail: machine.detail,
      now: this.now(),
    });
    this.live.set(input.executionId, { recordId: record.id, machine });
    this.deps.emit({ type: 'activity', activity: record });
  }

  signal(executionId: string, signal: ActivitySignal): void {
    const entry = this.live.get(executionId);
    if (!entry) return;

    const next = transition(entry.machine, signal);
    if (!next) return;

    // Internal bookkeeping (a remembered approval target, a pending question)
    // changes the machine without changing what is shown.
    const visible =
      next.state !== entry.machine.state ||
      next.detail !== entry.machine.detail ||
      next.active !== entry.machine.active;
    entry.machine = next;
    if (!next.active) this.live.delete(executionId);
    if (!visible) return;

    const record = this.deps.store.advance({
      id: entry.recordId,
      executionId,
      state: next.state,
      detail: next.detail,
      active: next.active,
      now: this.now(),
    });
    if (!record) {
      // Another execution owns this reaction now.
      this.live.delete(executionId);
      return;
    }
    this.deps.emit({ type: 'activity', activity: record });
  }

  finish(executionId: string, outcome: RunOutcome): void {
    this.signal(executionId, { type: 'finished', outcome });
  }

  /** The current machine for a run, for tests and diagnostics. */
  machineFor(executionId: string): ActivityMachine | null {
    return this.live.get(executionId)?.machine ?? null;
  }

  /**
   * Called once at startup. Anything still marked active was cut off by a
   * crash or a forced quit: it is shown as interrupted, never as completed.
   */
  reconcileInterrupted(): MessageActivityRecord[] {
    const changed: MessageActivityRecord[] = [];
    for (const record of this.deps.store.listActiveActivities()) {
      const updated = this.deps.store.advance({
        id: record.id,
        executionId: record.executionId,
        state: 'interrupted',
        detail: null,
        active: false,
        now: this.now(),
      });
      if (updated) changed.push(updated);
    }
    return changed;
  }
}
