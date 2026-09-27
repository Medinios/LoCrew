import type { Agent } from '@shared/types';
import type { RecordedUsageRow, RecordedUsageWindows } from '@shared/ipc';
import { Chip } from '@/components/ui/primitives';
import { cn, formatUsd } from '@/lib/utils';

/**
 * Consumption this app recorded, never provider quota.
 *
 * The two are different quantities from different sources, and the visual
 * language keeps them apart on purpose: recorded usage is text, quota is bars.
 * A percentage bar here would imply an allowance we are measuring against, and
 * there isn't one.
 */

const EMPTY: RecordedUsageRow = {
  agentId: '',
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  executions: 0,
  unverifiedExecutions: 0,
  unavailableExecutions: 0,
  unpricedExecutions: 0,
};

/**
 * Whether a window holds spend that was never measured.
 *
 * Claude Code reports a session total rather than a per-run figure, so runs
 * recorded before this app measured them -- or in a session it first saw
 * partway through -- really did spend something nobody can now recover. The
 * measured figure is a floor in that case, and saying "$1.23" flat would claim
 * a precision that does not exist.
 */
function hasUnverified(row: RecordedUsageRow): boolean {
  return row.unverifiedExecutions + (row.unavailableExecutions ?? 0) > 0;
}

function unverifiedNote(row: RecordedUsageRow): string {
  // Not every unverified run reported a session total: a reset reported a
  // figure that went backwards, and an unreported run reported nothing at all.
  // "Could not be established" covers all of them without claiming any.
  return describeTotal(row.costUsd, row).note ?? '';
}

/**
 * How to render a dollar total whose coverage is incomplete.
 *
 * Three different things can be missing, and they do not mean the same thing:
 * a run whose cost could not be established, a run that reported no usage at
 * all, and a run on a runtime that has no pricing. The first two make the
 * figure a floor. The third makes it partial -- nothing failed, there is simply
 * no price to include -- and a figure built only from those is not a figure at
 * all.
 */
export function describeTotal(
  measuredUsd: number,
  coverage: {
    unverifiedExecutions: number;
    unavailableExecutions?: number;
    unpricedExecutions: number;
  },
): { text: string; note: string | null } {
  const unavailable = coverage.unavailableExecutions ?? 0;
  const short = coverage.unverifiedExecutions + unavailable;
  const notes: string[] = [];

  if (coverage.unverifiedExecutions > 0) {
    notes.push(`${runs(coverage.unverifiedExecutions)} reported a cost that could not be established.`);
  }
  if (unavailable > 0) {
    notes.push(`${runs(unavailable)} finished without reporting any usage.`);
  }
  if (coverage.unpricedExecutions > 0) {
    notes.push(
      `${runs(coverage.unpricedExecutions)} are on a runtime with no pricing, so they contribute nothing to this figure.`,
    );
  }
  const note = notes.length ? notes.join(' ') : null;

  // Spend nobody could establish: the figure is a floor, or not a figure.
  if (short > 0) {
    return { text: measuredUsd === 0 ? 'not measured' : `+${formatUsd(measuredUsd)}`, note };
  }

  // Only unpriced runs. A zero here would read as "these were free".
  if (coverage.unpricedExecutions > 0) {
    return { text: measuredUsd === 0 ? 'Not priced' : `${formatUsd(measuredUsd)} (partial)`, note };
  }

  return { text: formatUsd(measuredUsd), note };
}

function runs(n: number): string {
  return `${n} ${n === 1 ? 'run' : 'runs'}`;
}

export function rowFor(rows: RecordedUsageRow[] | undefined, agentId: string): RecordedUsageRow {
  return rows?.find((r) => r.agentId === agentId) ?? EMPTY;
}

/**
 * Whether a dollar figure means anything for this runtime.
 *
 * `model` agents always record zero cost and A2A agents record nothing at all,
 * so their `$0.00` means "never measured", not "free". Saying so is the whole
 * point -- a zero that looks like a measurement is worse than no number.
 */
export function costIsMeasured(runtimeType: Agent['runtimeType']): boolean {
  return runtimeType === 'claude-code' || runtimeType === 'codex';
}

/**
 * Whether a token count means what a reader will take it to mean.
 *
 * A2A agents report no usage at all. Claude Code does report tokens, but the
 * field we record is main-loop-only: it excludes cache reads and every subagent
 * and compaction call, so the figure can be four orders of magnitude below the
 * work actually done. Showing it beside a Codex count -- which *includes* cache
 * -- invites a comparison that is simply false, so it is withheld until the two
 * are put on one basis.
 */
export function tokensAreMeasured(runtimeType: Agent['runtimeType']): boolean {
  return runtimeType === 'codex' || runtimeType === 'model';
}

