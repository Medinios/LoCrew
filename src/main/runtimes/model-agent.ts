import type { Agent, RuntimeDetection } from '../../shared/types.js';
import { effectiveCapabilities } from '../../shared/integrations.js';
import { GatewaySession, toolResultText, type GatewayTool } from '../mcp/gateway-client.js';
import type { ProviderRegistry } from '../providers/registry.js';
import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ToolCall,
  type ToolDefinition,
} from '../providers/types.js';
import { buildConversationalSystemPrompt, CHARS_PER_TOKEN, transcriptToMessages, withoutImages } from './conversation.js';
import { loadImages } from './images.js';
import type { AgentRuntime, InstallCheck, RuntimeEvent, RuntimeExecuteContext } from './types.js';

/** History budget when a model's context window is not known. */
const DEFAULT_CONTEXT_TOKENS = 16_000;
/** Share of the context window given to history; the rest is prompt, tools and output. */
const HISTORY_SHARE = 0.5;

/**
 * Runs an agent on any configured model provider.
 *
 * This is the app's own agent loop: it rebuilds the conversation from the
 * shared transcript, offers the model the tools it is allowed (workspace tools
 * and granted MCP tools, both through the gateway so permissions are enforced
 * in one place), executes the calls it makes and feeds the results back, up
 * to the agent's turn limit.
 *
 * Capabilities are used when the provider reports them and learned when it
 * does not: a model that rejects tools is retried without them and
 * remembered, so one unsupported feature never breaks a conversation.
 */
export class ModelAgentRuntime implements AgentRuntime {
  readonly runtimeType = 'model' as const;
  /** Streams output and reports every tool call, so reading, thinking and working are observable. */
  readonly activityProfile = 'detailed' as const;
  readonly perAgentAvailability = true;

  constructor(private readonly providers: ProviderRegistry) {}

  async detectInstall(agent?: Agent): Promise<InstallCheck> {
    const providerId = agent?.config.providerId;
    const model = agent?.config.model;
    const provider = providerId ? this.providers.get(providerId) : null;
    if (!provider) {
      return { installed: false, version: null, location: null, message: 'The provider this agent uses has been removed.' };
    }
    if (!model) {
      return { installed: false, version: null, location: provider.baseUrl, message: 'No model is selected.' };
    }
    return {
      installed: true,
      version: model,
      location: provider.baseUrl,
      message: `${provider.name} · ${model}${provider.lastCheck && !provider.lastCheck.ok ? ` (last check failed: ${provider.lastCheck.message})` : ''}`,
    };
  }

  async dispose(): Promise<void> {
    // Stateless: every execution opens and closes its own gateway sessions.
  }

  async detect(): Promise<RuntimeDetection> {
    return {
      runtimeType: 'model',
      installed: true,
      version: null,
      location: null,
      authenticated: true,
      message: 'Model agents use the providers configured in Settings → AI Providers.',
    };
  }

  async *execute(ctx: RuntimeExecuteContext): AsyncIterable<RuntimeEvent> {
    const { agent } = ctx;
    const providerId = agent.config.providerId;
    const modelId = agent.config.model;
    const provider = providerId ? this.providers.get(providerId) : null;
    if (!provider || !providerId) {
      yield { type: 'error', message: `${agent.name} has no provider. Choose one in the agent's settings.`, fatal: true };
      return;
    }
    if (!modelId) {
      yield { type: 'error', message: `${agent.name} has no model selected. Choose one in the agent's settings.`, fatal: true };
      return;
    }

    const capabilities = effectiveCapabilities(provider.models.find((m) => m.id === modelId));

    // Tools come from the gateway, exactly as for the CLI runtimes. A model
    // known not to support tools simply gets none.
    const sessions: GatewaySession[] = [];
    const toolIndex = new Map<string, GatewaySession>();
    const tools: ToolDefinition[] = [];
    if (capabilities.tools !== false) {
      try {
        const workspace = await GatewaySession.open(ctx.gateway.url, ctx.gateway.token);
        sessions.push(workspace);
        addTools(await workspace.listTools(), workspace, tools, toolIndex);
        if (ctx.gateway.hasToolGrants) {
          const granted = await GatewaySession.open(ctx.gateway.toolsUrl, ctx.gateway.token);
          sessions.push(granted);
          addTools(await granted.listTools(), granted, tools, toolIndex);
        }
      } catch (error) {
        yield {
          type: 'error',
          message: `Tools are unavailable for this run: ${error instanceof Error ? error.message : String(error)}`,
          fatal: false,
        };
      }
    }

    try {
      yield* this.loop(ctx, providerId, modelId, capabilities.contextWindow, capabilities.maxOutputTokens, capabilities.vision, tools, toolIndex);
    } finally {
      await Promise.all(sessions.map((s) => s.close()));
    }
  }

