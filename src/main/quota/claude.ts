import type { QuotaSnapshot, QuotaWindow } from '../../shared/quota.js';
import type { QuotaSource } from './types.js';

/**
 * Reads Claude Code's subscription quota through the Agent SDK's structured
 * `/usage` control request.
 *
 * The request is a control message on a live `Query`, so a query has to exist
 * to ask it. The trick that keeps this free is the prompt: a streaming-input
 * iterable that yields nothing. The transport comes up, the control channel is
 * live, and the CLI never receives a user turn -- so no model runs and nothing
 * is billed. Measured at ~1s against a real login.
 *
 * `settingSources: []` is not incidental. It is the SDK's isolation mode: no
 * user, project or local settings are read, which is what keeps a project's
 * hooks from firing during what is supposed to be a read-only meter check.
 */
export class ClaudeQuotaSource implements QuotaSource {
  readonly runtimeType = 'claude-code' as const;

  async read(signal: AbortSignal): Promise<QuotaSnapshot> {
    const observedAt = Date.now();
    if (signal.aborted) return cancelled(observedAt);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    // Resolves when we are done; until then the prompt iterable stays parked,
    // holding the session open without ever producing a message.
    let release = () => {};
    const parked = new Promise<void>((resolve) => (release = resolve));

    let query: typeof import('@anthropic-ai/claude-agent-sdk').query;
    try {
      ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      return unavailable('cli_missing', `The Claude Agent SDK could not be loaded: ${message(error)}`, observedAt);
    }

    // The import is awaited, so cancellation can land while it resolves. Check
    // again before spawning: an abandoned read must not leave a child running.
    if (signal.aborted) {
      signal.removeEventListener('abort', onAbort);
      return cancelled(observedAt);
    }

    let drained: Promise<void> | null = null;
    try {
      const q = query({
        prompt: (async function* () {
          await parked;
        })(),
        options: {
          abortController: controller,
          // Do not write a session file for a meter read.
          persistSession: false,
          // SDK isolation mode: no user/project/local settings, so no hooks.
          settingSources: [],
          allowedTools: [],
          maxTurns: 1,
        },
      });

      // The stream has to be consumed for the transport to pump. Nothing here
      // is interesting -- errors surface on the control request below.
      drained = (async () => {
        try {
          for await (const _ of q) void _;
        } catch {
          /* the abort below ends this normally */
        }
      })();

      if (typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') {
        // The method is explicitly experimental and will be renamed. When that
        // happens this degrades to "not available" instead of throwing.
        return unavailable(
          'schema_mismatch',
          'This version of the Claude Agent SDK does not expose the usage API.',
          observedAt,
        );
      }

      // skipBehaviors: the default scans every transcript touched in the last
      // seven days, which a meter read has no use for.
      const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      });

      if (!usage.rate_limits_available || !usage.rate_limits) {
        return unavailable(
          'not_applicable',
          'This login has no plan quota. API key, Bedrock and Vertex sessions are billed per request instead.',
          observedAt,
        );
      }

      const windows = parseClaudeWindows(usage.rate_limits as unknown as Record<string, unknown>);
      if (!windows.length) {
        return unavailable('schema_mismatch', 'The runtime reported no usage meters.', observedAt);
      }

      return {
        status: 'ok',
        runtimeType: this.runtimeType,
        planLabel: typeof usage.subscription_type === 'string' ? usage.subscription_type : null,
        windows,
        observedAt,
      };
    } catch (error) {
      const text = message(error);
      const reason = /auth|login|credential|unauthor/i.test(text) ? 'unauthenticated' : 'error';
      return unavailable(reason, text, observedAt);
    } finally {
      signal.removeEventListener('abort', onAbort);
      release();
      controller.abort();
      // Never let a stuck child hold the refresh open.
      if (drained) await Promise.race([drained, delay(2000)]);
    }
  }
}

/**
 * Maps the provider's meters.
 *
 * `rate_limits.limits[]` is the one to read: it is server-driven and
 * self-describing, carries its own labels and ordering, and the SDK documents
 * that a client should render it verbatim so a new meter needs no release here.
 * It is also what the app's own /usage screen shows. It is not declared on the
 * response type in this SDK version even though the runtime sends it, hence the
 * defensive shape check.
 *
 * The named `five_hour` / `seven_day` fields are the documented fallback for a
 * runtime that does not send `limits[]`.
 */
