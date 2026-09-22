import { describe, expect, it } from 'vitest';
import { WorkspaceLockManager } from '../../src/main/workspace/locks.js';

const OWNER = { agentId: 'agent:a', executionId: 'exec:1' };
const OTHER = { agentId: 'agent:b', executionId: 'exec:2' };

describe('WorkspaceLockManager', () => {
  it('grants the lock to the first caller', async () => {
    const locks = new WorkspaceLockManager();
    const release = await locks.acquire('/tmp/project', OWNER);

    expect(locks.isLocked('/tmp/project')).toBe(true);
    expect(locks.holder('/tmp/project')?.agentId).toBe('agent:a');

    release();
    expect(locks.isLocked('/tmp/project')).toBe(false);
  });

  it('serialises two agents against the same directory', async () => {
    const locks = new WorkspaceLockManager();
    const order: string[] = [];

    const first = await locks.acquire('/tmp/project', OWNER);
    order.push('a-acquired');

    const secondPromise = locks.acquire('/tmp/project', OTHER).then((release) => {
      order.push('b-acquired');
      return release;
    });

    // B must not have the lock while A holds it.
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['a-acquired']);

    first();
    const second = await secondPromise;
    expect(order).toEqual(['a-acquired', 'b-acquired']);
    second();
  });

  it('lets different directories proceed in parallel', async () => {
    const locks = new WorkspaceLockManager();
    const a = await locks.acquire('/tmp/one', OWNER);
    const b = await locks.acquire('/tmp/two', OTHER);

    expect(locks.list()).toHaveLength(2);
    a();
    b();
  });

  it('treats Windows paths case-insensitively', () => {
    const upper = WorkspaceLockManager.normalise('C:\\Repo\\App');
    const lower = WorkspaceLockManager.normalise('c:\\repo\\app');
    if (process.platform === 'win32') {
      expect(upper).toBe(lower);
    } else {
      // On POSIX the paths are distinct, which is also correct.
      expect(typeof upper).toBe('string');
    }
  });

  it('does not lock for read-only access', () => {
    expect(WorkspaceLockManager.requiresLock('read_only')).toBe(false);
    expect(WorkspaceLockManager.requiresLock('read_write')).toBe(true);
    expect(WorkspaceLockManager.requiresLock('approval_required')).toBe(true);
  });

  it('abandons a queued waiter when its execution is cancelled', async () => {
    const locks = new WorkspaceLockManager();
    const held = await locks.acquire('/tmp/project', OWNER);

    const controller = new AbortController();
    const waiting = locks.acquire('/tmp/project', OTHER, controller.signal);

    controller.abort();
    await expect(waiting).rejects.toThrow(/Cancelled/);

    held();
    expect(locks.isLocked('/tmp/project')).toBe(false);
  });

  it('releasing twice is a no-op', async () => {
    const locks = new WorkspaceLockManager();
    const release = await locks.acquire('/tmp/project', OWNER);
    release();
    release();
    expect(locks.isLocked('/tmp/project')).toBe(false);
  });

  it('notifies listeners when the lock set changes', async () => {
    const locks = new WorkspaceLockManager();
    const snapshots: number[] = [];
    locks.onChange((current) => snapshots.push(current.length));

    const release = await locks.acquire('/tmp/project', OWNER);
    release();

    expect(snapshots).toEqual([1, 0]);
  });
});
