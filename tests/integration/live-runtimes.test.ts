/**
 * LIVE tests against the real Claude Code and Codex runtimes.
 *
 * Nothing here is mocked: these spawn the user's actual CLI, use their actual
 * login, and cost real usage credit. They are skipped automatically when a
 * runtime is missing or not signed in, so the default `npm test` run stays
 * free and offline.
 *
 * Run them explicitly with:  LOCREW_LIVE=1 npx vitest run tests/integration/live-runtimes.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeDetection, RuntimeType } from '../../src/shared/types.js';
import { ClaudeCodeAdapter } from '../../src/main/runtimes/claude-code.js';
import { CodexAdapter } from '../../src/main/runtimes/codex.js';
import type { AgentRuntime } from '../../src/main/runtimes/types.js';
import { createChannel, createDm, createHarness, type Harness } from '../harness.js';

const LIVE = process.env['LOCREW_LIVE'] === '1';

const detections = new Map<RuntimeType, RuntimeDetection>();

// Detection runs at module scope, not in beforeAll: `skipIf` conditions are
// evaluated while the file is being collected, so a hook would run too late and
// every live test would skip even on a working install.
if (LIVE) {
  detections.set('claude-code', await new ClaudeCodeAdapter().detect());
  detections.set('codex', await new CodexAdapter().detect());
}

function ready(runtime: RuntimeType): boolean {
  const detection = detections.get(runtime);
  return Boolean(detection?.installed && detection.authenticated);
}

/** Replaces the harness's scripted double with the real adapter. */
async function liveHarness(runtime: RuntimeType): Promise<Harness> {
  const h = await createHarness({ maxConcurrentExecutions: 2 });
  const real: AgentRuntime =
    runtime === 'claude-code' ? new ClaudeCodeAdapter() : new CodexAdapter();
  // The orchestrator holds the map by reference, so replacing the entry here
  // makes subsequent executions use the real runtime.
  (h.orchestrator as unknown as { deps: { runtimes: Map<RuntimeType, AgentRuntime> } }).deps.runtimes.set(
    runtime,
    real,
  );
  return h;
}

describe.skipIf(!LIVE)('live runtime detection', () => {
  it('reports Claude Code install and auth state', async () => {
    const detection = detections.get('claude-code');
    expect(detection).toBeDefined();
    console.log('[live] claude-code:', JSON.stringify(detection, null, 2));
    expect(typeof detection?.installed).toBe('boolean');
  });

  it('reports Codex install and auth state', async () => {
    const detection = detections.get('codex');
    expect(detection).toBeDefined();
    console.log('[live] codex:', JSON.stringify(detection, null, 2));
    expect(typeof detection?.installed).toBe('boolean');
  });
});

