/**
 * Images sent with a message, through the real orchestrator and runtimes.
 * CLI agents run as the ScriptedRuntime test double (so the context they are
 * handed can be inspected); model agents run the real ModelAgentRuntime
 * against a mock provider; external agents run the real A2A runtime against
 * the official A2A SDK server.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Part } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { AgentEvent } from '@a2a-js/sdk/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_CONFIG } from '../../src/shared/types.js';
import type { Agent } from '../../src/shared/types.js';
import { prepareImages } from '../../src/main/attachments/images.js';
import { chatRequests, startMockProvider, textStream, type MockProvider } from '../support/mock-provider.js';
import { registerExternalAgent, startRemote, type RemoteAgent } from '../support/a2a-remote.js';
import { createChannel, createDm, createHarness, type Harness } from '../harness.js';
import { PNG_1PX } from '../support/images.js';

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

const png = (name: string) => ({ name, data: PNG_1PX });

function modelAgent(name: string, extra: { vision?: boolean } = {}) {
  const provider = h.providers.create({
    name: `${name} provider`,
    preset: 'openai-compatible',
    kind: 'openai-compatible',
    category: 'openai-compatible',
    baseUrl: `${mock!.url}/v1`,
    authMethod: 'none',
    models: [
      {
        id: 'vision-model',
        source: 'manual',
        capabilities: { contextWindow: null, maxOutputTokens: null, tools: false, vision: null, streaming: null, structuredOutput: null },
        overrides: extra.vision === undefined ? {} : { vision: extra.vision },
      },
    ],
  });
  return h.createAgent(name, {
    runtimeType: 'model',
    workingDirectory: '',
    permissions: { workspaceAccess: 'read_only', allowAgentToAgent: true, allowTaskUpdates: true, maxCostPerExecutionUsd: 0 },
    config: { ...DEFAULT_AGENT_CONFIG, providerId: provider.id, model: 'vision-model' },
  });
}

/** The user parts the model was sent, flattened. */
function userParts(request: { body: Record<string, unknown> | null }): Array<Record<string, unknown>> {
  const messages = (request.body?.messages ?? []) as Array<{ role: string; content: unknown }>;
  return messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [{ type: 'text', text: m.content }]));
}

describe('storing images sent with a message', () => {
  it('writes each image under the app\'s data folder with a generated name, and records it', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);

    const message = await h.orchestrator.handleHumanMessage(dm.id, 'What is wrong here?', prepareImages([png('C:\\Users\\me\\error.png')]));
    await h.waitForIdle();

    expect(message.attachments).toHaveLength(1);
    const [attachment] = message.attachments;
    expect(attachment).toMatchObject({ kind: 'image', mimeType: 'image/png', name: 'error.png' });
    expect(attachment!.path.startsWith(join(h.dir, 'attachments'))).toBe(true);
    expect(attachment!.path).not.toContain('error');
    expect(readFileSync(attachment!.path).toString('base64')).toBe(PNG_1PX);

    // The event and a reload both carry it.
    const emitted = h.events.find((e) => e.type === 'message' && e.message.id === message.id);
    expect(emitted && emitted.type === 'message' && emitted.message.attachments).toHaveLength(1);
    expect(h.store.listMessages(dm.id).find((m) => m.id === message.id)?.attachments).toEqual(message.attachments);
  });

  it('removes a conversation\'s image files when the conversation is deleted', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    const message = await h.orchestrator.handleHumanMessage(dm.id, '', prepareImages([png('a.png')]));
    await h.waitForIdle();
    const folder = dirname(message.attachments[0]!.path);
    expect(existsSync(folder)).toBe(true);

    h.store.deleteConversation(dm.id);
    h.attachments.removeConversation(dm.id);
    expect(existsSync(folder)).toBe(false);
    expect(readdirSync(join(h.dir, 'attachments'))).toEqual([]);
  });
});

