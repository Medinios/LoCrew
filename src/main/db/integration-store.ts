import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { ToolGrant, ToolGrantMode } from '../../shared/integrations.js';
import type { Db } from './index.js';
import * as t from './schema.js';

export type ProviderRow = typeof t.providers.$inferSelect;
export type McpServerRow = typeof t.mcpServers.$inferSelect;

type ProviderInsert = Omit<ProviderRow, 'id' | 'createdAt' | 'updatedAt'>;
type McpServerInsert = Omit<McpServerRow, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Persistence for the integration layer: providers, MCP servers and tool
 * grants. Plain rows in, plain rows out -- credentials are handled one level
 * up, by services that hold the {@link SecretStore}.
 */
export class IntegrationStore {
  constructor(private readonly db: Db) {}

  /* ------------------------------------------------------------- providers */

  listProviders(): ProviderRow[] {
    return this.db.select().from(t.providers).orderBy(t.providers.createdAt).all();
  }

  getProvider(id: string): ProviderRow | null {
    return this.db.select().from(t.providers).where(eq(t.providers.id, id)).get() ?? null;
  }

  getProviderByName(name: string): ProviderRow | null {
    return this.db.select().from(t.providers).where(eq(t.providers.name, name)).get() ?? null;
  }

  createProvider(input: ProviderInsert): ProviderRow {
    const now = Date.now();
    const row: ProviderRow = { ...input, id: `provider:${randomUUID()}`, createdAt: now, updatedAt: now };
    this.db.insert(t.providers).values(row).run();
    return row;
  }

  updateProvider(id: string, patch: Partial<ProviderInsert>): ProviderRow {
    this.db
      .update(t.providers)
      .set({ ...stripUndefined(patch), updatedAt: Date.now() })
      .where(eq(t.providers.id, id))
      .run();
    const row = this.getProvider(id);
    if (!row) throw new Error('That provider no longer exists.');
    return row;
  }

  deleteProvider(id: string): void {
    this.db.delete(t.providers).where(eq(t.providers.id, id)).run();
  }

  /* ----------------------------------------------------------- MCP servers */

  listMcpServers(): McpServerRow[] {
    return this.db.select().from(t.mcpServers).orderBy(t.mcpServers.createdAt).all();
  }

  getMcpServer(id: string): McpServerRow | null {
    return this.db.select().from(t.mcpServers).where(eq(t.mcpServers.id, id)).get() ?? null;
  }

  getMcpServerByName(name: string): McpServerRow | null {
    return this.db.select().from(t.mcpServers).where(eq(t.mcpServers.name, name)).get() ?? null;
  }

  createMcpServer(input: McpServerInsert): McpServerRow {
    const now = Date.now();
    const row: McpServerRow = { ...input, id: `mcp:${randomUUID()}`, createdAt: now, updatedAt: now };
    this.db.insert(t.mcpServers).values(row).run();
    return row;
  }

  updateMcpServer(id: string, patch: Partial<McpServerInsert>): McpServerRow {
    this.db
      .update(t.mcpServers)
      .set({ ...stripUndefined(patch), updatedAt: Date.now() })
      .where(eq(t.mcpServers.id, id))
      .run();
    const row = this.getMcpServer(id);
    if (!row) throw new Error('That MCP server no longer exists.');
    return row;
  }

  deleteMcpServer(id: string): void {
    // Grants go with it through the foreign key cascade.
    this.db.delete(t.mcpServers).where(eq(t.mcpServers.id, id)).run();
  }

  /* ----------------------------------------------------------- tool grants */

  listGrants(filter?: { agentId?: string; serverId?: string }): ToolGrant[] {
    const conditions = [
      filter?.agentId ? eq(t.agentToolGrants.agentId, filter.agentId) : undefined,
      filter?.serverId ? eq(t.agentToolGrants.serverId, filter.serverId) : undefined,
    ].filter((c) => c !== undefined);
    const query = this.db.select().from(t.agentToolGrants);
    const rows = conditions.length ? query.where(and(...conditions)).all() : query.all();
    return rows.map((r) => ({
      agentId: r.agentId,
      serverId: r.serverId,
      toolName: r.toolName,
      mode: r.mode,
    }));
  }

  getGrant(agentId: string, serverId: string, toolName: string): ToolGrant | null {
    const row = this.db
      .select()
      .from(t.agentToolGrants)
      .where(
        and(
          eq(t.agentToolGrants.agentId, agentId),
          eq(t.agentToolGrants.serverId, serverId),
          eq(t.agentToolGrants.toolName, toolName),
        ),
      )
      .get();
    return row ? { agentId: row.agentId, serverId: row.serverId, toolName: row.toolName, mode: row.mode } : null;
  }

  /** Replaces every grant an agent holds with exactly this set. */
  setAgentGrants(
    agentId: string,
    grants: Array<{ serverId: string; toolName: string; mode: ToolGrantMode }>,
  ): ToolGrant[] {
    this.db.transaction((tx) => {
      tx.delete(t.agentToolGrants).where(eq(t.agentToolGrants.agentId, agentId)).run();
      const now = Date.now();
      const seen = new Set<string>();
      for (const grant of grants) {
        const key = `${grant.serverId}\u0000${grant.toolName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tx.insert(t.agentToolGrants)
          .values({ agentId, serverId: grant.serverId, toolName: grant.toolName, mode: grant.mode, createdAt: now })
          .run();
      }
    });
    return this.listGrants({ agentId });
  }

  /** Copies one agent's grants onto another, for "duplicate agent". */
  copyGrants(fromAgentId: string, toAgentId: string): void {
    const grants = this.listGrants({ agentId: fromAgentId });
    this.setAgentGrants(
      toAgentId,
      grants.map((g) => ({ serverId: g.serverId, toolName: g.toolName, mode: g.mode })),
    );
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
