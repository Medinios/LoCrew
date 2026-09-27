import type { QuotaReport, QuotaSnapshot } from '../../shared/quota.js';
import type { RuntimeType } from '../../shared/types.js';
import type { QuotaSource } from './types.js';

/** How long a reading stays fresh enough to answer from cache. */
export const QUOTA_TTL_MS = 5 * 60 * 1000;

/** A read that outruns this is abandoned, whatever the source was waiting on. */
const READ_TIMEOUT_MS = 30_000;

export interface QuotaManagerDeps {
  sources: QuotaSource[];
  /** Which runtimes currently have agents. Nothing else is ever fetched. */
  activeRuntimes(): RuntimeType[];
  onChange(report: QuotaReport): void;
  now?(): number;
}

/**
 * Owns every quota reading.
 *
 * Quota belongs to a login, not to an agent, so everything here is keyed by
 * runtime type: ten Claude Code agents produce one fetch, not ten. That is safe
 * because nothing in `AgentConfig` can change which credentials a CLI uses --
 * there is no per-agent executable, environment or home override, so every
 * agent of a runtime necessarily shares one effective login.
 *
 * A failed refresh keeps the previous reading and marks it stale. Showing a
 * real 62% with an "as of" time is honest; replacing it with 0% is not.
 */
export class QuotaManager {
  private readonly cache = new Map<RuntimeType, QuotaSnapshot>();
  /** In-flight reads, so simultaneous callers share one fetch. */
  private readonly inFlight = new Map<RuntimeType, Promise<QuotaSnapshot>>();
  private readonly controllers = new Map<RuntimeType, AbortController>();
  /** The last report handed to `onChange`, so an unchanged one is not resent. */
  private lastAnnounced: string | null = null;
  private disposed = false;