/** Why a runtime's tokens are withheld, for the reader who wants to know. */
export function tokensUnavailableReason(runtimeType: Agent['runtimeType']): string {
  return runtimeType === 'claude-code'
    ? 'Claude Code reports only its main loop, leaving out cached input and every subagent and compaction call, so a token total here would be far below the real figure and would not compare with other runtimes.'
    : 'External agents run on someone else\u2019s service and report no usage to this app.';
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * The compact form for a list row: today and the trailing week, side by side.
 *
 * "7d" rather than "this week" because the window has no week boundary -- it is
 * the last 168 hours, and calling it a week would invite the reader to assume a
 * Monday.
 */
export function UsageChips({
  agent,
  windows,
  className,
}: {
  agent: Agent;
  windows: RecordedUsageWindows | undefined;
  className?: string;
}) {
  if (!windows) return null;

  const today = rowFor(windows.today, agent.id);
  const week = rowFor(windows.last7Days, agent.id);

  const measured = costIsMeasured(agent.runtimeType);

  // Nothing to show at all: no price, and no token count that can be trusted.
  if (!measured && !tokensAreMeasured(agent.runtimeType)) {
    return (
      <Chip className={className} title={tokensUnavailableReason(agent.runtimeType)}>
        Usage not reported
      </Chip>
    );
  }
  /**
   * A leading "+" marks a figure as a floor rather than a total. When nothing
   * at all was measured, though, "+$0.00" says nothing true -- the answer is
   * that there is no figure, not that the figure is zero.
   */
  const value = (row: RecordedUsageRow) =>
    measured
      ? describeTotal(row.costUsd, row).text
      : `${formatTokens(row.inputTokens + row.outputTokens)} tok`;

  const detail = measured
    ? 'Recorded by LoCrew. Counted against the day each run started. Estimated from runtime reports, not a bill.'
    : 'Recorded by LoCrew. Tokens only: this runtime reports no cost, so a dollar figure is not measured.';

  return (
    <span className={cn('flex flex-wrap items-center gap-1', className)}>
      <Chip
        tone={hasUnverified(today) ? 'warning' : 'neutral'}
        title={`Today, since local midnight. ${detail}${hasUnverified(today) ? ` ${unverifiedNote(today)}` : ''}`}
      >
        <span className="text-content-faint">Today</span>
        <span className="tabular-nums">{value(today)}</span>
      </Chip>
      <Chip
        tone={hasUnverified(week) ? 'warning' : 'neutral'}
        title={`The last 7 days, a trailing 168 hours rather than a calendar week. ${detail}${hasUnverified(week) ? ` ${unverifiedNote(week)}` : ''}`}
      >
        <span className="text-content-faint">7d</span>
        <span className="tabular-nums">{value(week)}</span>
      </Chip>
    </span>
  );
}

/** The fuller breakdown, for a detail surface with room for it. */
export function UsageBreakdown({
  agent,
  windows,
}: {
  agent: Agent;
  windows: RecordedUsageWindows | undefined;
}) {
  if (!windows) return null;

  const measured = costIsMeasured(agent.runtimeType);
  const tokensShown = tokensAreMeasured(agent.runtimeType);

  if (!measured && !tokensShown) {
    return (
      <p className="text-2xs leading-relaxed text-content-faint">
        {tokensUnavailableReason(agent.runtimeType)}
      </p>
    );
  }
  const rows: Array<[string, RecordedUsageRow]> = [
    ['Today', rowFor(windows.today, agent.id)],
    ['Last 7 days', rowFor(windows.last7Days, agent.id)],
  ];

  return (
    <div className="space-y-1.5">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-2xs text-content-faint">
            <th className="w-1/3 py-1 text-start font-normal" />
            <th className="py-1 text-end font-normal">Cost</th>
            <th className="py-1 text-end font-normal">Tokens</th>
            <th className="py-1 text-end font-normal">Runs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, row]) => (
            <tr key={label} className="border-t border-line">
              <td className="py-1 text-content-muted">{label}</td>
              <td className="py-1 text-end tabular-nums text-content-strong">
                {!measured ? (
                  <span className="text-content-faint">Not measured</span>
                ) : (
                  <span title={describeTotal(row.costUsd, row).note ?? undefined}>
                    {describeTotal(row.costUsd, row).text}
                  </span>
                )}
              </td>
              <td className="py-1 text-end tabular-nums text-content-strong">
                {tokensShown ? (
                  formatTokens(row.inputTokens + row.outputTokens)
                ) : (
                  <span
                    className="text-content-faint"
                    title={tokensUnavailableReason(agent.runtimeType)}
                  >
                    Not reliably measured
                  </span>
                )}
              </td>
              <td className="py-1 text-end tabular-nums text-content-muted">{row.executions}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-2xs leading-relaxed text-content-faint">
        Recorded by LoCrew, not a provider statement. A run counts against the day it started;
        &ldquo;last 7 days&rdquo; is a trailing 168 hours, not a calendar week.
        {measured ? '' : ' This runtime reports no cost, so only tokens are recorded.'}
      </p>
      {tokensShown ? null : (
        <p className="text-2xs leading-relaxed text-content-faint">
          {tokensUnavailableReason(agent.runtimeType)}
        </p>
      )}
      {rows.some(([, row]) => hasUnverified(row)) ? (
        <p className="text-2xs leading-relaxed text-warning-ink">
          Some runs here reported a whole-session total rather than their own spend, so their
          share cannot be separated out. The figures above are what was measured, not the
          full amount.
        </p>
      ) : null}
      {rows.some(([, row]) => row.unpricedExecutions > 0) ? (
        <p className="text-2xs leading-relaxed text-content-faint">
          Some runs here are on a runtime with no pricing, so they contribute nothing to the
          cost column. That is a gap in coverage, not a zero.
        </p>
      ) : null}
    </div>
  );
}
