import type {
  AuthMethod,
  ProviderKind,
  ProviderModel,
  ProviderOptions,
} from '../../shared/integrations.js';

/**
 * The provider-neutral conversation format. Every adapter translates this to
 * its wire protocol and back, so the conversation engine never branches on
 * provider.
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  /** Plain text, or text and images in order. */
  | { role: 'user'; content: string | UserContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

/** Part of a user turn. Images travel as base64 with their real type. */
export type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments exactly as the model produced them. */
  arguments: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments (an object schema). */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
  /** Parameters this provider was seen to reject, so they are left out. */
  compat?: { noStreamUsage?: boolean };
}

/** What a provider streams back, normalised. */
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** A complete tool call, emitted once its arguments have fully arrived. */
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: string | null };

/** A provider with its credentials decrypted. Main process only, never serialised. */
export interface ResolvedProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  preset: string;
  baseUrl: string;
  authMethod: AuthMethod;
  authHeaderName: string | null;
  apiKey: string | null;
  /** Plain and secret custom headers, merged. */
  headers: Record<string, string>;
  options: ProviderOptions;
  timeoutMs: number;
}

/**
 * One wire protocol. Adding a provider that speaks an existing protocol needs
 * only a preset; adding a new protocol means implementing this interface and
 * registering it -- the conversation engine does not change.
 */
export interface ProviderAdapter {
  readonly kind: ProviderKind;
  /** Lists models, with whatever capability data the provider reports. */
  listModels(provider: ResolvedProvider, signal: AbortSignal): Promise<ProviderModel[]>;
  /** Runs one model turn, streaming. Must honour `request.signal`. */
  chat(provider: ResolvedProvider, request: ChatRequest): AsyncIterable<ChatEvent>;
}

export type ProviderErrorKind =
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'bad_request'
  | 'unsupported_feature'
  | 'server'
  | 'network'
  | 'timeout'
  | 'cancelled';

/** A request parameter a model rejected, so the caller can retry without it. */
export type ProviderFeature = 'tools' | 'temperature' | 'stream_options' | 'max_tokens' | 'vision';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status: number | null = null,
    readonly feature: ProviderFeature | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
