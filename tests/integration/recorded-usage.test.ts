/**
 * Per-execution cost accounting, and the windows built on it.
 *
 * Claude Code reports `total_cost_usd` for a whole native session, and this app
 * resumes a session on every run, so a run's own spend is the difference
 * between what it reported and what that session had already reached. These
 * tests pin that measurement, pin the cases where the difference is genuinely
 * unknowable, and pin that Codex -- whose rows are already per-run -- is not
 * touched.
 *
 * Totals are aggregated from `agent_executions` rows, never from `agent_events`:
 * an execution row holds one figure per run, while the events table holds every
 * intermediate total for the same run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type OpenDbResult } from '../../src/main/db/index.js';
import { Store, startOfLocalDay } from '../../src/main/db/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, CostProvenance, RuntimeType } from '../../src/shared/types.js';
import { DEFAULT_AGENT_CONFIG, DEFAULT_AGENT_PERMISSIONS, LOCAL_USER_ID } from '../../src/shared/types.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('per-execution cost accounting', () => {
  let dir: string;
  let database: OpenDbResult;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'locrew-usage-'));
    database = openDatabase(join(dir, 'test.db'), join(process.cwd(), 'src/main/db/migrations'));
    store = new Store(database.db);
  });

  afterEach(() => {
    database?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function agentOf(name: string, runtimeType: RuntimeType): Agent {
    return store.createAgent({
      name,
      description: '',
      runtimeType,
      avatar: '',
      avatarColor: '#7C6CF6',
      workingDirectory: dir,
      permissions: DEFAULT_AGENT_PERMISSIONS,
      config: DEFAULT_AGENT_CONFIG,
    });
  }

  function conversationOf(name: string, agent: Agent): string {
    return store.createConversation({
      kind: 'channel',
      name,
      topic: null,
      memberAgentIds: [agent.id],
      humanMemberId: LOCAL_USER_ID,
    }).id;
  }

  /** One run, reporting `rawCostUsd` as the runtime would. */
  function run(
    agent: Agent,
    conversationId: string,
    opts: {
      raw: number;
      sessionId?: string | null;
      resumeRequested?: boolean;
      startedAt?: number;
      inputTokens?: number;
      outputTokens?: number;
      /** Report the figure twice, as finish() does after the cost events. */
      reapply?: boolean;
    },
  ) {
    const created = store.createExecution({
      agentId: agent.id,
      conversationId,
      taskId: null,
      trigger: 'human',
      triggeredByMessageId: null,
      chainId: `chain:${Math.random()}`,
      chainDepth: 0,
    });
    if (opts.startedAt !== undefined) {
      store.updateExecution(created.id, { startedAt: opts.startedAt } as never);
    }
    const record = () =>
      store.recordExecutionCost({
        executionId: created.id,
        runtimeType: agent.runtimeType,
        agentId: agent.id,
        conversationId,
        nativeSessionId: opts.sessionId === undefined ? 'sess-1' : opts.sessionId,
        resumeRequested: opts.resumeRequested ?? false,
        rawCostUsd: opts.raw,
        inputTokens: opts.inputTokens ?? 0,
        outputTokens: opts.outputTokens ?? 0,
        turns: 1,
      });
    let result = record();
    if (opts.reapply) result = record();
    store.updateExecution(created.id, { state: 'completed', endedAt: Date.now() } as never);
    return result;
  }

  function provenanceOf(executionId: string): CostProvenance {
    const row = store.getExecutionRow(executionId);
    if (!row) throw new Error('execution vanished');
    return row.costProvenance;
  }

  describe('measuring a Claude Code session', () => {
    it('measures the second run in a session as its own spend', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);

      // First run in a session nobody asked to resume: it really did start at
      // zero, so its reported total is its own spend.
      const first = run(agent, conv, { raw: 2 });
      const second = run(agent, conv, { raw: 5, resumeRequested: true });

      expect(first.costUsd).toBeCloseTo(2);
      expect(provenanceOf(first.id)).toBe('measured');
      expect(second.costUsd).toBeCloseTo(3);
      expect(provenanceOf(second.id)).toBe('measured');
    });

    it('is idempotent when finish re-applies the same figure', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);

      run(agent, conv, { raw: 2 });
      // finish() re-applies the last cost after the cost events have run. A
      // second measurement against the already-advanced baseline would collapse
      // the delta to zero; measuring from the frozen entry baseline does not.
      const second = run(agent, conv, { raw: 5, resumeRequested: true, reapply: true });

      expect(second.costUsd).toBeCloseTo(3);
      expect(provenanceOf(second.id)).toBe('measured');
    });

    it('keeps the baseline across a restart', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);
      run(agent, conv, { raw: 4 });

      // Reopen the database, as a relaunch would.
      const path = join(dir, 'test.db');
      database.close();
      database = openDatabase(path, join(process.cwd(), 'src/main/db/migrations'));
      store = new Store(database.db);

      const after = run(agent, conv, { raw: 9, resumeRequested: true });

      expect(after.costUsd).toBeCloseTo(5);
      expect(provenanceOf(after.id)).toBe('measured');
    });

    it('keeps separate sessions independent', () => {
      const agent = agentOf('Claude', 'claude-code');
      const a = conversationOf('one', agent);
      const b = conversationOf('two', agent);

      run(agent, a, { raw: 2, sessionId: 'sess-a' });
      const second = run(agent, b, { raw: 3, sessionId: 'sess-b' });

      // A different session's total must not become this one's baseline.
      expect(second.costUsd).toBeCloseTo(3);
      expect(provenanceOf(second.id)).toBe('measured');
    });
  });

  describe('cases where the spend is genuinely unknowable', () => {
    it('does not claim the spend of a session first seen mid-flight', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);

      // A session that already existed before this accounting was watching:
      // its earlier total was never recorded, so this run's own spend cannot
      // be recovered. It establishes the baseline and claims nothing.
      const first = run(agent, conv, { raw: 12, resumeRequested: true });

      expect(provenanceOf(first.id)).toBe('baseline_only');
      const row = store.getExecutionRow(first.id);
      expect(row?.rawCostUsd).toBeCloseTo(12);

      // The next run in that session is the first that can be measured.
      const second = run(agent, conv, { raw: 15, resumeRequested: true });
      expect(second.costUsd).toBeCloseTo(3);
      expect(provenanceOf(second.id)).toBe('measured');
    });

    it('treats a session id that differs from the resumed one as unverified', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);
      run(agent, conv, { raw: 4, sessionId: 'sess-1' });

      // Resume was asked for but the runtime reported a different session. A
      // fork carries the parent's totals forward; a fresh session starts at
      // zero. Nothing here can tell them apart, so nothing is claimed.
      const forked = run(agent, conv, { raw: 4, sessionId: 'sess-2', resumeRequested: true });

      expect(provenanceOf(forked.id)).toBe('baseline_only');
      expect(forked.costUsd).toBe(0);
    });

    it('does not let a zeroed crash result disturb the session', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);
      run(agent, conv, { raw: 3 });

      // The SDK documents that a crashed or startup-failed result can report
      // zero. Lowering the baseline to match would over-count the next run.
      const crashed = run(agent, conv, { raw: 0, resumeRequested: true });
      expect(crashed.costUsd).toBe(0);
      expect(provenanceOf(crashed.id)).toBe('ambiguous');

      // The crashed run may still have spent before dying, so the session's
      // real position is unknown. Measuring 8 - 3 here would quietly hand the
      // crashed run's spend to this one and call the result measured, so it
      // re-anchors and claims nothing instead.
      const after = run(agent, conv, { raw: 8, resumeRequested: true });
      expect(after.costUsd).toBe(0);
      expect(provenanceOf(after.id)).toBe('ambiguous');

      // Once re-anchored, measurement resumes.
      const clean = run(agent, conv, { raw: 11, resumeRequested: true });
      expect(clean.costUsd).toBeCloseTo(3);
      expect(provenanceOf(clean.id)).toBe('measured');
    });

    it('does not claim a run whose counter went backwards', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);
      run(agent, conv, { raw: 10 });

      // A mid-run reset. What was spent before it is in no figure we hold, so
      // this run is not claimed -- but the session stays measurable afterwards.
      const reset = run(agent, conv, { raw: 2, resumeRequested: true });
      expect(provenanceOf(reset.id)).toBe('ambiguous');
      expect(reset.costUsd).toBe(0);

      // The run after the reset measures from the post-reset counter. If the
      // session had stayed pinned to its old peak of 10, this would be negative
      // and every later run would stay ambiguous until 10 was passed again.
      const after = run(agent, conv, { raw: 5, resumeRequested: true });
      expect(provenanceOf(after.id)).toBe('measured');
      expect(after.costUsd).toBeCloseTo(3);

      // And the one after that keeps measuring cleanly.
      const third = run(agent, conv, { raw: 6.5, resumeRequested: true });
      expect(provenanceOf(third.id)).toBe('measured');
      expect(third.costUsd).toBeCloseTo(1.5);
    });

    it('excludes unverified runs from the total and counts them instead', () => {
      const now = Date.now();
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);

      run(agent, conv, { raw: 12, resumeRequested: true, startedAt: now - HOUR }); // baseline_only
      run(agent, conv, { raw: 15, resumeRequested: true, startedAt: now - HOUR }); // measured: 3

      const today = store.recordedUsage(now).today.find((r) => r.agentId === agent.id);

      // The measured figure is a floor, and the count says so.
      expect(today?.costUsd).toBeCloseTo(3);
      expect(today?.unverifiedExecutions).toBe(1);
      expect(today?.executions).toBe(2);
    });
  });

  describe('other runtimes are untouched', () => {
    it('passes Codex figures through unchanged', () => {
      const now = Date.now();
      const agent = agentOf('Codex', 'codex');
      const conv = conversationOf('general', agent);

      // Codex accumulates from zero inside each execution, so rising values are
      // genuine per-turn growth on a lengthening thread, not carried-forward
      // totals. Measuring them against a baseline would silently undercount.
      run(agent, conv, { raw: 0.01, startedAt: now - 3 * HOUR, resumeRequested: true });
      run(agent, conv, { raw: 0.02, startedAt: now - 2 * HOUR, resumeRequested: true });
      run(agent, conv, { raw: 0.03, startedAt: now - HOUR, resumeRequested: true });

      const today = store.recordedUsage(now).today.find((r) => r.agentId === agent.id);

      expect(today?.costUsd).toBeCloseTo(0.06);
      expect(today?.unverifiedExecutions).toBe(0);
    });

    it('measures a run with no session id only when nothing came before it', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);

      // Nothing to resume means the session started at zero, so the cumulative
      // is this run's own spend even without an id to file it under.
      const fresh = run(agent, conv, { raw: 1.5, sessionId: null });
      expect(fresh.costUsd).toBeCloseTo(1.5);
      expect(provenanceOf(fresh.id)).toBe('measured');
    });

    it('does not claim a resumed run that reported no session id', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);

      // A resumed run did have a history, and its figure covers a span we
      // cannot separate. Treating it as this run's spend would charge a whole
      // session to one run.
      const resumed = run(agent, conv, { raw: 1.5, sessionId: null, resumeRequested: true });

      expect(resumed.costUsd).toBe(0);
      expect(provenanceOf(resumed.id)).toBe('ambiguous');
      // The reported figure is kept: it still bounds what this run could have
      // spent, which is what the chain limit needs.
      expect(store.getExecutionRow(resumed.id)?.rawCostUsd).toBeCloseTo(1.5);
    });
  });

  describe('runtimes with no price', () => {
    it('does not turn an unpriced model run into a verified zero', () => {
      const now = Date.now();
      const agent = agentOf('Modelled', 'model');
      const conv = conversationOf('general', agent);

      // The model runtime emits a literal 0 because pricing was never
      // implemented. Recording that as measured would claim the run was free.
      const only = run(agent, conv, { raw: 0, startedAt: now - HOUR });
      expect(provenanceOf(only.id)).toBe('unpriced');

      const today = store.recordedUsage(now).today.find((r) => r.agentId === agent.id);
      expect(today?.unpricedExecutions).toBe(1);
      // Not counted as a failure to measure -- nothing failed, there is no price.
      expect(today?.unverifiedExecutions).toBe(0);
      expect(today?.costUsd).toBe(0);
    });

    it('marks an external agent the same way', () => {
      const now = Date.now();
      const agent = agentOf('Remote', 'a2a');
      const conv = conversationOf('general', agent);

      const only = run(agent, conv, { raw: 0, startedAt: now - HOUR, sessionId: null });
      expect(provenanceOf(only.id)).toBe('unpriced');
      expect(store.recordedUsage(now).today.find((r) => r.agentId === agent.id)?.unpricedExecutions).toBe(1);
    });
  });

  describe('chain spend limit', () => {
    it('counts unverified spend at its raw figure so it cannot under-enforce', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);

      const first = store.createExecution({
        agentId: agent.id,
        conversationId: conv,
        taskId: null,
        trigger: 'human',
        triggeredByMessageId: null,
        chainId: 'chain:x',
        chainDepth: 0,
      });
      store.recordExecutionCost({
        executionId: first.id,
        runtimeType: 'claude-code',
        agentId: agent.id,
        conversationId: conv,
        nativeSessionId: 'sess-1',
        resumeRequested: true,
        rawCostUsd: 9,
        inputTokens: 0,
        outputTokens: 0,
        turns: 1,
      });

      // The run is `baseline_only`: its measured cost is zero, but it really did
      // spend something. A ceiling must use the upper bound, not the floor, or
      // a chain could run past its budget without the limit noticing.
      expect(provenanceOf(first.id)).toBe('baseline_only');
      expect(store.chainCostUsd('chain:x')).toBeCloseTo(9);
    });

    it('fails closed when a run in the chain has no upper bound at all', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);
      const chainId = 'chain:unbounded';

      const make = (raw: number, sessionId: string | null) => {
        const created = store.createExecution({
          agentId: agent.id,
          conversationId: conv,
          taskId: null,
          trigger: 'human',
          triggeredByMessageId: null,
          chainId,
          chainDepth: 0,
        });
        store.recordExecutionCost({
          executionId: created.id,
          runtimeType: 'claude-code',
          agentId: agent.id,
          conversationId: conv,
          nativeSessionId: sessionId,
          resumeRequested: true,
          rawCostUsd: raw,
          inputTokens: 0,
          outputTokens: 0,
          turns: 1,
        });
        return created.id;
      };

      // Establish a session that has really spent, then have the next run
      // report zero. A crashed result may have spent before dying, so the
      // missing amount is bounded by nothing we hold -- reading its silent zero
      // as "nothing was spent" is exactly how a limit under-enforces.
      make(6, 'sess-1');
      expect(store.chainCostUsd(chainId)).toBeCloseTo(6);

      const crashed = make(0, 'sess-1');
      expect(provenanceOf(crashed)).toBe('ambiguous');
      expect(store.chainCostUsd(chainId)).toBe(Number.POSITIVE_INFINITY);
    });

    it('does not wedge a chain when a run failed before reaching the model', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);
      const chainId = 'chain:prestart';

      // No cost event ever arrived and the run produced no output. It most
      // likely died before the model was reached; blocking every chain that
      // contained such a run would make ordinary failures unrecoverable.
      const created = store.createExecution({
        agentId: agent.id,
        conversationId: conv,
        taskId: null,
        trigger: 'human',
        triggeredByMessageId: null,
        chainId,
        chainDepth: 0,
      });
      store.updateExecution(created.id, { state: 'failed', endedAt: Date.now() } as never);

      expect(provenanceOf(created.id)).toBe('unreported');
      expect(store.chainCostUsd(chainId)).toBe(0);
    });

    it('fails closed when a run produced output but never reported its cost', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);
      const chainId = 'chain:poststart';

      const created = store.createExecution({
        agentId: agent.id,
        conversationId: conv,
        taskId: null,
        trigger: 'human',
        triggeredByMessageId: null,
        chainId,
        chainDepth: 0,
      });
      // Output events cannot be produced before model work begins, so these are
      // affirmative evidence that something was spent -- even though no figure
      // ever arrived. Tokens cannot serve as that evidence: they are written by
      // the same event as the cost, so their absence is the same absence.
      store.appendEvent(created.id, 1, 'text', { text: 'working on it' });
      store.updateExecution(created.id, { state: 'failed', endedAt: Date.now() } as never);

      expect(provenanceOf(created.id)).toBe('unreported');
      expect(store.chainCostUsd(chainId)).toBe(Number.POSITIVE_INFINITY);
    });

    it('counts a finished run that reported nothing as unavailable, not free', () => {
      const now = Date.now();
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);

      const created = store.createExecution({
        agentId: agent.id,
        conversationId: conv,
        taskId: null,
        trigger: 'human',
        triggeredByMessageId: null,
        chainId: 'chain:c',
        chainDepth: 0,
      });
      store.updateExecution(created.id, {
        state: 'failed',
        startedAt: now - HOUR,
        endedAt: now,
      } as never);

      const today = store.recordedUsage(now).today.find((r) => r.agentId === agent.id);

      // Kept apart from the unverified count so the wording can differ: that
      // one reported a figure nothing could anchor, this one reported nothing.
      expect(today?.unavailableExecutions).toBe(1);
      expect(today?.unverifiedExecutions).toBe(0);
      expect(today?.costUsd).toBe(0);
    });

    it('still bounds a run whose figure does cover its own spend', () => {
      const agent = agentOf('Claude', 'claude-code');
      const conv = conversationOf('general', agent);
      const chainId = 'chain:bounded';

      const created = store.createExecution({
        agentId: agent.id,
        conversationId: conv,
        taskId: null,
        trigger: 'human',
        triggeredByMessageId: null,
        chainId,
        chainDepth: 0,
      });
      store.recordExecutionCost({
        executionId: created.id,
        runtimeType: 'claude-code',
        agentId: agent.id,
        conversationId: conv,
        nativeSessionId: null,
        resumeRequested: true,
        rawCostUsd: 2.5,
        inputTokens: 0,
        outputTokens: 0,
        turns: 1,
      });

      // Unidentifiable session, so the run is not claimed -- but its cumulative
      // still caps what it could have spent, so the limit has a real number to
      // work with rather than failing closed unnecessarily.
      expect(provenanceOf(created.id)).toBe('ambiguous');
      expect(store.chainCostUsd(chainId)).toBeCloseTo(2.5);
    });
  });
});

