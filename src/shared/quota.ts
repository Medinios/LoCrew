import type { RuntimeType } from './types.js';

/**
 * One usage meter as the provider reported it.
 *
 * Every field here is the provider's own. We never re-label a window, never
 * grade its severity ourselves, and never infer a window's calendar meaning
 * from its duration: a provider that reports a 300-minute window is showing a
 * 300-minute window, not "today".
 */
export interface QuotaWindow {
  /**
   * The provider's own meter kind, e.g. Claude Code's `session` / `weekly_all`
   * / `weekly_scoped`, or `primary` / `secondary` for Codex. Classify on this,
   * never on a label -- the Agent SDK says so explicitly, and it is what lets a
   * provider add a meter without a release here.
   */
  kind: string;
  /** The provider's grouping for display order, e.g. `session` or `weekly`. */
  group: string;
  /** Human label. The provider's own wording when it supplies one. */
  label: string;
  /** Share of the window consumed, 0-100. */
  percentUsed: number;
  /** Epoch ms when the window resets, or null when the provider did not say. */
  resetsAt: number | null;
  /**
   * Window length in minutes when the provider states it (Codex does, Claude
   * Code does not). Null means unknown -- it must not be guessed from the
   * distance to `resetsAt`, which is time remaining, not window size.
   */
  windowMinutes: number | null;
  /** The provider's own severity reading, when it grades the row. */
  severity: string | null;
  /** The provider's pick for a single-value indicator. */
  isActive: boolean;
}

/**
 * Why a runtime has no quota to show. Kept distinct internally so the UI can
 * say something true; several of these collapse to the same short text.
 */
export type QuotaUnavailableReason =
  /** The runtime has no subscription quota concept at all (`model`, `a2a`). */
  | 'unsupported'
  /** Quota does not apply to this login: API key, Bedrock, Vertex. */
  | 'not_applicable'
  /** The CLI is not installed on this machine. */
  | 'cli_missing'
  /** The CLI is installed but nobody is signed in. */
  | 'unauthenticated'
  /** The provider answered in a shape this version does not understand. */
  | 'schema_mismatch'
  /** The request failed, timed out, or the child process died. */
  | 'error';

export type QuotaSnapshot =
  | {
      status: 'ok';
      runtimeType: RuntimeType;
      /** Plan name as the provider states it, e.g. "max", "plus". */
      planLabel: string | null;
      windows: QuotaWindow[];
      /** Epoch ms this reading was taken. */
      observedAt: number;
    }
  | {
      status: 'unavailable';
      runtimeType: RuntimeType;
      reason: QuotaUnavailableReason;
      detail: string;
      observedAt: number;
      /**
       * The last good reading, when there was one. Shown as stale rather than
       * discarded: a failed refresh must never turn a real 62% into 0%.
       */
      stale: { planLabel: string | null; windows: QuotaWindow[]; observedAt: number } | null;
    };

/** Quota for every runtime that has agents, keyed by runtime type. */
export type QuotaReport = Partial<Record<RuntimeType, QuotaSnapshot>>;

/**
 * Quota is billed to a login, not to an agent: every Claude Code agent on this
 * machine draws on the same allowance, and so does anything else using that
 * login -- other terminals, the desktop app, the website. So the count below is
 * only how many LoCrew agents share it, never a count of everything consuming
 * the quota.
 */
export function sharedAccountNote(agentCount: number): string {
  if (agentCount <= 1) return 'Account-wide usage. Other apps signed in to this account also draw on it.';
  return `Account-wide usage, shared by ${agentCount} agents here and by anything else signed in to this account.`;
}

/** Renders a provider window length honestly, or nothing when it is unknown. */
export function describeWindowLength(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? '24-hour' : `${days}-day`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}
