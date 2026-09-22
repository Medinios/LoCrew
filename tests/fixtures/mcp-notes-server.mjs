// A real MCP server built on the official SDK, spoken to over stdio. Used by
// tests/integration/mcp.test.ts to exercise the client manager, discovery,
// the tool proxy and permission enforcement against the actual protocol.
//
// It keeps notes in memory and exposes them as tools, a resource and a
// prompt. `crash` exits the process, to test a server that dies mid-session.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const notes = [];
const server = new McpServer({ name: 'notes-fixture', version: '1.2.3' }, { instructions: 'A notes store for tests.' });

server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Returns the text it is given.',
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);

server.registerTool(
  'add_note',
  {
    description: 'Stores a note.',
    inputSchema: { note: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ note }) => {
    notes.push(note);
    return { content: [{ type: 'text', text: `stored note ${notes.length}` }] };
  },
);

server.registerTool(
  'list_notes',
  { description: 'Lists stored notes.', inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: 'text', text: JSON.stringify(notes) }] }),
);

server.registerTool(
  'env_value',
  { description: 'Reports whether an environment variable reached the server.', inputSchema: { name: z.string() } },
  async ({ name }) => ({ content: [{ type: 'text', text: process.env[name] ?? '(unset)' }] }),
);

server.registerTool('crash', { description: 'Exits the server process.', inputSchema: {} }, async () => {
  setTimeout(() => process.exit(1), 10);
  return { content: [{ type: 'text', text: 'crashing' }] };
});

server.registerResource(
  'readme',
  'notes://readme',
  { title: 'Readme', description: 'What this server is.', mimeType: 'text/plain' },
  async (uri) => ({ contents: [{ uri: uri.href, text: 'A notes store for tests.' }] }),
);

server.registerPrompt(
  'summarise',
  { description: 'Summarise the notes.', argsSchema: { style: z.string().optional() } },
  async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Summarise the notes.' } }] }),
);

process.stderr.write('notes-fixture ready\n');
await server.connect(new StdioServerTransport());
