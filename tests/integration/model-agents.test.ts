/**
 * Custom model agents in real conversations: the orchestrator, gateway, tool
 * proxy, MCP client and ModelAgentRuntime all run for real; only the model is
 * a scripted mock (tests/support/mock-provider.ts) that answers over HTTP in
 * OpenAI Chat Completions format.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '../../src/shared/types.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/shared/types.js';
import { IntegrationStore } from '../../src/main/db/integration-store.js';
import { openDatabase } from '../../src/main/db/index.js';
import { Store } from '../../src/main/db/store.js';
import { SecretStore } from '../../src/main/security/secrets.js';
import {
  chatRequests,
  lastMessage,
  startMockProvider,
  textStream,
  toolCallStream,
  type MockProvider,
  type RecordedRequest,
} from '../support/mock-provider.js';
import { createChannel, createDm, createHarness, testCipher, type Harness } from '../harness.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'mcp-notes-server.mjs');

let h: Harness;
let mock: MockProvider;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.dispose();
  await mock?.close();
});

function addProvider(name = 'Local AI') {
  return h.providers.create({
    name,
    preset: 'openai-compatible',
    kind: 'openai-compatible',
    category: 'openai-compatible',
    baseUrl: `${mock.url}/v1`,
    authMethod: 'none',
  });
}

function addModelAgent(name: string, providerId: string, extra: Partial<Agent['config']> = {}, description = '') {
  return h.createAgent(name, {
    runtimeType: 'model',
    description,
    workingDirectory: '',
    permissions: { workspaceAccess: 'read_only', allowAgentToAgent: true, allowTaskUpdates: true, maxCostPerExecutionUsd: 0 },
    config: { ...DEFAULT_AGENT_CONFIG, providerId, model: 'qwen3:8b', ...extra },
  });
}

const toolNames = (request: RecordedRequest) =>
  ((request.body?.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);

const agentReplies = (conversationId: string, agentId: string) =>
  h.store.listMessages(conversationId, 100).filter((m) => m.senderId === agentId && m.kind === 'chat');

describe('creating and talking to a custom agent', () => {
  it('answers in a DM with its own identity and instructions', async () => {
    mock = await startMockProvider(() => textStream('Here are the main security risks.'));
    const provider = addProvider();
    const architect = addModelAgent(
      'Security Architect',
      provider.id,
      { systemPromptAppend: 'You are an experienced cybersecurity architect.', temperature: 0.2, maxOutputTokens: 800 },
      'Reviews designs for security risks',
    );
    const dm = createDm(h, architect);

    await h.orchestrator.handleHumanMessage(dm.id, 'Review the login flow.');
    await h.waitForIdle();

    expect(agentReplies(dm.id, architect.id).map((m) => m.body)).toEqual(['Here are the main security risks.']);

    const request = chatRequests(mock)[0]!;
    const system = (request.body?.messages as Array<{ role: string; content: string }>)[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('You are "Security Architect"');
    expect(system.content).toContain('Reviews designs for security risks');
    expect(system.content).toContain('experienced cybersecurity architect');
    expect(system.content).toMatch(/untrusted data/);
    expect(request.body).toMatchObject({ model: 'qwen3:8b', temperature: 0.2, max_tokens: 800, stream: true });
    expect(lastMessage(request)).toMatchObject({ role: 'user', content: '[Human operator → you]: Review the login flow.' });

    const execution = h.store.listExecutionsForConversation(dm.id)[0]!;
    expect(execution).toMatchObject({ state: 'completed', inputTokens: 12, outputTokens: 7, turns: 1 });
    expect(h.store.getAgent(architect.id)!.status).toBe('online');
  });

  it('keeps separate identities for several agents on the same model', async () => {
    mock = await startMockProvider((req) => {
      const system = (req.body?.messages as Array<{ content: string }>)[0]!.content;
      return textStream(system.includes('"Product Manager"') ? 'PM here.' : 'Frontend here.');
    });
    const provider = addProvider();
    const pm = addModelAgent('Product Manager', provider.id);
    const fe = addModelAgent('Frontend Developer', provider.id);
    const channel = createChannel(h, 'development', [pm, fe]);

    await h.orchestrator.handleHumanMessage(channel.id, '@ProductManager and @FrontendDeveloper, introduce yourselves.');
    await h.waitForIdle();

    expect(agentReplies(channel.id, pm.id)[0]!.body).toBe('PM here.');
    expect(agentReplies(channel.id, fe.id)[0]!.body).toBe('Frontend here.');
  });

  it('carries the conversation history into the next turn', async () => {
    mock = await startMockProvider(() => textStream('Noted.'));
    const provider = addProvider();
    const agent = addModelAgent('Scribe', provider.id);
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'First point.');
    await h.waitForIdle();
    await h.orchestrator.handleHumanMessage(dm.id, 'Second point.');
    await h.waitForIdle();

    const messages = chatRequests(mock)[1]!.body?.messages as Array<{ role: string; content: string }>;
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: '[Human operator → you]: First point.' },
      { role: 'assistant', content: 'Noted.' },
      { role: 'user', content: '[Human operator → you]: Second point.' },
    ]);
  });
});

describe('custom agents in channels with other runtimes', () => {
  it('replies only when mentioned, next to a CLI agent', async () => {
    mock = await startMockProvider(() => textStream('Research summary: three options.'));
    const provider = addProvider();
    const claude = h.createAgent('Claude');
    const research = addModelAgent('Research Agent', provider.id);
    const channel = createChannel(h, 'development', [claude, research]);

    await h.orchestrator.handleHumanMessage(channel.id, '@Claude please look at the diff.');
    await h.waitForIdle();
    expect(chatRequests(mock)).toHaveLength(0);

    await h.orchestrator.handleHumanMessage(channel.id, '@ResearchAgent Research the available authentication solutions.');
    await h.waitForIdle();
    expect(agentReplies(channel.id, research.id).map((m) => m.body)).toEqual(['Research summary: three options.']);

    // It saw what Claude said, labelled with Claude's name.
    const messages = chatRequests(mock)[0]!.body?.messages as Array<{ content: string }>;
    expect(messages.map((m) => m.content).join('\n')).toContain('[Claude]: Claude acknowledges.');
  });

  it('hands work to an agent on a different runtime through send_message', async () => {
    const claude = h.createAgent('Claude');
    mock = await startMockProvider((req) =>
      lastMessage(req)?.role === 'tool'
        ? textStream('Handed over to Claude.')
        : toolCallStream([{ id: 'c1', name: 'send_message', args: { message: 'Please implement this.', to_agent_ids: [claude.id] } }]),
    );
    const provider = addProvider();
    const architect = addModelAgent('Security Architect', provider.id);
    const channel = createChannel(h, 'development', [claude, architect]);

    await h.orchestrator.handleHumanMessage(channel.id, '@SecurityArchitect review it, then pass it to Claude.');
    await h.waitForIdle();

    const handoff = h.store.listMessages(channel.id, 50).find((m) => m.body === 'Please implement this.')!;
    expect(handoff.senderId).toBe(architect.id);
    expect(handoff.mentions).toEqual([claude.id]);
    // Claude was actually woken by the model agent's message.
    expect(h.runtime.calls.some((c) => c.agent.id === claude.id)).toBe(true);
    expect(agentReplies(channel.id, architect.id).at(-1)!.body).toBe('Handed over to Claude.');
    expect(toolNames(chatRequests(mock)[0]!)).toContain('send_message');
  });
});

describe('MCP tools through a custom agent', () => {
  async function setup(mode: 'allow' | 'ask') {
    const server = h.mcp.create({ name: 'Notes', transport: 'stdio', command: 'node', args: [FIXTURE], timeoutMs: 20_000 });
    await h.mcp.connect(server.id, { interactive: true });
    return server;
  }

  it('executes an authorized tool and feeds the result back to the model', async () => {
    mock = await startMockProvider((req) =>
      lastMessage(req)?.role === 'tool'
        ? textStream(`The server said: ${String(lastMessage(req)!.content)}`)
        : toolCallStream([{ id: 'c1', name: 'notes__echo', args: { text: 'hello tools' } }]),
    );
    const provider = addProvider();
    const agent = addModelAgent('Security Architect', provider.id);
    const server = await setup('allow');
    h.integrations.setAgentGrants(agent.id, [{ serverId: server.id, toolName: 'echo', mode: 'allow' }]);
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Try the echo tool.');
    await h.waitForIdle();

    expect(agentReplies(dm.id, agent.id)[0]!.body).toBe('The server said: echo: hello tools');
    // Only the granted tool was offered, alongside the workspace tools.
    const offered = toolNames(chatRequests(mock)[0]!);
    expect(offered).toContain('notes__echo');
    expect(offered).not.toContain('notes__add_note');
    expect(h.approvals).toHaveLength(0); // "allow" means no prompt
  });

  it('asks the operator first when the grant says so, and honours a refusal', async () => {
    mock = await startMockProvider((req) =>
      lastMessage(req)?.role === 'tool'
        ? textStream(String(lastMessage(req)!.content))
        : toolCallStream([{ id: 'c1', name: 'notes__add_note', args: { note: 'deploy on friday' } }]),
    );
    const provider = addProvider();
    const agent = addModelAgent('Scribe', provider.id);
    const server = await setup('ask');
    h.integrations.setAgentGrants(agent.id, [{ serverId: server.id, toolName: 'add_note', mode: 'ask' }]);
    const dm = createDm(h, agent);

    h.approvalAnswer = { approved: false, reason: 'Not today.' };
    await h.orchestrator.handleHumanMessage(dm.id, 'Store a note.');
    await h.waitForIdle();

    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ agentId: agent.id, toolName: 'Notes → add_note', input: { note: 'deploy on friday' } });
    expect(agentReplies(dm.id, agent.id)[0]!.body).toBe('Not today.');
    expect((await h.mcp.callTool(server.id, 'list_notes', {})).content[0]).toMatchObject({ text: '[]' });

    h.approvalAnswer = { approved: true };
    await h.orchestrator.handleHumanMessage(dm.id, 'Store it now.');
    await h.waitForIdle();
    expect((await h.mcp.callTool(server.id, 'list_notes', {})).content[0]).toMatchObject({ text: '["deploy on friday"]' });
  });

  it('rejects a tool the model invents or was not granted', async () => {
    mock = await startMockProvider((req) =>
      lastMessage(req)?.role === 'tool'
        ? textStream(`Result: ${String(lastMessage(req)!.content)}`)
        : toolCallStream([{ id: 'c1', name: 'notes__add_note', args: { note: 'x' } }]),
    );
    const provider = addProvider();
    const agent = addModelAgent('Reviewer', provider.id);
    const server = await setup('allow');
    h.integrations.setAgentGrants(agent.id, [{ serverId: server.id, toolName: 'echo', mode: 'allow' }]);
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Add a note.');
    await h.waitForIdle();

    expect(agentReplies(dm.id, agent.id)[0]!.body).toMatch(/Result: There is no tool named "notes__add_note"/);
    expect((await h.mcp.callTool(server.id, 'list_notes', {})).content[0]).toMatchObject({ text: '[]' });
  });
});

describe('capabilities and failures', () => {
  it('retries without tools when a model rejects them, and remembers', async () => {
    let calls = 0;
    mock = await startMockProvider((req) => {
      calls += 1;
      if (req.body?.tools) return { status: 400, json: { error: { message: 'registry.ollama.ai/library/tiny does not support tools' } } };
      return textStream('Plain answer.');
    });
    const provider = addProvider();
    const agent = addModelAgent('Tiny', provider.id);
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Hello?');
    await h.waitForIdle();

    expect(agentReplies(dm.id, agent.id)[0]!.body).toBe('Plain answer.');
    expect(calls).toBe(2);
    expect(h.providers.get(provider.id)!.models.find((m) => m.id === 'qwen3:8b')!.capabilities.tools).toBe(false);

    // Next time it does not even try.
    await h.orchestrator.handleHumanMessage(dm.id, 'Again?');
    await h.waitForIdle();
    expect(calls).toBe(3);
  });

  it('records an unavailable provider as a failed run without crashing', async () => {
    mock = await startMockProvider(() => textStream('unused'));
    const provider = addProvider();
    const url = mock.url;
    await mock.close();
    h.providers.update(provider.id, {
      name: 'Local AI',
      preset: 'openai-compatible',
      kind: 'openai-compatible',
      category: 'openai-compatible',
      baseUrl: `${url}/v1`,
      authMethod: 'none',
    });
    const agent = addModelAgent('Offline', provider.id);
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Are you there?');
    await h.waitForIdle();

    const error = h.store.listMessages(dm.id, 10).find((m) => m.kind === 'execution_error')!;
    expect(error.body).toMatch(/Could not reach Local AI/);
    expect(h.store.getAgent(agent.id)!.status).toBe('error');
    expect(h.store.listExecutionsForConversation(dm.id)[0]!.state).toBe('failed');
  });
});

describe('preventing uncontrolled agent response loops', () => {
  it('stops two model agents that keep handing work to each other', async () => {
    h.settings.limits.maxAgentToAgentTurns = 3;
    const ids: Record<string, string> = {};
    mock = await startMockProvider((req) => {
      const system = (req.body?.messages as Array<{ content: string }>)[0]!.content;
      const me = system.includes('"Ping"') ? 'Ping' : 'Pong';
      if (lastMessage(req)?.role === 'tool') return textStream(`${me} passed it on.`);
      return toolCallStream([{ id: `c-${Date.now()}`, name: 'send_message', args: { message: `${me}: your turn`, to_agent_ids: [ids[me === 'Ping' ? 'Pong' : 'Ping']] } }]);
    });
    const provider = addProvider();
    const ping = addModelAgent('Ping', provider.id);
    const pong = addModelAgent('Pong', provider.id);
    ids.Ping = ping.id;
    ids.Pong = pong.id;
    const channel = createChannel(h, 'loop', [ping, pong]);

    await h.orchestrator.handleHumanMessage(channel.id, '@Ping start the ping-pong.');
    await h.waitForIdle(20_000);

    const runs = h.store.listExecutionsForConversation(channel.id, 100);
    expect(runs.length).toBeLessThanOrEqual(3);
    const notice = h.store.listMessages(channel.id, 100).find((m) => m.kind === 'limit_notice')!;
    expect(notice.body).toMatch(/limit of 3 agent-to-agent turns/);
  });
});

describe('preserving configuration after restart', () => {
  it('keeps providers, agents, MCP servers and grants, with secrets still readable', async () => {
    mock = await startMockProvider(() => textStream('ok'));
    const provider = h.providers.create({
      name: 'Keeper',
      preset: 'custom',
      kind: 'openai-compatible',
      category: 'custom',
      baseUrl: `${mock.url}/v1`,
      authMethod: 'bearer',
      apiKey: 'persisted-key-5555',
      models: [{ id: 'm1', source: 'manual', capabilities: { contextWindow: 8000, maxOutputTokens: null, tools: true, vision: null, streaming: null, structuredOutput: null }, overrides: { vision: false } }],
    });
    const agent = addModelAgent('Durable', provider.id, { systemPromptAppend: 'Remember me.' }, 'Survives restarts');
    const server = h.mcp.create({ name: 'Notes', transport: 'stdio', command: 'node', args: [FIXTURE], env: { K: 'env-val' } });
    h.integrations.setAgentGrants(agent.id, [{ serverId: server.id, toolName: 'echo', mode: 'allow' }]);

    // "Restart": a fresh connection to the same database file.
    const reopened = openDatabase(join(h.dir, 'test.db'), join(process.cwd(), 'src/main/db/migrations'));
    try {
      const store = new Store(reopened.db);
      const integrations = new IntegrationStore(reopened.db);
      const secrets = new SecretStore(reopened.db, testCipher);

      const again = store.getAgent(agent.id)!;
      expect(again).toMatchObject({ name: 'Durable', description: 'Survives restarts', runtimeType: 'model' });
      expect(again.config).toMatchObject({ providerId: provider.id, model: 'qwen3:8b', systemPromptAppend: 'Remember me.' });

      const row = integrations.getProvider(provider.id)!;
      expect(row.models[0]).toMatchObject({ id: 'm1', overrides: { vision: false } });
      expect(secrets.read<{ apiKey: string }>(row.secretId).apiKey).toBe('persisted-key-5555');

      const mcpRow = integrations.getMcpServer(server.id)!;
      expect(mcpRow).toMatchObject({ name: 'Notes', command: 'node', envKeys: ['K'] });
      expect(secrets.read<{ env: Record<string, string> }>(mcpRow.secretId).env).toEqual({ K: 'env-val' });
      expect(integrations.listGrants({ agentId: agent.id })).toEqual([
        { agentId: agent.id, serverId: server.id, toolName: 'echo', mode: 'allow' },
      ]);
    } finally {
      reopened.close();
    }
  });
});