describe.skipIf(!LIVE)('live Claude Code', () => {
  let h: Harness;

  beforeAll(async () => {
    if (!ready('claude-code')) return;
    h = await liveHarness('claude-code');
  }, 60_000);

  afterAll(async () => {
    await h?.dispose();
  });

  it.skipIf(!LIVE || !ready('claude-code'))(
    'answers a direct message with real model output',
    async () => {
      const agent = h.createAgent('Claude', {
        config: { autoCompact: true, maxTurnsPerExecution: 3, timeoutMs: 180_000 },
        permissions: {
          workspaceAccess: 'read_only',
          allowAgentToAgent: true,
          allowTaskUpdates: true,
          maxCostPerExecutionUsd: 0.5,
        },
      });
      const dm = createDm(h, agent);

      await h.orchestrator.handleHumanMessage(
        dm.id,
        'Reply with exactly the word ACKNOWLEDGED and nothing else. Do not use any tools.',
      );
      await h.waitForIdle(180_000);

      const messages = h.store.listMessages(dm.id);
      const reply = messages.find((m) => m.senderType === 'agent' && m.kind === 'chat');

      console.log('[live] claude reply:', reply?.body);
      expect(reply).toBeDefined();
      expect(reply!.body.toUpperCase()).toContain('ACKNOWLEDGED');

      const [execution] = h.store.listExecutionsForConversation(dm.id);
      expect(execution?.state).toBe('completed');
      // A real run reports real spend.
      expect(execution!.costUsd).toBeGreaterThan(0);
      console.log('[live] execution cost: $', execution!.costUsd);
    },
    240_000,
  );

  it.skipIf(!LIVE || !ready('claude-code'))(
    'persists and resumes the native session id',
    async () => {
      const agent = h.createAgent('ClaudeSession', {
        config: { autoCompact: true, maxTurnsPerExecution: 2, timeoutMs: 180_000 },
        permissions: {
          workspaceAccess: 'read_only',
          allowAgentToAgent: false,
          allowTaskUpdates: false,
          maxCostPerExecutionUsd: 0.5,
        },
      });
      const dm = createDm(h, agent);

      await h.orchestrator.handleHumanMessage(dm.id, 'Say OK. No tools.');
      await h.waitForIdle(180_000);

      const sessionId = h.store.getRuntimeSessionId(agent.id, dm.id);
      console.log('[live] stored session id:', sessionId);
      expect(sessionId).toBeTruthy();
      // Claude Code session ids are UUIDs.
      expect(sessionId).toMatch(/^[0-9a-f-]{16,}$/i);
    },
    240_000,
  );

  it.skipIf(!LIVE || !ready('claude-code'))(
    'routes a real write through the human approval gate',
    async () => {
      const agent = h.createAgent('ClaudeApproval', {
        config: { autoCompact: true, maxTurnsPerExecution: 4, timeoutMs: 180_000 },
        permissions: {
          workspaceAccess: 'approval_required',
          allowAgentToAgent: false,
          allowTaskUpdates: false,
          maxCostPerExecutionUsd: 1,
        },
      });
      const dm = createDm(h, agent);

      // Deny it, so nothing is actually written to disk by this test.
      h.approvalAnswer = { approved: false, reason: 'Denied by the test.' };
      const before = h.approvals.length;

      await h.orchestrator.handleHumanMessage(
        dm.id,
        'Create a file called approval-probe.txt in the working directory containing the word hello. Use the Write tool.',
      );
      await h.waitForIdle(240_000);

      const requests = h.approvals.slice(before);
      console.log(
        '[live] approval requests seen:',
        requests.map((r) => r.toolName),
      );

      // The gate must fire for a mutating tool before anything touches disk.
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.some((r) => ['Write', 'Edit', 'Bash'].includes(r.toolName))).toBe(true);

      const { existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      expect(existsSync(join(agent.workingDirectory, 'approval-probe.txt'))).toBe(false);
    },
    300_000,
  );

  it.skipIf(!LIVE || !ready('claude-code'))(
    'calls the MCP gateway tools from a real model',
    async () => {
      const claude = h.createAgent('ClaudeGateway', {
        config: { autoCompact: true, maxTurnsPerExecution: 6, timeoutMs: 240_000 },
        permissions: {
          workspaceAccess: 'read_only',
          allowAgentToAgent: true,
          allowTaskUpdates: true,
          maxCostPerExecutionUsd: 1,
        },
      });
      const peer = h.createAgent('PeerAgent', { runtimeType: 'codex' });
      const channel = createChannel(h, 'gateway-check', [claude, peer]);

      await h.orchestrator.handleHumanMessage(
        channel.id,
        '@ClaudeGateway Use the list_channel_members tool right now and then tell me, in one short sentence, how many participants are in this channel.',
      );
      await h.waitForIdle(300_000);

      const events = h.store
        .listExecutionsForConversation(channel.id)
        .flatMap((execution) => h.store.listEvents(execution.id));

      const toolCalls = events
        .filter((e) => e.type === 'tool_use')
        .map((e) => String(e.payload['name']));

      console.log('[live] tools the model actually called:', toolCalls);
      expect(toolCalls.some((name) => name.includes('list_channel_members'))).toBe(true);
    },
    360_000,
  );
});

