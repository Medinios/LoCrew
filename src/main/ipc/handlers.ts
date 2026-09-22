import { BrowserWindow, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import {
  EVENT_CHANNEL,
  INVOKE_SCHEMAS,
  type AppEvent,
  type InvokeChannel,
} from '../../shared/ipc.js';
import type { Agent, AgentConfig, AppSettings, RuntimeType } from '../../shared/types.js';
import {
  DEFAULT_AGENT_CONFIG,
  DEFAULT_AGENT_PERMISSIONS,
  DEFAULT_LIMITS,
  LOCAL_USER_ID,
  isCliRuntime,
} from '../../shared/types.js';
import type { A2AConfig } from '../../shared/integrations.js';
import type { ActivityStore } from '../db/activity-store.js';
import { prepareImages, type ImageAttachmentStore } from '../attachments/images.js';
import type { IntegrationStore } from '../db/integration-store.js';
import type { Store } from '../db/store.js';
import type { McpClientManager } from '../mcp/manager.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { inspectAgentCard } from '../runtimes/a2a.js';
import type { SecretStore } from '../security/secrets.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { discoverPlugins } from '../runtimes/plugins.js';
import type { AgentRuntime } from '../runtimes/types.js';
import type { WorkspaceLockManager } from '../workspace/locks.js';

export interface IpcContext {
  store: Store;
  /** Images sent with messages: validated and stored by the main process. */
  attachments: ImageAttachmentStore;
  /** Agent activity and the user's own message reactions. */
  activity: ActivityStore;
  /** Pushes an event to the renderer. */
  emit(event: AppEvent): void;
  integrations: IntegrationStore;
  secrets: SecretStore;
  providers: ProviderRegistry;
  mcp: McpClientManager;
  orchestrator: Orchestrator;
  runtimes: Map<RuntimeType, AgentRuntime>;
  locks: WorkspaceLockManager;
  getSettings(): AppSettings;
  setSettings(settings: AppSettings): AppSettings;
  mainWindow(): BrowserWindow | null;
}

type Handler<C extends InvokeChannel> = (
  payload: z.output<(typeof INVOKE_SCHEMAS)[C]>,
) => unknown | Promise<unknown>;

/**
 * Registers every IPC handler.
 *
 * Each payload is parsed against its schema before the handler runs, so a
 * compromised renderer cannot reach privileged code with a malformed or
 * unexpected shape. Handler errors are converted to plain messages: raw stack
 * traces stay in the main process.
 */
export function registerIpcHandlers(ctx: IpcContext): void {
  const handlers: { [C in InvokeChannel]: Handler<C> } = {
    /* --------------------------------------------------------------- agents */

    'agents:list': () => ctx.store.listAgents(),

    'agents:create': async (input) => {
      if (ctx.store.getAgentByName(input.name)) {
        throw new Error(`An agent named "${input.name}" already exists.`);
      }
      const shaped = await shapeAgentConfig(ctx, {
        runtimeType: input.runtimeType,
        workingDirectory: input.workingDirectory,
        permissions: { ...DEFAULT_AGENT_PERMISSIONS, ...input.permissions },
        config: { ...DEFAULT_AGENT_CONFIG, ...input.config },
        a2aToken: input.a2aToken,
        existingSecretId: null,
        previousA2A: null,
      });
      const agent = ctx.store.createAgent({
        name: input.name,
        description: input.description,
        runtimeType: input.runtimeType,
        avatar: input.avatar,
        avatarColor: input.avatarColor,
        ...shaped,
      });

      // Every agent gets a DM so it is reachable the moment it exists.
      const dm = ctx.store.createConversation({
        kind: 'dm',
        name: agent.name,
        topic: null,
        memberAgentIds: [agent.id],
        humanMemberId: LOCAL_USER_ID,
      });

      emit(ctx, { type: 'agent', agent });
      emit(ctx, { type: 'conversation', conversation: dm });
      return agent;
    },

    'agents:update': async (input) => {
      const before = ctx.store.getAgent(input.id);
      if (!before) throw new Error('That agent no longer exists.');

      // Model and external agents validate their provider / connection the
      // same way on edit as on creation.
      if (!isCliRuntime(before.runtimeType) && (input.patch.config || input.a2aToken !== undefined)) {
        const shaped = await shapeAgentConfig(ctx, {
          runtimeType: before.runtimeType,
          workingDirectory: '',
          permissions: input.patch.permissions ?? before.permissions,
          config: { ...before.config, ...(input.patch.config ?? {}) },
          a2aToken: input.a2aToken,
          existingSecretId: before.config.a2a?.secretId ?? null,
          previousA2A: before.config.a2a ?? null,
        });
        input.patch.config = shaped.config;
        input.patch.permissions = shaped.permissions;
        input.patch.workingDirectory = shaped.workingDirectory;
      }

      if (input.patch.name && input.patch.name !== before.name) {
        const clash = ctx.store.getAgentByName(input.patch.name);
        if (clash && clash.id !== input.id) {
          throw new Error(`An agent named "${input.patch.name}" already exists.`);
        }
      }

      const movingDirectory =
        input.patch.workingDirectory !== undefined &&
        input.patch.workingDirectory !== before.workingDirectory;

      const agent = ctx.store.updateAgent(input.id, input.patch);

      // A native session belongs to the directory it was started in, so moving
      // the agent invalidates it rather than silently resuming somewhere else.
      if (movingDirectory) {
        const dropped = ctx.store.clearAgentSessions(input.id);
        if (dropped > 0) {
          emit(ctx, {
            type: 'notice',
            level: 'info',
            title: `${agent.name} moved`,
            detail: `New working directory. ${dropped} saved session${
              dropped === 1 ? '' : 's'
            } cleared, so the next run starts fresh.`,
          });
        }
      }

      emit(ctx, { type: 'agent', agent });
      return agent;
    },

    'agents:delete': (input) => {
      const agent = ctx.store.getAgent(input.id);
      ctx.orchestrator.cancelConversation(input.id);
      ctx.secrets.delete(agent?.config.a2a?.secretId);
      ctx.store.deleteAgent(input.id);
      emit(ctx, { type: 'agent-deleted', agentId: input.id });
      return { ok: true as const };
    },

    'agents:plugins': () => discoverPlugins(),

    /**
     * A copy with its own identity: same model, instructions and tool grants,
     * but a new name, its own DM and its own conversation memory.
     */
    'agents:duplicate': (input) => {
      const source = ctx.store.getAgent(input.id);
      if (!source) throw new Error('That agent no longer exists.');
      let name = `${source.name} copy`;
      for (let n = 2; ctx.store.getAgentByName(name); n += 1) name = `${source.name} copy ${n}`;

      // An external agent's credential is copied into a secret of its own, so
      // deleting either agent never strands the other.
      let config: AgentConfig = source.config;
      if (source.config.a2a?.secretId) {
        const secret = ctx.secrets.read(source.config.a2a.secretId);
        const secretId = Object.keys(secret).length ? ctx.secrets.create(secret) : null;
        config = { ...source.config, a2a: { ...source.config.a2a, secretId } };
      }

      const agent = ctx.store.createAgent({
        name: name.slice(0, 64),
        description: source.description,
        runtimeType: source.runtimeType,
        avatar: source.avatar,
        avatarColor: source.avatarColor,
        workingDirectory: source.workingDirectory,
        permissions: source.permissions,
        config,
      });
      ctx.integrations.copyGrants(source.id, agent.id);

      const dm = ctx.store.createConversation({
        kind: 'dm',
        name: agent.name,
        topic: null,
        memberAgentIds: [agent.id],
        humanMemberId: LOCAL_USER_ID,
      });
      emit(ctx, { type: 'agent', agent });
      emit(ctx, { type: 'conversation', conversation: dm });
      emit(ctx, { type: 'grants', agentId: agent.id, grants: ctx.integrations.listGrants({ agentId: agent.id }) });
      return agent;
    },

    'agents:detectRuntime': async (input) => {
      const runtime = ctx.runtimes.get(input.runtimeType);
      if (!runtime) throw new Error(`No adapter for runtime "${input.runtimeType}".`);
      return runtime.detect();
    },

    /* -------------------------------------------------------- conversations */

    'conversations:list': () => ctx.store.listConversations(),

    'conversations:create': (input) => {
      const conversation = ctx.store.createConversation({
        kind: input.kind,
        name: input.name,
        topic: input.topic,
        icon: input.icon ?? null,
        memberAgentIds: input.memberAgentIds,
        humanMemberId: LOCAL_USER_ID,
      });
      emit(ctx, { type: 'conversation', conversation });
      return conversation;
    },

    'conversations:update': (input) => {
      const conversation = ctx.store.updateConversation(input.id, input.patch);
      emit(ctx, { type: 'conversation', conversation });
      return conversation;
    },

    'conversations:delete': (input) => {
      ctx.orchestrator.cancelConversation(input.id);
      ctx.store.deleteConversation(input.id);
      ctx.attachments.removeConversation(input.id);
      emit(ctx, { type: 'conversation-deleted', conversationId: input.id });
      return { ok: true as const };
    },

    'conversations:members': (input) => ctx.store.listMembers(input.conversationId),

    'conversations:addAgent': (input) => {
      ctx.store.addAgentToConversation(input.conversationId, input.agentId);
      emit(ctx, { type: 'members-changed', conversationId: input.conversationId });
      return { ok: true as const };
    },

    'conversations:removeAgent': (input) => {
      ctx.store.removeAgentFromConversation(input.conversationId, input.agentId);
      emit(ctx, { type: 'members-changed', conversationId: input.conversationId });
      return { ok: true as const };
    },

    /* ------------------------------------------------------------- messages */

    'messages:list': (input) =>
      ctx.store.listMessages(input.conversationId, input.limit, input.before),

    // Images are checked here, before anything is stored or any agent woken.
    'messages:send': (input) =>
      ctx.orchestrator.handleHumanMessage(input.conversationId, input.body, prepareImages(input.images)),

    /* ---------------------------------------------------------------- tasks */

    'tasks:list': (input) => ctx.store.listTasks(input.conversationId),

    'tasks:create': (input) => {
      const task = ctx.store.createTask(input);
      emit(ctx, { type: 'task', task });
      return task;
    },

    'tasks:update': (input) => {
      const task = ctx.store.updateTask(input.id, input.patch);
      emit(ctx, { type: 'task', task });
      return task;
    },

    'tasks:delete': (input) => {
      ctx.store.deleteTask(input.id);
      emit(ctx, { type: 'task-deleted', taskId: input.id });
      return { ok: true as const };
    },

    /* ----------------------------------------------------------- executions */

    'executions:active': () => ctx.store.listActiveExecutions(),

    'executions:forConversation': (input) =>
      ctx.store.listExecutionsForConversation(input.conversationId),

    'executions:events': (input) => ctx.store.listEvents(input.executionId),

    /* ------------------------------------------------------------- activity */

    'activity:list': (input) => ({
      activities: ctx.activity.listActivities(input.conversationId),
      reactions: ctx.activity.listReactions(input.conversationId),
    }),

    'activity:live': () => ctx.activity.listActiveActivities(),

    // The user's reactions live in their own table and are never read by the
    // orchestrator: reacting with 👀 cannot wake or steer an agent, and agent
    // activity cannot be removed from here.
    'reactions:toggle': (input) => {
      const message = ctx.store.getMessage(input.messageId);
      if (!message) throw new Error('Message not found.');
      if (message.kind !== 'chat' && message.kind !== 'task_update' && message.kind !== 'execution_error') {
        throw new Error('This message cannot be reacted to.');
      }
      const reactions = ctx.activity.toggleReaction({
        messageId: message.id,
        conversationId: message.conversationId,
        userId: LOCAL_USER_ID,
        emoji: input.emoji,
      });
      ctx.emit({ type: 'reactions', conversationId: message.conversationId, messageId: message.id, reactions });
      return reactions;
    },

    'executions:cancel': (input) => {
      ctx.orchestrator.cancelExecution(input.executionId);
      return { ok: true as const };
    },

    'executions:cancelConversation': (input) => ({
      cancelled: ctx.orchestrator.cancelConversation(input.conversationId),
    }),

    /* ------------------------------------------------------------ workspace */

    'workspace:pickDirectory': async () => {
      const window = ctx.mainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, {
            properties: ['openDirectory', 'createDirectory'],
            title: 'Choose a working directory',
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });

      return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
    },

    // Attachments are references, not uploads: agents work on this machine's
    // filesystem, so the message carries the path and the agent reads it.
    'workspace:pickFiles': async () => {
      const window = ctx.mainWindow();
      const options: Electron.OpenDialogOptions = {
        properties: ['openFile', 'multiSelections'],
        title: 'Attach files',
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return { paths: result.canceled ? [] : result.filePaths.slice(0, 20) };
    },

    'workspace:locks': () => ctx.locks.list(),

    /* ------------------------------------------------------------- settings */

    'settings:get': () => ctx.getSettings(),

    'settings:update': (patch) => {
      const current = ctx.getSettings();
      return ctx.setSettings({
        ...current,
        ...patch,
        limits: { ...DEFAULT_LIMITS, ...current.limits, ...(patch.limits ?? {}) },
      });
    },

    /* ---------------------------------------------------------------- costs */

    'costs:summary': () => ctx.store.costSummary(),

    /* ------------------------------------------------------------ providers */

    'providers:list': () => ctx.providers.list(),
    'providers:create': (input) => ctx.providers.create(input),
    'providers:update': (input) => ctx.providers.update(input.id, input.input),
    'providers:delete': (input) => {
      ctx.providers.delete(input.id);
      return { ok: true as const };
    },
    'providers:test': async (input) => {
      if (input.draft) return ctx.providers.testDraft(input.draft, input.id);
      if (input.id) return ctx.providers.test(input.id);
      throw new Error('Nothing to test.');
    },
    'providers:discover': (input) => ctx.providers.discover(input.id),
    'providers:setModels': (input) => ctx.providers.setModels(input.id, input.models),

    /* ---------------------------------------------------------- MCP servers */

    'mcp:list': () => ctx.mcp.list(),
    'mcp:create': (input) => ctx.mcp.create(input),
    'mcp:update': (input) => ctx.mcp.update(input.id, input.input),
    'mcp:delete': async (input) => {
      const affected = ctx.integrations.listGrants({ serverId: input.id }).map((g) => g.agentId);
      await ctx.mcp.delete(input.id);
      for (const agentId of new Set(affected)) {
        emit(ctx, { type: 'grants', agentId, grants: ctx.integrations.listGrants({ agentId }) });
      }
      return { ok: true as const };
    },
    'mcp:connect': (input) => ctx.mcp.connect(input.id, { interactive: true }),
    'mcp:disconnect': async (input) => {
      await ctx.mcp.disconnect(input.id);
      const view = ctx.mcp.get(input.id);
      if (!view) throw new Error('That MCP server no longer exists.');
      return view;
    },
    'mcp:reconnect': (input) => ctx.mcp.reconnect(input.id),

    /* ---------------------------------------------------------- tool grants */

    'grants:list': (input) => ctx.integrations.listGrants(input),
    'grants:set': (input) => {
      if (!ctx.store.getAgent(input.agentId)) throw new Error('That agent no longer exists.');
      for (const grant of input.grants) {
        if (!ctx.integrations.getMcpServer(grant.serverId)) throw new Error('One of those MCP servers no longer exists.');
      }
      const grants = ctx.integrations.setAgentGrants(input.agentId, input.grants);
      emit(ctx, { type: 'grants', agentId: input.agentId, grants });
      return grants;
    },

    /* ------------------------------------------------------ external agents */

    'a2a:inspect': async (input) =>
      (await inspectAgentCard(input.cardUrl, { allowInsecure: input.allowInsecure })).summary,
  };

  for (const channel of Object.keys(INVOKE_SCHEMAS) as InvokeChannel[]) {
    ipcMain.handle(channel, async (_event, rawPayload: unknown) => {
      const schema = INVOKE_SCHEMAS[channel];
      const parsed = schema.safeParse(rawPayload === undefined ? undefined : rawPayload);

      if (!parsed.success) {
        throw new Error(
          `Invalid payload for "${channel}": ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
            .join('; ')}`,
        );
      }

      try {
        const handler = handlers[channel] as Handler<InvokeChannel>;
        return await handler(parsed.data as never);
      } catch (error) {
        // Surface a readable message; keep the stack in the main process log.
        console.error(`[ipc] ${channel} failed:`, error);
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    });
  }
}

/**
 * Normalises an agent's runtime-specific configuration, the same way on
 * create and edit. CLI agents need a working directory; model agents need a
 * provider that exists and a model; external agents get their endpoint pinned
 * from their own Agent Card (re-read here, never taken from the renderer) and
 * their credential moved into the secret store.
 */
async function shapeAgentConfig(
  ctx: IpcContext,
  input: {
    runtimeType: RuntimeType;
    workingDirectory: string;
    permissions: Agent['permissions'];
    config: AgentConfig;
    a2aToken: string | undefined;
    existingSecretId: string | null;
    /** The connection as it was, so an unchanged URL needs no network round trip. */
    previousA2A: A2AConfig | null;
  },
): Promise<Pick<Agent, 'workingDirectory' | 'permissions' | 'config'>> {
  const { runtimeType, config } = input;

  if (isCliRuntime(runtimeType)) {
    if (!input.workingDirectory.trim()) throw new Error('Choose a working directory for this agent.');
    return { workingDirectory: input.workingDirectory, permissions: input.permissions, config };
  }

  // Agents without a working directory never touch the filesystem through
  // this app, so they never contend for the workspace lock.
  const permissions = { ...input.permissions, workspaceAccess: 'read_only' as const };

  if (runtimeType === 'model') {
    if (!config.providerId || !ctx.providers.get(config.providerId)) {
      throw new Error('Choose a provider for this agent.');
    }
    if (!config.model?.trim()) throw new Error('Choose or enter a model id.');
    const { a2a: _drop, ...rest } = config;
    return { workingDirectory: '', permissions, config: { ...rest, model: config.model.trim() } };
  }

  // runtimeType === 'a2a'
  const requested = config.a2a;
  if (!requested?.cardUrl) throw new Error('Enter the external agent\'s URL.');

  // Same card URL and TLS policy as before: keep the endpoint the user already
  // approved (so an agent that is offline can still be renamed). A different
  // URL means reading the new card and pinning whatever it declares.
  const previous = input.previousA2A;
  const unchanged =
    previous && previous.cardUrl === requested.cardUrl.trim() && previous.allowInsecure === requested.allowInsecure;
  const pinned = unchanged
    ? {
        endpointUrl: previous.endpointUrl,
        streaming: previous.streaming,
        protocolVersion: previous.protocolVersion,
        remoteName: previous.remoteName,
        resolvedCardUrl: previous.cardUrl,
      }
    : await (async () => {
        const { summary, resolvedCardUrl } = await inspectAgentCard(requested.cardUrl, {
          allowInsecure: requested.allowInsecure,
        });
        if (summary.problem) throw new Error(summary.problem);
        return {
          endpointUrl: summary.endpointUrl,
          streaming: summary.streaming,
          protocolVersion: summary.protocolVersion,
          remoteName: summary.name,
          resolvedCardUrl,
        };
      })();

  let secretId = input.existingSecretId;
  if (input.a2aToken !== undefined) {
    const token = input.a2aToken.trim();
    if (token) secretId = ctx.secrets.put(secretId, { token });
    else {
      ctx.secrets.delete(secretId);
      secretId = null;
    }
  }

  const a2a: A2AConfig = {
    cardUrl: pinned.resolvedCardUrl,
    endpointUrl: pinned.endpointUrl,
    authMethod: requested.authMethod,
    authHeaderName: requested.authMethod === 'header' ? (requested.authHeaderName?.trim() || null) : null,
    secretId,
    streaming: pinned.streaming,
    allowInsecure: requested.allowInsecure,
    protocolVersion: pinned.protocolVersion,
    remoteName: pinned.remoteName,
  };
  if (a2a.authMethod === 'header' && !a2a.authHeaderName) throw new Error('Name the header that carries the credential.');
  const { providerId: _p, temperature: _t, maxOutputTokens: _m, ...rest } = config;
  return { workingDirectory: '', permissions, config: { ...rest, a2a } };
}

export function removeIpcHandlers(): void {
  for (const channel of Object.keys(INVOKE_SCHEMAS)) ipcMain.removeHandler(channel);
}

function emit(ctx: IpcContext, event: AppEvent): void {
  ctx.mainWindow()?.webContents.send(EVENT_CHANNEL, event);
}
