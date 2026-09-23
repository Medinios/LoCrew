/**
 * The provider registry and its adapters, over real HTTP against a local mock
 * of each wire protocol (tests/support/mock-provider.ts). No real provider is
 * contacted and none is claimed to be: these tests prove request shapes,
 * parsing, discovery, credential handling and failure behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collect } from '../support/collect.js';
import { startMockProvider, textStream, toolCallStream, type MockProvider } from '../support/mock-provider.js';
import { createHarness, type Harness } from '../harness.js';
import { rejectedFeature } from '../../src/main/providers/http.js';
import type { ProviderInput } from '../../src/main/providers/registry.js';

let h: Harness;
let mock: MockProvider;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await mock?.close();
  await h.dispose();
});

function openAiInput(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    name: 'My Local AI',
    preset: 'custom',
    kind: 'openai-compatible',
    category: 'custom',
    baseUrl: `${mock.url}/v1`,
    authMethod: 'bearer',
    apiKey: 'sk-test-secret-123456',
    headers: [
      { name: 'X-Title', value: 'LoCrew', secret: false },
      { name: 'X-Org-Token', value: 'org-secret-987654', secret: false },
    ],
    ...overrides,
  };
}

describe('registering a custom provider', () => {
  it('stores the key encrypted and never returns it', async () => {
    mock = await startMockProvider(() => ({ status: 200, json: { data: [] } }));
    const view = h.providers.create(openAiInput());

    expect(view.hasApiKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-test-secret-123456');
    // A header whose name looks like a credential is treated as one.
    expect(view.headers.find((x) => x.name === 'X-Org-Token')).toMatchObject({ secret: true, value: '', hasValue: true });
    expect(view.headers.find((x) => x.name === 'X-Title')).toMatchObject({ secret: false, value: 'LoCrew' });

    // Nothing in the database holds the plaintext.
    const dump = JSON.stringify(h.database.sqlite.prepare('SELECT * FROM providers').all()) +
      JSON.stringify(h.database.sqlite.prepare('SELECT * FROM secrets').all());
    expect(dump).not.toContain('sk-test-secret-123456');
    expect(dump).not.toContain('org-secret-987654');
  });

  it('keeps the stored key when an edit leaves the field empty', async () => {
    mock = await startMockProvider(() => ({ status: 200, json: { data: [] } }));
    const view = h.providers.create(openAiInput());
    h.providers.update(view.id, openAiInput({ name: 'Renamed', apiKey: '' }));
    expect(h.providers.resolve(view.id).apiKey).toBe('sk-test-secret-123456');
    h.providers.update(view.id, openAiInput({ name: 'Renamed', apiKey: null }));
    expect(h.providers.resolve(view.id).apiKey).toBeNull();
  });

  it('refuses plain http to a remote host and credentials in the URL', () => {
    expect(() =>
      h.providers.create({ ...openAiInput(), baseUrl: 'http://example.com/v1', name: 'Remote' }),
    ).toThrow(/https/);
    expect(() =>
      h.providers.create({ ...openAiInput(), baseUrl: 'https://user:pass@example.com/v1', name: 'Creds' }),
    ).toThrow(/credentials/i);
  });

  it('will not delete a provider an agent still uses', async () => {
    mock = await startMockProvider(() => ({ status: 200, json: { data: [] } }));
    const provider = h.providers.create(openAiInput());
    h.createAgent('Security Architect', {
      runtimeType: 'model',
      config: { maxTurnsPerExecution: 8, timeoutMs: 60_000, autoCompact: false, providerId: provider.id, model: 'm' },
    });
    expect(() => h.providers.delete(provider.id)).toThrow(/Security Architect/);
  });
});

describe('OpenAI-compatible API', () => {
  it('tests the connection and discovers models with capability data', async () => {
    mock = await startMockProvider((req) =>
      req.path === '/v1/models'
        ? {
            status: 200,
            json: {
              data: [
                // OpenRouter-style metadata.
                {
                  id: 'vendor/big-model',
                  context_length: 131072,
                  supported_parameters: ['tools', 'temperature', 'response_format'],
                  architecture: { input_modalities: ['text', 'image'] },
                  top_provider: { max_completion_tokens: 16384 },
                },
                // Groq-style metadata.
                { id: 'small-model', context_window: 8192, max_completion_tokens: 1024 },
                // Bare OpenAI shape: nothing known.
                { id: 'plain-model', owned_by: 'someone' },
              ],
            },
          }
        : { status: 404, json: { error: 'no' } },
    );
    const provider = h.providers.create(openAiInput());

    const result = await h.providers.test(provider.id);
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(3);

    const discovered = await h.providers.discover(provider.id);
    const big = discovered.models.find((m) => m.id === 'vendor/big-model')!;
    expect(big.capabilities).toMatchObject({
      contextWindow: 131072,
      maxOutputTokens: 16384,
      tools: true,
      vision: true,
      structuredOutput: true,
    });
    expect(discovered.models.find((m) => m.id === 'small-model')!.capabilities.contextWindow).toBe(8192);
    expect(discovered.models.find((m) => m.id === 'plain-model')!.capabilities.tools).toBeNull();

    // Credentials and custom headers went out on the request.
    const request = mock.requests.find((r) => r.path === '/v1/models')!;
    expect(request.headers.authorization).toBe('Bearer sk-test-secret-123456');
    expect(request.headers['x-title']).toBe('LoCrew');
    expect(request.headers['x-org-token']).toBe('org-secret-987654');
  });

  it('keeps manual models and overrides when rediscovering', async () => {
    mock = await startMockProvider(() => ({ status: 200, json: { data: [{ id: 'a' }] } }));
    const provider = h.providers.create(openAiInput());
    await h.providers.discover(provider.id);
    const current = h.providers.get(provider.id)!.models;
    h.providers.setModels(provider.id, [
      { ...current[0]!, overrides: { tools: false } },
      { id: 'hand-typed', source: 'manual', capabilities: { contextWindow: null, maxOutputTokens: null, tools: null, vision: null, streaming: null, structuredOutput: null }, overrides: {} },
    ]);
    const again = await h.providers.discover(provider.id);
    expect(again.models.map((m) => m.id).sort()).toEqual(['a', 'hand-typed']);
    expect(again.models.find((m) => m.id === 'a')!.overrides).toEqual({ tools: false });
  });

  it('streams text and assembles tool calls split across chunks', async () => {
    mock = await startMockProvider((req) =>
      (req.body?.messages as unknown[]).length > 1
        ? toolCallStream([{ id: 'call_1', name: 'lookup', args: { query: 'auth flows', limit: 3 } }])
        : textStream('Hello from the model.'),
    );
    const provider = h.providers.create(openAiInput());

    const text = await collect(
      h.providers.chat(provider.id, { model: 'm', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal }),
    );
    expect(text.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Hello from the model.');
    expect(text).toContainEqual({ type: 'usage', inputTokens: 12, outputTokens: 7 });

    const calls = await collect(
      h.providers.chat(provider.id, {
        model: 'm',
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'find it' },
        ],
        tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }],
        signal: new AbortController().signal,
      }),
    );
    const call = calls.find((e) => e.type === 'tool_call') as { call: { name: string; arguments: string } };
    expect(call.call.name).toBe('lookup');
    expect(JSON.parse(call.call.arguments)).toEqual({ query: 'auth flows', limit: 3 });

    // The request carried the tool in Chat Completions shape.
    const sent = mock.requests.filter((r) => r.path === '/v1/chat/completions')[1]!;
    expect(sent.body?.tools).toEqual([{ type: 'function', function: { name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } } }]);
  });

  it('accepts a non-streaming JSON answer from servers that ignore stream: true', async () => {
    mock = await startMockProvider(() => ({
      status: 200,
      json: { choices: [{ message: { content: 'whole answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    }));
    const provider = h.providers.create(openAiInput());
    const events = await collect(h.providers.chat(provider.id, { model: 'm', messages: [{ role: 'user', content: 'x' }], signal: new AbortController().signal }));
    expect(events[0]).toEqual({ type: 'text', text: 'whole answer' });
  });

  it('surfaces an error sent inside a 200 stream', async () => {
    mock = await startMockProvider(() => ({ sse: [{ error: { message: 'upstream overloaded' } }] }));
    const provider = h.providers.create(openAiInput());
    await expect(
      collect(h.providers.chat(provider.id, { model: 'm', messages: [{ role: 'user', content: 'x' }], signal: new AbortController().signal })),
    ).rejects.toThrow(/upstream overloaded/);
  });

  it('uses max_completion_tokens where the preset says so', async () => {
    mock = await startMockProvider(() => textStream('ok'));
    const provider = h.providers.create(openAiInput({ options: { tokenParameter: 'max_completion_tokens' } }));
    await collect(h.providers.chat(provider.id, { model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 50, signal: new AbortController().signal }));
    expect(mock.requests[0]!.body).toMatchObject({ max_completion_tokens: 50 });
    expect(mock.requests[0]!.body).not.toHaveProperty('max_tokens');
  });
});

describe('handling unavailable providers', () => {
  it('reports a refused connection without throwing', async () => {
    mock = await startMockProvider(() => ({ status: 200, json: {} }));
    const url = mock.url;
    await mock.close();
    const provider = h.providers.create(openAiInput({ baseUrl: `${url}/v1` }));
    const result = await h.providers.test(provider.id);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not reach My Local AI/);
    expect(h.providers.get(provider.id)!.lastCheck).toMatchObject({ ok: false });
  });

  it('never echoes the key back in an error, even when the server does', async () => {
    mock = await startMockProvider(() => ({ status: 401, json: { error: { message: 'Invalid key sk-test-secret-123456 for org-secret-987654' } } }));
    const provider = h.providers.create(openAiInput());
    const result = await h.providers.test(provider.id);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected the credentials/);
    expect(result.message).not.toContain('sk-test-secret-123456');
    expect(result.message).not.toContain('org-secret-987654');
  });

  it('refuses to follow a redirect with credentials attached', async () => {
    mock = await startMockProvider(() => ({ redirect: 'http://127.0.0.1:9/elsewhere' }));
    const provider = h.providers.create(openAiInput());
    const result = await h.providers.test(provider.id);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/redirect/i);
  });

  it('tests an unsaved draft without persisting anything', async () => {
    mock = await startMockProvider(() => ({ status: 200, json: { data: [{ id: 'x' }] } }));
    const result = await h.providers.testDraft(openAiInput());
    expect(result.ok).toBe(true);
    expect(h.providers.list()).toHaveLength(0);
    expect(h.database.sqlite.prepare('SELECT count(*) AS n FROM secrets').get()).toEqual({ n: 0 });
  });
});

describe('local Ollama (mocked Ollama API)', () => {
  it('discovers models with their real capabilities and chats through /v1', async () => {
    mock = await startMockProvider((req) => {
      if (req.path === '/api/tags') return { status: 200, json: { models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }, { name: 'llava:7b', model: 'llava:7b' }, { name: 'nomic-embed-text', model: 'nomic-embed-text' }] } };
      if (req.path === '/api/show') {
        const model = req.body?.model;
        if (model === 'qwen3:8b') return { status: 200, json: { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'qwen3.context_length': 40960 } } };
        if (model === 'llava:7b') return { status: 200, json: { capabilities: ['completion', 'vision'], model_info: { 'llama.context_length': 4096 } } };
        return { status: 200, json: { capabilities: ['embedding'] } };
      }
      if (req.path === '/v1/chat/completions') return textStream('Local answer.');
      return { status: 404, json: {} };
    });

    const provider = h.providers.create({
      name: 'Ollama',
      preset: 'ollama',
      kind: 'ollama',
      category: 'local',
      baseUrl: mock.url,
      authMethod: 'none',
    });
    const view = await h.providers.discover(provider.id);

    expect(view.models.map((m) => m.id)).toEqual(['llava:7b', 'qwen3:8b']); // embedding model left out
    expect(view.models.find((m) => m.id === 'qwen3:8b')!.capabilities).toMatchObject({ tools: true, vision: false, contextWindow: 40960 });
    expect(view.models.find((m) => m.id === 'llava:7b')!.capabilities).toMatchObject({ tools: false, vision: true });

    const events = await collect(h.providers.chat(provider.id, { model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal }));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Local answer.');
    expect(mock.requests.find((r) => r.path === '/v1/chat/completions')?.headers.authorization).toBeUndefined();
  });
});

describe('Anthropic adapter (mocked Messages API through the official SDK)', () => {
  it('discovers models and streams text and tool use', async () => {
    mock = await startMockProvider((req) => {
      if (req.path.startsWith('/v1/models')) {
        return {
          status: 200,
          json: {
            data: [
              {
                id: 'claude-test-1',
                type: 'model',
                display_name: 'Claude Test',
                created_at: '2026-01-01T00:00:00Z',
                max_input_tokens: 200000,
                max_tokens: 64000,
                capabilities: { image_input: { supported: true }, structured_outputs: { supported: true } },
              },
            ],
            has_more: false,
            first_id: 'claude-test-1',
            last_id: 'claude-test-1',
          },
        };
      }
      return {
        events: ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'],
        sse: [
          { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test-1', content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"x"}' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
          { type: 'message_stop' },
        ],
      };
    });

    const provider = h.providers.create({
      name: 'Anthropic',
      preset: 'anthropic',
      kind: 'anthropic',
      category: 'builtin',
      baseUrl: mock.url,
      authMethod: 'header',
      authHeaderName: 'x-api-key',
      apiKey: 'sk-ant-test-key-000',
      options: { anthropicVersion: '2023-06-01' },
    });

    const view = await h.providers.discover(provider.id);
    expect(view.models[0]).toMatchObject({ id: 'claude-test-1', label: 'Claude Test' });
    expect(view.models[0]!.capabilities).toMatchObject({ contextWindow: 200000, maxOutputTokens: 64000, tools: true, vision: true });

    const events = await collect(
      h.providers.chat(provider.id, {
        model: 'claude-test-1',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'look it up' },
        ],
        tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: { query: { type: 'string' } } } }],
        signal: new AbortController().signal,
      }),
    );
    expect(events).toContainEqual({ type: 'text', text: 'Checking.' });
    expect(events).toContainEqual({ type: 'tool_call', call: { id: 'toolu_1', name: 'lookup', arguments: '{"query":"x"}' } });
    expect(events).toContainEqual({ type: 'usage', inputTokens: 20, outputTokens: 15 });

    const sent = mock.requests.find((r) => r.path === '/v1/messages')!;
    expect(sent.headers['x-api-key']).toBe('sk-ant-test-key-000');
    expect(sent.body).toMatchObject({ system: 'Be brief.', max_tokens: 4096, stream: true });
    expect(sent.body?.tools).toEqual([{ name: 'lookup', description: 'd', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }]);
  });
});

describe('Gemini adapter (mocked)', () => {
  it('reads token limits from the native list and chats through the compatibility endpoint', async () => {
    mock = await startMockProvider((req) => {
      if (req.path.startsWith('/v1beta/models')) {
        return {
          status: 200,
          json: {
            models: [
              { name: 'models/gemini-test', displayName: 'Gemini Test', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
              { name: 'models/embedding-test', supportedGenerationMethods: ['embedContent'] },
            ],
          },
        };
      }
      if (req.path === '/v1beta/openai/chat/completions') return textStream('Gemini says hi.');
      return { status: 404, json: {} };
    });
    const provider = h.providers.create({
      name: 'Gemini',
      preset: 'gemini',
      kind: 'gemini',
      category: 'builtin',
      baseUrl: mock.url,
      authMethod: 'header',
      authHeaderName: 'x-goog-api-key',
      apiKey: 'gemini-key-1234',
    });
    const view = await h.providers.discover(provider.id);
    expect(view.models).toHaveLength(1);
    expect(view.models[0]!.capabilities).toMatchObject({ contextWindow: 1048576, maxOutputTokens: 65536 });
    expect(mock.requests[0]!.headers['x-goog-api-key']).toBe('gemini-key-1234');

    const events = await collect(h.providers.chat(provider.id, { model: 'gemini-test', messages: [{ role: 'user', content: 'x' }], signal: new AbortController().signal }));
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(0);
    // The compatibility endpoint takes the same key as a bearer token.
    expect(mock.requests.find((r) => r.path === '/v1beta/openai/chat/completions')!.headers.authorization).toBe('Bearer gemini-key-1234');
  });
});

describe('learning capabilities from errors', () => {
  it('recognises which parameter a provider refused', () => {
    expect(rejectedFeature('This model does not support tools')).toBe('tools');
    expect(rejectedFeature("Unsupported parameter: 'temperature' is not supported with this model.")).toBe('temperature');
    expect(rejectedFeature('Unrecognized request argument supplied: stream_options')).toBe('stream_options');
    expect(rejectedFeature("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.")).toBe('max_tokens');
    expect(rejectedFeature('Something else went wrong')).toBeNull();
  });
});
