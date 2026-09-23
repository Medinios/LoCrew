import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeDetection } from '../../shared/types.js';
import { loadImages, missingImagesNote, type LoadedImage } from './images.js';
import type { AgentRuntime, ContextImage, InstallCheck, RuntimeEvent, RuntimeExecuteContext } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * The Agent SDK is ESM-only and the main process bundle is CommonJS, so it is
 * pulled in with a dynamic import. The module is cached after the first call,
 * which also keeps it off the startup path until an agent actually runs.
 */
let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null;

async function loadQuery(): Promise<typeof import('@anthropic-ai/claude-agent-sdk').query> {
  if (!queryFn) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    queryFn = sdk.query;
  }
  return queryFn;
}

/**
 * Drives the locally installed Claude Code through the official Claude Agent
 * SDK. The SDK spawns the user's own `claude` binary, so the user's existing
 * login is what pays for the run -- we never ask for or handle an API key.
 */
export class ClaudeCodeAdapter implements AgentRuntime {
  readonly runtimeType = 'claude-code' as const;
  /** Streams output and reports every tool call, so reading, thinking and working are observable. */
  readonly activityProfile = 'detailed' as const;

  async detectInstall(): Promise<InstallCheck> {
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], {
        timeout: 15_000,
        windowsHide: true,
        shell: process.platform === 'win32',
      });
      const version = stdout.trim().split('\n')[0] ?? null;
      return {
        installed: true,
        version,
        location: 'claude (on PATH)',
        message: `Claude Code ${version} is installed.`,
      };
    } catch {
      return {
        installed: false,
        version: null,
        location: null,
        message:
          'Claude Code was not found on PATH. Install it with "npm i -g @anthropic-ai/claude-code", then reopen this window.',
      };
    }
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

    // The only honest way to check auth is to make the runtime do a trivial
    // turn: credentials live in Claude Code's own store and we deliberately do
    // not read it. A one-word prompt is the cheapest real probe available.
    const auth = await this.probeAuth();

    return {
      runtimeType: this.runtimeType,
      installed: true,
      version: install.version,
      location: install.location,
      authenticated: auth.ok,
      message: auth.ok
        ? `Claude Code ${install.version} is installed and authenticated.`
        : `Claude Code ${install.version} is installed but the auth probe failed: ${auth.detail} Run "claude" in a terminal and complete login, then re-check.`,
    };
  }

  private async probeAuth(): Promise<{ ok: boolean; detail: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const query = await loadQuery();
      const q = query({
        prompt: 'Reply with the single word: ok',
        options: {
          maxTurns: 1,
          abortController: controller,
          persistSession: false,
          settingSources: [],
          allowedTools: [],
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch'],
        },
      });

      for await (const message of q) {
        if (message.type === 'result') {
          if (message.subtype === 'success') return { ok: true, detail: '' };
          return { ok: false, detail: `runtime returned ${message.subtype}.` };
        }
        if (message.type === 'assistant' && message.error) {
          return { ok: false, detail: `${message.error}.` };
        }
      }
      return { ok: false, detail: 'the runtime produced no result.' };
    } catch (error) {
      return { ok: false, detail: `${(error as Error).message}.` };
    } finally {
      clearTimeout(timer);
    }
  }

  async *execute(ctx: RuntimeExecuteContext): AsyncIterable<RuntimeEvent> {
    const gatewayToolPrefix = `mcp__${ctx.gateway.serverName}__`;
    const toolsPrefix = `mcp__${ctx.gateway.toolsServerName}__`;
    const bearer = { Authorization: `Bearer ${ctx.gateway.token}` };

    const options: Options = {
      cwd: ctx.workingDirectory,
      abortController: abortControllerFrom(ctx.abortSignal),
      maxTurns: ctx.maxTurns,
      includePartialMessages: true,
      // Resume the native session for this (agent, conversation) pair when we
      // have one. This is a real Claude Code session, not a replayed transcript.
      ...(ctx.resumeSessionId ? { resume: ctx.resumeSessionId } : {}),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: ctx.systemPrompt,
      },
      // Only our own gateway is auto-approved. Everything else falls through to
      // canUseTool below, which applies the agent's workspace policy.
      //
      // A bare allowedTools entry shadows canUseTool for the tools it matches,
      // and the SDK warns about that at runtime. That is the intent here: the
      // gateway is our own in-app surface, already authenticated per agent, and
      // asking the operator to approve every send_message would make agent-to-
      // agent work unusable. Verified live: with this in place canUseTool still
      // fires for Write/Edit/Bash (tests/integration/live-runtimes.test.ts).
      //
      // The tools server proxies MCP tools the operator granted this agent.
      // It is auto-approved here for the same reason: the proxy itself checks
      // the grant on every call and asks the operator when the grant says so,
      // so a second prompt from Claude Code would only duplicate it.
      allowedTools: [
        `${gatewayToolPrefix}*`,
        ...(ctx.gateway.hasToolGrants ? [`${toolsPrefix}*`] : []),
      ],
      mcpServers: {
        [ctx.gateway.serverName]: { type: 'http', url: ctx.gateway.url, headers: bearer },
        ...(ctx.gateway.hasToolGrants
          ? { [ctx.gateway.toolsServerName]: { type: 'http' as const, url: ctx.gateway.toolsUrl, headers: bearer } }
          : {}),
      },
      // Do not inherit the user's global Claude Code settings: an agent in this
      // app should behave the same regardless of what is in ~/.claude.
      settingSources: [],
      // Compaction is the runtime's own job: it summarises older turns in place
      // so the agent can keep working past the context limit. The app's
      // transcript is untouched -- SQLite keeps every message either way.
      managedSettings: {
        autoCompactEnabled: ctx.agent.config.autoCompact,
        ...(ctx.agent.config.autoCompactWindow
          ? { autoCompactWindow: ctx.agent.config.autoCompactWindow }
          : {}),
      },
      // Local plugins (ponytail and friends) load through the runtime's own
      // mechanism. skipMcpDiscovery because this host owns the MCP connection.
      ...(ctx.agent.config.plugins?.length
        ? {
            plugins: ctx.agent.config.plugins.map((path) => ({
              type: 'local' as const,
              path,
              skipMcpDiscovery: true,
            })),
          }
        : {}),
      permissionMode: 'default',
      canUseTool: this.buildPermissionCallback(ctx),
      ...(ctx.maxCostUsd > 0 ? { maxBudgetUsd: ctx.maxCostUsd } : {}),
      ...(ctx.agent.config.model ? { model: ctx.agent.config.model } : {}),
      ...(ctx.agent.config.effort ? { effort: ctx.agent.config.effort } : {}),
    };

    // With images the prompt goes in as one user message of content blocks.
    // That uses the SDK's streaming input, which is kept open until the turn
    // ends: Claude Code answers permission requests over the same channel.
    let releaseInput = () => {};
    let prompt: string | AsyncIterable<SDKUserMessage> = ctx.prompt;
    if (ctx.images.length) {
      const { loaded, missing } = await loadImages(ctx.images);
      const finished = new Promise<void>((resolve) => (releaseInput = resolve));
      const message = claudeUserMessage(ctx.prompt + missingImagesNote(missing), loaded);
      prompt = (async function* () {
        yield message;
        await finished;
      })();
    }

    let q: Query;
    try {
      const query = await loadQuery();
      q = query({ prompt, options });
    } catch (error) {
      releaseInput();
      yield { type: 'error', message: `Failed to start Claude Code: ${asMessage(error)}`, fatal: true };
      return;
    }

    // ctx.abortSignal already drives options.abortController; interrupt() asks
    // the runtime to wind down its current turn cleanly first.
    const onAbort = () => void q.interrupt?.().catch(() => undefined);
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

    let sessionReported = false;

    try {
      for await (const message of q as AsyncIterable<SDKMessage>) {
        if (ctx.abortSignal.aborted) break;

        if (!sessionReported && 'session_id' in message && message.session_id) {
          sessionReported = true;
          yield { type: 'session', sessionId: message.session_id };
        }

        for (const event of translate(message)) yield event;

        if (message.type === 'result') break;
      }
    } catch (error) {
      if (!ctx.abortSignal.aborted) {
        yield { type: 'error', message: asMessage(error), fatal: true };
      }
    } finally {
      releaseInput();
      ctx.abortSignal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Maps the agent's workspace policy onto Claude Code's permission callback.
   *
   * This is an application-level guard, not a sandbox: the underlying CLI still
   * runs with the user's own privileges. See docs/ARCHITECTURE.md.
   */
  private buildPermissionCallback(ctx: RuntimeExecuteContext) {
    const MUTATING = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

    return async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      if (
        toolName.startsWith(`mcp__${ctx.gateway.serverName}__`) ||
        toolName.startsWith(`mcp__${ctx.gateway.toolsServerName}__`)
      ) {
        return { behavior: 'allow', updatedInput: input };
      }

      if (ctx.workspaceAccess === 'read_only') {
        if (MUTATING.has(toolName) || toolName === 'Bash') {
          return {
            behavior: 'deny',
            message: `"${ctx.agent.name}" has read-only access to ${ctx.workingDirectory}. The operator must grant write access before ${toolName} can run.`,
          };
        }
        return { behavior: 'allow', updatedInput: input };
      }

      if (ctx.workspaceAccess === 'read_write') {
        return { behavior: 'allow', updatedInput: input };
      }

      // approval_required: reads flow, mutations need a human decision.
      if (!MUTATING.has(toolName) && toolName !== 'Bash') {
        return { behavior: 'allow', updatedInput: input };
      }
      const decision = await ctx.requestApproval({
        agentId: ctx.agent.id,
        executionId: ctx.executionId,
        toolName,
        input,
        kind: 'workspace',
      });
      return decision.approved
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: decision.reason ?? 'The operator denied this operation.' };
    };
  }

  async dispose(): Promise<void> {
    // Stateless: every execution owns its own query() and AbortController.
  }
}

