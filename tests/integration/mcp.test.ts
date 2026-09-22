/**
 * MCP integration against real servers built with the official SDK: a stdio
 * server (tests/fixtures/mcp-notes-server.mjs, launched as a child process)
 * and an in-process Streamable HTTP server. Covers connection and launch
 * approval, discovery, per-agent grants, confirmation, enforcement and a
 * server that dies mid-session.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { waitFor } from '../support/collect.js';
import { createHarness, type Harness } from '../harness.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'mcp-notes-server.mjs');

let h: Harness;
let http: { server: Server; url: string; authHeaders: string[] } | null = null;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.dispose();
  if (http) {
    http.server.closeAllConnections?.();
    await new Promise<void>((r) => http!.server.close(() => r()));
    http = null;
  }
});

function addNotesServer(name = 'Notes', env: Record<string, string> = {}) {
  return h.mcp.create({ name, transport: 'stdio', command: 'node', args: [FIXTURE], env, timeoutMs: 20_000 });
}

/** A stateless Streamable HTTP MCP server that insists on a bearer token. */
async function startHttpServer(token: string) {
  const authHeaders: string[] = [];
  const server = createServer((req, res) => {
    authHeaders.push(String(req.headers.authorization ?? ''));
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const mcp = new McpServer({ name: 'remote-tools', version: '0.9.0' });
        mcp.registerTool(
          'search_repositories',
          { description: 'Searches repositories.', inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
          async ({ query }) => ({ content: [{ type: 'text', text: `3 repositories match "${query}"` }] }),
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        const raw = Buffer.concat(chunks).toString('utf8');
        await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  http = { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, authHeaders };
  return http;
}

describe('connecting an MCP server', () => {
  it('asks before launching a stdio server, showing the exact command', async () => {
    const server = addNotesServer();

    // A background connect never prompts; it just reports that approval is needed.
    const quiet = await h.mcp.connect(server.id, { interactive: false });
    expect(quiet.status).toBe('error');
    expect(quiet.statusDetail).toMatch(/approval/);
    expect(h.launchRequests).toHaveLength(0);

    h.approveLaunches = false;
    const refused = await h.mcp.connect(server.id, { interactive: true });
    expect(refused.status).toBe('error');
    expect(refused.statusDetail).toMatch(/not approved/);
    expect(h.launchRequests[0]).toMatchObject({ serverName: 'Notes', command: 'node', args: [FIXTURE] });

    h.approveLaunches = true;
    const connected = await h.mcp.connect(server.id, { interactive: true });
    expect(connected.status).toBe('connected');
    expect(connected.launchApproved).toBe(true);
  });

  it('remembers the approval until the command line changes', async () => {
    const server = addNotesServer();
    await h.mcp.connect(server.id, { interactive: true });
    await h.mcp.disconnect(server.id);

    // Same command: reconnecting in the background needs no new approval.
    expect((await h.mcp.connect(server.id, { interactive: false })).status).toBe('connected');
    expect(h.launchRequests).toHaveLength(1);

    // A changed argument list is a different program as far as consent goes.
    await h.mcp.update(server.id, { name: 'Notes', transport: 'stdio', command: 'node', args: [FIXTURE, '--extra'] });
    const after = await h.mcp.connect(server.id, { interactive: false });
    expect(after.status).toBe('error');
    expect(after.launchApproved).toBe(false);
  });

  it('passes secret environment variables to the server without exposing them', async () => {
    const server = addNotesServer('Notes', { NOTES_TOKEN: 'env-secret-4242' });
    expect(server.envKeys).toEqual(['NOTES_TOKEN']);
    expect(JSON.stringify(server)).not.toContain('env-secret-4242');
    expect(JSON.stringify(h.database.sqlite.prepare('SELECT * FROM mcp_servers').all())).not.toContain('env-secret-4242');

    await h.mcp.connect(server.id, { interactive: true });
    const result = await h.mcp.callTool(server.id, 'env_value', { name: 'NOTES_TOKEN' });
    expect(result.content[0]).toMatchObject({ text: 'env-secret-4242' });
    // Only the SDK's safe default environment is inherited, not ours.
    process.env.AW_TEST_LEAK = 'should-not-leak';
    await h.mcp.reconnect(server.id);
    const leak = await h.mcp.callTool(server.id, 'env_value', { name: 'AW_TEST_LEAK' });
    expect(leak.content[0]).toMatchObject({ text: '(unset)' });
    delete process.env.AW_TEST_LEAK;
  });

  it('connects to a Streamable HTTP server with a bearer token', async () => {
    const remote = await startHttpServer('remote-token-777');
    const server = h.mcp.create({
      name: 'Remote Tools',
      transport: 'streamable-http',
      url: remote.url,
      authMethod: 'bearer',
      token: 'remote-token-777',
    });
    const view = await h.mcp.connect(server.id, { interactive: false });
    expect(view.status).toBe('connected');
    expect(view.serverInfo).toMatchObject({ name: 'remote-tools', version: '0.9.0' });
    expect(view.tools.map((t) => t.name)).toEqual(['search_repositories']);
    expect(remote.authHeaders.every((a) => a === 'Bearer remote-token-777')).toBe(true);
    expect(view.hasToken).toBe(true);
  });

  it('refuses plain http to a remote MCP server unless explicitly allowed', () => {
    expect(() => h.mcp.create({ name: 'Insecure', transport: 'streamable-http', url: 'http://example.com/mcp' })).toThrow(/https/);
    expect(() =>
      h.mcp.create({ name: 'Insecure', transport: 'streamable-http', url: 'http://example.com/mcp', allowInsecure: true }),
    ).not.toThrow();
  });
});

describe('discovering MCP tools', () => {
  it('lists tools with descriptions and annotations, plus resources, prompts and capabilities', async () => {
    const server = addNotesServer();
    const view = await h.mcp.connect(server.id, { interactive: true });

    expect(view.tools.map((t) => t.name)).toEqual(['echo', 'add_note', 'list_notes', 'env_value', 'crash']);
    expect(view.tools.find((t) => t.name === 'echo')).toMatchObject({
      title: 'Echo',
      description: 'Returns the text it is given.',
      annotations: { readOnlyHint: true },
    });
    expect(view.resources).toEqual([{ uri: 'notes://readme', name: 'readme', description: 'What this server is.', mimeType: 'text/plain' }]);
    expect(view.prompts.map((p) => p.name)).toEqual(['summarise']);
    expect(view.serverInfo).toMatchObject({
      name: 'notes-fixture',
      version: '1.2.3',
      instructions: 'A notes store for tests.',
      capabilities: { tools: true, resources: true, prompts: true },
    });
    expect(await h.mcp.readResource(server.id, 'notes://readme')).toBe('A notes store for tests.');

    // The discovery survives a disconnect, so tools can be granted offline.
    await h.mcp.disconnect(server.id);
    expect(h.mcp.get(server.id)!.tools).toHaveLength(5);
  });
});

describe('agent tool permissions', () => {
  it('grants nothing by default and only what is assigned', async () => {
    const server = addNotesServer();
    await h.mcp.connect(server.id, { interactive: true });
    const architect = h.createAgent('Security Architect');
    const other = h.createAgent('Frontend Developer');

    expect(h.toolAccess.listTools(architect.id)).toEqual([]);

    h.integrations.setAgentGrants(architect.id, [
      { serverId: server.id, toolName: 'echo', mode: 'allow' },
      { serverId: server.id, toolName: 'list_notes', mode: 'allow' },
    ]);

    expect(h.toolAccess.listTools(architect.id).map((t) => t.name)).toEqual(['notes__echo', 'notes__list_notes']);
    expect(h.toolAccess.listTools(other.id)).toEqual([]);
    expect(h.gateway.connectionFor(architect.id).hasToolGrants).toBe(true);
    expect(h.gateway.connectionFor(other.id).hasToolGrants).toBe(false);
  });

  it('rejects a call to a tool the agent was not granted', async () => {
    const server = addNotesServer();
    await h.mcp.connect(server.id, { interactive: true });
    const agent = h.createAgent('Reviewer');
    h.integrations.setAgentGrants(agent.id, [{ serverId: server.id, toolName: 'echo', mode: 'allow' }]);

    const refused = await h.toolAccess.callTool(agent.id, 'notes__add_note', { note: 'sneaky' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]).toMatchObject({ text: expect.stringMatching(/not permitted/) });

    // And the server was never asked.
    const list = await h.mcp.callTool(server.id, 'list_notes', {});
    expect(list.content[0]).toMatchObject({ text: '[]' });
  });

  it('stops working the moment a grant is revoked', async () => {
    const server = addNotesServer();
    await h.mcp.connect(server.id, { interactive: true });
    const agent = h.createAgent('Reviewer');
    h.integrations.setAgentGrants(agent.id, [{ serverId: server.id, toolName: 'echo', mode: 'allow' }]);
    h.integrations.setAgentGrants(agent.id, []);
    expect((await h.toolAccess.callTool(agent.id, 'notes__echo', { text: 'x' })).isError).toBe(true);
  });

  it('removes grants with the server', async () => {
    const server = addNotesServer();
    const agent = h.createAgent('Reviewer');
    h.integrations.setAgentGrants(agent.id, [{ serverId: server.id, toolName: 'echo', mode: 'allow' }]);
    await h.mcp.delete(server.id);
    expect(h.integrations.listGrants({ agentId: agent.id })).toEqual([]);
  });
});

describe('handling disconnected MCP servers', () => {
  it('reports a server that dies and fails tool calls cleanly', async () => {
    const remote = await startHttpServer('t');
    const server = h.mcp.create({ name: 'Remote', transport: 'streamable-http', url: remote.url, authMethod: 'bearer', token: 't' });
    await h.mcp.connect(server.id, { interactive: false });

    // The remote goes away.
    remote.server.closeAllConnections?.();
    await new Promise<void>((r) => remote.server.close(() => r()));
    http = null;

    const result = await h.mcp.callTool(server.id, 'search_repositories', { query: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/Remote/) });
  });

  it('notices when a stdio server process exits', async () => {
    const server = addNotesServer();
    await h.mcp.connect(server.id, { interactive: true });
    await h.mcp.callTool(server.id, 'crash', {});
    await waitFor(() => h.mcp.statusOf(server.id) === 'error', 10_000, 'the crash to be noticed');
    expect(h.mcp.get(server.id)!.statusDetail).toMatch(/closed the connection/);
  });
});