describe('handing images to agents', () => {
  it('gives a local agent the images of the message it is answering, named in its prompt', async () => {
    const claude = h.createAgent('Claude');
    const dm = createDm(h, claude);
    const message = await h.orchestrator.handleHumanMessage(dm.id, '', prepareImages([png('screenshot.png'), png('trace.png')]));
    await h.waitForIdle();

    const ctx = h.runtime.calls[0]!;
    expect(ctx.images.map((i) => i.name)).toEqual(['screenshot.png', 'trace.png']);
    expect(ctx.images.map((i) => i.path)).toEqual(message.attachments.map((a) => a.path));
    expect(ctx.prompt).toContain('[Attached image: screenshot.png]');
    expect(ctx.prompt).toContain('[Attached image: trace.png]');
    // The transcript carries them too, for runtimes that rebuild context.
    expect(ctx.transcript.at(-1)?.images.map((i) => i.name)).toEqual(['screenshot.png', 'trace.png']);
  });

  it('caps the images in one turn, and names the ones left out with their paths', async () => {
    const claude = h.createAgent('Claude');
    const channel = createChannel(h, 'design', [claude]);
    // Not addressed to anyone: nobody wakes, the images just sit in the channel.
    const first = await h.orchestrator.handleHumanMessage(channel.id, 'Mockups', prepareImages(Array.from({ length: 5 }, (_, i) => png(`mock-${i}.png`))));
    await h.orchestrator.handleHumanMessage(channel.id, 'More', prepareImages(Array.from({ length: 5 }, (_, i) => png(`more-${i}.png`))));
    await h.orchestrator.handleHumanMessage(channel.id, '@Claude compare these');
    await h.waitForIdle();

    const ctx = h.runtime.calls[0]!;
    expect(ctx.images).toHaveLength(8);
    expect(ctx.images[0]!.name).toBe('mock-2.png');
    for (const skipped of first.attachments.slice(0, 2)) {
      expect(ctx.prompt).toContain(`[Attached image, not included in this turn: ${skipped.name} (${skipped.path})]`);
    }
  });

  it('sends a model agent the image as an image part', async () => {
    mock = await startMockProvider((req) => {
      const sawImage = userParts(req).some((p) => p.type === 'image_url');
      return textStream(sawImage ? 'I can see a tiny image.' : 'No image reached me.');
    });
    const agent = modelAgent('Scout');
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'What do you see?', prepareImages([png('dot.png')]));
    await h.waitForIdle();

    const parts = userParts(chatRequests(mock)[0]!);
    expect(parts).toContainEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1PX}` } });
    expect(h.store.listMessages(dm.id).at(-1)?.body).toBe('I can see a tiny image.');
  });

  it('does not send images to a model known not to view them, and says so in the text', async () => {
    mock = await startMockProvider(() => textStream('Understood.'));
    const agent = modelAgent('TextOnly', { vision: false });
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Look', prepareImages([png('dot.png')]));
    await h.waitForIdle();

    const parts = userParts(chatRequests(mock)[0]!);
    expect(parts.some((p) => p.type === 'image_url')).toBe(false);
    expect(JSON.stringify(parts)).toContain('you cannot view images');
  });

  it('retries without the image when a provider refuses it, and remembers', async () => {
    mock = await startMockProvider((req) =>
      userParts(req).some((p) => p.type === 'image_url')
        ? { status: 400, json: { error: { message: 'This model does not support image input.' } } }
        : textStream('I only got the text.'),
    );
    const agent = modelAgent('Learner');
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Look', prepareImages([png('dot.png')]));
    await h.waitForIdle();

    expect(h.store.listMessages(dm.id).at(-1)?.body).toBe('I only got the text.');
    const provider = h.providers.list().find((p) => p.name === 'Learner provider')!;
    expect(provider.models[0]!.capabilities.vision).toBe(false);

    // Next time the image is not even tried.
    const before = chatRequests(mock).length;
    await h.orchestrator.handleHumanMessage(dm.id, 'Again', prepareImages([png('dot.png')]));
    await h.waitForIdle();
    expect(chatRequests(mock).length).toBe(before + 1);
  });
});

describe('external agents', () => {
  /** Records the parts of every message the remote agent receives. */
  function recordingExecutor(received: Part[][]) {
    return (): AgentExecutor => ({
      async execute(context: RequestContext, bus: ExecutionEventBus) {
        received.push(context.userMessage.parts);
        bus.publish(
          AgentEvent.message({
            messageId: 'reply-1',
            contextId: context.contextId,
            taskId: '',
            role: 2 as never,
            parts: [{ content: { $case: 'text', value: 'Received.' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          }),
        );
        bus.finished();
      },
      async cancelTask() {},
    });
  }

  it('sends images as file parts to an agent that accepts them', async () => {
    const received: Part[][] = [];
    remote = await startRemote({ executor: recordingExecutor(received), inputModes: ['text/plain', 'image/png', 'image/jpeg'] });
    const agent: Agent = await registerExternalAgent(h, `${remote.baseUrl}/.well-known/agent-card.json`);
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Please look.', prepareImages([png('dot.png')]));
    await h.waitForIdle();

    const file = received[0]!.find((p) => p.content?.$case === 'raw');
    expect(file).toMatchObject({ mediaType: 'image/png', filename: 'dot.png' });
    expect(Buffer.from(file!.content!.value as Uint8Array).toString('base64')).toBe(PNG_1PX);
  });

  it('tells an agent that does not accept images that one was attached, without sending it', async () => {
    const received: Part[][] = [];
    remote = await startRemote({ executor: recordingExecutor(received) });
    const agent: Agent = await registerExternalAgent(h, `${remote.baseUrl}/.well-known/agent-card.json`);
    const dm = createDm(h, agent);

    await h.orchestrator.handleHumanMessage(dm.id, 'Please look.', prepareImages([png('dot.png')]));
    await h.waitForIdle();

    expect(received[0]!.some((p) => p.content?.$case === 'raw')).toBe(false);
    const text = received[0]!.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join('');
    expect(text).toContain('[Attached image: dot.png]');
    expect(text).toContain('this agent does not accept images');
  });
});
