/**
 * Work sessions: temporary write access, driven through the real orchestrator.
 *
 * The rule under test is that an agent set to "ask first" stops for approval
 * on every write, unless a session covers it -- and that a session never
 * touches a read-only agent or an MCP tool grant.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '../../src/shared/types.js';
import { createDm, createHarness, type Harness } from '../harness.js';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.dispose();
});

/** Makes the agent ask for approval once, the way a real write does. */
function scriptOneWrite(agent: Agent): void {
  h.runtime.hooks.set(agent.id, async (ctx) => {
    const decision = await ctx.requestApproval({
      agentId: agent.id,
      executionId: ctx.executionId,
      toolName: 'Write',
      input: { file_path: join(ctx.workingDirectory, 'notes.md') },
      kind: 'workspace',
    });
    decisions.push(decision.approved);
  });
}

let decisions: boolean[] = [];
beforeEach(() => {
  decisions = [];
});

/** The access level the runtime was actually given for this agent's last run. */
const lastAccess = (agent: Agent) =>
  h.runtime.calls.filter((call) => call.agent.id === agent.id).at(-1)?.workspaceAccess;

describe('without a work session', () => {
  it('asks the operator for every write', async () => {
    const agent = h.createAgent('Builder');
    scriptOneWrite(agent);
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Write the notes file.');
    await h.waitForIdle();

    expect(lastAccess(agent)).toBe('approval_required');
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ toolName: 'Write', kind: 'workspace' });
    expect(decisions).toEqual([true]);
  });
});

describe('with a work session open', () => {
  it('runs the agent as read/write, so nothing is asked', async () => {
    const agent = h.createAgent('Builder');
    scriptOneWrite(agent);
    h.sessionAccess.grant({ scope: 'agent', agent, durationMs: null });
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Write the notes file.');
    await h.waitForIdle();

    expect(lastAccess(agent)).toBe('read_write');
    expect(h.approvals).toHaveLength(0);
    expect(decisions).toEqual([true]);
  });

  it('covers a run that was already going when the session opened', async () => {
    const agent = h.createAgent('Builder');
    h.runtime.hooks.set(agent.id, async (ctx) => {
      // The run started under "ask first"; the operator opens a session from
      // the approval dialog, and the rest of the run stops asking.
      const first = await ctx.requestApproval({
        agentId: agent.id,
        executionId: ctx.executionId,
        toolName: 'Write',
        input: {},
        kind: 'workspace',
      });
      decisions.push(first.approved);
      h.sessionAccess.grant({ scope: 'agent', agent, durationMs: null });
      const second = await ctx.requestApproval({
        agentId: agent.id,
        executionId: ctx.executionId,
        toolName: 'Edit',
        input: {},
        kind: 'workspace',
      });
      decisions.push(second.approved);
    });
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Write, then edit.');
    await h.waitForIdle();

    expect(decisions).toEqual([true, true]);
    // Only the first write reached the operator.
    expect(h.approvals.map((a) => a.toolName)).toEqual(['Write']);
  });

  it('covers every agent in the directory when granted that way', async () => {
    const shared = join(h.dir, 'shared');
    const one = h.createAgent('Builder', { workingDirectory: shared });
    const two = h.createAgent('Reviewer', { workingDirectory: join(shared, 'packages', 'api') });
    const elsewhere = h.createAgent('Outsider', { workingDirectory: join(h.dir, 'elsewhere') });
    h.sessionAccess.grant({ scope: 'directory', agent: one, durationMs: null });

    for (const agent of [one, two, elsewhere]) {
      const dm = createDm(h, agent);
      await h.orchestrator.handleHumanMessage(dm.id, 'Do the work.');
      await h.waitForIdle();
    }

    expect(lastAccess(one)).toBe('read_write');
    expect(lastAccess(two)).toBe('read_write');
    expect(lastAccess(elsewhere)).toBe('approval_required');
  });

  it('stops covering the agent once it is revoked', async () => {
    const agent = h.createAgent('Builder');
    scriptOneWrite(agent);
    const granted = h.sessionAccess.grant({ scope: 'agent', agent, durationMs: null });
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'First.');
    await h.waitForIdle();
    expect(h.approvals).toHaveLength(0);

    h.sessionAccess.revoke(granted.id);
    await h.orchestrator.handleHumanMessage(dm.id, 'Second.');
    await h.waitForIdle();

    expect(lastAccess(agent)).toBe('approval_required');
    expect(h.approvals).toHaveLength(1);
  });

  it('leaves a read-only agent read-only', async () => {
    const agent = h.createAgent('Reader', {
      permissions: { workspaceAccess: 'read_only', allowAgentToAgent: true, allowTaskUpdates: true, maxCostPerExecutionUsd: 2 },
    });
    // A session can only be opened through the manager, which the IPC handler
    // refuses for a read-only agent; even so, coverage never raises one.
    h.sessionAccess.grant({ scope: 'agent', agent, durationMs: null });
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Have a look.');
    await h.waitForIdle();

    expect(lastAccess(agent)).toBe('read_only');
  });

  it('still asks before an MCP tool call', async () => {
    const agent = h.createAgent('Builder');
    h.sessionAccess.grant({ scope: 'agent', agent, durationMs: null });
    h.runtime.hooks.set(agent.id, async () => {
      const decision = await h.orchestrator.requestToolApproval(agent.id, {
        toolName: 'notes → append',
        input: { text: 'hello' },
      });
      decisions.push(decision.approved);
    });
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Append a note.');
    await h.waitForIdle();

    expect(decisions).toEqual([true]);
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ toolName: 'notes → append', kind: 'tool' });
  });

  it('lapses on its own when the time is up', async () => {
    const agent = h.createAgent('Builder');
    scriptOneWrite(agent);
    h.sessionAccess.grant({ scope: 'agent', agent, durationMs: 60_000 }, Date.now() - 61_000);
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Write the notes file.');
    await h.waitForIdle();

    expect(lastAccess(agent)).toBe('approval_required');
    expect(h.approvals).toHaveLength(1);
    expect(h.sessionAccess.list()).toHaveLength(0);
  });
});