export function parseClaudeWindows(limits: Record<string, unknown>): QuotaWindow[] {
  const rows = (limits as { limits?: unknown }).limits;
  if (Array.isArray(rows)) {
    const parsed = rows.map(parseServerRow).filter((w): w is QuotaWindow => w !== null);
    if (parsed.length) return parsed;
  }
  return parseNamedWindows(limits);
}

function parseServerRow(row: unknown): QuotaWindow | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const percent = finitePercent(r.percent);
  if (percent === null) return null;

  const kind = typeof r.kind === 'string' ? r.kind : 'unknown';
  const group = typeof r.group === 'string' ? r.group : kind;
  const scope = r.scope as { model?: { display_name?: unknown }; surface?: { display_name?: unknown } } | null;
  const scopeName =
    typeof scope?.model?.display_name === 'string'
      ? scope.model.display_name
      : typeof scope?.surface?.display_name === 'string'
        ? scope.surface.display_name
        : null;

  return {
    kind,
    group,
    label: labelForKind(kind, scopeName),
    percentUsed: percent,
    resetsAt: parseIsoDate(r.resets_at),
    // Claude Code states a reset time but never a window length.
    windowMinutes: null,
    severity: typeof r.severity === 'string' ? r.severity : null,
    isActive: r.is_active === true,
  };
}

/** Fallback for a runtime that predates the server-driven rows. */
const NAMED_WINDOWS: ReadonlyArray<readonly [string, string, string]> = [
  ['five_hour', 'session', 'Current session'],
  ['seven_day', 'weekly', 'Current week (all models)'],
  ['seven_day_opus', 'weekly', 'Current week (Opus)'],
  ['seven_day_sonnet', 'weekly', 'Current week (Sonnet)'],
];

function parseNamedWindows(limits: Record<string, unknown>): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  for (const [key, group, label] of NAMED_WINDOWS) {
    const entry = limits[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!entry || typeof entry !== 'object') continue;
    const percent = finitePercent(entry.utilization);
    if (percent === null) continue;
    out.push({
      kind: key,
      group,
      label,
      percentUsed: percent,
      resetsAt: parseIsoDate(entry.resets_at),
      windowMinutes: null,
      severity: null,
      isActive: false,
    });
  }
  return out;
}

/**
 * Wording follows the runtime's own usage screen so the two agree on sight.
 * A kind we do not recognise keeps its own name rather than being forced into
 * one of ours -- a wrong label is worse than an unfamiliar one.
 */
function labelForKind(kind: string, scopeName: string | null): string {
  switch (kind) {
    case 'session':
      return 'Current session';
    case 'weekly_all':
      return 'Current week (all models)';
    case 'weekly_scoped':
      return scopeName ? `Current week (${scopeName})` : 'Current week (scoped)';
    default:
      return scopeName ? `${kind} (${scopeName})` : kind;
  }
}

/**
 * A percentage, or null when the provider did not really send one.
 *
 * Deliberately strict about the type: `Number(null)`, `Number('')` and
 * `Number(false)` are all 0, so a coercing check would turn missing data into a
 * confident "0% used". Absent has to stay absent all the way to the UI.
 *
 * A value above 100 is passed through as reported rather than clamped. If the
 * provider says 104, that is what it says; only the bar's drawn width is
 * capped, and that happens in the renderer.
 */
function finitePercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function parseIsoDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function unavailable(
  reason: 'cli_missing' | 'not_applicable' | 'schema_mismatch' | 'unauthenticated' | 'error',
  detail: string,
  observedAt: number,
): QuotaSnapshot {
  return { status: 'unavailable', runtimeType: 'claude-code', reason, detail, observedAt, stale: null };
}

function cancelled(observedAt: number): QuotaSnapshot {
  return unavailable('error', 'The usage check was cancelled.', observedAt);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Unref'd: a drain that never finishes must not hold the process open. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
