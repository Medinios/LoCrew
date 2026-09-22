import type { ProviderModel } from '../../shared/integrations.js';
import { UNKNOWN_CAPABILITIES } from '../../shared/integrations.js';
import { authHeaders, errorFromResponse, joinUrl, providerFetch } from './http.js';
import { streamChatCompletions } from './openai-compatible.js';
import type { ChatEvent, ChatRequest, ProviderAdapter, ResolvedProvider } from './types.js';

/**
 * Google Gemini.
 *
 * Inference goes through Google's OpenAI-compatible endpoint, which handles
 * streaming and tools; discovery uses the native model list, because only it
 * reports each model's input and output token limits.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly kind = 'gemini' as const;

  async listModels(provider: ResolvedProvider, signal: AbortSignal): Promise<ProviderModel[]> {
    const models: ProviderModel[] = [];
    let pageToken = '';
    do {
      const url = joinUrl(provider.baseUrl, `/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      const response = await providerFetch(provider, url, { headers: authHeaders(provider), signal });
      if (!response.ok) throw await errorFromResponse(provider, response);
      const body = (await response.json()) as {
        models?: Array<{
          name: string;
          displayName?: string;
          inputTokenLimit?: number;
          outputTokenLimit?: number;
          supportedGenerationMethods?: string[];
        }>;
        nextPageToken?: string;
      };
      for (const entry of body.models ?? []) {
        // Embedding-only and other non-chat models are not agent material.
        if (!entry.supportedGenerationMethods?.includes('generateContent')) continue;
        models.push({
          id: entry.name.replace(/^models\//, ''),
          ...(entry.displayName ? { label: entry.displayName } : {}),
          source: 'discovered',
          capabilities: {
            ...UNKNOWN_CAPABILITIES,
            contextWindow: entry.inputTokenLimit ?? null,
            maxOutputTokens: entry.outputTokenLimit ?? null,
            streaming: true,
          },
          overrides: {},
        });
      }
      pageToken = body.nextPageToken ?? '';
    } while (pageToken && models.length < 2000);
    return models;
  }

  async *chat(provider: ResolvedProvider, request: ChatRequest): AsyncIterable<ChatEvent> {
    // The compatibility endpoint takes the same key as a bearer token.
    const compat: ResolvedProvider = { ...provider, authMethod: 'bearer', authHeaderName: null };
    yield* streamChatCompletions(compat, joinUrl(provider.baseUrl, '/v1beta/openai/chat/completions'), request);
  }
}

/**
 * Ollama.
 *
 * Inference uses Ollama's OpenAI-compatible `/v1` endpoint (streaming and
 * tools). Discovery uses the native API: `/api/tags` for the installed
 * models and `/api/show` for what each one can actually do -- Ollama reports
 * a `capabilities` array ("completion", "tools", "vision", ...) and the
 * context length, so nothing has to be guessed from the model name.
 */
export class OllamaAdapter implements ProviderAdapter {
  readonly kind = 'ollama' as const;

  async listModels(provider: ResolvedProvider, signal: AbortSignal): Promise<ProviderModel[]> {
    const response = await providerFetch(provider, joinUrl(provider.baseUrl, '/api/tags'), {
      headers: authHeaders(provider),
      signal,
    });
    if (!response.ok) throw await errorFromResponse(provider, response);
    const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = (body.models ?? []).map((m) => m.model ?? m.name).filter((n): n is string => !!n).slice(0, 100);

    const models: ProviderModel[] = [];
    // A few at a time: /api/show loads model metadata from disk.
    for (let i = 0; i < names.length; i += 4) {
      const batch = await Promise.all(names.slice(i, i + 4).map((name) => this.describe(provider, name, signal)));
      for (const model of batch) if (model) models.push(model);
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async describe(provider: ResolvedProvider, name: string, signal: AbortSignal): Promise<ProviderModel | null> {
    const model: ProviderModel = {
      id: name,
      source: 'discovered',
      capabilities: { ...UNKNOWN_CAPABILITIES, streaming: true },
      overrides: {},
    };
    try {
      const response = await providerFetch(provider, joinUrl(provider.baseUrl, '/api/show'), {
        method: 'POST',
        headers: { ...authHeaders(provider), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal,
      });
      if (!response.ok) return model;
      const info = (await response.json()) as { capabilities?: string[]; model_info?: Record<string, unknown> };
      const caps = info.capabilities;
      if (Array.isArray(caps)) {
        // Embedding models cannot hold a conversation.
        if (caps.includes('embedding') && !caps.includes('completion')) return null;
        model.capabilities.tools = caps.includes('tools');
        model.capabilities.vision = caps.includes('vision');
      }
      const contextKey = Object.keys(info.model_info ?? {}).find((k) => k.endsWith('.context_length'));
      const context = contextKey ? info.model_info?.[contextKey] : undefined;
      if (typeof context === 'number') model.capabilities.contextWindow = context;
    } catch {
      // Keep the bare entry; the model can still be used.
    }
    return model;
  }

  async *chat(provider: ResolvedProvider, request: ChatRequest): AsyncIterable<ChatEvent> {
    yield* streamChatCompletions(provider, joinUrl(provider.baseUrl, '/v1/chat/completions'), request);
  }
}