describe('recorded usage windows', () => {
  let dir: string;
  let database: OpenDbResult;
  let store: Store;
  let agent: Agent;
  let conversationId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'locrew-windows-'));
    database = openDatabase(join(dir, 'test.db'), join(process.cwd(), 'src/main/db/migrations'));
    store = new Store(database.db);
    // Codex: its figures pass through unmeasured, so these tests exercise the
    // windowing without the Claude accounting changing the arithmetic.
    agent = store.createAgent({
      name: 'Tester',
      description: '',
      runtimeType: 'codex',
      avatar: '',
      avatarColor: '#7C6CF6',
      workingDirectory: dir,
      permissions: DEFAULT_AGENT_PERMISSIONS,
      config: DEFAULT_AGENT_CONFIG,
    });
    conversationId = store.createConversation({
      kind: 'channel',
      name: 'general',
      topic: null,
      memberAgentIds: [agent.id],
      humanMemberId: LOCAL_USER_ID,
    }).id;
  });

  afterEach(() => {
    database?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function execution(
    startedAt: number,
    patch: { costUsd?: number; inputTokens?: number; outputTokens?: number; state?: 'completed' | 'failed' | 'cancelled' } = {},
  ) {
    const created = store.createExecution({
      agentId: agent.id,
      conversationId,
      taskId: null,
      trigger: 'human',
      triggeredByMessageId: null,
      chainId: `chain:${startedAt}:${Math.random()}`,
      chainDepth: 0,
    });
    store.recordExecutionCost({
      executionId: created.id,
      runtimeType: 'codex',
      agentId: agent.id,
      conversationId,
      nativeSessionId: 'thread-1',
      resumeRequested: false,
      rawCostUsd: patch.costUsd ?? 0,
      inputTokens: patch.inputTokens ?? 0,
      outputTokens: patch.outputTokens ?? 0,
      turns: 1,
    });
    store.updateExecution(created.id, {
      state: patch.state ?? 'completed',
      startedAt,
      endedAt: startedAt + 1000,
    } as never);
    return created.id;
  }

  it('counts each execution once even when many cost events landed for it', () => {
    const now = Date.now();
    const id = execution(now - HOUR, { costUsd: 1.5, inputTokens: 100, outputTokens: 50 });

    // A real run emits the running total repeatedly; every one is recorded as
    // an event. Summing those would report 0.5 + 1.0 + 1.5 for a run that
    // actually cost 1.5.
    store.appendEvent(id, 1, 'cost', { costUsd: 0.5, inputTokens: 30, outputTokens: 10 });
    store.appendEvent(id, 2, 'cost', { costUsd: 1.0, inputTokens: 60, outputTokens: 30 });
    store.appendEvent(id, 3, 'cost', { costUsd: 1.5, inputTokens: 100, outputTokens: 50 });

    const today = store.recordedUsage(now).today.find((r) => r.agentId === agent.id);

    expect(today?.costUsd).toBeCloseTo(1.5);
    expect(today?.inputTokens).toBe(100);
    expect(today?.executions).toBe(1);
  });

  it('includes failed and cancelled runs: the tokens were still spent', () => {
    const now = Date.now();
    execution(now - HOUR, { costUsd: 1, state: 'completed' });
    execution(now - 2 * HOUR, { costUsd: 2, state: 'failed' });
    execution(now - 3 * HOUR, { costUsd: 4, state: 'cancelled' });

    const today = store.recordedUsage(now).today.find((r) => r.agentId === agent.id);

    expect(today?.costUsd).toBeCloseTo(7);
    expect(today?.executions).toBe(3);
  });

  it('separates today from the trailing week at local midnight', () => {
    const now = new Date(2026, 4, 20, 15, 0, 0).getTime();
    const midnight = startOfLocalDay(now);

    execution(midnight + 60_000, { costUsd: 1 });
    execution(midnight - 60_000, { costUsd: 2 });
    execution(now - 3 * DAY, { costUsd: 4 });
    execution(now - 8 * DAY, { costUsd: 8 });

    const windows = store.recordedUsage(now);

    expect(windows.today.find((r) => r.agentId === agent.id)?.costUsd).toBeCloseTo(1);
    expect(windows.last7Days.find((r) => r.agentId === agent.id)?.costUsd).toBeCloseTo(7);
    expect(windows.todayStartedAt).toBe(midnight);
  });

  it('uses the local calendar day even across a DST change', () => {
    // 2026-03-29 is when European clocks go forward; the day is 23 hours long,
    // so subtracting a fixed 24 hours would land on the wrong boundary.
    const now = new Date(2026, 2, 29, 12, 0, 0).getTime();
    const midnight = startOfLocalDay(now);

    expect(new Date(midnight).getDate()).toBe(29);
    expect(new Date(midnight).getHours()).toBe(0);

    execution(midnight + 1000, { costUsd: 3 });
    execution(midnight - 1000, { costUsd: 5 });

    expect(store.recordedUsage(now).today.find((r) => r.agentId === agent.id)?.costUsd).toBeCloseTo(3);
  });

  it('ignores rows stamped in the future after a clock change', () => {
    const now = Date.now();
    execution(now - HOUR, { costUsd: 1 });
    execution(now + 2 * DAY, { costUsd: 99 });

    const windows = store.recordedUsage(now);

    expect(windows.today.find((r) => r.agentId === agent.id)?.costUsd).toBeCloseTo(1);
    expect(windows.last7Days.find((r) => r.agentId === agent.id)?.costUsd).toBeCloseTo(1);
  });

  it('keeps each agent separate and omits agents with nothing in the window', () => {
    const now = Date.now();
    const other = store.createAgent({
      name: 'Other',
      description: '',
      runtimeType: 'model',
      avatar: '',
      avatarColor: '#7C6CF6',
      workingDirectory: dir,
      permissions: DEFAULT_AGENT_PERMISSIONS,
      config: DEFAULT_AGENT_CONFIG,
    });

    execution(now - HOUR, { costUsd: 1, outputTokens: 10 });

    const windows = store.recordedUsage(now);

    expect(windows.today.find((r) => r.agentId === agent.id)?.outputTokens).toBe(10);
    expect(windows.today.find((r) => r.agentId === other.id)).toBeUndefined();
  });

  it('uses one accounting basis for the summary rows and the windows', () => {
    const now = Date.now();
    execution(now - HOUR, { costUsd: 2 });
    execution(now - 30 * HOUR, { costUsd: 5 });

    const summary = store.costSummary(now);

    // Two totals on one screen computed differently is a bug the user should
    // not have to notice for us.
    expect(summary.totalUsd).toBeCloseTo(7);
    expect(summary.last24hUsd).toBeCloseTo(2);
    expect(summary.byAgent.find((r) => r.agentId === agent.id)?.executions).toBe(2);
    expect(summary.windows.today.find((r) => r.agentId === agent.id)?.costUsd).toBeCloseTo(2);
  });
});

