import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { QuotaSnapshot, QuotaWindow } from '../../shared/quota.js';
import { describeWindowLength } from '../../shared/quota.js';
import { findCodexBinary } from '../runtimes/codex.js';
import type { QuotaSource } from './types.js';

/**
 * Reads Codex's account quota over the CLI's own app-server protocol.
 *
 * The TypeScript SDK exposes no quota at all -- its only usage type is per-turn
 * token counts -- so the meter lives in `codex app-server`'s JSON-RPC surface,
 * method `account/rateLimits/read`. The schema is first-party and can be
 * regenerated from the installed binary with
 * `codex app-server generate-json-schema`.
 *
 * The process is short-lived by design: spawn, handshake, one request, kill.
 * A sub-second round trip does not justify holding a child process open for the
 * life of the app, and it sidesteps merging the sparse `account/rateLimits/
 * updated` pushes, whose "null does not clear a previous value" rule is easy to
 * get wrong. The cache in the manager is what keeps this from running often.
 */
export class CodexQuotaSource implements QuotaSource {
  readonly runtimeType = 'codex' as const;

  async read(signal: AbortSignal): Promise<QuotaSnapshot> {
    const observedAt = Date.now();
    if (signal.aborted) return unavailable('error', 'The usage check was cancelled.', observedAt);

    const binary = await findCodexBinary();
    if (!binary) {
      return unavailable('cli_missing', 'The Codex CLI was not found on this machine.', observedAt);
    }
    // Resolving the binary can probe PATH, so cancellation can land during it.
    // Check again rather than spawning a child nobody is waiting for.
    if (signal.aborted) return unavailable('error', 'The usage check was cancelled.', observedAt);

    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      child = spawn(binary.path, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const rpc = new JsonRpc(child);

      await rpc.request(
        'initialize',
        { clientInfo: { name: 'locrew', version: '0.1.0' }, capabilities: { experimentalApi: true } },
        signal,
      );
      rpc.notify('initialized', {});

      // excludeResetCreditDetails is documented as the flag for background
      // usage polls: it skips a second lookup we have nothing to show from.
      const result = await rpc.request(
        'account/rateLimits/read',
        { excludeResetCreditDetails: true },
        signal,
      );

      const snapshot = (result as { rateLimits?: unknown } | null)?.rateLimits;
      if (!snapshot || typeof snapshot !== 'object') {
        return unavailable('schema_mismatch', 'The Codex app-server returned no rate limits.', observedAt);
      }

      const windows = parseCodexWindows(snapshot as Record<string, unknown>);
      if (!windows.length) {
        return unavailable(
          'not_applicable',
          'This Codex account reports no usage meters. API-key billing has no plan quota.',
          observedAt,
        );
      }

      const planType = (snapshot as { planType?: unknown }).planType;
      return {
        status: 'ok',
        runtimeType: this.runtimeType,
        planLabel: typeof planType === 'string' && planType !== 'unknown' ? planType : null,
        windows,
        observedAt,
      };
    } catch (error) {
      const text = message(error);
      const reason = /not logged in|unauthenticated|login|401/i.test(text) ? 'unauthenticated' : 'error';
      return unavailable(reason, text, observedAt);
    } finally {
      // Always. A meter read must not leave a child behind on any path.
      killTree(child);
    }
  }
}

/**
 * Codex names its windows `primary` and `secondary` and states each one's
 * length in minutes, so the label can be derived from real data instead of
 * assumed. 300 minutes is a 5-hour window; 10080 is a 7-day one. When the
 * length is missing the window keeps a neutral name rather than a guessed one.
 */
export function parseCodexWindows(snapshot: Record<string, unknown>): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  for (const [key, group, fallback] of [
    ['primary', 'session', 'Current session'],
    ['secondary', 'weekly', 'Current period'],
  ] as const) {
    const raw = snapshot[key];
    if (!raw || typeof raw !== 'object') continue;
    const w = raw as { usedPercent?: unknown; resetsAt?: unknown; windowDurationMins?: unknown };

    const percent = finitePercent(w.usedPercent);
    if (percent === null) continue;

    const minutes = finiteMinutes(w.windowDurationMins);
    const length = describeWindowLength(minutes);

    out.push({
      kind: key,
      group,
      label: length ? `${length} window` : fallback,
      percentUsed: percent,
      // Codex sends unix seconds; everything downstream works in epoch ms.
      resetsAt: finiteSeconds(w.resetsAt),
      windowMinutes: minutes,
      severity: null,
      isActive: key === 'primary',
    });
  }
  return out;
}

/** Minimal newline-delimited JSON-RPC client for one short-lived exchange. */
class JsonRpc {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private failure: Error | null = null;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code) => this.fail(new Error(`The Codex app-server exited (code ${code ?? 'unknown'}).`)));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;

      let parsed: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        parsed = JSON.parse(line);
      } catch {
        // Notifications and stray output are none of our business.
        continue;
      }
      if (typeof parsed.id !== 'number') continue;
      const waiter = this.pending.get(parsed.id);
      if (!waiter) continue;
      this.pending.delete(parsed.id);
      if (parsed.error) waiter.reject(new Error(String(parsed.error.message ?? 'The request failed.')));
      else waiter.resolve(parsed.result ?? null);
    }
  }

  /** A dead child must reject every in-flight call, not hang until the timeout. */
  private fail(error: Error): void {
    this.failure ??= error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  notify(method: string, params: unknown): void {
    if (this.failure) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  request(method: string, params: unknown, signal: AbortSignal, timeoutMs = 15_000): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal.aborted) return Promise.reject(new Error('The usage check was cancelled.'));

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        fn();
      };
      const onAbort = () => settle(() => reject(new Error('The usage check was cancelled.')));
      const timer = setTimeout(
        () => settle(() => reject(new Error(`The Codex app-server did not answer ${method} in time.`))),
        timeoutMs,
      );

      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
      });
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }
}

function killTree(child: ChildProcessWithoutNullStreams | null): void {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    child.stdin.end();
    child.kill('SIGTERM');
    // A child that ignores SIGTERM still must not outlive the read.
    const hard = setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000);
    hard.unref?.();
  } catch {
    /* already gone */
  }
}

/**
 * Strict on purpose: `Number(null)`, `Number('')` and `Number(false)` are all
 * 0, so coercing here would report missing data as "0% used". Values above 100
 * pass through as reported; only the drawn bar is capped, in the renderer.
 */
function finitePercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function finiteMinutes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** Codex sends unix seconds; everything downstream works in epoch ms. */
function finiteSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value * 1000;
}

function unavailable(
  reason: 'cli_missing' | 'not_applicable' | 'schema_mismatch' | 'unauthenticated' | 'error',
  detail: string,
  observedAt: number,
): QuotaSnapshot {
  return { status: 'unavailable', runtimeType: 'codex', reason, detail, observedAt, stale: null };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
