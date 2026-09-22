import { randomUUID } from 'node:crypto';
import type { AgentCard, Message, Part, StreamResponse, Task } from '@a2a-js/sdk';
import type { Client } from '@a2a-js/sdk/client';
import type { Agent, RuntimeDetection } from '../../shared/types.js';
import type { A2ACardSummary, A2AConfig, AuthMethod } from '../../shared/integrations.js';
import { checkEndpointUrl } from '../../shared/integrations.js';
import { redact, type SecretStore } from '../security/secrets.js';
import { buildConversationalSystemPrompt } from './conversation.js';
import { loadImages, missingImagesNote } from './images.js';
import type { AgentRuntime, InstallCheck, RuntimeEvent, RuntimeExecuteContext } from './types.js';

/**
 * The A2A SDK is ESM (and its JOSE dependency is ESM-only), while the main
 * bundle is CommonJS, so it is loaded with a dynamic import on first use.
 */
type A2ASdk = {
  ClientFactory: typeof import('@a2a-js/sdk/client').ClientFactory;
  ClientFactoryOptions: typeof import('@a2a-js/sdk/client').ClientFactoryOptions;
  JsonRpcTransportFactory: typeof import('@a2a-js/sdk/client').JsonRpcTransportFactory;
  RestTransportFactory: typeof import('@a2a-js/sdk/client').RestTransportFactory;
  DefaultAgentCardResolver: typeof import('@a2a-js/sdk/client').DefaultAgentCardResolver;
  Role: typeof import('@a2a-js/sdk').Role;
  TaskState: typeof import('@a2a-js/sdk').TaskState;
};

let sdk: A2ASdk | null = null;

async function loadSdk(): Promise<A2ASdk> {
  if (!sdk) {
    const [client, core] = await Promise.all([import('@a2a-js/sdk/client'), import('@a2a-js/sdk')]);
    sdk = {
      ClientFactory: client.ClientFactory,
      ClientFactoryOptions: client.ClientFactoryOptions,
      JsonRpcTransportFactory: client.JsonRpcTransportFactory,
      RestTransportFactory: client.RestTransportFactory,
      DefaultAgentCardResolver: client.DefaultAgentCardResolver,
      Role: core.Role,
      TaskState: core.TaskState,
    };
  }
  return sdk;
}

/** Credentials never follow a redirect to wherever a server points. */
const noRedirectFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });

const SUPPORTED_BINDINGS = ['JSONRPC', 'HTTP+JSON'];
const CARD_TIMEOUT_MS = 15_000;

/**
 * Fetches and summarises an Agent Card. Accepts either the agent's base URL
 * (the card is looked up at `/.well-known/agent-card.json`, with the older
 * `agent.json` as a fallback) or the full URL of a card.
 */
export async function inspectAgentCard(
  cardUrl: string,
  options: { allowInsecure?: boolean } = {},
): Promise<{ card: AgentCard; summary: A2ACardSummary; resolvedCardUrl: string }> {
  const problem = checkEndpointUrl(cardUrl, options.allowInsecure);
  if (problem) throw new Error(problem);

  const { DefaultAgentCardResolver } = await loadSdk();
  const resolver = new DefaultAgentCardResolver({
    fetchImpl: (input, init) =>
      noRedirectFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(CARD_TIMEOUT_MS) }),
    legacyCompat: { enabled: true },
  });

  const explicit = /\.json($|\?)/i.test(new URL(cardUrl).pathname + new URL(cardUrl).search);
  const attempts: Array<[string, string]> = explicit
    ? [[cardUrl, '']]
    : [
        [cardUrl, '/.well-known/agent-card.json'],
        [cardUrl, '/.well-known/agent.json'],
      ];

  let lastError: unknown = null;
  for (const [base, path] of attempts) {
    try {
      const card = await resolver.resolve(base, path);
      const resolvedCardUrl = path ? new URL(path, base).toString() : base;
      return { card, summary: summariseCard(card, resolvedCardUrl, options.allowInsecure), resolvedCardUrl };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not read an Agent Card at ${cardUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function summariseCard(card: AgentCard, cardUrl: string, allowInsecure = false): A2ACardSummary {
  const iface = card.supportedInterfaces.find((i) => SUPPORTED_BINDINGS.includes(i.protocolBinding.toUpperCase()));
  let problem: string | null = null;
  if (!card.supportedInterfaces.length) problem = 'The card declares no interfaces to connect to.';
  else if (!iface) {
    problem = `The agent only offers ${card.supportedInterfaces.map((i) => i.protocolBinding).join(', ')}; this app speaks JSON-RPC and HTTP+JSON.`;
  } else {
    problem = checkEndpointUrl(iface.url, allowInsecure);
  }

  let crossOrigin = false;
  try {
    crossOrigin = !!iface && new URL(iface.url).origin !== new URL(cardUrl).origin;
  } catch {
    // Reported through `problem` already.
  }

  return {
    name: card.name,
    description: card.description,
    version: card.version,
    protocolVersion: iface?.protocolVersion || null,
    endpointUrl: iface?.url ?? '',
    transport: iface?.protocolBinding ?? '',
    streaming: !!card.capabilities?.streaming,
    skills: card.skills.map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags })),
    securitySchemes: Object.keys(card.securitySchemes ?? {}),
    defaultInputModes: card.defaultInputModes,
    defaultOutputModes: card.defaultOutputModes,
    problem,
    crossOrigin,
  };
}

