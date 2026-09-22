import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scriptable HTTP server that speaks provider wire protocols (OpenAI Chat
 * Completions SSE, Anthropic Messages SSE, Ollama and Gemini discovery).
 *
 * THIS IS A TEST DOUBLE. It lets the provider adapters and the model agent
 * loop run end to end over real HTTP without credentials or a GPU. Tests that
 * use it say so; nothing here is presented as testing a real provider.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

export type MockReply =
  | { status: number; json: unknown }
  | { sse: Array<string | Record<string, unknown>>; events?: string[] }
  | { redirect: string };

export interface MockProvider {
  url: string;
  requests: RecordedRequest[];
  /** Replace the request handler mid-test. */
  handle(handler: (request: RecordedRequest) => MockReply | Promise<MockReply>): void;
  close(): Promise<void>;
}

export async function startMockProvider(
  handler: (request: RecordedRequest) => MockReply | Promise<MockReply>,
): Promise<MockProvider> {
  let current = handler;
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> | null = null;
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        } catch {
          body = null;
        }
        const recorded: RecordedRequest = {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          headers: req.headers,
          body,
        };
        requests.push(recorded);

        const reply = await current(recorded);
        if ('redirect' in reply) {
          res.writeHead(302, { Location: reply.redirect });
          res.end();
        } else if ('json' in reply) {
          const payload = JSON.stringify(reply.json);
          res.writeHead(reply.status, { 'Content-Type': 'application/json' });
          res.end(payload);
        } else {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          reply.sse.forEach((item, index) => {
            const event = reply.events?.[index];
            if (event) res.write(`event: ${event}\n`);
            res.write(`data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`);
          });
          res.end();
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    handle(next) {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/* ------------------------------------------------------ OpenAI chunk helpers */

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 'chatcmpl-test',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/** A streamed plain-text answer, split into a few deltas, with usage. */
export function textStream(text: string, usage = { prompt_tokens: 12, completion_tokens: 7 }): MockReply {
  const words = text.split(/(?<= )/);
  return {
    sse: [
      chunk({ role: 'assistant', content: '' }),
      ...words.map((w) => chunk({ content: w })),
      chunk({}, 'stop'),
      { id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [], usage },
      '[DONE]',
    ],
  };
}

/** A streamed tool call, with arguments split across deltas the way real providers do. */
export function toolCallStream(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): MockReply {
  const parts: Array<string | Record<string, unknown>> = [chunk({ role: 'assistant', content: null })];
  calls.forEach((call, index) => {
    const json = JSON.stringify(call.args);
    const mid = Math.floor(json.length / 2);
    parts.push(chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }));
    parts.push(chunk({ tool_calls: [{ index, function: { arguments: json.slice(0, mid) } }] }));
    parts.push(chunk({ tool_calls: [{ index, function: { arguments: json.slice(mid) } }] }));
  });
  parts.push(chunk({}, 'tool_calls'), '[DONE]');
  return { sse: parts };
}

/** The last user/tool turn of a recorded chat request. */
export function lastMessage(request: RecordedRequest): { role: string; content: unknown; tool_call_id?: string } | undefined {
  const messages = (request.body?.messages ?? []) as Array<{ role: string; content: unknown; tool_call_id?: string }>;
  return messages[messages.length - 1];
}

export function chatRequests(provider: MockProvider): RecordedRequest[] {
  return provider.requests.filter((r) => r.method === 'POST' && /chat\/completions|messages$/.test(r.path));
}
