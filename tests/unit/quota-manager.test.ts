/**
 * The quota manager's caching, coalescing and failure behaviour.
 *
 * The rule every test here defends: a reading we could not take must never
 * render as a number. "0% used" and "we don't know" look identical on a bar and
 * mean opposite things, so an unknown has to stay unknown all the way through.
 */
import { describe, expect, it, vi } from 'vitest';
import { QuotaManager, QUOTA_TTL_MS } from '../../src/main/quota/manager.js';
import type { QuotaSnapshot } from '../../src/shared/quota.js';
import type { RuntimeType } from '../../src/shared/types.js';
import type { QuotaSource } from '../../src/main/quota/types.js';

function okSnapshot(runtimeType: RuntimeType, percent: number, observedAt = Date.now()): QuotaSnapshot {
  return {
    status: 'ok',
    runtimeType,
    planLabel: 'max',
    windows: [
      {
        kind: 'session',
        group: 'session',
        label: 'Current session',
        percentUsed: percent,
        resetsAt: observedAt + 3_600_000,
        windowMinutes: null,
        severity: 'normal',
        isActive: true,
      },
    ],
    observedAt,
  };
}

/** A source whose behaviour each test scripts. */
function source(
  runtimeType: RuntimeType,
  read: (signal: AbortSignal) => Promise<QuotaSnapshot>,
): QuotaSource & { calls: number; read: (signal: AbortSignal) => Promise<QuotaSnapshot> } {
  let impl = read;
  const s = {
    runtimeType,
    calls: 0,
    get read() {
      return (signal: AbortSignal) => {
        s.calls += 1;
        return impl(signal);
      };
    },
    set read(next: (signal: AbortSignal) => Promise<QuotaSnapshot>) {
      impl = next;
    },
  };
  return s;
}

