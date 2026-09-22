import Anthropic from '@anthropic-ai/sdk';
import type { ProviderModel } from '../../shared/integrations.js';
import { UNKNOWN_CAPABILITIES } from '../../shared/integrations.js';
import { rejectedFeature, scrub } from './http.js';
import {
  ProviderError,
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  type ProviderAdapter,
  type ResolvedProvider,
} from './types.js';

/** The Messages API requires an output cap; used when neither agent nor model sets one. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Anthropic's native Messages API, through the official SDK.
 *
 * Anthropic's OpenAI-compatible endpoint is documented as not production
 * ready and silently drops features, so Claude models get a dedicated
 * adapter. Its model list is also the richest: context size, output cap and
 * capability flags come straight from `GET /v1/models`.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic' as const;

  async listModels(provider: ResolvedProvider, signal: AbortSignal): Promise<ProviderModel[]> {
    const client = this.client(provider);
    const models: ProviderModel[] = [];
    try {
      for await (const info of client.models.list({ limit: 100 }, { signal })) {
        const caps = info.capabilities;
        models.push({
          id: info.id,
          label: info.display_name,
          source: 'discovered',
          capabilities: {
            ...UNKNOWN_CAPABILITIES,
            contextWindow: info.max_input_tokens ?? null,
            maxOutputTokens: info.max_tokens ?? null,
            // Every model the Messages API serves supports tool use and streaming.
            tools: true,
            streaming: true,
            vision: caps ? caps.image_input.supported : null,
            structuredOutput: caps ? caps.structured_outputs.supported : null,
          },
          overrides: {},
        });
        if (models.length >= 500) break;
      }
    } catch (error) {
      throw this.wrap(provider, error);
    }
    return models;
  }

  async *chat(provider: ResolvedProvider, request: ChatRequest): AsyncIterable<ChatEvent> {
    const client = this.client(provider);
    const { system, messages } = toAnthropicMessages(request.messages);

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      stream: true,
      ...(system ? { system } : {}),
      ...(request.temperature !== undefined ? { temperature: Math.min(1, Math.max(0, request.temperature)) } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
    };

    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = await client.messages.create(params, { signal: request.signal });
    } catch (error) {
      throw this.wrap(provider, error);
    }

    const blocks = new Map<number, { id: string; name: string; json: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: string | null = null;

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            inputTokens = event.message.usage.input_tokens ?? 0;
            outputTokens = event.message.usage.output_tokens ?? 0;
            break;
          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              blocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
            }
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') yield { type: 'text', text: event.delta.text };
            else if (event.delta.type === 'thinking_delta') yield { type: 'reasoning', text: event.delta.thinking };
            else if (event.delta.type === 'input_json_delta') {
              const block = blocks.get(event.index);
              if (block) block.json += event.delta.partial_json;
            }
            break;
          case 'content_block_stop': {
            const block = blocks.get(event.index);
            if (block) {
              yield { type: 'tool_call', call: { id: block.id, name: block.name, arguments: block.json || '{}' } };
              blocks.delete(event.index);
            }
            break;
          }
          case 'message_delta':
            outputTokens = event.usage.output_tokens ?? outputTokens;
            finishReason = event.delta.stop_reason ?? finishReason;
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (request.signal.aborted) return;
      throw this.wrap(provider, error);
    }

    yield { type: 'usage', inputTokens, outputTokens };
    yield { type: 'done', finishReason };
  }

  private client(provider: ResolvedProvider): Anthropic {
    const bearer = provider.authMethod === 'bearer';
    return new Anthropic({
      apiKey: bearer ? null : provider.apiKey,
      authToken: bearer ? provider.apiKey : null,
      baseURL: provider.baseUrl,
      timeout: provider.timeoutMs,
      // The orchestrator owns retries and limits; hidden retries would blur them.
      maxRetries: 1,
      defaultHeaders: {
        ...provider.headers,
        ...(provider.options.anthropicVersion ? { 'anthropic-version': provider.options.anthropicVersion } : {}),
      },
      fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
    });
  }

  private wrap(provider: ResolvedProvider, error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    if (error instanceof Anthropic.APIUserAbortError) return new ProviderError('The request was cancelled.', 'cancelled');
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return new ProviderError(`${provider.name} did not answer in time.`, 'timeout');
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new ProviderError(`Could not reach ${provider.name}: ${scrub(provider, error.message)}`, 'network');
    }
    if (error instanceof Anthropic.APIError) {
      const status = error.status ?? null;
      const detail = scrub(provider, error.message);
      const feature = status === 400 ? rejectedFeature(detail) : null;
      const kind =
        status === 401 || status === 403
          ? 'auth'
          : status === 404
            ? 'not_found'
            : status === 429
              ? 'rate_limit'
              : status && status >= 500
                ? 'server'
                : 'bad_request';
      return new ProviderError(`${provider.name}: ${detail}`, feature ? 'unsupported_feature' : kind, status, feature);
    }
    return new ProviderError(scrub(provider, error instanceof Error ? error.message : String(error)), 'server');
  }
}

/**
 * The Messages API wants a separate system prompt, strictly alternating
 * user/assistant turns, and tool results as user-turn content blocks.
 */
export function toAnthropicMessages(input: ChatMessage[]): {
  system: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const messages: Anthropic.MessageParam[] = [];

  const push = (role: 'user' | 'assistant', blocks: Anthropic.ContentBlockParam[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      (last.content as Anthropic.ContentBlockParam[]).push(...blocks);
    } else {
      messages.push({ role, content: blocks });
    }
  };

  for (const message of input) {
    switch (message.role) {
      case 'system':
        systemParts.push(message.content);
        break;
      case 'user':
        if (typeof message.content === 'string') {
          if (message.content) push('user', [{ type: 'text', text: message.content }]);
        } else if (message.content.length) {
          push(
            'user',
            message.content.map((part): Anthropic.ContentBlockParam =>
              part.type === 'text'
                ? { type: 'text', text: part.text }
                : {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: part.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                      data: part.data,
                    },
                  },
            ),
          );
        }
        break;
      case 'assistant': {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (message.content) blocks.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: safeJson(call.arguments) });
        }
        if (blocks.length) push('assistant', blocks);
        break;
      }
      case 'tool':
        push('user', [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.content,
            ...(message.isError ? { is_error: true } : {}),
          },
        ]);
        break;
    }
  }

  // The first turn must come from the user.
  if (messages[0]?.role === 'assistant') {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation continues)' }] });
  }
  return { system: systemParts.join('\n\n'), messages };
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
