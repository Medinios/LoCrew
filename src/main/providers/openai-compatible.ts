import type { ModelCapabilities, ProviderModel } from '../../shared/integrations.js';
import { UNKNOWN_CAPABILITIES } from '../../shared/integrations.js';
import { authHeaders, errorFromResponse, joinUrl, providerFetch, readSse } from './http.js';
import {
  ProviderError,
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  type ProviderAdapter,
  type ResolvedProvider,
} from './types.js';

/**
 * OpenAI Chat Completions, the protocol most of the ecosystem speaks: OpenAI,
 * Azure v1, OpenRouter, Groq, Together, Fireworks, Hugging Face, Bedrock's
 * compatibility endpoint, LM Studio, vLLM, llama.cpp, LiteLLM, and (through
 * their own adapters) Gemini and Ollama for inference.
 *
 * Model lists are enriched per provider where the provider reports more than
 * the bare OpenAI shape (id, owned_by), because that is where context sizes
 * and tool support actually come from.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly kind = 'openai-compatible' as const;

  async listModels(provider: ResolvedProvider, signal: AbortSignal): Promise<ProviderModel[]> {
    const path = provider.options.modelsPath ?? '/models';
    if (path === '') {
      throw new ProviderError(`${provider.name} does not offer a model list. Enter the model id manually.`, 'not_found');
    }
    const response = await providerFetch(provider, joinUrl(provider.baseUrl, path), {
      headers: { ...authHeaders(provider), Accept: 'application/json' },
      signal,
    });
    if (!response.ok) throw await errorFromResponse(provider, response);
    const body = (await response.json()) as unknown;
    const entries = Array.isArray(body)
      ? body
      : Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : Array.isArray((body as { models?: unknown }).models)
          ? (body as { models: unknown[] }).models
          : [];

    const models = entries
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((entry) => toModel(entry))
      .filter((m): m is ProviderModel => m !== null);

    if (provider.preset === 'lmstudio') await enrichFromLmStudio(provider, models, signal);
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  async *chat(provider: ResolvedProvider, request: ChatRequest): AsyncIterable<ChatEvent> {
    yield* streamChatCompletions(provider, joinUrl(provider.baseUrl, provider.options.chatPath ?? '/chat/completions'), request);
  }
}

/**
 * Shared by every adapter that speaks Chat Completions for inference (the
 * Gemini and Ollama adapters call this with their compatibility endpoints).
 */
export async function* streamChatCompletions(
  provider: ResolvedProvider,
  url: string,
  request: ChatRequest,
  options: { includeUsage?: boolean } = {},
): AsyncIterable<ChatEvent> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(toWireMessage),
    stream: true,
  };
  if (options.includeUsage !== false && !request.compat?.noStreamUsage) {
    body.stream_options = { include_usage: true };
  }
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined) {
    body[provider.options.tokenParameter ?? 'max_tokens'] = request.maxOutputTokens;
  }

  const response = await providerFetch(provider, url, {
    method: 'POST',
    headers: {
      ...authHeaders(provider),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });
  if (!response.ok) throw await errorFromResponse(provider, response);

  // A server that ignores `stream: true` answers with one JSON document.
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    yield* fromCompletion(provider, (await response.json()) as Record<string, unknown>);
    return;
  }

  const pending = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: string | null = null;

  const flushToolCalls = function* (): Generator<ChatEvent> {
    for (const [, call] of [...pending.entries()].sort(([a], [b]) => a - b)) {
      if (call.name) yield { type: 'tool_call', call: { ...call, arguments: call.arguments || '{}' } };
    }
    pending.clear();
  };

  for await (const { data } of readSse(response)) {
    if (request.signal.aborted) return;
    if (data === '[DONE]') break;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Some providers report failures inside a 200 stream (OpenRouter does).
    if (chunk.error) {
      const error = chunk.error as { message?: string };
      throw new ProviderError(`${provider.name}: ${error.message ?? 'the stream reported an error.'}`, 'server');
    }

    const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (usage && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined)) {
      yield { type: 'usage', inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 };
    }

    const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) continue;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;

    if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content };
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning };

    for (const part of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
      const index = typeof part.index === 'number' ? part.index : pending.size;
      const fn = (part.function ?? {}) as { name?: string; arguments?: unknown };
      const entry = pending.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof part.id === 'string' && part.id) entry.id = part.id;
      if (typeof fn.name === 'string' && fn.name) entry.name = fn.name;
      if (typeof fn.arguments === 'string') entry.arguments += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === 'object') entry.arguments = JSON.stringify(fn.arguments);
      if (!entry.id) entry.id = `call_${index}_${Date.now().toString(36)}`;
      pending.set(index, entry);
    }

    if (typeof choice.finish_reason === 'string') {
      finishReason = choice.finish_reason;
      yield* flushToolCalls();
    }
  }

  // Streams that end without a finish_reason (or without [DONE]) still count.
  yield* flushToolCalls();
  yield { type: 'done', finishReason };
}

