/**
 * Agent activity reactions, driven through the real orchestrator.
 *
 * Most tests use the ScriptedRuntime test double, which emits exactly the
 * events a script lists -- that is what lets each assertion say "this event
 * produced that reaction". Custom agents run the real ModelAgentRuntime
 * against a mock provider and a real MCP server; external agents run the real
 * A2A runtime against the official A2A SDK server.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '../../src/shared/types.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/shared/types.js';
import { ACTIVITY_EMOJI } from '../../src/shared/activity.js';
import { AgentActivityManager } from '../../src/main/activity/manager.js';
import { ActivityStore } from '../../src/main/db/activity-store.js';
import { openDatabase } from '../../src/main/db/index.js';
import type { RuntimeEvent } from '../../src/main/runtimes/types.js';
import { lastMessage, startMockProvider, textStream, toolCallStream, type MockProvider } from '../support/mock-provider.js';
import { inputRequiredExecutor, registerExternalAgent, startRemote, taskExecutor, type RemoteAgent } from '../support/a2a-remote.js';
import { waitFor } from '../support/collect.js';
import { createChannel, createDm, createHarness, type Harness } from '../harness.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'mcp-notes-server.mjs');

let h: Harness;
let mock: MockProvider | null = null;
let remote: RemoteAgent | null = null;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.dispose();
  await mock?.close();
  await remote?.close();
  mock = null;
  remote = null;
});

/** Every distinct state this agent showed on this message, in order ("state/detail"). */
function trail(messageId: string, agentId: string): string[] {
  const seen: string[] = [];
  for (const event of h.events) {
    if (event.type !== 'activity') continue;
    const a = event.activity;
    if (a.messageId !== messageId || a.agentId !== agentId) continue;
    const label = a.detail ? `${a.state}/${a.detail}` : a.state;
    if (seen[seen.length - 1] !== label) seen.push(label);
  }
  return seen;
}

const activityOf = (messageId: string, agentId: string) => h.activityStore.getActivity(messageId, agentId);

