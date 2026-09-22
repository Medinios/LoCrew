import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type ClientSdk = {
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  StreamableHTTPClientTransport: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport;
};

let sdk: ClientSdk | null = null;

async function loadSdk(): Promise<ClientSdk> {
  if (!sdk) {
    const [client, http] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    sdk = { Client: client.Client, StreamableHTTPClientTransport: http.StreamableHTTPClientTransport };
  }
  return sdk;
}

export interface GatewayTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * An MCP client session against the app's own loopback gateway, authenticated
 * as one agent. Runtimes that drive a model themselves use this to reach the
 * same tools -- and the same permission checks -- as the CLI runtimes.
 */
export class GatewaySession {
  private constructor(private readonly client: Client) {}

  static async open(url: string, token: string): Promise<GatewaySession> {
    const { Client, StreamableHTTPClientTransport } = await loadSdk();
    const client = new Client({ name: 'locrew-runtime', version: '0.2.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return new GatewaySession(client);
  }

  async listTools(): Promise<GatewayTool[]> {
    const tools: GatewayTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          description: tool.description ?? tool.title ?? tool.name,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    // Tool calls may wait on a human confirmation, so the timeout is generous;
    // the run's own abort signal is what ends a stuck call.
    return (await this.client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: 15 * 60_000,
    })) as CallToolResult;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}

/** Flattens a tool result into the text a model receives. */
export function toolResultText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text') parts.push(item.text);
    else if (item.type === 'image') parts.push(`[image: ${item.mimeType}]`);
    else if (item.type === 'audio') parts.push(`[audio: ${item.mimeType}]`);
    else if (item.type === 'resource_link') parts.push(`[resource: ${item.uri}]`);
    else if (item.type === 'resource') {
      const resource = item.resource as { uri: string; text?: string };
      parts.push(typeof resource.text === 'string' ? resource.text : `[resource: ${resource.uri}]`);
    }
  }
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n') || (result.isError ? 'The tool failed without a message.' : '(no output)');
}
