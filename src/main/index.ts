import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, protocol, safeStorage, shell } from 'electron';
import { EVENT_CHANNEL, type AppEvent } from '../shared/ipc.js';
import type { AppSettings, RuntimeType } from '../shared/types.js';
import { DEFAULT_LIMITS } from '../shared/types.js';
import { openDatabase, type OpenDbResult } from './db/index.js';
import { IntegrationStore } from './db/integration-store.js';
import { Store } from './db/store.js';
import { GatewayServer } from './gateway/server.js';
import { registerIpcHandlers, removeIpcHandlers } from './ipc/handlers.js';
import { AgentActivityManager } from './activity/manager.js';
import { ImageAttachmentStore } from './attachments/images.js';
import { ActivityStore } from './db/activity-store.js';
import { McpClientManager, type LaunchApprovalRequest } from './mcp/manager.js';
import { ToolAccessService } from './mcp/tool-access.js';
import { ProviderRegistry } from './providers/registry.js';
import { A2ARuntime } from './runtimes/a2a.js';
import { ModelAgentRuntime } from './runtimes/model-agent.js';
import { SecretStore, safeStorageCipher } from './security/secrets.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { ClaudeCodeAdapter } from './runtimes/claude-code.js';
import { CodexAdapter } from './runtimes/codex.js';
import type { AgentRuntime, ApprovalDecision, ApprovalRequest } from './runtimes/types.js';
import { WorkspaceLockManager } from './workspace/locks.js';
import { databasePath, legacyUserDataDir } from './user-data.js';
import {
  LOCAL_IMAGE_SCHEME,
  pathFromImageUrl,
  resolveLocalImage,
} from './workspace/local-images.js';

// Locrew was called AgentWorkspace. An existing install keeps its data folder
// (see user-data.ts); an explicit --user-data-dir, as the tests pass, wins.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const legacy = legacyUserDataDir(app.getPath('appData'));
  if (legacy) app.setPath('userData', legacy);
}

// Must happen before the app is ready. A standard, secure scheme is what lets
// the renderer's CSP name it and load images from it like any other origin.
protocol.registerSchemesAsPrivileged([
  { scheme: LOCAL_IMAGE_SCHEME, privileges: { standard: true, secure: true } },
]);

const isDev = !app.isPackaged;

/** This bundle is CommonJS (see electron.vite.config.ts). */
const moduleDir = __dirname;

let mainWindow: BrowserWindow | null = null;
let database: OpenDbResult | null = null;
let gateway: GatewayServer | null = null;
let orchestrator: Orchestrator | null = null;
let runtimeAdapters: Map<RuntimeType, AgentRuntime> | null = null;
let mcpManager: McpClientManager | null = null;

/** The OS account name, capitalised, as a starting display name. */
function defaultDisplayName(): string {
  try {
    const name = userInfo().username.trim();
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'You';
  } catch {
    return 'You';
  }
}

function defaultSettings(): AppSettings {
  return {
    displayName: defaultDisplayName(),
    defaultWorkspaceDirectory: app.getPath('documents'),
    limits: { ...DEFAULT_LIMITS },
    notifyOnAgentReply: false,
    notifyOnLimitReached: true,
    developerMode: false,
  };
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    // The midnight shell, so there is no flash of another colour on open.
    backgroundColor: '#111827',
    // Packaged builds take the icon from the executable (electron-builder
    // derives it from resources/icon.png); in development, point at it directly.
    ...(isDev && process.platform !== 'darwin' ? { icon: join(app.getAppPath(), 'resources', 'icon.png') } : {}),
    // The renderer draws its own title strip across the top of the window. On
    // macOS the traffic lights sit inset in it; on Windows and Linux the
    // native caption buttons are overlaid on its right-hand end.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 12 } }
      : { titleBarOverlay: { color: '#111827', symbolColor: '#CBD5E1', height: 36 } }),
    webPreferences: {
      preload: join(moduleDir, '../preload/index.js'),
      // The renderer is untrusted UI code: no Node, no remote module, isolated
      // context, and a real OS sandbox. Everything privileged goes over IPC.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Nothing in this app should open a second window or navigate away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL'];
    if (devServer && url.startsWith(devServer)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(moduleDir, '../renderer/index.html'));
  }

  return window;
}

/** Asks the operator to approve a mutating tool call from an agent. */
async function requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
  const store = database ? new Store(database.db) : null;
  const agent = store?.getAgent(request.agentId);
  const name = agent?.name ?? request.agentId;

  const detail = summariseToolInput(request.toolName, request.input);
  const window = mainWindow;
  if (!window) return { approved: false, reason: 'No window is available to ask the operator.' };

  const result = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: ['Deny', 'Allow once'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Approve agent operation',
    message: `${name} wants to run ${request.toolName}`,
    // Agents on a model provider or an external service have no directory.
    detail: agent?.workingDirectory ? `${detail}\n\nWorking directory: ${agent.workingDirectory}` : detail,
  });

  return result.response === 1
    ? { approved: true }
    : { approved: false, reason: 'The operator denied this operation.' };
}

