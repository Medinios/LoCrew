import type { ApprovalChoice, ApprovalRequestView } from '../../shared/types.js';
import type { ApprovalDecision } from '../runtimes/types.js';

/** What the manager tells the renderer. */
export type ApprovalEvent =
  | { type: 'approval'; request: ApprovalRequestView }
  | { type: 'approval-resolved'; id: string };

export interface ApprovalManagerDeps {
  emit(event: ApprovalEvent): void;
  /** The operator chose to stop being asked for a while. */
  openSession(view: ApprovalRequestView, choice: Extract<ApprovalChoice, { decision: 'session' }>): void;
}

interface Pending {
  view: ApprovalRequestView;
  settle(decision: ApprovalDecision): void;
}

/**
 * Operations waiting for the operator's decision.
 *
 * The question is asked in the app rather than in a native message box, so it
 * can show what would actually change. Everything here is deliberately
 * fail-closed: a run that is cancelled, or a window that goes away, denies the
 * operation rather than leaving a write pending on a promise nobody will keep.
 */
export class ApprovalManager {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: ApprovalManagerDeps) {}

  /** Requests in the order they arrived, oldest first. */
  list(): ApprovalRequestView[] {
    return [...this.pending.values()].map((entry) => entry.view);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Asks, and resolves once the operator answers or the run goes away. */
  ask(view: ApprovalRequestView, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (signal?.aborted) {
      return Promise.resolve({ approved: false, reason: 'The run was stopped before you answered.' });
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (decision: ApprovalDecision) => {
        if (!this.pending.delete(view.id)) return;
        signal?.removeEventListener('abort', onAbort);
        this.deps.emit({ type: 'approval-resolved', id: view.id });
        resolve(decision);
      };
      const onAbort = () =>
        settle({ approved: false, reason: 'The run was stopped before you answered.' });

      this.pending.set(view.id, { view, settle });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.deps.emit({ type: 'approval', request: view });
    });
  }

  /** The operator's answer. False when the request is already gone. */
  respond(id: string, choice: ApprovalChoice): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;

    if (choice.decision === 'deny') {
      entry.settle({ approved: false, reason: 'You denied this operation.' });
      return true;
    }
    if (choice.decision === 'session') {
      if (!entry.view.canOpenSession) {
        // Sessions cover writes in the agent's own directory, never MCP tools.
        entry.settle({ approved: true });
        return true;
      }
      this.deps.openSession(entry.view, choice);
    }
    entry.settle({ approved: true });
    return true;
  }

  /** Nothing can answer any more: deny what is waiting. */
  clear(reason: string): void {
    for (const entry of [...this.pending.values()]) {
      entry.settle({ approved: false, reason });
    }
  }
}