describe.skipIf(!LIVE)('live Codex', () => {
  it.skipIf(!LIVE || !ready('codex'))(
    'answers a direct message with real model output',
    async () => {
      const h = await liveHarness('codex');
      try {
        const agent = h.createAgent('Codex', {
          runtimeType: 'codex',
          config: { autoCompact: true, maxTurnsPerExecution: 3, timeoutMs: 180_000 },
          permissions: {
            workspaceAccess: 'read_only',
            allowAgentToAgent: true,
            allowTaskUpdates: true,
            maxCostPerExecutionUsd: 0.5,
          },
        });
        const dm = createDm(h, agent);

        await h.orchestrator.handleHumanMessage(
          dm.id,
          'Reply with exactly the word ACKNOWLEDGED and nothing else.',
        );
        await h.waitForIdle(180_000);

        const reply = h.store
          .listMessages(dm.id)
          .find((m) => m.senderType === 'agent' && m.kind === 'chat');

        console.log('[live] codex reply:', reply?.body);
        expect(reply?.body.toUpperCase()).toContain('ACKNOWLEDGED');
      } finally {
        await h.dispose();
      }
    },
    240_000,
  );

  // Every gateway tool that changes something is annotated readOnlyHint:false,
  // and Codex refuses those without an approval it has no way to ask for. A
  // Codex agent could read the whole deck and never answer on it, so this
  // asserts the write path end to end rather than just that a reply came back.
  it.skipIf(!LIVE || !ready('codex'))(
    'posts through the gateway instead of being blocked on approval',
    async () => {
      const h = await liveHarness('codex');
      try {
        const codexAgent = h.createAgent('CodexSender', {
          runtimeType: 'codex',
          config: { autoCompact: true, maxTurnsPerExecution: 6, timeoutMs: 240_000 },
          permissions: {
            workspaceAccess: 'read_only',
            allowAgentToAgent: true,
            allowTaskUpdates: true,
            maxCostPerExecutionUsd: 1,
          },
        });
        const peer = h.createAgent('PeerHand', {
          permissions: {
            workspaceAccess: 'read_only',
            allowAgentToAgent: true,
            allowTaskUpdates: false,
            maxCostPerExecutionUsd: 1,
          },
        });
        const channel = createChannel(h, 'codex-send-check', [codexAgent, peer]);

        await h.orchestrator.handleHumanMessage(
          channel.id,
          `@CodexSender Use the send_message tool to post "RELAY OK" to this channel, addressed to agent id ${peer.id}. Use the tool -- do not just write the words in your reply.`,
        );
        await h.waitForIdle(300_000);

        const events = h.store
          .listExecutionsForConversation(channel.id)
          .flatMap((execution) => h.store.listEvents(execution.id));

        const sendCalls = events.filter(
          (e) => e.type === 'tool_use' && String(e.payload['name']).includes('send_message'),
        );
        console.log('[live] codex send_message calls:', sendCalls.length);
        expect(sendCalls.length).toBeGreaterThan(0);

        const callIds = new Set(sendCalls.map((e) => String(e.payload['toolUseId'])));
        const results = events.filter(
          (e) => e.type === 'tool_result' && callIds.has(String(e.payload['toolUseId'])),
        );
        for (const result of results) {
          console.log('[live] send_message result:', JSON.stringify(result.payload).slice(0, 200));
        }

        // The exact failure this guards against, named so a regression is obvious.
        const approvalBlocked = results.some((e) =>
          String(e.payload['summary'] ?? '').includes('requires approval'),
        );
        expect(approvalBlocked, 'Codex was blocked on an approval it cannot be asked for').toBe(
          false,
        );

        expect(results.length).toBeGreaterThan(0);
        expect(results.some((e) => e.payload['isError'] !== true)).toBe(true);

        // And the message really landed in the conversation.
        const posted = h.store
          .listMessages(channel.id)
          .filter((m) => m.senderType === 'agent' && m.senderId === codexAgent.id);
        console.log('[live] messages from the Codex agent:', posted.length);
        expect(posted.length).toBeGreaterThan(0);
      } finally {
        await h.dispose();
      }
    },
    360_000,
  );
});