/** Session state persisted per (agent, conversation) as the runtime session id. */
interface A2ASession {
  contextId: string;
  /** Set while the remote task waits for our input, so the reply continues it. */
  taskId?: string;
}

/**
 * External agents over the Agent2Agent protocol.
 *
 * The remote agent is a normal participant: it receives what was said since
 * it last spoke, keeps its own memory under an A2A `contextId` persisted per
 * conversation, and its answer is posted like any other agent's. It cannot
 * call this app's tools or wake other agents -- A2A gives it no channel to do
 * so, and that is the right default for software running on someone else's
 * machine.
 */
export class A2ARuntime implements AgentRuntime {
  readonly runtimeType = 'a2a' as const;
  /** A remote agent reports only that it is working and how it ended; its internal steps are not observable. */
  readonly activityProfile = 'basic' as const;
  readonly perAgentAvailability = true;

  constructor(private readonly secrets: SecretStore) {}

  async detectInstall(agent?: Agent): Promise<InstallCheck> {
    const config = agent?.config.a2a;
    if (!config) return { installed: false, version: null, location: null, message: 'No connection is configured.' };
    return {
      installed: true,
      version: config.protocolVersion,
      location: config.endpointUrl,
      message: `External agent at ${new URL(config.endpointUrl).host}`,
    };
  }

  async detect(): Promise<RuntimeDetection> {
    return {
      runtimeType: 'a2a',
      installed: true,
      version: null,
      location: null,
      authenticated: true,
      message: 'External agents are reached over the Agent2Agent protocol.',
    };
  }

  async *execute(ctx: RuntimeExecuteContext): AsyncIterable<RuntimeEvent> {
    const config = ctx.agent.config.a2a;
    if (!config) {
      yield { type: 'error', message: `${ctx.agent.name} has no external agent connection configured.`, fatal: true };
      return;
    }
    const token = (this.secrets.read<{ token?: string }>(config.secretId).token ?? null) || null;
    const clean = (text: string) => redact(text, [token]);

    let client: Client;
    let acceptsImages = false;
    let taskState: typeof import('@a2a-js/sdk').TaskState;
    let role: typeof import('@a2a-js/sdk').Role;
    try {
      const loaded = await loadSdk();
      taskState = loaded.TaskState;
      role = loaded.Role;
      const connected = await this.connect(config, loaded);
      client = connected.client;
      acceptsImages = acceptsImageInput(connected.card);
    } catch (error) {
      yield { type: 'error', message: clean(`Could not connect to ${ctx.agent.name}: ${asMessage(error)}`), fatal: true };
      return;
    }

    const session = parseSession(ctx.resumeSessionId);
    const firstTurn = !session;
    let text = firstTurn
      ? `${buildConversationalSystemPrompt(ctx, { canMessageAgents: false, toolNames: [] })}\n\n---\n\n${ctx.prompt}`
      : ctx.prompt;

    // Images go as file parts, but only to an agent whose card accepts image
    // input; otherwise it is told they exist and were not sent.
    let imageParts: Part[] = [];
    if (ctx.images.length) {
      if (acceptsImages) {
        const { loaded, missing } = await loadImages(ctx.images);
        imageParts = loaded.map((image) => ({
          content: { $case: 'raw' as const, value: image.bytes },
          metadata: undefined,
          filename: image.name,
          mediaType: image.mimeType,
        }));
        text += missingImagesNote(missing);
      } else {
        text += `\n\n[${ctx.images.length === 1 ? 'An image was' : `${ctx.images.length} images were`} attached, but were not sent: this agent does not accept images.]`;
      }
    }

    const message: Message = {
      messageId: randomUUID(),
      contextId: session?.contextId ?? '',
      taskId: session?.taskId ?? '',
      role: role.ROLE_USER,
      parts: [textPart(text), ...imageParts],
      metadata: { conversation: ctx.conversationName, sender: 'locrew' },
      extensions: [],
      referenceTaskIds: [],
    };
    const request = {
      tenant: '',
      message,
      configuration: {
        acceptedOutputModes: ['text/plain', 'text/markdown', 'application/json'],
        taskPushNotificationConfig: undefined,
        returnImmediately: false,
      },
      metadata: undefined,
    };
    const options = { signal: ctx.abortSignal, serviceParameters: authParameters(config.authMethod, config.authHeaderName, token) };

    const state = new ReplyAssembler();
    let contextId = session?.contextId ?? '';
    let taskId = '';
    let finalState: number | null = null;

    try {
      if (config.streaming) {
        for await (const event of client.sendMessageStream(request, options)) {
          if (ctx.abortSignal.aborted) break;
          const update = state.apply(event);
          if (update.contextId) contextId = update.contextId;
          if (update.taskId) taskId = update.taskId;
          if (update.state !== null) finalState = update.state;
          if (update.delta) yield { type: 'text_delta', text: update.delta };
          if (update.working) yield { type: 'state', state: 'working' };
        }
      } else {
        const result = await client.sendMessage(request, options);
        const update = 'messageId' in result ? state.apply({ payload: { $case: 'message', value: result } }) : state.apply({ payload: { $case: 'task', value: result } });
        if (update.contextId) contextId = update.contextId;
        if (update.taskId) taskId = update.taskId;
        if (update.state !== null) finalState = update.state;
      }
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        if (taskId) void client.cancelTask({ tenant: '', id: taskId, metadata: undefined }, { serviceParameters: options.serviceParameters }).catch(() => undefined);
        return;
      }
      yield { type: 'error', message: clean(`${ctx.agent.name}: ${asMessage(error)}`), fatal: true };
      return;
    }

