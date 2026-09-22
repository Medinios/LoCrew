/**
 * A real A2A peer for tests: the official A2A JS SDK server
 * (DefaultRequestHandler + its Express handlers) running in-process, with a
 * small scripted executor. The protocol on the wire is the reference
 * implementation; only the remote agent's "thinking" is scripted.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { AGENT_CARD_PATH, Role, TaskState, type AgentCard, type Message } from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { A2AConfig } from '../../src/shared/integrations.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/shared/types.js';
import { inspectAgentCard } from '../../src/main/runtimes/a2a.js';
import type { Harness } from '../harness.js';

export interface RemoteAgent {
  baseUrl: string;
  /** Every contextId the remote agent saw, in order. */
  contexts: string[];
  /** Every Authorization header received on the JSON-RPC endpoint. */
  auth: string[];
  /** The A2A-Version header of every JSON-RPC request: which wire format was used. */
  versions: string[];
  prompts: string[];
  card: AgentCard;
  close(): Promise<void>;
}

const text = (value: string) => ({ content: { $case: 'text' as const, value }, metadata: undefined, filename: '', mediaType: 'text/plain' });

function agentMessage(contextId: string, taskId: string, value: string): Message {
  return { messageId: randomUUID(), contextId, taskId, role: Role.ROLE_AGENT, parts: [text(value)], metadata: undefined, extensions: [], referenceTaskIds: [] };
}

function userText(context: RequestContext): string {
  return context.userMessage.parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join('');
}

/** Answers with a plain message (the simplest A2A agent). */
export function messageExecutor(remoteState: { contexts: string[]; prompts: string[] }): AgentExecutor {
  return {
    async execute(context: RequestContext, bus: ExecutionEventBus) {
      remoteState.contexts.push(context.contextId);
      remoteState.prompts.push(userText(context));
      bus.publish(AgentEvent.message(agentMessage(context.contextId, '', `I found three possible approaches (turn ${remoteState.contexts.length}).`)));
      bus.finished();
    },
    async cancelTask() {},
  };
}

/** Works as a task: status updates plus a streamed artifact, then completes. */
export function taskExecutor(remoteState: { contexts: string[]; prompts: string[] }): AgentExecutor {
  return {
    async execute(context: RequestContext, bus: ExecutionEventBus) {
      remoteState.contexts.push(context.contextId);
      remoteState.prompts.push(userText(context));
      const base = { taskId: context.taskId, contextId: context.contextId, metadata: undefined };
      bus.publish(
        AgentEvent.task({
          id: context.taskId,
          contextId: context.contextId,
          status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
          artifacts: [],
          history: [context.userMessage],
          metadata: undefined,
        }),
      );
      bus.publish(AgentEvent.statusUpdate({ ...base, status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined } }));
      const artifactId = randomUUID();
      bus.publish(
        AgentEvent.artifactUpdate({
          ...base,
          artifact: { artifactId, name: 'report', description: '', parts: [text('Option A: OAuth. ')], metadata: undefined, extensions: [] },
          append: false,
          lastChunk: false,
        }),
      );
      bus.publish(
        AgentEvent.artifactUpdate({
          ...base,
          artifact: { artifactId, name: 'report', description: '', parts: [text('Option B: passkeys.')], metadata: undefined, extensions: [] },
          append: true,
          lastChunk: true,
        }),
      );
      bus.publish(AgentEvent.statusUpdate({ ...base, status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined } }));
      bus.finished();
    },
    async cancelTask() {},
  };
}

export async function startRemote(options: {
  executor: (state: { contexts: string[]; prompts: string[] }) => AgentExecutor;
  streaming?: boolean;
  requireToken?: string;
  protocolVersion?: string;
  /** What the card says the agent accepts. Defaults to text only. */
  inputModes?: string[];
}): Promise<RemoteAgent> {
  const state = { contexts: [] as string[], prompts: [] as string[], auth: [] as string[], versions: [] as string[] };
  const app = express();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const legacy = options.protocolVersion === '0.3';

  const card: AgentCard = {
    name: 'Research Agent',
    description: 'Researches technical options.',
    supportedInterfaces: [{ url: `${baseUrl}/a2a`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: options.protocolVersion ?? '1.0' }],
    provider: undefined,
    version: '2.0.0',
    capabilities: { streaming: options.streaming ?? false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: options.inputModes ?? ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'research', name: 'Research', description: 'Finds and compares options.', tags: ['research'], examples: [], inputModes: [], outputModes: [], securityRequirements: [] }],
    signatures: [],
  } as unknown as AgentCard;

  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), options.executor(state));
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler, ...(legacy ? { legacyCompat: { enabled: true } } : {}) }));
  app.use(
    '/a2a',
    (req, res, next) => {
      state.auth.push(String(req.headers.authorization ?? ''));
      state.versions.push(String(req.headers['a2a-version'] ?? ''));
      if (options.requireToken && req.headers.authorization !== `Bearer ${options.requireToken}`) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    },
    jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication, ...(legacy ? { legacyCompat: { enabled: true } } : {}) }),
  );

  return {
    baseUrl,
    contexts: state.contexts,
    prompts: state.prompts,
    auth: state.auth,
    versions: state.versions,
    card,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export async function registerExternalAgent(h: Harness, cardUrl: string, token?: string) {
  const { summary, resolvedCardUrl } = await inspectAgentCard(cardUrl);
  let secretId: string | null = null;
  if (token) secretId = h.secrets.create({ token });
  const a2a: A2AConfig = {
    cardUrl: resolvedCardUrl,
    endpointUrl: summary.endpointUrl,
    authMethod: token ? 'bearer' : 'none',
    authHeaderName: null,
    secretId,
    streaming: summary.streaming,
    allowInsecure: false,
    protocolVersion: summary.protocolVersion,
    remoteName: summary.name,
  };
  return h.createAgent('Research Agent', {
    runtimeType: 'a2a',
    workingDirectory: '',
    permissions: { workspaceAccess: 'read_only', allowAgentToAgent: true, allowTaskUpdates: false, maxCostPerExecutionUsd: 0 },
    config: { ...DEFAULT_AGENT_CONFIG, a2a },
  });
}

/** Works as a task that ends by asking the user a question (INPUT_REQUIRED). */
export function inputRequiredExecutor(remoteState: { contexts: string[]; prompts: string[] }): AgentExecutor {
  return {
    async execute(context: RequestContext, bus: ExecutionEventBus) {
      remoteState.contexts.push(context.contextId);
      remoteState.prompts.push(userText(context));
      const base = { taskId: context.taskId, contextId: context.contextId, metadata: undefined };
      bus.publish(
        AgentEvent.task({
          id: context.taskId,
          contextId: context.contextId,
          status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
          artifacts: [],
          history: [context.userMessage],
          metadata: undefined,
        }),
      );
      bus.publish(AgentEvent.statusUpdate({ ...base, status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined } }));
      bus.publish(
        AgentEvent.statusUpdate({
          ...base,
          status: {
            state: TaskState.TASK_STATE_INPUT_REQUIRED,
            message: agentMessage(context.contextId, context.taskId, 'Which region should I search?'),
            timestamp: undefined,
          },
        }),
      );
      bus.finished();
    },
    async cancelTask() {},
  };
}