/**
 * Asks the operator before a local MCP server is started. The security
 * guidance for MCP clients is explicit: show the exact command untruncated,
 * say that it runs with the user's own privileges, and require a decision.
 */
async function approveLaunch(request: LaunchApprovalRequest): Promise<boolean> {
  const window = mainWindow;
  const commandLine = [request.command, ...request.args.map(quoteArg)].join(' ');
  const detail = [
    'This starts a program on your computer. It runs with your user account\'s permissions and can read and change anything you can.',
    '',
    `Command:\n${commandLine}`,
    `Working directory: ${request.cwd || '(default)'}`,
    `Environment variables: ${request.envKeys.length ? request.envKeys.join(', ') : '(none)'}`,
    ...(request.warnings.length ? ['', 'Please note:', ...request.warnings.map((w) => `  - ${w}`)] : []),
    '',
    'Only continue if you trust this program. You will be asked again if the command changes.',
  ].join('\n');

  const options = {
    type: request.warnings.length ? ('warning' as const) : ('question' as const),
    buttons: ['Cancel', 'Launch'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Launch local MCP server',
    message: `Launch the MCP server "${request.serverName}"?`,
    detail,
  };
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}

function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg;
}

function summariseToolInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input['command'] === 'string') {
    return `Command:\n${truncate(input['command'])}`;
  }
  if (typeof input['file_path'] === 'string') {
    return `File: ${input['file_path']}`;
  }
  return truncate(JSON.stringify(input, null, 2));
}

function truncate(value: string, max = 1200): string {
  return value.length > max ? `${value.slice(0, max)}\n... (truncated)` : value;
}

/**
 * Marks every agent as reachable or not, using the cheap install probe.
 *
 * "unverified" is the honest state for a runtime that is present but whose
 * sign-in has not been exercised this session; the first execution promotes it
 * to "online" or demotes it to "error".
 */
