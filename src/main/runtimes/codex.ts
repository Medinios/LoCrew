import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { missingImagesNote } from './images.js';
import type {
  Codex,
  SandboxMode,
  Thread,
  ThreadEvent,
  ThreadOptions,
  Usage,
} from '@openai/codex-sdk';
import type { RuntimeDetection, WorkspaceAccess } from '../../shared/types.js';
import type { AgentRuntime, ContextImage, InstallCheck, RuntimeEvent, RuntimeExecuteContext } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * The Codex SDK is ESM-only and the main process bundle is CommonJS, so it is
 * pulled in with a dynamic import, cached after first use.
 */
let CodexCtor: typeof import('@openai/codex-sdk').Codex | null = null;

async function loadCodex(): Promise<typeof import('@openai/codex-sdk').Codex> {
  if (!CodexCtor) {
    const sdk = await import('@openai/codex-sdk');
    CodexCtor = sdk.Codex;
  }
  return CodexCtor;
}

/** Env var name that carries this agent's gateway token to the Codex process. */
export function gatewayTokenEnvVar(agentId: string): string {
  return `LOCREW_TOKEN_${agentId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

/**
 * `@openai/codex-sdk` depends on `@openai/codex`, which ships the CLI as a
 * vendored per-platform binary. The SDK resolves it through the module graph,
 * so Codex works without any global install -- and, critically, without being
 * on PATH. Detection must resolve it the same way, or a packaged build would
 * report "not installed" for a runtime that ships inside it.
 *
 * Mirrors the SDK's own lookup (@openai/codex-sdk/dist/index.js).
 */
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

function targetTriple(): string | null {
  const arch = process.arch;
  switch (process.platform) {
    case 'linux':
      if (arch === 'x64') return 'x86_64-unknown-linux-musl';
      if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
      return null;
    case 'darwin':
      if (arch === 'x64') return 'x86_64-apple-darwin';
      if (arch === 'arm64') return 'aarch64-apple-darwin';
      return null;
    case 'win32':
      if (arch === 'x64') return 'x86_64-pc-windows-msvc';
      if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
      return null;
    default:
      return null;
  }
}

export interface CodexBinary {
  path: string;
  /** 'bundled' ships with the app; 'path' is a separate install on PATH. */
  source: 'bundled' | 'path';
}

/** Absolute path to the vendored CLI, or null when it is not resolvable. */
export function resolveBundledCodex(): string | null {
  const triple = targetTriple();
  if (!triple) return null;

  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[triple];
  if (!platformPackage) return null;

  try {
    const selfRequire = createRequire(__filename);
    const codexPackageJson = selfRequire.resolve('@openai/codex/package.json');
    const codexRequire = createRequire(codexPackageJson);
    const platformPackageJson = codexRequire.resolve(`${platformPackage}/package.json`);
    const vendorRoot = join(dirname(platformPackageJson), 'vendor');

    const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const packageRoot = join(vendorRoot, triple);

    for (const candidate of [
      join(packageRoot, 'bin', binaryName),
      join(packageRoot, 'codex', binaryName),
    ]) {
      // A packaged build serves these from app.asar.unpacked; see the
      // asarUnpack entry in package.json.
      if (existsSync(candidate)) return candidate;
      const unpacked = candidate.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
      if (unpacked !== candidate && existsSync(unpacked)) return unpacked;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Prefers the binary that ships with the SDK, and falls back to a separate
 * install on PATH. The bundled copy is checked first so detection agrees with
 * whatever the SDK will actually spawn.
 */
export async function findCodexBinary(): Promise<CodexBinary | null> {
  const bundled = resolveBundledCodex();
  if (bundled) return { path: bundled, source: 'bundled' };

  try {
    await execFileAsync('codex', ['--version'], {
      timeout: 15_000,
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    return { path: 'codex', source: 'path' };
  } catch {
    return null;
  }
}

async function readVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version'], {
      timeout: 15_000,
      windowsHide: true,
      shell: binaryPath === 'codex' && process.platform === 'win32',
    });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Drives the local Codex CLI through the official Codex SDK, which spawns the
 * binary and therefore uses the existing login.
 *
 * Two capabilities the Claude adapter gets for free are absent here and are
 * emulated:
 *  - Codex threads take no system prompt, so the persona is prepended to the
 *    first turn of a thread and the orchestrator marks the thread as seeded.
 *  - Codex exposes no turn or budget ceiling, so this adapter enforces the
 *    spend limit itself from the usage reported on each completed turn.
 */
export class CodexAdapter implements AgentRuntime {
  readonly runtimeType = 'codex' as const;
  /** Streams output and reports every tool call, so reading, thinking and working are observable. */
  readonly activityProfile = 'detailed' as const;

  async detectInstall(): Promise<InstallCheck> {
    const binary = await findCodexBinary();
    if (!binary) {
      return {
        installed: false,
        version: null,
        location: null,
        message:
          'The Codex CLI could not be located. It normally ships with this app; reinstall dependencies with "npm install", or install it separately with "npm i -g @openai/codex".',
      };
    }

    const version = await readVersion(binary.path);
    const where =
      binary.source === 'bundled' ? 'bundled with this app' : `${binary.path} (on PATH)`;

    return {
      installed: true,
      version,
      location: where,
      message: `Codex ${version ?? ''} is available (${where}).`.replace('  ', ' '),
    };
  }

  async detect(): Promise<RuntimeDetection> {
    const install = await this.detectInstall();

    if (!install.installed) {
      return {
        runtimeType: this.runtimeType,
        installed: false,
        version: null,
        location: null,
        authenticated: false,
        message: install.message,
      };
    }

    const version = install.version;
    const where = install.location ?? 'unknown location';

    const auth = await this.probeAuth();
    return {
      runtimeType: this.runtimeType,
      installed: true,
      version,
      location: where,
      authenticated: auth.ok,
      message: auth.ok
        ? `Codex ${version ?? ''} is available (${where}) and signed in.`.replace('  ', ' ')
        : `Codex ${version ?? ''} is available (${where}) but is not signed in: ${auth.detail} Run "codex" in a terminal and sign in, then re-check.`.replace(
            '  ',
            ' ',
          ),
    };
  }

  private async probeAuth(): Promise<{ ok: boolean; detail: string }> {
    try {
      const Codex = await loadCodex();
      const binary = await findCodexBinary();
      const codex = new Codex(
        binary?.source === 'path' ? { codexPathOverride: binary.path } : {},
      );
      const thread = codex.startThread({
        sandboxMode: 'read-only',
        skipGitRepoCheck: true,
      });
      const turn = await thread.run('Reply with the single word: ok');
      if (turn.finalResponse && turn.finalResponse.trim().length > 0) {
        return { ok: true, detail: '' };
      }
      return { ok: false, detail: 'the runtime produced no response.' };
    } catch (error) {
      return { ok: false, detail: `${asMessage(error)}.` };
    }
  }

  async *execute(ctx: RuntimeExecuteContext): AsyncIterable<RuntimeEvent> {
    const tokenVar = gatewayTokenEnvVar(ctx.agent.id);
    // The SDK spawns `codex` as a child of this process, so exporting the token
    // here is how the CLI resolves `bearer_token_env_var`. Tokens are minted per
    // app launch and never written to disk.
    process.env[tokenVar] = ctx.gateway.token;

    let codex: Codex;
    let thread: Thread;
    try {
      const Codex = await loadCodex();
      // When the CLI only exists on PATH, the SDK's own module-graph lookup
      // would fail, so the resolved path is handed to it explicitly.
      const binary = await findCodexBinary();
      codex = new Codex({
        ...(binary?.source === 'path' ? { codexPathOverride: binary.path } : {}),
        config: {
          mcp_servers: {
            [ctx.gateway.serverName]: {
              url: ctx.gateway.url,
              bearer_token_env_var: tokenVar,
              // Codex demands approval for every MCP tool that is not
              // annotated read-only -- here, send_message and update_task.
              // The SDK exposes no approval event, so under approvalPolicy
              // 'never' those calls came back as "MCP tool call requires
              // approval, but approval policy is never": a Codex agent could
              // read the deck but never answer on it.
              //
              // Approving is scoped to this one server and gives up no real
              // control. The gateway resolves the sender from the bearer
              // token, and the orchestrator still enforces the autonomy
              // flags, the per-agent permissions and the chain limits when
              // the message is delivered. Workspace reads, writes and
              // commands are unaffected: those remain governed by
              // sandboxMode and approvalPolicy below.
              default_tools_approval_mode: 'approve',
            },
            // MCP tools the operator granted this agent. Approving at the
            // Codex level is safe for the same reason: the gateway's tool
            // proxy checks the grant on every call and asks the operator
            // itself when the grant is "ask first".
            ...(ctx.gateway.hasToolGrants
              ? {
                  [ctx.gateway.toolsServerName]: {
                    url: ctx.gateway.toolsUrl,
                    bearer_token_env_var: tokenVar,
                    default_tools_approval_mode: 'approve',
                  },
                }
              : {}),
          },
        },
      });

      const threadOptions: ThreadOptions = {
        workingDirectory: ctx.workingDirectory,
        sandboxMode: toSandboxMode(ctx.workspaceAccess),
        approvalPolicy: ctx.workspaceAccess === 'approval_required' ? 'on-request' : 'never',
        skipGitRepoCheck: true,
        ...(ctx.agent.config.model ? { model: ctx.agent.config.model } : {}),
        ...(ctx.agent.config.effort ? { modelReasoningEffort: ctx.agent.config.effort } : {}),
      };

      thread = ctx.resumeSessionId
        ? codex.resumeThread(ctx.resumeSessionId, threadOptions)
        : codex.startThread(threadOptions);
    } catch (error) {
      yield { type: 'error', message: `Failed to start Codex: ${asMessage(error)}`, fatal: true };
      return;
    }

    // Codex has no system-prompt channel, so a brand new thread is seeded with
    // the persona ahead of the real instruction. Images go as local files,
    // which Codex reads and sends to the model itself.
    const text = ctx.resumeSessionId
      ? ctx.prompt
      : `${ctx.systemPrompt}\n\n---\n\n${ctx.prompt}`;
    const input = codexInput(text, ctx.images, existsSync);

    // Codex reports tokens, not dollars, so cost is derived from the model's
    // published rates. Resolved once per execution rather than per event.
    const prices = pricesForModel(ctx.agent.config.model);

    let streamed: { events: AsyncGenerator<ThreadEvent> };
    try {
      streamed = await thread.runStreamed(input);
    } catch (error) {
      yield { type: 'error', message: asMessage(error), fatal: true };
      return;
    }

    let sessionReported = false;
    // Codex reports usage per completed turn, but a `cost` RuntimeEvent is a
    // running total by contract. Accumulating here is what keeps multi-turn
    // Codex runs from reporting only their final turn -- which would also have
    // let a run sail past its spend ceiling.
    let spentUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let turns = 0;

    try {
      for await (const event of streamed.events) {
        if (ctx.abortSignal.aborted) break;

        if (!sessionReported && thread.id) {
          sessionReported = true;
          yield { type: 'session', sessionId: thread.id };
        }

        for (const translated of translate(event, prices)) {
          if (translated.type === 'cost') {
            spentUsd += translated.costUsd;
            inputTokens += translated.inputTokens;
            outputTokens += translated.outputTokens;
            turns += 1;
            yield { type: 'cost', costUsd: spentUsd, inputTokens, outputTokens, turns };
            continue;
          }
          yield translated;
        }

        // Budget enforcement, which Codex does not provide natively.
        if (ctx.maxCostUsd > 0 && spentUsd >= ctx.maxCostUsd) {
          yield {
            type: 'error',
            message: `The agent reached its spend limit for this execution (estimated $${spentUsd.toFixed(
              4,
            )}).`,
            fatal: true,
          };
          break;
        }
      }

      if (!sessionReported && thread.id) {
        yield { type: 'session', sessionId: thread.id };
      }
    } catch (error) {
      if (!ctx.abortSignal.aborted) {
        yield { type: 'error', message: asMessage(error), fatal: true };
      }
    } finally {
      // Closing the generator lets the SDK tear down the child process. Codex
      // exposes no explicit interrupt, so this is the cancellation path.
      await streamed.events.return?.(undefined as never).catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    // Stateless: threads are created per execution.
  }
}

function toSandboxMode(access: WorkspaceAccess): SandboxMode {
  switch (access) {
    case 'read_only':
      return 'read-only';
    case 'read_write':
      return 'workspace-write';
    case 'approval_required':
      // Writes are allowed by the sandbox but gated by approvalPolicy.
      return 'workspace-write';
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** USD per million tokens. Cached input is billed at a lower rate than fresh. */
export interface TokenPrices {
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * Rough price table used only to turn Codex's token counts into the same
 * dollar figure the Claude adapter reports natively. Codex does not return a
 * cost, so this is an estimate for budgeting, never a billing statement, and
 * it goes stale whenever OpenAI reprices. This table is the one place to edit.
 *
 * Matched as prefixes of the configured model, so the longer keys come first.
 */
const PRICES_BY_MODEL_PREFIX: ReadonlyArray<readonly [string, TokenPrices]> = [
  ['gpt-5-nano', { input: 0.05, cachedInput: 0.005, output: 0.4 }],
  ['gpt-5-mini', { input: 0.25, cachedInput: 0.025, output: 2 }],
  ['gpt-5', { input: 1.25, cachedInput: 0.125, output: 10 }],
];

/** What Codex bills at unless the agent names a model, and the fallback for an unknown one. */
export const DEFAULT_TOKEN_PRICES: TokenPrices = { input: 1.25, cachedInput: 0.125, output: 10 };

export function pricesForModel(model: string | null | undefined): TokenPrices {
  if (!model) return DEFAULT_TOKEN_PRICES;
  const normalised = model.trim().toLowerCase();
  for (const [prefix, prices] of PRICES_BY_MODEL_PREFIX) {
    if (normalised.startsWith(prefix)) return prices;
  }
  return DEFAULT_TOKEN_PRICES;
}

/** Non-negative finite token count, because these figures come off the wire. */
function tokenCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Estimated dollar cost of one Codex turn.
 *
 * Codex counts cached tokens inside `input_tokens`, so the fresh portion is the
 * difference; the cached portion is clamped to the total in case a future SDK
 * reports them separately.
 */
export function estimateTurnCostUsd(usage: Usage | null | undefined, prices: TokenPrices): number {
  const input = tokenCount(usage?.input_tokens);
  const cached = Math.min(tokenCount(usage?.cached_input_tokens), input);
  const output = tokenCount(usage?.output_tokens);

  return (
    ((input - cached) * prices.input + cached * prices.cachedInput + output * prices.output) /
    1_000_000
  );
}

function* translate(event: ThreadEvent, prices: TokenPrices): Generator<RuntimeEvent> {
  switch (event.type) {
    case 'thread.started':
      return;

    case 'turn.started':
      yield { type: 'state', state: 'thinking' };
      return;

    case 'turn.completed': {
      const usage = event.usage;
      if (usage) {
        // Per turn; execute() accumulates these into the running total that a
        // `cost` event is defined as.
        yield {
          type: 'cost',
          costUsd: estimateTurnCostUsd(usage, prices),
          inputTokens: tokenCount(usage.input_tokens),
          outputTokens: tokenCount(usage.output_tokens),
        };
      }
      return;
    }

    case 'turn.failed':
      yield {
        type: 'error',
        message: event.error?.message ?? 'The Codex turn failed.',
        fatal: true,
      };
      return;

    case 'error':
      yield {
        type: 'error',
        message: event.message ?? 'Codex reported an error.',
        fatal: true,
      };
      return;

    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = event.item;
      if (!item) return;

      switch (item.type) {
        case 'agent_message':
          if (event.type === 'item.completed' && item.text) {
            yield { type: 'text', text: item.text };
          }
          return;

        case 'reasoning':
          if (event.type === 'item.completed' && item.text) {
            yield { type: 'thinking', text: item.text };
          }
          return;

        case 'command_execution':
          if (event.type === 'item.started') {
            yield {
              type: 'tool_use',
              toolUseId: item.id ?? null,
              name: 'Shell',
              input: { command: item.command },
            };
          } else if (event.type === 'item.completed') {
            yield {
              type: 'tool_result',
              toolUseId: item.id ?? null,
              summary: truncate(item.aggregated_output ?? ''),
              isError: item.status === 'failed',
            };
          }
          return;

        case 'file_change':
          if (event.type === 'item.completed') {
            const files = (item.changes ?? [])
              .map((c) => `${c.kind}: ${c.path}`)
              .join('\n');
            yield {
              type: 'tool_result',
              toolUseId: item.id ?? null,
              summary: truncate(files),
              isError: item.status === 'failed',
            };
          } else if (event.type === 'item.started') {
            yield {
              type: 'tool_use',
              toolUseId: item.id ?? null,
              name: 'ApplyPatch',
              input: { changes: item.changes },
            };
          }
          return;

        case 'mcp_tool_call':
          if (event.type === 'item.started') {
            yield {
              type: 'tool_use',
              toolUseId: item.id ?? null,
              name: `mcp__${item.server}__${item.tool}`,
              input: (item.arguments as Record<string, unknown> | undefined) ?? {},
            };
          } else if (event.type === 'item.completed') {
            const failed = item.status === 'failed';
            yield {
              type: 'tool_result',
              toolUseId: item.id ?? null,
              summary: failed
                ? (item.error?.message ?? 'MCP tool call failed.')
                : summariseMcpResult(item.result),
              isError: failed,
            };
          }
          return;

        case 'error':
          if (event.type === 'item.completed') {
            yield { type: 'error', message: item.message ?? 'Codex item error.', fatal: false };
          }
          return;

        default:
          return;
      }
    }

    default:
      return;
  }
}

function summariseMcpResult(result: { content?: unknown } | undefined): string {
  if (!result || !Array.isArray(result.content)) return 'MCP tool call completed.';
  const text = result.content
    .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
    .filter(Boolean)
    .join('\n');
  return truncate(text || 'MCP tool call completed.');
}

function truncate(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}\n... (truncated)` : text;
}

/**
 * The turn for Codex: plain text, or text plus each image as a `local_image`
 * input. Files that no longer exist are named in the text instead of breaking
 * the run.
 */
export function codexInput(
  text: string,
  images: ContextImage[],
  exists: (path: string) => boolean,
): string | Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> {
  if (!images.length) return text;
  const present = images.filter((image) => exists(image.path));
  const missing = images.filter((image) => !exists(image.path));
  const withNote = text + missingImagesNote(missing);
  if (!present.length) return withNote;
  return [{ type: 'text', text: withNote }, ...present.map((image) => ({ type: 'local_image' as const, path: image.path }))];
}
