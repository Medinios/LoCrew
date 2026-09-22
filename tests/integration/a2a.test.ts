/**
 * External agents over A2A, against the official A2A JS SDK's own server
 * (DefaultRequestHandler + its Express handlers) running in-process. The
 * remote "agent" is a small executor, but the protocol on the wire -- Agent
 * Card discovery, JSON-RPC, SSE streaming, v0.3 compatibility -- is the real
 * reference implementation, so this is a genuine interoperability test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectAgentCard } from '../../src/main/runtimes/a2a.js';
import {
  messageExecutor,
  registerExternalAgent as registerWith,
  startRemote,
  taskExecutor,
  type RemoteAgent,
} from '../support/a2a-remote.js';
import { createChannel, createDm, createHarness, type Harness } from '../harness.js';

let h: Harness;
let remote: RemoteAgent | null = null;

const registerExternalAgent = (cardUrl: string, token?: string) => registerWith(h, cardUrl, token);

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.dispose();
  await remote?.close();
  remote = null;
});


describe('discovering an external agent', () => {
  it('reads the Agent Card from the well-known path', async () => {
    remote = await startRemote({ executor: messageExecutor, streaming: true });
    const { summary } = await inspectAgentCard(remote.baseUrl);
    expect(summary).toMatchObject({
      name: 'Research Agent',
      version: '2.0.0',
      endpointUrl: `${remote.baseUrl}/a2a`,
      transport: 'JSONRPC',
      streaming: true,
      problem: null,
      crossOrigin: false,
    });
    expect(summary.skills[0]).toMatchObject({ id: 'research', name: 'Research' });
  });

  it('refuses a remote agent over plain http', async () => {
    await expect(inspectAgentCard('http://agents.example.com')).rejects.toThrow(/https/);
  });
});

describe('talking to an external agent', () => {
  it('sends messages and posts its replies, keeping one A2A context per conversation', async () => {
    remote = await startRemote({ executor: messageExecutor });
    const agent = await registerExternalAgent(remote.baseUrl);
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Research the authentication options.');
    await h.waitForIdle();
    await h.orchestrator.handleHumanMessage(dm.id, 'Which one is simplest?');
    await h.waitForIdle();

    const replies = h.store.listMessages(dm.id, 10).filter((m) => m.senderId === agent.id).map((m) => m.body);
    expect(replies).toEqual(['I found three possible approaches (turn 1).', 'I found three possible approaches (turn 2).']);
    expect(new Set(remote.versions)).toEqual(new Set(['1.0']));

    // Same conversation, same remote context: the remote agent keeps its memory.
    expect(remote.contexts).toHaveLength(2);
    expect(remote.contexts[0]).toBeTruthy();
    expect(remote.contexts[1]).toBe(remote.contexts[0]);
    // The first turn introduces the workspace; later turns send only what is new.
    expect(remote.prompts[0]).toContain('You are "Research Agent"');
    expect(remote.prompts[1]).not.toContain('You are "Research Agent"');
    expect(remote.prompts[1]).toContain('Which one is simplest?');
  });

  it('streams a task and posts its artifact as the reply', async () => {
    remote = await startRemote({ executor: taskExecutor, streaming: true });
    const agent = await registerExternalAgent(remote.baseUrl);
    const channel = createChannel(h, 'development', [h.createAgent('Claude'), agent]);

    await h.orchestrator.handleHumanMessage(channel.id, '@ResearchAgent Research the available authentication solutions.');
    await h.waitForIdle();

    const reply = h.store.listMessages(channel.id, 10).find((m) => m.senderId === agent.id)!;
    expect(reply.body).toBe('Option A: OAuth. Option B: passkeys.');
    // Streaming reached the UI as deltas.
    const execution = h.store.listExecutionsForConversation(channel.id).find((e) => e.agentId === agent.id)!;
    expect(h.store.listEvents(execution.id).some((e) => e.type === 'text_delta')).toBe(true);
    expect(execution.state).toBe('completed');
  });

  it('sends its stored credential and never shows it', async () => {
    remote = await startRemote({ executor: messageExecutor, requireToken: 'remote-agent-token-99' });
    const agent = await registerExternalAgent(remote.baseUrl, 'remote-agent-token-99');
    expect(JSON.stringify(h.store.getAgent(agent.id))).not.toContain('remote-agent-token-99');
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Hello.');
    await h.waitForIdle();

    expect(remote.auth.every((a) => a === 'Bearer remote-agent-token-99')).toBe(true);
    expect(h.store.listMessages(dm.id, 10).find((m) => m.senderId === agent.id)?.kind).toBe('chat');
  });

  it('reports a rejected credential as a failed run', async () => {
    remote = await startRemote({ executor: messageExecutor, requireToken: 'right-token' });
    const agent = await registerExternalAgent(remote.baseUrl, 'wrong-token');
    const dm = createDm(h, agent);
    await h.orchestrator.handleHumanMessage(dm.id, 'Hello.');
    await h.waitForIdle();
    const error = h.store.listMessages(dm.id, 10).find((m) => m.kind === 'execution_error')!;
    expect(error.body).toMatch(/Research Agent/);
    expect(error.body).not.toContain('wrong-token');
  });

  it('talks to a peer that only speaks A2A v0.3', async () => {
    remote = await startRemote({ executor: messageExecutor, protocolVersion: '0.3' });
    const agent = await registerExternalAgent(remote.baseUrl);
    expect(h.store.getAgent(agent.id)!.config.a2a!.protocolVersion).toBe('0.3');
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Legacy hello.');
    await h.waitForIdle();

    expect(h.store.listMessages(dm.id, 10).find((m) => m.senderId === agent.id)?.body).toMatch(/three possible approaches/);
    // The v0.3 wire format was actually used, not v1.0 accepted by a lenient server.
    expect(remote.versions.length).toBeGreaterThan(0);
    expect(new Set(remote.versions)).toEqual(new Set(['0.3']));
  });

  it('stops instead of following a card that now points somewhere else', async () => {
    remote = await startRemote({ executor: messageExecutor });
    const agent = await registerExternalAgent(remote.baseUrl);
    // Simulate a changed card: the approved endpoint is no longer listed.
    h.store.updateAgent(agent.id, {
      config: { ...agent.config, a2a: { ...agent.config.a2a!, endpointUrl: 'https://attacker.example.com/a2a' } },
    });
    const dm = createDm(h, agent);
    await h.orchestrator.handleHumanMessage(dm.id, 'Hello.');
    await h.waitForIdle();
    const error = h.store.listMessages(dm.id, 10).find((m) => m.kind === 'execution_error')!;
    expect(error.body).toMatch(/no longer lists the approved endpoint/);
    expect(remote.contexts).toHaveLength(0);
  });
});