describe('legacy rows', () => {
  let dir: string;
  let database: OpenDbResult;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'locrew-legacy-'));
    database = openDatabase(join(dir, 'test.db'), join(process.cwd(), 'src/main/db/migrations'));
    store = new Store(database.db);
  });

  afterEach(() => {
    database?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never counts a pre-fix row as measured spend, and says so', () => {
    const now = Date.now();
    const agent = store.createAgent({
      name: 'Legacy',
      description: '',
      runtimeType: 'claude-code',
      avatar: '',
      avatarColor: '#7C6CF6',
      workingDirectory: dir,
      permissions: DEFAULT_AGENT_PERMISSIONS,
      config: DEFAULT_AGENT_CONFIG,
    });
    const conv = store.createConversation({
      kind: 'channel',
      name: 'general',
      topic: null,
      memberAgentIds: [agent.id],
      humanMemberId: LOCAL_USER_ID,
    }).id;

    // A row as the migration leaves it: cost recorded, provenance legacy, raw
    // back-filled from the original column.
    const created = store.createExecution({
      agentId: agent.id,
      conversationId: conv,
      taskId: null,
      trigger: 'human',
      triggeredByMessageId: null,
      chainId: 'chain:legacy',
      chainDepth: 0,
    });
    store.updateExecution(created.id, {
      costUsd: 9.41,
      rawCostUsd: 9.41,
      costProvenance: 'legacy',
      state: 'completed',
      startedAt: now - HOUR,
      endedAt: now,
    } as never);

    const today = store.recordedUsage(now).today.find((r) => r.agentId === agent.id);

    // Not summed -- that figure is a session cumulative, not this run's spend.
    expect(today?.costUsd).toBe(0);
    // ...and not silently dropped either: the UI has to be able to say so.
    expect(today?.unverifiedExecutions).toBe(1);
    expect(today?.executions).toBe(1);

    // A ceiling still has to respect it, at its upper bound.
    expect(store.chainCostUsd('chain:legacy')).toBeCloseTo(9.41);
  });
});