    if (ctx.abortSignal.aborted) {
      if (taskId) void client.cancelTask({ tenant: '', id: taskId, metadata: undefined }, { serviceParameters: options.serviceParameters }).catch(() => undefined);
      return;
    }

    if (contextId) {
      const waiting = finalState === taskState.TASK_STATE_INPUT_REQUIRED || finalState === taskState.TASK_STATE_AUTH_REQUIRED;
      const next: A2ASession = { contextId, ...(waiting && taskId ? { taskId } : {}) };
      yield { type: 'session', sessionId: JSON.stringify(next) };
    }

    const reply = state.text().trim();
    if (reply) yield { type: 'text', text: clean(reply) };

    // The remote task is paused on the user: its reply is a question, not an answer.
    if (reply && (finalState === taskState.TASK_STATE_INPUT_REQUIRED || finalState === taskState.TASK_STATE_AUTH_REQUIRED)) {
      yield { type: 'awaiting_input', reason: finalState === taskState.TASK_STATE_AUTH_REQUIRED ? 'authorization' : 'input' };
    }

    if (finalState === taskState.TASK_STATE_FAILED || finalState === taskState.TASK_STATE_REJECTED) {
      yield {
        type: 'error',
        message: `${ctx.agent.name} reported the task ${finalState === taskState.TASK_STATE_FAILED ? 'failed' : 'was rejected'}.`,
        fatal: !reply,
      };
    } else if (finalState === taskState.TASK_STATE_AUTH_REQUIRED && !reply) {
      yield { type: 'error', message: `${ctx.agent.name} needs additional authorization before it can continue.`, fatal: true };
    } else if (!reply) {
      yield { type: 'error', message: `${ctx.agent.name} finished without replying.`, fatal: false };
    }
  }

  /**
   * Builds a client pinned to the endpoint the user approved. The card is
   * re-read each run (it may advertise a newer protocol version), but if it
   * now points somewhere else the run stops instead of following it.
   */
  private async connect(config: A2AConfig, loaded: A2ASdk): Promise<{ client: Client; card: AgentCard }> {
    const problem = checkEndpointUrl(config.endpointUrl, config.allowInsecure);
    if (problem) throw new Error(problem);

    const { card } = await inspectAgentCard(config.cardUrl, { allowInsecure: config.allowInsecure });
    const iface = card.supportedInterfaces.find((i) => i.url === config.endpointUrl);
    if (!iface) {
      throw new Error(
        `Its Agent Card no longer lists the approved endpoint ${config.endpointUrl}. Open the agent's settings and test the connection again to review the change.`,
      );
    }

    const factory = new loaded.ClientFactory(
      loaded.ClientFactoryOptions.createFrom(loaded.ClientFactoryOptions.default, {
        transports: [
          new loaded.JsonRpcTransportFactory({ fetchImpl: noRedirectFetch, legacyCompat: { enabled: true } }),
          new loaded.RestTransportFactory({ fetchImpl: noRedirectFetch, legacyCompat: { enabled: true } }),
        ],
        preferredTransports: [iface.protocolBinding as 'JSONRPC'],
      }),
    );
    return { client: await factory.createFromAgentCard({ ...card, supportedInterfaces: [iface] }), card };
  }

  async dispose(): Promise<void> {}
}