/** A promise the test opens when it chooses, to hold a run mid-flight. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function script(agent: Agent, events: RuntimeEvent[]) {
  h.runtime.scripts.set(agent.id, () => events);
}

describe('one agent, one message', () => {
  it('shows received, reading, thinking, then completed, and keeps the final state', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    script(claude, [
      { type: 'text_delta', text: 'Looking' },
      { type: 'text', text: 'Looks fine.' },
    ]);

    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Review the auth code.');
    await h.waitForIdle();

    expect(trail(message.id, claude.id)).toEqual(['received', 'reading', 'thinking/responding', 'completed']);
    expect(activityOf(message.id, claude.id)).toMatchObject({
      state: 'completed',
      emoji: ACTIVITY_EMOJI.completed,
      active: false,
      conversationId: dm.id,
    });
  });

  it('stays received while queued behind the same agent\'s previous run', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    const hold = gate();
    let first = true;
    h.runtime.hooks.set(claude.id, async () => {
      if (first) {
        first = false;
        await hold.promise;
      }
    });

    const one = await h.orchestrator.handleHumanMessage(dm.id, 'First task.');
    const two = await h.orchestrator.handleHumanMessage(dm.id, 'Second task.');
    await waitFor(() => activityOf(one.id, claude.id)?.state === 'reading', 5000, 'first run to start');

    expect(activityOf(two.id, claude.id)).toMatchObject({ state: 'received', active: true });

    hold.open();
    await h.waitForIdle();
    expect(activityOf(one.id, claude.id)?.state).toBe('completed');
    expect(activityOf(two.id, claude.id)?.state).toBe('completed');
  });

  it('tells reasoning apart from writing the reply', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    script(claude, [
      { type: 'thinking', text: 'The token check looks off.' },
      { type: 'text_delta', text: 'The token' },
      { type: 'text', text: 'The token is never verified.' },
    ]);
    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Check it.');
    await h.waitForIdle();
    expect(trail(message.id, claude.id)).toEqual([
      'received',
      'reading',
      'thinking/reasoning',
      'thinking/responding',
      'completed',
    ]);
  });

  it('shows working while a tool runs, with its name but never its input', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    script(claude, [
      { type: 'tool_use', toolUseId: 't1', name: 'mcp__tools__files__search_files', input: { query: 'password=hunter2' } },
      { type: 'tool_result', toolUseId: 't1', summary: 'secret file contents', isError: false },
      { type: 'text', text: 'Found two issues.' },
    ]);
    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Search for security issues.');
    await h.waitForIdle();

    expect(trail(message.id, claude.id)).toEqual([
      'received',
      'reading',
      'working/mcp__tools__files__search_files',
      'thinking/responding',
      'completed',
    ]);
    const published = JSON.stringify(h.events.filter((e) => e.type === 'activity'));
    expect(published).not.toContain('hunter2');
    expect(published).not.toContain('secret file contents');
  });

  it('shows failed when the runtime reports a fatal error', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    script(claude, [
      { type: 'text_delta', text: 'Start' },
      { type: 'error', message: 'Provider unavailable', fatal: true },
    ]);
    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Go.');
    await h.waitForIdle();
    expect(activityOf(message.id, claude.id)).toMatchObject({ state: 'failed', emoji: '❌', active: false });
  });

  it('shows failed, not cancelled, when the run hits its time limit', async () => {
    await h.dispose();
    h = await createHarness({ maxTaskDurationMs: 150 });
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    h.runtime.delayMs = 3000;
    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Take your time.');
    await h.waitForIdle();
    expect(activityOf(message.id, claude.id)).toMatchObject({ state: 'failed', detail: 'timeout', active: false });
  });
});

describe('cancellation', () => {
  it('shows cancelled for a running run and for one still queued', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    const hold = gate();
    h.runtime.hooks.set(claude.id, () => hold.promise);

    const running = await h.orchestrator.handleHumanMessage(dm.id, 'Long task.');
    const queued = await h.orchestrator.handleHumanMessage(dm.id, 'Next task.');
    await waitFor(() => activityOf(running.id, claude.id)?.state === 'reading', 5000, 'run to start');

    const runningId = activityOf(running.id, claude.id)!.executionId;
    const queuedId = activityOf(queued.id, claude.id)!.executionId;
    expect(h.orchestrator.cancelExecution(queuedId)).toBe(true);
    expect(h.orchestrator.cancelExecution(runningId)).toBe(true);
    hold.open();
    await h.waitForIdle();

    expect(activityOf(running.id, claude.id)).toMatchObject({ state: 'cancelled', emoji: '🚫', active: false });
    expect(activityOf(queued.id, claude.id)).toMatchObject({ state: 'cancelled', active: false });
  });

  it('an approval answered after cancelling does not bring the run back', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    h.runtime.hooks.set(claude.id, async (ctx) => {
      const answer = ctx.requestApproval({ agentId: claude.id, executionId: ctx.executionId, toolName: 'Write', input: {} });
      h.orchestrator.cancelExecution(ctx.executionId);
      await answer;
    });
    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Write the file.');
    await h.waitForIdle();

    const record = activityOf(message.id, claude.id)!;
    expect(record).toMatchObject({ state: 'cancelled', active: false });
    expect(h.store.getExecution(record.executionId)?.state).toBe('cancelled');
    expect(trail(message.id, claude.id)).toEqual(['received', 'reading', 'waiting_for_input/approval', 'cancelled']);
  });
});

describe('several agents on one message', () => {
  it('gives each agent its own independent reaction', async () => {
    // Separate directories, so neither waits on the other's workspace lock.
    const claude = h.createAgent('Claude', { workingDirectory: join(h.dir, 'claude') });
    const codex = h.createAgent('Codex', { runtimeType: 'codex', workingDirectory: join(h.dir, 'codex') });
    const channel = createChannel(h, 'auth', [claude, codex]);
    script(claude, [{ type: 'thinking', text: 'Analysing' }, { type: 'text', text: 'Reviewed.' }]);
    h.codexRuntime.scripts.set(codex.id, () => [
      { type: 'tool_use', toolUseId: 'e1', name: 'apply_patch', input: {} },
      { type: 'text', text: 'Patched.' },
    ]);

    const message = await h.orchestrator.handleHumanMessage(channel.id, '@Claude @Codex review and improve the auth code.');
    await h.waitForIdle();

    expect(trail(message.id, claude.id)).toEqual(['received', 'reading', 'thinking/reasoning', 'thinking/responding', 'completed']);
    expect(trail(message.id, codex.id)).toEqual(['received', 'reading', 'working/apply_patch', 'thinking/responding', 'completed']);
    expect(h.activityStore.listActivities(channel.id).map((r) => r.agentId).sort()).toEqual([claude.id, codex.id].sort());
  });

  it('shows one agent done while the other is still working', async () => {
    const claude = h.createAgent('Claude', { workingDirectory: join(h.dir, 'claude') });
    const codex = h.createAgent('Codex', { runtimeType: 'codex', workingDirectory: join(h.dir, 'codex') });
    const channel = createChannel(h, 'auth', [claude, codex]);
    const hold = gate();
    h.codexRuntime.hooks.set(codex.id, () => hold.promise);
    h.codexRuntime.scripts.set(codex.id, () => [
      { type: 'tool_use', toolUseId: 'e1', name: 'shell', input: { command: 'npm test' } },
      { type: 'text', text: 'Tests pass.' },
    ]);

    const message = await h.orchestrator.handleHumanMessage(channel.id, '@Claude @Codex go.');
    await waitFor(() => activityOf(message.id, claude.id)?.state === 'completed', 5000, 'Claude to finish');

    expect(activityOf(message.id, codex.id)).toMatchObject({ state: 'reading', active: true });
    hold.open();
    await h.waitForIdle();
    expect(activityOf(message.id, codex.id)?.state).toBe('completed');
    expect(activityOf(message.id, claude.id)?.state).toBe('completed');
  });

  it('shows an agent waiting for a shared workspace while another agent holds it', async () => {
    const codex = h.createAgent('Codex', { runtimeType: 'codex' });
    const claude = h.createAgent('Claude');
    const channel = createChannel(h, 'shared', [codex, claude]);
    const hold = gate();
    h.codexRuntime.hooks.set(codex.id, () => hold.promise);

    const first = await h.orchestrator.handleHumanMessage(channel.id, '@Codex refactor the module.');
    await waitFor(() => activityOf(first.id, codex.id)?.state === 'reading', 5000, 'Codex to start');
    const second = await h.orchestrator.handleHumanMessage(channel.id, '@Claude fix the tests.');
    await waitFor(() => activityOf(second.id, claude.id)?.detail === 'workspace', 5000, 'Claude to wait');

    expect(activityOf(second.id, claude.id)).toMatchObject({ state: 'received', detail: 'workspace', active: true });
    hold.open();
    await h.waitForIdle();
    expect(trail(second.id, claude.id)).toEqual(['received', 'received/workspace', 'reading', 'thinking/responding', 'completed']);
  });

  it('keeps each conversation\'s reactions to itself', async () => {
    const claude = h.createAgent('Claude');
    const one = createChannel(h, 'one', [claude]);
    const two = createChannel(h, 'two', [claude]);
    const m1 = await h.orchestrator.handleHumanMessage(one.id, '@Claude first');
    const m2 = await h.orchestrator.handleHumanMessage(two.id, '@Claude second');
    await h.waitForIdle();

    expect(h.activityStore.listActivities(one.id).map((r) => r.messageId)).toEqual([m1.id]);
    expect(h.activityStore.listActivities(two.id).map((r) => r.messageId)).toEqual([m2.id]);
  });
});

describe('restarts and interrupted runs', () => {
  it('keeps final states across a restart', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Hello.');
    await h.waitForIdle();

    // A second connection to the same file, as the app would open after a restart.
    const reopened = openDatabase(join(h.dir, 'test.db'), join(process.cwd(), 'src/main/db/migrations'));
    try {
      const store = new ActivityStore(reopened.db);
      expect(store.getActivity(message.id, claude.id)).toMatchObject({ state: 'completed', active: false });
      const restarted = new AgentActivityManager({ store, emit: () => {} });
      expect(restarted.reconcileInterrupted()).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it('marks a run cut off by a crash as interrupted, never completed', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    const message = h.store.insertMessage({ conversationId: dm.id, senderType: 'human', senderId: 'user:local', body: 'Hi' });
    const execution = h.store.createExecution({
      agentId: claude.id,
      conversationId: dm.id,
      taskId: null,
      trigger: 'human',
      triggeredByMessageId: message.id,
      chainId: 'chain:crash',
      chainDepth: 0,
    });
    h.activity.received({ executionId: execution.id, messageId: message.id, conversationId: dm.id, agentId: claude.id });
    h.activity.signal(execution.id, { type: 'started', profile: 'detailed' });
    h.activity.signal(execution.id, { type: 'tool', name: 'Edit' });

    // The process dies here. The next launch reconciles what it finds.
    const afterRestart = new AgentActivityManager({ store: new ActivityStore(h.database.db), emit: () => {} });
    const changed = afterRestart.reconcileInterrupted();

    expect(changed.map((r) => r.state)).toEqual(['interrupted']);
    expect(activityOf(message.id, claude.id)).toMatchObject({ state: 'interrupted', emoji: '⚠️', active: false });
  });

  it('marks runs stopped by quitting the app as interrupted', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    const hold = gate();
    h.runtime.hooks.set(claude.id, () => hold.promise);
    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Long job.');
    await waitFor(() => activityOf(message.id, claude.id)?.state === 'reading', 5000, 'run to start');

    await h.orchestrator.shutdown();
    hold.open();
    await waitFor(() => activityOf(message.id, claude.id)?.active === false, 5000, 'run to stop');
    expect(activityOf(message.id, claude.id)?.state).toBe('interrupted');
  });
});

describe('history from before activity reactions', () => {
  it('backfills only the recorded final outcome of each past run', () => {
    const claude = h.createAgent('Claude');
    const codex = h.createAgent('Codex', { runtimeType: 'codex' });
    const dm = createDm(h, claude);
    const past = (agent: Agent, body: string, state: 'completed' | 'failed' | 'cancelled', error: string | null) => {
      const message = h.store.insertMessage({ conversationId: dm.id, senderType: 'human', senderId: 'user:local', body });
      const execution = h.store.createExecution({
        agentId: agent.id,
        conversationId: dm.id,
        taskId: null,
        trigger: 'human',
        triggeredByMessageId: message.id,
        chainId: `chain:${body}`,
        chainDepth: 0,
      });
      h.store.updateExecution(execution.id, { state, error, endedAt: Date.now() });
      return message;
    };
    const done = past(claude, 'done', 'completed', null);
    const broke = past(claude, 'broke', 'failed', 'Provider unavailable');
    const stopped = past(claude, 'stopped', 'cancelled', null);
    const slow = past(claude, 'slow', 'cancelled', 'The execution timed out.');
    const crashed = past(codex, 'crashed', 'failed', 'The application stopped while this execution was running.');

    const sql = readFileSync(join(process.cwd(), 'src/main/db/migrations/0003_backfill_message_activities.sql'), 'utf8');
    h.database.sqlite.exec(sql);
    h.database.sqlite.exec(sql); // idempotent

    const view = (m: { id: string }, a: Agent) => {
      const r = activityOf(m.id, a.id)!;
      return [r.state, r.emoji, r.detail, r.active];
    };
    expect(view(done, claude)).toEqual(['completed', '✅', null, false]);
    expect(view(broke, claude)).toEqual(['failed', '❌', null, false]);
    expect(view(stopped, claude)).toEqual(['cancelled', '🚫', null, false]);
    expect(view(slow, claude)).toEqual(['failed', '❌', 'timeout', false]);
    expect(view(crashed, codex)).toEqual(['interrupted', '⚠️', null, false]);
    expect(h.activityStore.listActivities(dm.id)).toHaveLength(5);
  });
});

describe('custom and external agents', () => {
  it('a custom agent on a model provider shows the states its runtime reports, including an MCP tool', async () => {
    mock = await startMockProvider((req) =>
      lastMessage(req)?.role === 'tool'
        ? textStream(`The server said: ${String(lastMessage(req)!.content)}`)
        : toolCallStream([{ id: 'c1', name: 'notes__echo', args: { text: 'ping' } }]),
    );
    const provider = h.providers.create({
      name: 'Local AI',
      preset: 'openai-compatible',
      kind: 'openai-compatible',
      category: 'openai-compatible',
      baseUrl: `${mock.url}/v1`,
      authMethod: 'none',
    });
    const agent = h.createAgent('Security Architect', {
      runtimeType: 'model',
      workingDirectory: '',
      permissions: { workspaceAccess: 'read_only', allowAgentToAgent: true, allowTaskUpdates: true, maxCostPerExecutionUsd: 0 },
      config: { ...DEFAULT_AGENT_CONFIG, providerId: provider.id, model: 'qwen3:8b' },
    });
    const server = h.mcp.create({ name: 'Notes', transport: 'stdio', command: 'node', args: [FIXTURE], timeoutMs: 20_000 });
    await h.mcp.connect(server.id, { interactive: true });
    h.integrations.setAgentGrants(agent.id, [{ serverId: server.id, toolName: 'echo', mode: 'allow' }]);
    const dm = createDm(h, agent);

    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Try the echo tool.');
    await h.waitForIdle();

    expect(trail(message.id, agent.id)).toEqual([
      'received',
      'reading',
      'working/notes__echo',
      'thinking/responding',
      'completed',
    ]);
  });

  it('an external agent shows only received, processing and done, whatever it streams', async () => {
    remote = await startRemote({ executor: taskExecutor, streaming: true });
    const agent = await registerExternalAgent(h, `${remote.baseUrl}/.well-known/agent-card.json`);
    const dm = createDm(h, agent);

    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Compare login options.');
    await h.waitForIdle();

    // The remote streamed status updates and artifact text; none of it is
    // presented as reading, thinking or tool use it never reported.
    expect(trail(message.id, agent.id)).toEqual(['received', 'processing', 'completed']);
  });

  it('an external agent that ends by asking a question shows it needs input', async () => {
    remote = await startRemote({ executor: inputRequiredExecutor, streaming: true });
    const agent = await registerExternalAgent(h, `${remote.baseUrl}/.well-known/agent-card.json`);
    const dm = createDm(h, agent);

    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Find flights.');
    await h.waitForIdle();

    const record = activityOf(message.id, agent.id)!;
    expect(record).toMatchObject({ state: 'waiting_for_input', detail: 'input', emoji: '❓', active: false });
    // The run itself finished normally; only its answer was a question.
    expect(h.store.getExecution(record.executionId)?.state).toBe('completed');
  });
});

describe('stale updates', () => {
  it('ignores updates from a run that has already finished', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Hi.');
    await h.waitForIdle();
    const record = activityOf(message.id, claude.id)!;
    const before = h.events.length;

    h.activity.signal(record.executionId, { type: 'tool', name: 'Bash' });
    h.activity.finish(record.executionId, 'failed');

    expect(h.events.length).toBe(before);
    expect(activityOf(message.id, claude.id)).toMatchObject({ state: 'completed', revision: record.revision });
  });

  it('an older run cannot overwrite a reaction a newer run has taken over', () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    const message = h.store.insertMessage({ conversationId: dm.id, senderType: 'human', senderId: 'user:local', body: 'Hi' });
    const newExecution = (chainId: string) =>
      h.store.createExecution({
        agentId: claude.id,
        conversationId: dm.id,
        taskId: null,
        trigger: 'human',
        triggeredByMessageId: message.id,
        chainId,
        chainDepth: 0,
      });
    const older = newExecution('chain:old');
    const newer = newExecution('chain:new');

    h.activity.received({ executionId: older.id, messageId: message.id, conversationId: dm.id, agentId: claude.id });
    h.activity.signal(older.id, { type: 'started', profile: 'detailed' });
    h.activity.received({ executionId: newer.id, messageId: message.id, conversationId: dm.id, agentId: claude.id });

    // The old run keeps talking; none of it lands.
    h.activity.signal(older.id, { type: 'tool', name: 'Bash' });
    h.activity.finish(older.id, 'completed');

    expect(activityOf(message.id, claude.id)).toMatchObject({ executionId: newer.id, state: 'received', active: true });
    h.activity.signal(newer.id, { type: 'started', profile: 'detailed' });
    expect(activityOf(message.id, claude.id)?.state).toBe('reading');
  });
});

describe('the user\'s own reactions', () => {
  it('are stored apart from agent activity and never wake or change an agent', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    const message = await h.orchestrator.handleHumanMessage(dm.id, 'Hi.');
    await h.waitForIdle();
    const executionsBefore = h.store.listExecutionsForConversation(dm.id).length;
    const activityBefore = activityOf(message.id, claude.id)!;

    const added = h.activityStore.toggleReaction({ messageId: message.id, conversationId: dm.id, userId: 'user:local', emoji: '👀' });
    h.activityStore.toggleReaction({ messageId: message.id, conversationId: dm.id, userId: 'user:local', emoji: '✅' });
    await h.waitForIdle();

    expect(added.map((r) => r.emoji)).toEqual(['👀']);
    expect(h.activityStore.listReactions(dm.id).map((r) => r.emoji)).toEqual(['👀', '✅']);
    expect(h.store.listExecutionsForConversation(dm.id)).toHaveLength(executionsBefore);
    expect(activityOf(message.id, claude.id)).toEqual(activityBefore);

    // Toggling removes only the user's reaction; the agent's ✅ is untouched.
    h.activityStore.toggleReaction({ messageId: message.id, conversationId: dm.id, userId: 'user:local', emoji: '✅' });
    expect(h.activityStore.listReactions(dm.id).map((r) => r.emoji)).toEqual(['👀']);
    expect(activityOf(message.id, claude.id)?.state).toBe('completed');
  });
});