  private async *loop(
    ctx: RuntimeExecuteContext,
    providerId: string,
    modelId: string,
    contextWindow: number | null,
    modelMaxOutput: number | null,
    vision: boolean | null,
    initialTools: ToolDefinition[],
    toolIndex: Map<string, GatewaySession>,
  ): AsyncIterable<RuntimeEvent> {
    const { agent } = ctx;
    let tools = initialTools;
    let temperature = agent.config.temperature;
    let maxOutputTokens = agent.config.maxOutputTokens ?? (modelMaxOutput ? Math.min(modelMaxOutput, 8192) : undefined);
    const compat: ChatRequest['compat'] = {};

    const buildSystem = () =>
      buildConversationalSystemPrompt(ctx, {
        canMessageAgents: tools.some((t) => t.name === 'send_message'),
        toolNames: tools.map((t) => t.name),
      });

    const historyBudget = Math.floor((contextWindow ?? DEFAULT_CONTEXT_TOKENS) * HISTORY_SHARE * CHARS_PER_TOKEN);

    // This turn's images are sent unless the model is known not to take them;
    // when support is unknown they are tried, and a refusal is learned below.
    const { loaded } = await loadImages(ctx.images);
    const imageData = new Map(loaded.map((image) => [image.path, { mimeType: image.mimeType, data: image.bytes.toString('base64') }]));
    const conversation: ChatMessage[] = transcriptToMessages(ctx.transcript, historyBudget, {
      data: imageData,
      canView: vision !== false,
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let turns = 0;
    const finalText: string[] = [];

    while (turns < ctx.maxTurns) {
      if (ctx.abortSignal.aborted) return;
      turns += 1;

      let text = '';
      const calls: ToolCall[] = [];
      const dropped = new Set<string>();

      for (;;) {
        text = '';
        calls.length = 0;
        try {
          const stream = this.providers.chat(providerId, {
            model: modelId,
            messages: [{ role: 'system', content: buildSystem() }, ...conversation],
            ...(tools.length ? { tools } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            signal: ctx.abortSignal,
            compat,
          });
          for await (const event of stream) {
            if (ctx.abortSignal.aborted) return;
            if (event.type === 'text') {
              text += event.text;
              yield { type: 'text_delta', text: event.text };
            } else if (event.type === 'reasoning') {
              yield { type: 'thinking', text: event.text };
            } else if (event.type === 'tool_call') {
              calls.push(event.call);
            } else if (event.type === 'usage') {
              inputTokens += event.inputTokens;
              outputTokens += event.outputTokens;
            }
          }
          break;
        } catch (error) {
          if (ctx.abortSignal.aborted) return;
          // Drop the one parameter the provider refused and try again, once
          // per parameter. Tool support is remembered for next time.
          if (error instanceof ProviderError && error.feature && !dropped.has(error.feature)) {
            dropped.add(error.feature);
            if (error.feature === 'tools' && tools.length) {
              tools = [];
              this.providers.learnCapability(providerId, modelId, { tools: false });
              yield { type: 'error', message: `${modelId} does not accept tools, so ${agent.name} will answer without them.`, fatal: false };
              continue;
            }
            if (error.feature === 'vision' && hasImages(conversation)) {
              conversation.splice(0, conversation.length, ...withoutImages(conversation));
              this.providers.learnCapability(providerId, modelId, { vision: false });
              yield { type: 'error', message: `${modelId} does not accept images, so ${agent.name} will answer from the text alone.`, fatal: false };
              continue;
            }
            if (error.feature === 'temperature' && temperature !== undefined) {
              temperature = undefined;
              continue;
            }
            if (error.feature === 'max_tokens' && maxOutputTokens !== undefined && !agent.config.maxOutputTokens) {
              maxOutputTokens = undefined;
              continue;
            }
            if (error.feature === 'stream_options' && !compat.noStreamUsage) {
              compat.noStreamUsage = true;
              continue;
            }
          }
          yield {
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
            fatal: true,
          };
          yield { type: 'cost', costUsd: 0, inputTokens, outputTokens, turns };
          return;
        }
      }

      if (text.trim()) finalText.push(text.trim());

      if (!calls.length) break;

      conversation.push({ role: 'assistant', content: text, toolCalls: calls });
      for (const call of calls) {
        if (ctx.abortSignal.aborted) return;
        const args = parseArguments(call.arguments);
        yield { type: 'tool_use', toolUseId: call.id, name: call.name, input: args ?? call.arguments };

        let resultText: string;
        let isError = false;
        const session = toolIndex.get(call.name);
        if (!args) {
          resultText = 'The arguments were not valid JSON. Call the tool again with a JSON object.';
          isError = true;
        } else if (!session) {
          resultText = `There is no tool named "${call.name}" available to you.`;
          isError = true;
        } else {
          try {
            const result = await session.callTool(call.name, args, ctx.abortSignal);
            resultText = toolResultText(result);
            isError = !!result.isError;
          } catch (error) {
            if (ctx.abortSignal.aborted) return;
            resultText = `The tool call failed: ${error instanceof Error ? error.message : String(error)}`;
            isError = true;
          }
        }

        yield { type: 'tool_result', toolUseId: call.id, summary: resultText.slice(0, 2000), isError };
        conversation.push({ role: 'tool', toolCallId: call.id, name: call.name, content: resultText, isError });
      }

      if (turns >= ctx.maxTurns) {
        finalText.push(`_(${agent.name} reached its limit of ${ctx.maxTurns} model turns for this message.)_`);
      }
    }

    // Everything the model said to the conversation, in order, as one message.
    const reply = finalText.join('\n\n').trim();
    if (reply) yield { type: 'text', text: reply };
    yield { type: 'cost', costUsd: 0, inputTokens, outputTokens, turns };
  }
}

function addTools(
  found: GatewayTool[],
  session: GatewaySession,
  tools: ToolDefinition[],
  index: Map<string, GatewaySession>,
): void {
  for (const tool of found) {
    if (index.has(tool.name)) continue;
    index.set(tool.name, session);
    tools.push({
      name: tool.name,
      description: tool.description,
      parameters:
        tool.inputSchema && tool.inputSchema.type === 'object'
          ? stripSchemaMeta(tool.inputSchema)
          : { type: 'object', properties: {} },
    });
  }
}

/** Some providers reject JSON Schema meta keys they do not use. */
function stripSchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, ...rest } = schema;
  return rest;
}

function parseArguments(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hasImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'user' && typeof m.content !== 'string' && m.content.some((p) => p.type === 'image'));
}