/* -------------------------------------------------------------------------- */

/**
 * Turns an A2A response stream into one reply. Artifacts are the task's
 * output (the spec says results SHOULD be artifacts); agent messages and the
 * final status message are included when there are no artifacts, so agents
 * that answer with plain messages still read naturally.
 */
class ReplyAssembler {
  private readonly artifacts = new Map<string, string>();
  private readonly order: string[] = [];
  private messageText = '';
  private statusText = '';

  apply(event: StreamResponse): {
    delta: string;
    contextId: string;
    taskId: string;
    state: number | null;
    working: boolean;
  } {
    const result = { delta: '', contextId: '', taskId: '', state: null as number | null, working: false };
    const payload = event.payload;
    if (!payload) return result;

    switch (payload.$case) {
      case 'message': {
        const text = partsText(payload.value.parts);
        this.messageText += (this.messageText && text ? '\n\n' : '') + text;
        result.delta = text;
        result.contextId = payload.value.contextId;
        result.taskId = payload.value.taskId;
        break;
      }
      case 'task': {
        const task: Task = payload.value;
        result.contextId = task.contextId;
        result.taskId = task.id;
        for (const artifact of task.artifacts) this.setArtifact(artifact.artifactId, partsText(artifact.parts), false);
        if (task.status) {
          result.state = task.status.state;
          if (task.status.message) this.statusText = partsText(task.status.message.parts);
        }
        break;
      }
      case 'statusUpdate': {
        result.contextId = payload.value.contextId;
        result.taskId = payload.value.taskId;
        const status = payload.value.status;
        if (status) {
          result.state = status.state;
          result.working = true;
          if (status.message) this.statusText = partsText(status.message.parts);
        }
        break;
      }
      case 'artifactUpdate': {
        result.contextId = payload.value.contextId;
        result.taskId = payload.value.taskId;
        const artifact = payload.value.artifact;
        if (artifact) {
          const text = partsText(artifact.parts);
          this.setArtifact(artifact.artifactId, text, payload.value.append);
          result.delta = text;
        }
        break;
      }
    }
    return result;
  }

  text(): string {
    const artifacts = this.order.map((id) => this.artifacts.get(id) ?? '').filter(Boolean).join('\n\n');
    return artifacts || this.messageText || this.statusText;
  }

  private setArtifact(id: string, text: string, append: boolean): void {
    if (!this.artifacts.has(id)) this.order.push(id);
    this.artifacts.set(id, append ? (this.artifacts.get(id) ?? '') + text : text);
  }
}

function partsText(parts: Part[]): string {
  return parts
    .map((part) => {
      const content = part.content;
      if (!content) return '';
      switch (content.$case) {
        case 'text':
          return content.value;
        case 'data':
          return `\`\`\`json\n${JSON.stringify(content.value, null, 2)}\n\`\`\``;
        case 'url':
          return `[${part.filename || 'file'}](${content.value})`;
        case 'raw':
          return `_(${part.filename || 'binary content'}, ${part.mediaType || 'file'})_`;
      }
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Whether an agent's card says it takes images: its default input modes, or
 * any skill's, include an image type (or everything).
 */
export function acceptsImageInput(card: Pick<AgentCard, 'defaultInputModes' | 'skills'>): boolean {
  const modes = [...(card.defaultInputModes ?? []), ...(card.skills ?? []).flatMap((skill) => skill.inputModes ?? [])];
  return modes.some((mode) => /^image\//i.test(mode) || mode === '*/*');
}

function textPart(text: string): Part {
  return { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

function authParameters(method: AuthMethod, headerName: string | null, token: string | null): Record<string, string> {
  if (!token) return {};
  if (method === 'bearer') return { Authorization: `Bearer ${token}` };
  if (method === 'header' && headerName) return { [headerName]: token };
  return {};
}

function parseSession(value: string | null): A2ASession | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as A2ASession;
    return typeof parsed.contextId === 'string' && parsed.contextId ? parsed : null;
  } catch {
    return null;
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
