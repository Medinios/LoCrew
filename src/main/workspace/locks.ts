import { resolve } from 'node:path';
import type { WorkspaceLockInfo } from '../../shared/ipc.js';
import type { WorkspaceAccess } from '../../shared/types.js';

/**
 * Serialises write access to a working directory.
 *
 * Two agents pointed at the same checkout will happily overwrite each other's
 * edits, and neither runtime knows the other exists. This lock is what makes
 * "both agents on the same project" safe in the initial version: read-only
 * executions run freely and in parallel, while anything that can write waits
 * its turn.
 *
 * It is an in-process advisory lock. It does not defend against another program
 * on the machine editing the same files.
 */
export class WorkspaceLockManager {
  private readonly locks = new Map<string, WorkspaceLockInfo>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly listeners = new Set<(locks: WorkspaceLockInfo[]) => void>();

  static normalise(path: string): string {
    const resolved = resolve(path);
    // Windows paths are case-insensitive; without this, "C:\Repo" and "c:\repo"
    // would be treated as two different workspaces and the lock would not hold.
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  /** Read-only executions never contend for the lock. */
  static requiresLock(access: WorkspaceAccess): boolean {
    return access !== 'read_only';
  }

  isLocked(path: string): boolean {
    return this.locks.has(WorkspaceLockManager.normalise(path));
  }

  holder(path: string): WorkspaceLockInfo | null {
    return this.locks.get(WorkspaceLockManager.normalise(path)) ?? null;
  }

  list(): WorkspaceLockInfo[] {
    return [...this.locks.values()];
  }

  onChange(listener: (locks: WorkspaceLockInfo[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Waits for exclusive access to `path`, then returns a release function.
   * Rejects if `signal` aborts while queued.
   */
  async acquire(
    path: string,
    owner: { agentId: string; executionId: string },
    signal?: AbortSignal,
  ): Promise<() => void> {
    const key = WorkspaceLockManager.normalise(path);

    while (this.locks.has(key)) {
      if (signal?.aborted) throw new Error('Cancelled while waiting for the workspace lock.');
      await this.waitForRelease(key, signal);
    }

    this.locks.set(key, {
      path,
      agentId: owner.agentId,
      executionId: owner.executionId,
      acquiredAt: Date.now(),
    });
    this.emit();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locks.delete(key);
      const queue = this.waiters.get(key);
      // Wake one waiter; it re-checks the map, so a spurious wake is harmless.
      queue?.shift()?.();
      if (queue && queue.length === 0) this.waiters.delete(key);
      this.emit();
    };
  }

  private waitForRelease(key: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const queue = this.waiters.get(key) ?? [];
      const wake = () => {
        cleanup();
        resolvePromise();
      };
      const onAbort = () => {
        cleanup();
        const remaining = this.waiters.get(key);
        if (remaining) {
          const index = remaining.indexOf(wake);
          if (index >= 0) remaining.splice(index, 1);
        }
        reject(new Error('Cancelled while waiting for the workspace lock.'));
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);

      queue.push(wake);
      this.waiters.set(key, queue);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private emit(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) listener(snapshot);
  }

  /** Test helper: drops all state. */
  reset(): void {
    this.locks.clear();
    this.waiters.clear();
  }
}