  constructor(private readonly deps: QuotaManagerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The last known reading for every active runtime, without fetching. */
  report(): QuotaReport {
    const out: QuotaReport = {};
    for (const runtimeType of this.deps.activeRuntimes()) {
      const cached = this.cache.get(runtimeType);
      if (cached) out[runtimeType] = cached;
    }
    return out;
  }

  /**
   * Refreshes every active runtime whose reading has expired. `force` ignores
   * the TTL but still coalesces: hammering the refresh button produces one
   * fetch per runtime, not one per click.
   */
  async refresh(force = false): Promise<QuotaReport> {
    if (this.disposed) return this.report();

    const runtimes = this.deps.activeRuntimes();
    await Promise.all(
      runtimes.map((runtimeType) => {
        const cached = this.cache.get(runtimeType);
        const fresh = cached && this.now() - observedAt(cached) < QUOTA_TTL_MS;
        if (fresh && !force) return Promise.resolve(cached);
        return this.read(runtimeType);
      }),
    );

    const report = this.report();
    // Announce only a reading that actually moved. Without this, every panel
    // mount and every window focus broadcasts a full report to the renderer
    // even when every runtime answered from cache.
    const fingerprint = JSON.stringify(report);
    if (!this.disposed && fingerprint !== this.lastAnnounced) {
      this.lastAnnounced = fingerprint;
      this.deps.onChange(report);
    }
    return report;
  }

  private read(runtimeType: RuntimeType): Promise<QuotaSnapshot> {
    const existing = this.inFlight.get(runtimeType);
    if (existing) return existing;

    const source = this.deps.sources.find((s) => s.runtimeType === runtimeType);
    if (!source) {
      const snapshot: QuotaSnapshot = {
        status: 'unavailable',
        runtimeType,
        reason: 'unsupported',
        detail: 'This runtime has no subscription quota.',
        observedAt: this.now(),
        stale: null,
      };
      this.cache.set(runtimeType, snapshot);
      return Promise.resolve(snapshot);
    }

    const controller = new AbortController();
    this.controllers.set(runtimeType, controller);

    // The timeout has to settle this call, not merely ask the source to stop.
    // A source that ignores its signal would otherwise keep `inFlight`
    // occupied forever, and every later refresh would join that dead promise
    // instead of starting a real one.
    let bail: (snapshot: QuotaSnapshot) => void = () => {};
    const timedOut = new Promise<QuotaSnapshot>((resolve) => (bail = resolve));
    const timer = setTimeout(() => {
      controller.abort();
      bail({
        status: 'unavailable',
        runtimeType,
        reason: 'error',
        detail: 'The usage check did not finish in time.',
        observedAt: this.now(),
        stale: null,
      });
    }, READ_TIMEOUT_MS);

    const attempt = source.read(controller.signal).catch(
      (error): QuotaSnapshot => ({
        status: 'unavailable',
        runtimeType,
        reason: 'error',
        detail: error instanceof Error ? error.message : String(error),
        observedAt: this.now(),
        stale: null,
      }),
    );
    // A source that never settles is abandoned here, but its rejection must
    // still be consumed or Node reports an unhandled rejection later.
    void attempt.catch(() => {});

    const task = Promise.race([attempt, timedOut])
      .then((snapshot) => {
        const settled = this.withStale(runtimeType, snapshot);
        // A read that outlived dispose(), or whose runtime lost its last agent
        // while it was in flight, must not repopulate the cache.
        if (!this.disposed && this.inFlight.get(runtimeType) === task) {
          this.cache.set(runtimeType, settled);
        }
        return settled;
      })
      .finally(() => {
        clearTimeout(timer);
        // Only clear the slot if it is still ours: a later read may already
        // have replaced it after a timeout abandoned this one.
        if (this.inFlight.get(runtimeType) === task) this.inFlight.delete(runtimeType);
        if (this.controllers.get(runtimeType) === controller) this.controllers.delete(runtimeType);
      });

    this.inFlight.set(runtimeType, task);
    return task;
  }

  /**
   * Carries the last good reading forward onto a failure.
   *
   * The previous value is preserved verbatim, including its original
   * `observedAt`, so the UI can say when it was true. An elapsed reset time is
   * not rewritten to zero here: we do not know that the window actually reset,
   * only that it was due to, and inventing a zero would be a fresh claim rather
   * than an old one.
   */
  private withStale(runtimeType: RuntimeType, snapshot: QuotaSnapshot): QuotaSnapshot {
    if (snapshot.status === 'ok') return snapshot;

    const previous = this.cache.get(runtimeType);
    if (previous?.status === 'ok') {
      return {
        ...snapshot,
        stale: {
          planLabel: previous.planLabel,
          windows: previous.windows,
          observedAt: previous.observedAt,
        },
      };
    }
    // A failure following a failure keeps whatever stale value the first one
    // was already carrying, rather than dropping it.
    return { ...snapshot, stale: previous?.status === 'unavailable' ? previous.stale : null };
  }

  /**
   * Drops cached readings for runtimes that no longer have agents, and cancels
   * any read still running for them -- there is nobody left to show it to.
   */
  prune(): void {
    const active = new Set(this.deps.activeRuntimes());
    for (const runtimeType of [...this.cache.keys()]) {
      if (!active.has(runtimeType)) this.cache.delete(runtimeType);
    }
    for (const [runtimeType, controller] of [...this.controllers.entries()]) {
      if (active.has(runtimeType)) continue;
      controller.abort();
      this.controllers.delete(runtimeType);
      // Dropping the slot also stops the settling read from writing back, via
      // the identity check in read().
      this.inFlight.delete(runtimeType);
    }
  }

  /**
   * Cancels everything in flight. Called on shutdown.
   *
   * `disposed` stays set so a read that settles after this cannot repopulate
   * the cache or fire `onChange` at a renderer that is going away.
   */
  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.inFlight.clear();
    this.cache.clear();
    this.lastAnnounced = null;
  }
}

function observedAt(snapshot: QuotaSnapshot): number {
  return snapshot.observedAt;
}