async function refreshAgentAvailability(
  store: Store,
  runtimes: Map<RuntimeType, AgentRuntime>,
  emit: (event: AppEvent) => void,
): Promise<void> {
  const checks = new Map<RuntimeType, Awaited<ReturnType<AgentRuntime['detectInstall']>>>();

  for (const agent of store.listAgents()) {
    const runtime = runtimes.get(agent.runtimeType);
    if (!runtime) continue;

    // CLI runtimes are probed once per type; provider-backed and external
    // agents depend on their own configuration, so each is checked alone.
    let check = runtime.perAgentAvailability ? undefined : checks.get(agent.runtimeType);
    if (!check) {
      try {
        check = await runtime.detectInstall(agent);
      } catch (error) {
        check = {
          installed: false,
          version: null,
          location: null,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (!runtime.perAgentAvailability) checks.set(agent.runtimeType, check);
    }

    const status = check.installed ? 'unverified' : 'offline';
    if (agent.status === status && agent.statusDetail === check.message) continue;

    emit({ type: 'agent', agent: store.updateAgent(agent.id, { status, statusDetail: check.message }) });
  }
}

async function bootstrap(): Promise<void> {
  const dbPath = databasePath(app.getPath('userData'));
  const migrationsFolder = isDev
    ? join(app.getAppPath(), 'src/main/db/migrations')
    : join(process.resourcesPath, 'migrations');

  database = openDatabase(dbPath, migrationsFolder);
  const store = new Store(database.db);
  const integrations = new IntegrationStore(database.db);
  // API keys and tokens are encrypted with the OS keychain (DPAPI, Keychain,
  // libsecret). If none is available, saving a key fails rather than
  // falling back to plaintext.
  const secrets = new SecretStore(database.db, safeStorageCipher(safeStorage));

  const orphaned = store.reconcileOrphanedExecutions();
  if (orphaned > 0) {
    console.warn(`[startup] marked ${orphaned} interrupted execution(s) as failed.`);
  }

  // Activity reactions for runs the last session never finished: shown as
  // interrupted, never as completed.
  const activityStore = new ActivityStore(database.db);
  const activity = new AgentActivityManager({
    store: activityStore,
    emit: (event) => mainWindow?.webContents.send(EVENT_CHANNEL, event),
  });
  const interrupted = activity.reconcileInterrupted();
  if (interrupted.length > 0) {
    console.warn(`[startup] marked ${interrupted.length} activity reaction(s) as interrupted.`);
  }

  let settings = store.getSettings(defaultSettings());

  // Images sent with messages live in the app's own data folder, one folder
  // per conversation.
  const attachments = new ImageAttachmentStore(join(app.getPath('userData'), 'attachments'), store);

  const providers = new ProviderRegistry({
    integrations,
    secrets,
    emit: (event) => mainWindow?.webContents.send(EVENT_CHANNEL, event),
    agentsUsing: (providerId) =>
      store
        .listAgents()
        .filter((a) => a.runtimeType === 'model' && a.config.providerId === providerId)
        .map((a) => a.name),
  });

  const mcp = new McpClientManager({
    integrations,
    secrets,
    emit: (event) => mainWindow?.webContents.send(EVENT_CHANNEL, event),
    approveLaunch,
  });
  mcpManager = mcp;

  const runtimes = new Map<RuntimeType, AgentRuntime>([
    ['claude-code', new ClaudeCodeAdapter()],
    ['codex', new CodexAdapter()],
    ['model', new ModelAgentRuntime(providers)],
    ['a2a', new A2ARuntime(secrets)],
  ]);
  runtimeAdapters = runtimes;

  // One enforcement point for MCP tool permissions, used by every runtime
  // through the gateway's tool endpoint.
  const toolAccess = new ToolAccessService({
    integrations,
    manager: mcp,
    requestApproval: (agentId, request) => orchestrator!.requestToolApproval(agentId, request),
    signalFor: (agentId) => orchestrator!.signalFor(agentId),
    agentName: (agentId) => store.getAgent(agentId)?.name ?? agentId,
  });

  const locks = new WorkspaceLockManager();

  // Images agents reference by path, served read-only from their working
  // directories. See workspace/local-images.ts for what is refused and why.
  protocol.handle(LOCAL_IMAGE_SCHEME, async (request) => {
    const requested = pathFromImageUrl(request.url);
    if (!requested) return new Response('Bad request', { status: 400 });
    const roots = [
      ...store.listAgents().map((agent) => agent.workingDirectory),
      settings.defaultWorkspaceDirectory,
      attachments.directory,
    ];
    const result = await resolveLocalImage(requested, roots);
    if (!result.ok) return new Response(result.reason, { status: result.status });
    return new Response(await readFile(result.path), {
      headers: {
        'content-type': result.type,
        'x-content-type-options': 'nosniff',
        // An SVG opened on its own must not be able to run anything.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'cache-control': 'no-cache',
      },
    });
  });

  const emit = (event: AppEvent) => {
    mainWindow?.webContents.send(EVENT_CHANNEL, event);
  };

  // The orchestrator implements GatewayServices, and the gateway needs the
  // orchestrator, so the gateway is constructed with a lazy reference.
  const lazyServices = {
    getActiveContext: (id: string) => orchestrator!.getActiveContext(id),
    getAgent: (id: string) => orchestrator!.getAgent(id),
    isMember: (c: string, a: string) => orchestrator!.isMember(c, a),
    listMembers: (c: string) => orchestrator!.listMembers(c),
    readMessages: (c: string, l: number) => orchestrator!.readMessages(c, l),
    getConversationContext: (c: string) => orchestrator!.getConversationContext(c),
    sendAgentMessage: (i: Parameters<Orchestrator['sendAgentMessage']>[0]) =>
      orchestrator!.sendAgentMessage(i),
    updateTask: (i: Parameters<Orchestrator['updateTask']>[0]) => orchestrator!.updateTask(i),
    tools: toolAccess,
  };

  gateway = new GatewayServer(lazyServices);
  const port = await gateway.start();
  console.log(`[gateway] MCP server listening on 127.0.0.1:${port}`);

  orchestrator = new Orchestrator({
    store,
    gateway,
    runtimes,
    locks,
    emit,
    requestApproval,
    getSettings: () => settings,
    activity,
    attachments,
  });

  locks.onChange((current) => emit({ type: 'locks', locks: current }));

  // Reflect each agent's real availability instead of leaving the roster on
  // "offline", which reads as "broken". Install-only, so startup costs nothing;
  // sign-in is confirmed by the first execution.
  void refreshAgentAvailability(store, runtimes, emit);

  // Servers marked auto-connect come up in the background. This never prompts:
  // a stdio server whose command line is not yet approved simply waits for
  // the user to click Connect.
  void mcp.autoConnect();

  registerIpcHandlers({
    store,
    attachments,
    activity: activityStore,
    emit,
    integrations,
    secrets,
    providers,
    mcp,
    orchestrator,
    runtimes,
    locks,
    getSettings: () => settings,
    setSettings: (next) => {
      settings = store.saveSettings(next);
      return settings;
    },
    mainWindow: () => mainWindow,
  });
}

app.whenReady().then(async () => {
  // Deny every permission request: this app needs no camera, microphone,
  // geolocation or notifications from web content.
  const { session } = await import('electron');
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          isDev
            ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: aw-image:; connect-src 'self' ws: http://localhost:*"
            : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: aw-image:; connect-src 'self'",
        ],
      },
    });
  });

  try {
    await bootstrap();
  } catch (error) {
    console.error('[startup] failed:', error);
    dialog.showErrorBox(
      'Locrew failed to start',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
    return;
  }

  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (!orchestrator && !gateway && !database) return;
  event.preventDefault();

  try {
    await orchestrator?.shutdown();
    await mcpManager?.shutdown();
    await gateway?.stop();
    for (const runtime of runtimeAdapters?.values() ?? []) {
      await runtime.dispose();
    }
    database?.close();
  } finally {
    orchestrator = null;
    gateway = null;
    database = null;
    runtimeAdapters = null;
    mcpManager = null;
    removeIpcHandlers();
    app.quit();
  }
});
