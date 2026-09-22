import type { ActivityProfile } from '../src/shared/activity.js';
import { AgentActivityManager } from '../src/main/activity/manager.js';
import { ActivityStore } from '../src/main/db/activity-store.js';
import { ImageAttachmentStore } from '../src/main/attachments/images.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppEvent } from '../src/shared/ipc.js';
import type { Agent, AppSettings, ExecutionLimits, RuntimeType } from '../src/shared/types.js';
import {
  DEFAULT_AGENT_CONFIG,
  DEFAULT_AGENT_PERMISSIONS,
  DEFAULT_LIMITS,
} from '../src/shared/types.js';
import { openDatabase, type OpenDbResult } from '../src/main/db/index.js';
import { IntegrationStore } from '../src/main/db/integration-store.js';
import { Store } from '../src/main/db/store.js';
import { GatewayServer } from '../src/main/gateway/server.js';
import { McpClientManager, type LaunchApprovalRequest } from '../src/main/mcp/manager.js';
import { ToolAccessService } from '../src/main/mcp/tool-access.js';
import { Orchestrator } from '../src/main/orchestrator/orchestrator.js';
import { ProviderRegistry } from '../src/main/providers/registry.js';
import { A2ARuntime } from '../src/main/runtimes/a2a.js';
import { ModelAgentRuntime } from '../src/main/runtimes/model-agent.js';
import { SecretStore, type SecretCipher } from '../src/main/security/secrets.js';
import type {
  AgentRuntime,
  ApprovalDecision,
  ApprovalRequest,
  RuntimeEvent,
  RuntimeExecuteContext,
} from '../src/main/runtimes/types.js';
import { WorkspaceLockManager } from '../src/main/workspace/locks.js';

/**
 * A scripted runtime adapter.
 *
 * THIS IS A TEST DOUBLE, NOT AN AGENT. It never calls a model. It exists so the
 * orchestrator's queueing, limits, locking and cancellation can be tested
 * deterministically. Tests that exercise the real Claude Code and Codex
 * runtimes live in tests/integration/live-runtimes.test.ts and are skipped
 * unless those CLIs are installed and authenticated.
 */
export class ScriptedRuntime implements AgentRuntime {
  readonly runtimeType: RuntimeType;
  /** What activity this fake can report; tests of external agents set `basic`. */
  activityProfile: ActivityProfile = 'detailed';
  /** Per-agent scripts: what this fake should emit when that agent runs. */
  readonly scripts = new Map<string, (ctx: RuntimeExecuteContext) => RuntimeEvent[]>();
  /** Every context the orchestrator handed over, for assertions. */
  readonly calls: RuntimeExecuteContext[] = [];
  /**
   * Per-agent side effects run *during* an execution, while the orchestrator
   * still has an active context for that agent. This is how a test reproduces
   * an agent calling the send_message gateway tool mid-turn, which is the only
   * way a real agent-to-agent chain is formed.
   */
  readonly hooks = new Map<string, (ctx: RuntimeExecuteContext) => Promise<void>>();
  /** Milliseconds each execution should take. */
  delayMs = 0;

  constructor(runtimeType: RuntimeType = 'claude-code') {
    this.runtimeType = runtimeType;
  }

  async detectInstall() {
    return {
      installed: true,
      version: 'scripted-1.0.0',
      location: 'test double',
      message: 'Scripted test runtime.',
    };
  }

  async detect() {
    return {
      runtimeType: this.runtimeType,
      installed: true,
      version: 'scripted-1.0.0',
      location: 'test double',
      authenticated: true,
      message: 'Scripted test runtime.',
    };
  }

  async *execute(ctx: RuntimeExecuteContext): AsyncIterable<RuntimeEvent> {
    this.calls.push(ctx);

    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.delayMs);
        ctx.abortSignal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    if (ctx.abortSignal.aborted) return;

    const hook = this.hooks.get(ctx.agent.id);
    if (hook) await hook(ctx);

    if (ctx.abortSignal.aborted) return;