describe('QuotaManager', () => {
  it('fetches once for many agents sharing a runtime', async () => {
    const claude = source('claude-code', async () => okSnapshot('claude-code', 12));
    const manager = new QuotaManager({
      sources: [claude],
      // Five agents, one login: the count must not become the fetch count.
      activeRuntimes: () => ['claude-code'],
      onChange: () => {},
    });

    await Promise.all([manager.refresh(), manager.refresh(), manager.refresh()]);

    expect(claude.calls).toBe(1);
    expect(manager.report()['claude-code']).toMatchObject({ status: 'ok' });
  });

  it('answers from cache inside the TTL and refetches once it expires', async () => {
    let now = 1_000_000;
    const claude = source('claude-code', async () => okSnapshot('claude-code', 12, now));
    const manager = new QuotaManager({
      sources: [claude],
      activeRuntimes: () => ['claude-code'],
      onChange: () => {},
      now: () => now,
    });

    await manager.refresh();
    await manager.refresh();
    expect(claude.calls).toBe(1);

    now += QUOTA_TTL_MS + 1;
    await manager.refresh();
    expect(claude.calls).toBe(2);
  });

  it('forces a refetch on demand but still coalesces concurrent callers', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const claude = source('claude-code', async () => {
      await gate;
      return okSnapshot('claude-code', 30);
    });
    const manager = new QuotaManager({
      sources: [claude],
      activeRuntimes: () => ['claude-code'],
      onChange: () => {},
    });

    const all = Promise.all([manager.refresh(true), manager.refresh(true), manager.refresh(true)]);
    release();
    await all;

    // A held-down refresh button is one fetch, not three.
    expect(claude.calls).toBe(1);
  });

  it('keeps the last good reading as stale instead of showing zero', async () => {
    let fail = false;
    const claude = source('claude-code', async () => {
      if (fail) throw new Error('network down');
      return okSnapshot('claude-code', 62, 1000);
    });
    const manager = new QuotaManager({
      sources: [claude],
      activeRuntimes: () => ['claude-code'],
      onChange: () => {},
    });

    await manager.refresh();
    fail = true;
    await manager.refresh(true);

    const snapshot = manager.report()['claude-code'];
    expect(snapshot?.status).toBe('unavailable');
    if (snapshot?.status !== 'unavailable') throw new Error('expected unavailable');
    // The real number survives, with the time it was true.
    expect(snapshot.stale?.windows[0]?.percentUsed).toBe(62);
    expect(snapshot.stale?.observedAt).toBe(1000);
    expect(snapshot.reason).toBe('error');
  });

  it('carries a stale reading through a second consecutive failure', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const claude = source('claude-code', async () => {
      if (mode === 'fail') throw new Error('still down');
      return okSnapshot('claude-code', 41, 500);
    });
    const manager = new QuotaManager({
      sources: [claude],
      activeRuntimes: () => ['claude-code'],
      onChange: () => {},
    });

    await manager.refresh();
    mode = 'fail';
    await manager.refresh(true);
    await manager.refresh(true);

    const snapshot = manager.report()['claude-code'];
    if (snapshot?.status !== 'unavailable') throw new Error('expected unavailable');
    // A second failure must not drop what the first one preserved.
    expect(snapshot.stale?.windows[0]?.percentUsed).toBe(41);
  });

  it('gives up on a source that ignores cancellation, and recovers afterwards', async () => {
    vi.useFakeTimers();
    try {
      let hang = true;
      const claude = source(
        'claude-code',
        (_signal) =>
          hang
            ? // Never settles and never checks the signal: the manager has to
              // settle the call itself or the runtime is wedged forever.
              new Promise<QuotaSnapshot>(() => {})
            : Promise.resolve(okSnapshot('claude-code', 7)),
      );
      const manager = new QuotaManager({
        sources: [claude],
        activeRuntimes: () => ['claude-code'],
        onChange: () => {},
      });

      const first = manager.refresh(true);
      await vi.advanceTimersByTimeAsync(31_000);
      await first;

      const stuck = manager.report()['claude-code'];
      expect(stuck?.status).toBe('unavailable');

      // The slot must be free again: a retry starts a real fetch.
      hang = false;
      await manager.refresh(true);
      expect(claude.calls).toBe(2);
      expect(manager.report()['claude-code']?.status).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not repopulate the cache after dispose', async () => {
    let finish: (s: QuotaSnapshot) => void = () => {};
    const claude = source('claude-code', () => new Promise<QuotaSnapshot>((r) => (finish = r)));
    const changes: unknown[] = [];
    const manager = new QuotaManager({
      sources: [claude],
      activeRuntimes: () => ['claude-code'],
      onChange: (r) => changes.push(r),
    });

    const pending = manager.refresh(true);
    manager.dispose();
    finish(okSnapshot('claude-code', 90));
    await pending;

    expect(manager.report()).toEqual({});
    expect(changes).toHaveLength(0);
  });

  it('reports a runtime with no source as unsupported, not as zero', async () => {
    const manager = new QuotaManager({
      sources: [],
      activeRuntimes: () => ['model'],
      onChange: () => {},
    });

    await manager.refresh();

    const snapshot = manager.report().model;
    if (snapshot?.status !== 'unavailable') throw new Error('expected unavailable');
    expect(snapshot.reason).toBe('unsupported');
  });

  it('never asks about a runtime that has no agents', async () => {
    const claude = source('claude-code', async () => okSnapshot('claude-code', 5));
    const codex = source('codex', async () => okSnapshot('codex', 5));
    const manager = new QuotaManager({
      sources: [claude, codex],
      activeRuntimes: () => ['claude-code'],
      onChange: () => {},
    });

    await manager.refresh();

    expect(claude.calls).toBe(1);
    expect(codex.calls).toBe(0);
    expect(manager.report().codex).toBeUndefined();
  });

  it('announces a report only when it actually changed', async () => {
    let now = 1_000_000;
    const claude = source('claude-code', async () => okSnapshot('claude-code', 12, now));
    const changes: unknown[] = [];
    const manager = new QuotaManager({
      sources: [claude],
      activeRuntimes: () => ['claude-code'],
      onChange: (r) => changes.push(r),
      now: () => now,
    });

    await manager.refresh();
    expect(changes).toHaveLength(1);

    // Served from cache: nothing moved, so nothing should be broadcast. Panel
    // mounts and window focus both land here, and each one used to push a full
    // report at the renderer for no reason.
    await manager.refresh();
    await manager.refresh();
    expect(changes).toHaveLength(1);

    // A real change still is announced.
    now += QUOTA_TTL_MS + 1;
    claude.read = async () => okSnapshot('claude-code', 44, now);
    await manager.refresh();
    expect(changes).toHaveLength(2);
  });

  it('prunes and cancels a runtime whose last agent was deleted', async () => {
    let active: RuntimeType[] = ['claude-code'];
    const claude = source('claude-code', async () => okSnapshot('claude-code', 20));
    const manager = new QuotaManager({
      sources: [claude],
      activeRuntimes: () => active,
      onChange: () => {},
    });

    await manager.refresh();
    expect(manager.report()['claude-code']).toBeDefined();

    active = [];
    manager.prune();
    expect(manager.report()['claude-code']).toBeUndefined();
  });
});