function* fromCompletion(provider: ResolvedProvider, completion: Record<string, unknown>): Generator<ChatEvent> {
  if (completion.error) {
    const error = completion.error as { message?: string };
    throw new ProviderError(`${provider.name}: ${error.message ?? 'request failed.'}`, 'server');
  }
  const choice = (completion.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const message = (choice?.message ?? {}) as Record<string, unknown>;
  if (typeof message.content === 'string' && message.content) yield { type: 'text', text: message.content };
  for (const call of (message.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
    const fn = (call.function ?? {}) as { name?: string; arguments?: unknown };
    if (!fn.name) continue;
    yield {
      type: 'tool_call',
      call: {
        id: typeof call.id === 'string' ? call.id : `call_${Date.now().toString(36)}`,
        name: fn.name,
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    };
  }
  const usage = completion.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  if (usage) yield { type: 'usage', inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 };
  yield { type: 'done', finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null };
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return {
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) =>
                part.type === 'text'
                  ? { type: 'text', text: part.text }
                  : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
              ),
      };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content || (message.toolCalls?.length ? null : ''),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}

/**
 * One model entry, reading whichever capability fields this provider uses.
 * The same idea has a different name on almost every provider.
 */
function toModel(entry: Record<string, unknown>): ProviderModel | null {
  const id = typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : null;
  if (!id) return null;

  const capabilities: ModelCapabilities = { ...UNKNOWN_CAPABILITIES };
  const num = (value: unknown) => (typeof value === 'number' && value > 0 ? value : null);

  // OpenRouter / Together / HF: context_length; Groq: context_window.
  capabilities.contextWindow =
    num(entry.context_length) ??
    num(entry.context_window) ??
    num((entry.top_provider as Record<string, unknown> | undefined)?.context_length) ??
    num((entry.meta as Record<string, unknown> | undefined)?.n_ctx_train) ??
    num(entry.max_model_len) ??
    null;

  // Groq: max_completion_tokens; OpenRouter: top_provider.max_completion_tokens.
  capabilities.maxOutputTokens =
    num(entry.max_completion_tokens) ??
    num((entry.top_provider as Record<string, unknown> | undefined)?.max_completion_tokens) ??
    null;

  // OpenRouter lists the request parameters each model accepts.
  const params = entry.supported_parameters;
  if (Array.isArray(params)) {
    capabilities.tools = params.includes('tools');
    capabilities.structuredOutput = params.includes('structured_outputs') || params.includes('response_format');
  }

  const modalities = (entry.architecture as Record<string, unknown> | undefined)?.input_modalities;
  if (Array.isArray(modalities)) capabilities.vision = modalities.includes('image');

  return {
    id,
    ...(typeof entry.name === 'string' && entry.name !== id ? { label: entry.name } : {}),
    ...(typeof entry.display_name === 'string' ? { label: entry.display_name } : {}),
    source: 'discovered',
    capabilities,
    overrides: {},
  };
}

/** LM Studio's native model list reports context size, vision and tool training. */
async function enrichFromLmStudio(provider: ResolvedProvider, models: ProviderModel[], signal: AbortSignal) {
  try {
    const origin = new URL(provider.baseUrl).origin;
    const response = await providerFetch(provider, `${origin}/api/v1/models`, { headers: authHeaders(provider), signal }, 5_000);
    if (!response.ok) return;
    const body = (await response.json()) as { models?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> };
    for (const entry of body.models ?? body.data ?? []) {
      const key = String(entry.key ?? entry.id ?? '');
      const model = models.find((m) => m.id === key);
      if (!model) continue;
      const caps = (entry.capabilities ?? {}) as Record<string, unknown>;
      if (typeof entry.max_context_length === 'number') model.capabilities.contextWindow = entry.max_context_length;
      if (typeof caps.vision === 'boolean') model.capabilities.vision = caps.vision;
      if (typeof caps.trained_for_tool_use === 'boolean') model.capabilities.tools = caps.trained_for_tool_use;
    }
  } catch {
    // Enrichment is best effort; the plain list already worked.
  }
}