    const script = this.scripts.get(ctx.agent.id);
    const events = script
      ? script(ctx)
      : ([
          { type: 'session', sessionId: `session-for-${ctx.agent.id}` },
          { type: 'text', text: `${ctx.agent.name} acknowledges.` },
          { type: 'cost', costUsd: 0.01, inputTokens: 100, outputTokens: 20 },
        ] as RuntimeEvent[]);

    for (const event of events) {
      if (ctx.abortSignal.aborted) return;
      yield event;
    }
  }

  async dispose() {}
}

/**
 * A reversible stand-in for the OS keychain, so tests can prove that what
 * lands in the database is not the plaintext. NOT encryption.
 */
export const testCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (plaintext) => Buffer.from(`sealed:${Buffer.from(plaintext, 'utf8').toString('hex')}`, 'utf8'),
  decrypt: (ciphertext) => {
    const text = ciphertext.toString('utf8');
    if (!text.startsWith('sealed:')) throw new Error('not sealed');
    return Buffer.from(text.slice('sealed:'.length), 'hex').toString('utf8');
  },
};

export interface Harness {
  store: Store;
  attachments: ImageAttachmentStore;
  activityStore: ActivityStore;
  activity: AgentActivityManager;
  integrations: IntegrationStore;
  secrets: SecretStore;
  providers: ProviderRegistry;
  mcp: McpClientManager;
  toolAccess: ToolAccessService;
  /** Launch requests the MCP manager asked the "user" to approve. */
  launchRequests: LaunchApprovalRequest[];
  /** What the "user" answers to a stdio launch request. */
  approveLaunches: boolean;
  database: OpenDbResult;
  dir: string;
  orchestrator: Orchestrator;
  gateway: GatewayServer;
  locks: WorkspaceLockManager;
  runtime: ScriptedRuntime;
  codexRuntime: ScriptedRuntime;
  events: AppEvent[];
  settings: AppSettings;
  approvals: ApprovalRequest[];
  approvalAnswer: ApprovalDecision;
  createAgent(name: string, overrides?: Partial<Agent>): Agent;
  waitForIdle(timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

export async function createHarness(limits?: Partial<ExecutionLimits>): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'locrew-test-'));
  const database: OpenDbResult = openDatabase(
    join(dir, 'test.db'),
    join(process.cwd(), 'src/main/db/migrations'),
  );

  const store = new Store(database.db);
  const locks = new WorkspaceLockManager();
  const events: AppEvent[] = [];
  const activityStore = new ActivityStore(database.db);
  const attachments = new ImageAttachmentStore(join(dir, 'attachments'), store);
  const activity = new AgentActivityManager({ store: activityStore, emit: (event) => events.push(event) });

  const settings: AppSettings = {
    defaultWorkspaceDirectory: dir,
    limits: { ...DEFAULT_LIMITS, ...limits },
    notifyOnAgentReply: false,
    notifyOnLimitReached: true,
    developerMode: false,
  };

  const runtime = new ScriptedRuntime('claude-code');
  const codexRuntime = new ScriptedRuntime('codex');

  const harness: Partial<Harness> = {
    approvals: [],
    approvalAnswer: { approved: true },
    launchRequests: [],
    approveLaunches: true,
  };

  let orchestrator!: Orchestrator;

  const integrations = new IntegrationStore(database.db);
  const secrets = new SecretStore(database.db, testCipher);
  const providers = new ProviderRegistry({
    integrations,
    secrets,
    emit: (event) => events.push(event),
    agentsUsing: (providerId) =>
      store
        .listAgents()
        .filter((a) => a.config.providerId === providerId)
        .map((a) => a.name),
  });
  const mcp = new McpClientManager({
    integrations,
    secrets,
    emit: (event) => events.push(event),
    approveLaunch: async (request) => {
      harness.launchRequests!.push(request);
      return harness.approveLaunches!;
    },
  });
  const toolAccess = new ToolAccessService({
    integrations,
    manager: mcp,
    requestApproval: (agentId, request) => orchestrator.requestToolApproval(agentId, request),
    signalFor: (agentId) => orchestrator.signalFor(agentId),
    agentName: (agentId) => store.getAgent(agentId)?.name ?? agentId,
  });

  const gateway = new GatewayServer({
    getActiveContext: (id) => orchestrator.getActiveContext(id),
    getAgent: (id) => orchestrator.getAgent(id),
    isMember: (c, a) => orchestrator.isMember(c, a),
    listMembers: (c) => orchestrator.listMembers(c),
    readMessages: (c, l) => orchestrator.readMessages(c, l),
    getConversationContext: (c) => orchestrator.getConversationContext(c),
    sendAgentMessage: (i) => orchestrator.sendAgentMessage(i),
    updateTask: (i) => orchestrator.updateTask(i),
    tools: toolAccess,
  });
  await gateway.start();

  orchestrator = new Orchestrator({
    store,
    gateway,
    runtimes: new Map<RuntimeType, AgentRuntime>([
      ['claude-code', runtime],
      ['codex', codexRuntime],
      ['model', new ModelAgentRuntime(providers)],
      ['a2a', new A2ARuntime(secrets)],
    ]),
    locks,
    emit: (event) => events.push(event),
    requestApproval: async (request) => {
      harness.approvals!.push(request);
      return harness.approvalAnswer!;
    },
    getSettings: () => settings,
    activity,
    attachments,
  });

  const result: Harness = {
    store,
    attachments,
    activityStore,
    activity,
    integrations,
    secrets,
    providers,
    mcp,
    toolAccess,
    launchRequests: harness.launchRequests!,
    approveLaunches: true,
    database,
    dir,
    orchestrator,
    gateway,
    locks,
    runtime,
    codexRuntime,
    events,
    settings,
    approvals: harness.approvals!,
    approvalAnswer: harness.approvalAnswer!,

    createAgent(name, overrides) {
      return store.createAgent({
        name,
        description: overrides?.description ?? '',
        runtimeType: overrides?.runtimeType ?? 'claude-code',
        avatar: '',
        avatarColor: '#7C6CF6',
        workingDirectory: overrides?.workingDirectory ?? dir,
        permissions: { ...DEFAULT_AGENT_PERMISSIONS, ...overrides?.permissions },
        config: { ...DEFAULT_AGENT_CONFIG, ...overrides?.config },
      });
    },

    async waitForIdle(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      // Give already-scheduled microtasks a chance to enqueue work first.
      await new Promise((r) => setTimeout(r, 15));
      while (Date.now() < deadline) {
        const snapshot = orchestrator.snapshot();
        if (!snapshot.running.length && !snapshot.queued.length) {
          await new Promise((r) => setTimeout(r, 25));
          const again = orchestrator.snapshot();
          if (!again.running.length && !again.queued.length) return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('Timed out waiting for the orchestrator to go idle.');
    },

    async dispose() {
      await orchestrator.shutdown();
      await mcp.shutdown();
      await gateway.stop();
      database.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };

  // Keep the mutable approval answer reachable through the harness object.
  Object.defineProperty(result, 'approvalAnswer', {
    get: () => harness.approvalAnswer!,
    set: (value: ApprovalDecision) => {
      harness.approvalAnswer = value;
    },
  });
  Object.defineProperty(result, 'approveLaunches', {
    get: () => harness.approveLaunches!,
    set: (value: boolean) => {
      harness.approveLaunches = value;
    },
  });

  return result;
}

/** Convenience: a channel containing the given agents plus the human. */
export function createChannel(harness: Harness, name: string, agents: Agent[]) {
  return harness.store.createConversation({
    kind: 'channel',
    name,
    topic: null,
    memberAgentIds: agents.map((a) => a.id),
    humanMemberId: 'user:local',
  });
}

export function createDm(harness: Harness, agent: Agent) {
  return harness.store.createConversation({
    kind: 'dm',
    name: agent.name,
    topic: null,
    memberAgentIds: [agent.id],
    humanMemberId: 'user:local',
  });
}
