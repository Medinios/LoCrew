import { redact } from '../security/secrets.js';
import { ProviderError, type ProviderFeature, type ResolvedProvider } from './types.js';

/**
 * Headers that authenticate a request, per the provider's configured method.
 * Custom headers come first so they can never overwrite the credential.
 */
export function authHeaders(provider: ResolvedProvider): Record<string, string> {
  const headers: Record<string, string> = { ...provider.headers };
  if (provider.apiKey) {
    if (provider.authMethod === 'bearer') headers.Authorization = `Bearer ${provider.apiKey}`;
    else if (provider.authMethod === 'header' && provider.authHeaderName) {
      headers[provider.authHeaderName] = provider.apiKey;
    }
  }
  return headers;
}

/** Joins a base URL and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
  if (!path) return base;
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * fetch with the provider's timeout, the caller's cancellation, and no
 * redirects: a credentialed request must never be followed silently to
 * another host.
 */
export async function providerFetch(
  provider: ResolvedProvider,
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  timeoutMs = provider.timeoutMs,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal, redirect: 'error' });
  } catch (error) {
    if (init.signal?.aborted) throw new ProviderError('The request was cancelled.', 'cancelled');
    if (timeout.aborted) {
      throw new ProviderError(`${provider.name} did not answer within ${Math.round(timeoutMs / 1000)}s.`, 'timeout');
    }
    throw new ProviderError(
      `Could not reach ${provider.name} at ${safeOrigin(url)}: ${describeNetworkError(error)}`,
      'network',
    );
  }
}

/** Turns a non-2xx response into a typed, secret-free error. */
export async function errorFromResponse(provider: ResolvedProvider, response: Response): Promise<ProviderError> {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const error = json.error;
      detail =
        typeof error === 'string'
          ? error
          : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
            ? String((error as { message: string }).message)
            : typeof json.message === 'string'
              ? json.message
              : text;
    } catch {
      detail = text;
    }
  } catch {
    // Body unreadable; the status alone will have to do.
  }
  detail = scrub(provider, detail.trim().slice(0, 600));

  const status = response.status;
  const kind =
    status === 401 || status === 403
      ? 'auth'
      : status === 404
        ? 'not_found'
        : status === 429
          ? 'rate_limit'
          : status >= 500
            ? 'server'
            : 'bad_request';

  const feature = kind === 'bad_request' ? rejectedFeature(detail) : null;
  const prefix =
    kind === 'auth'
      ? `${provider.name} rejected the credentials`
      : kind === 'not_found'
        ? `${provider.name} could not find that endpoint or model`
        : kind === 'rate_limit'
          ? `${provider.name} is rate limiting requests`
          : kind === 'server'
            ? `${provider.name} had a server error`
            : `${provider.name} refused the request`;

  return new ProviderError(
    `${prefix} (HTTP ${status})${detail ? `: ${detail}` : '.'}`,
    feature ? 'unsupported_feature' : kind,
    status,
    feature,
  );
}

/**
 * Which request parameter a 400 complains about, when it is one we can drop
 * and retry without. This is how capabilities are learned at runtime instead
 * of assumed up front.
 */
export function rejectedFeature(detail: string): ProviderFeature | null {
  const text = detail.toLowerCase();
  if (/stream_options|include_usage/.test(text)) return 'stream_options';
  if (/image|vision|multimodal|multi-modal/.test(text) && /support|not allowed|invalid|unsupported|cannot|can't|does not|doesn't|only/.test(text)) {
    return 'vision';
  }
  if (/\btools?\b|function[ _]call|tool_choice|tool use/.test(text) && /support|not allowed|invalid|unrecognized|unknown|disabled/.test(text)) {
    return 'tools';
  }
  if (/temperature/.test(text) && /support|only|default|unsupported|not allowed/.test(text)) return 'temperature';
  if (/max_tokens|max_completion_tokens/.test(text)) return 'max_tokens';
  return null;
}

/** Server-sent events as `{ event, data }`, tolerant of comments and CRLF. */
export async function* readSse(
  response: Response,
): AsyncGenerator<{ event: string | null; data: string }> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | null = null;
  let data: string[] = [];

  const flush = function* () {
    if (data.length) yield { event, data: data.join('\n') };
    event = null;
    data = [];
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1);
        if (line === '') {
          yield* flush();
        } else if (line.startsWith(':')) {
          // Comment / keep-alive (OpenRouter sends ": OPENROUTER PROCESSING").
        } else {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const valueText = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'data') data.push(valueText);
          else if (field === 'event') event = valueText;
        }
      }
    }
    if (buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}

export function scrub(provider: Pick<ResolvedProvider, 'apiKey' | 'headers'>, text: string): string {
  return redact(text, [provider.apiKey, ...Object.values(provider.headers)]);
}

export function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'the configured URL';
  }
}

function describeNetworkError(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  if (cause?.code === 'ECONNREFUSED') return 'connection refused (is the server running?)';
  if (cause?.code === 'ENOTFOUND') return 'host not found';
  if (cause?.code === 'CERT_HAS_EXPIRED' || cause?.code?.startsWith('ERR_TLS')) return 'TLS certificate problem';
  if (/redirect/i.test(String((error as Error)?.message ?? ''))) {
    return 'the server tried to redirect; update the base URL to the final address';
  }
  return cause?.message ?? (error instanceof Error ? error.message : String(error));
}
