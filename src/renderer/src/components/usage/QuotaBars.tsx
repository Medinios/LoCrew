import { useEffect, useState } from 'react';
import type { QuotaSnapshot, QuotaWindow } from '@shared/quota';
import { sharedAccountNote } from '@shared/quota';
import { cn } from '@/lib/utils';

/**
 * Provider subscription quota: percentages the provider itself reports.
 *
 * Nothing here is computed from anything this app recorded. A window we cannot
 * read says so; it never falls back to 0%, because "0% used" and "we don't
 * know" look identical on a bar and mean opposite things.
 */

/**
 * Re-renders on a timer so "3 minutes ago" and a reset that has come due stay
 * true while the panel sits open. The data is unchanged -- only the clock moved
 * -- so this deliberately does not refetch.
 */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function formatAgo(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * A reset time in the past is reported as due, not as a fresh zero. The window
 * may well have reset, but we have not observed that -- only the next reading
 * can say so.
 */
function formatReset(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return 'Reset time not reported';
  if (resetsAt <= now) return 'Reset due — awaiting a fresh reading';
  const time = new Date(resetsAt).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Resets ${time}`;
}

function toneFor(severity: string | null, percent: number): string {
  const level = severity ?? (percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal');
  if (level === 'critical') return 'bg-danger';
  if (level === 'warning') return 'bg-warning';
  return 'bg-primary';
}

function Bar({ window: w, now, stale }: { window: QuotaWindow; now: number; stale: boolean }) {
  // The number is shown as reported; only the drawn width is clamped, so a
  // provider reporting 104% still reads as 104%.
  const width = Math.max(0, Math.min(100, w.percentUsed));
  // ARIA requires valuenow within [valuemin, valuemax]; a provider reporting
  // 104% would otherwise be an invalid value. The visible text keeps the real
  // figure, so nothing is hidden -- only the machine-readable value is capped.
  const ariaNow = Math.round(width);
  return (
    <div className={cn('px-1.5 py-1.5', stale && 'opacity-60')}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-content-muted" title={w.label}>
          {w.label}
        </span>
        <span className="shrink-0 text-xs font-medium tabular-nums text-content-strong">
          {Math.round(w.percentUsed)}% used
        </span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle"
        role="meter"
        aria-valuenow={ariaNow}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${w.label}, ${Math.round(w.percentUsed)} percent used`}
      >
        <div
          className={cn('h-full rounded-full transition-[width]', toneFor(w.severity, w.percentUsed))}
          style={{ width: `${width}%` }}
        />
      </div>
      <p className="mt-0.5 text-2xs text-content-faint">{formatReset(w.resetsAt, now)}</p>
    </div>
  );
}

const REASON_TEXT: Record<string, string> = {
  unsupported: 'This runtime has no subscription quota.',
  not_applicable: 'No plan quota on this login — usage is billed per request instead.',
  cli_missing: 'The command-line tool for this runtime was not found.',
  unauthenticated: 'Not signed in, so usage cannot be read.',
  schema_mismatch: 'This version reported usage in a shape the app does not recognise.',
  error: 'Usage could not be read.',
};

export function QuotaSection({
  title,
  snapshot,
  agentCount,
}: {
  title: string;
  snapshot: QuotaSnapshot;
  agentCount: number;
}) {
  const now = useNow();

  if (snapshot.status === 'ok') {
    return (
      <div>
        <Header title={title} planLabel={snapshot.planLabel} observedAt={snapshot.observedAt} now={now} />
        {snapshot.windows.map((w) => (
          <Bar key={`${w.kind}:${w.label}`} window={w} now={now} stale={false} />
        ))}
        <p className="px-1.5 py-1 text-2xs leading-relaxed text-content-faint">
          {sharedAccountNote(agentCount)}
        </p>
      </div>
    );
  }

  // A failed read keeps the last good numbers rather than blanking them, and
  // labels them with when they were true.
  if (snapshot.stale) {
    return (
      <div>
        <Header
          title={title}
          planLabel={snapshot.stale.planLabel}
          observedAt={snapshot.stale.observedAt}
          now={now}
          stale
        />
        {snapshot.stale.windows.map((w) => (
          <Bar key={`${w.kind}:${w.label}`} window={w} now={now} stale />
        ))}
        <p className="px-1.5 py-1 text-2xs leading-relaxed text-content-faint">
          Could not refresh: {REASON_TEXT[snapshot.reason] ?? REASON_TEXT.error} Showing the last
          reading. {sharedAccountNote(agentCount)}
        </p>
      </div>
    );
  }

  return (
    <div>
      <Header title={title} planLabel={null} observedAt={null} now={now} />
      <p className="px-1.5 py-1.5 text-2xs leading-relaxed text-content-faint">
        {REASON_TEXT[snapshot.reason] ?? REASON_TEXT.error}
      </p>
    </div>
  );
}

function Header({
  title,
  planLabel,
  observedAt,
  now,
  stale = false,
}: {
  title: string;
  planLabel: string | null;
  observedAt: number | null;
  now: number;
  stale?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-1.5 pt-1.5">
      <span className="truncate text-xs font-medium text-content-strong">
        {title}
        {planLabel ? <span className="ms-1 font-normal text-content-faint">{planLabel}</span> : null}
      </span>
      {observedAt !== null ? (
        <span className="shrink-0 text-2xs text-content-faint">
          {stale ? 'as of ' : ''}
          {formatAgo(observedAt, now)}
        </span>
      ) : null}
    </div>
  );
}