/** Bridges the orchestrator's AbortSignal onto the SDK's AbortController. */
function abortControllerFrom(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Translates one SDK message into zero or more normalised runtime events. */
function* translate(message: SDKMessage): Generator<RuntimeEvent> {
  switch (message.type) {
    case 'stream_event': {
      const event = message.event;
      if (
        event.type === 'content_block_delta' &&
        'delta' in event &&
        event.delta &&
        typeof event.delta === 'object'
      ) {
        const delta = event.delta as { type?: string; text?: string; thinking?: string };
        if (delta.type === 'text_delta' && delta.text) {
          yield { type: 'text_delta', text: delta.text };
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          yield { type: 'thinking', text: delta.thinking };
        }
      }
      return;
    }

    case 'assistant': {
      if (message.error) {
        yield { type: 'error', message: `Claude Code error: ${message.error}`, fatal: false };
      }
      const content = message.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          yield { type: 'text', text: block.text };
        } else if (block.type === 'tool_use') {
          yield {
            type: 'tool_use',
            toolUseId: block.id ?? null,
            name: block.name,
            input: block.input,
          };
        }
      }
      return;
    }

    case 'user': {
      const content = message.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block && typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
          const b = block as { tool_use_id?: string; is_error?: boolean; content?: unknown };
          yield {
            type: 'tool_result',
            toolUseId: b.tool_use_id ?? null,
            summary: summariseToolResult(b.content),
            isError: Boolean(b.is_error),
          };
        }
      }
      return;
    }

    case 'system': {
      if (message.subtype !== 'compact_boundary') return;
      const meta = message.compact_metadata;
      yield {
        type: 'compaction',
        trigger: meta.trigger,
        preTokens: meta.pre_tokens,
        postTokens: meta.post_tokens ?? null,
        durationMs: meta.duration_ms ?? null,
      };
      return;
    }

    case 'result': {
      // total_cost_usd is already cumulative for this query() call, so the last
      // result carries the full amount and needs no accumulation here. This is
      // the running total the `cost` event contract asks for.
      yield {
        type: 'cost',
        costUsd: message.total_cost_usd ?? 0,
        inputTokens: Number(message.usage?.input_tokens ?? 0),
        outputTokens: Number(message.usage?.output_tokens ?? 0),
        turns: message.num_turns,
      };

      if (message.subtype === 'success') return;

      const reason =
        message.subtype === 'error_max_turns'
          ? 'The agent reached its turn limit for this execution.'
          : message.subtype === 'error_max_budget_usd'
            ? 'The agent reached its spend limit for this execution.'
            : 'The agent run failed.';
      yield { type: 'error', message: reason, fatal: true };
      return;
    }

    default:
      return;
  }
}

function summariseToolResult(content: unknown): string {
  if (typeof content === 'string') return truncate(content);
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
    return truncate(text);
  }
  return '';
}

function truncate(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}\n... (truncated)` : text;
}

/**
 * The turn as an Anthropic user message: the prompt text, then each image as a
 * base64 image block. Claude Code passes the blocks to the model unchanged.
 */
export function claudeUserMessage(text: string, images: Array<LoadedImage | (ContextImage & { bytes: Buffer })>): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.map((image) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mimeType, data: image.bytes.toString('base64') },
        })),
      ],
    },
    parent_tool_use_id: null,
  };
}
