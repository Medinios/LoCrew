import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolAnnotations } from '../../shared/integrations.js';
import type { IntegrationStore } from '../db/integration-store.js';
import type { ApprovalDecision } from '../runtimes/types.js';
import type { McpClientManager } from './manager.js';

/** A user-configured MCP tool as one agent sees it through the gateway. */
export interface ProxiedTool {
  /** Collision-free name the agent calls, e.g. `filesystem__read_file`. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  serverId: string;
  serverName: string;
  toolName: string;
}

/** What the gateway's tool endpoint needs; implemented by {@link ToolAccessService}. */
export interface AgentToolSurface {
  hasGrants(agentId: string): boolean;
  listTools(agentId: string): ProxiedTool[];
  callTool(agentId: string, name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface ToolAccessDeps {
  integrations: IntegrationStore;
  manager: McpClientManager;
  /** Confirms one call with the operator; refuses when the agent is not running. */
  requestApproval(
    agentId: string,
    request: { toolName: string; input: Record<string, unknown> },
  ): Promise<ApprovalDecision>;
  /** The agent's current run, so a cancelled run cancels its tool calls. */
  signalFor(agentId: string): AbortSignal | undefined;
  agentName(agentId: string): string;
}

/** Text returned to a model from one call, in characters. */
const MAX_TEXT = 100_000;
/** Base64 image data passed through, in characters (~3.75 MB decoded). */
const MAX_IMAGE = 5_000_000;
/** Longest proxied tool name. Leaves room for runtime prefixes like `mcp__tools__`. */
const MAX_NAME = 50;

/**
 * The single enforcement point for MCP tool permissions.
 *
 * Every agent -- Claude Code, Codex, API model or anything added later --
 * reaches user-configured MCP tools only through the gateway's tool endpoint,
 * which calls into this service. Grants are re-read from the database on
 * every call, so revoking one takes effect immediately, and nothing a tool
 * returns can change them: tool output is data, never configuration.
 */
export class ToolAccessService implements AgentToolSurface {
  constructor(private readonly deps: ToolAccessDeps) {}

  hasGrants(agentId: string): boolean {
    return this.deps.integrations.listGrants({ agentId }).length > 0;
  }

  listTools(agentId: string): ProxiedTool[] {
    const grants = this.deps.integrations.listGrants({ agentId });
    if (!grants.length) return [];

    const servers = this.deps.integrations
      .listMcpServers()
      .filter((server) => grants.some((g) => g.serverId === server.id));
    const slugs = serverSlugs(servers);

    const tools: ProxiedTool[] = [];
    for (const server of servers) {
      const granted = new Set(grants.filter((g) => g.serverId === server.id).map((g) => g.toolName));
      for (const tool of server.toolsCache) {
        if (!granted.has(tool.name)) continue;
        tools.push({
          name: qualifyToolName(slugs.get(server.id) ?? 'mcp', tool.name),
          description: `[${server.name}] ${tool.description ?? tool.title ?? tool.name}`.slice(0, 2000),
          inputSchema: normaliseSchema(tool.inputSchema),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          serverId: server.id,
          serverName: server.name,
          toolName: tool.name,
        });
      }
    }
    return tools;
  }

  async callTool(agentId: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const agent = this.deps.agentName(agentId);
    const tool = this.listTools(agentId).find((t) => t.name === name);
    if (!tool) {
      console.info(`[mcp] refused ${agent} -> ${name}: not granted`);
      return errorResult(`You are not permitted to use "${name}", or it is no longer available.`);
    }

    // Re-read the grant itself: the listing above is the same data, but this
    // is the line a security review looks for.
    const grant = this.deps.integrations.getGrant(agentId, tool.serverId, tool.toolName);
    if (!grant) return errorResult(`You are not permitted to use "${name}".`);

    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return errorResult('Tool arguments must be a JSON object.');
    }

    if (grant.mode === 'ask') {
      const decision = await this.deps.requestApproval(agentId, {
        toolName: `${tool.serverName} → ${tool.toolName}`,
        input: args,
      });
      if (!decision.approved) {
        console.info(`[mcp] declined ${agent} -> ${tool.serverName}/${tool.toolName}`);
        return errorResult(decision.reason ?? 'The operator declined this tool call.');
      }
    }

    const result = await this.deps.manager.callTool(tool.serverId, tool.toolName, args, {
      signal: this.deps.signalFor(agentId),
    });
    // Arguments and results are deliberately not logged: they can hold
    // credentials or private data.
    console.info(
      `[mcp] ${agent} -> ${tool.serverName}/${tool.toolName}: ${result.isError ? 'error' : 'ok'}`,
    );
    return boundResult(result);
  }
}

/* -------------------------------------------------------------------------- */

/** Short, unique, name-safe prefixes for a set of servers. */
function serverSlugs(servers: Array<{ id: string; name: string }>): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const server of servers) {
    let slug =
      server.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 16) || 'mcp';
    if (used.has(slug)) slug = `${slug.slice(0, 11)}_${shortHash(server.id, 4)}`;
    used.add(slug);
    result.set(server.id, slug);
  }
  return result;
}

/**
 * `slug__tool`, restricted to the characters every provider accepts in a
 * function name and kept short enough for runtimes that add their own prefix.
 */
export function qualifyToolName(slug: string, toolName: string): string {
  const name = `${slug}__${toolName.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  if (name.length <= MAX_NAME) return name;
  return `${name.slice(0, MAX_NAME - 7)}_${shortHash(name, 6)}`;
}

function shortHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/** Model APIs insist on an object schema at the top level. */
function normaliseSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && typeof schema === 'object' && schema.type === 'object') return schema;
  return { type: 'object', properties: {} };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Caps what one tool call can push into a model's context. */
function boundResult(result: CallToolResult): CallToolResult {
  let budget = MAX_TEXT;
  const content: CallToolResult['content'] = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text') {
      if (budget <= 0) continue;
      const text = item.text.length > budget ? `${item.text.slice(0, budget)}\n… (output truncated)` : item.text;
      budget -= text.length;
      content.push({ ...item, text });
    } else if (item.type === 'image' || item.type === 'audio') {
      content.push(
        item.data.length <= MAX_IMAGE
          ? item
          : { type: 'text', text: `[${item.type} omitted: larger than the app passes to agents]` },
      );
    } else {
      content.push(item);
    }
  }
  if (result.structuredContent && budget > 0) {
    const json = JSON.stringify(result.structuredContent);
    if (json.length > budget) {
      return { content, isError: result.isError };
    }
  }
  return { ...result, content };
}
