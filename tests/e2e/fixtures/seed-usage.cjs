const Database = require('better-sqlite3');
const { join } = require('node:path');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { migrate } = require('drizzle-orm/better-sqlite3/migrator');

const dir = process.argv[2];
if (!dir) throw new Error('A temporary profile directory is required');

const sqlite = new Database(join(dir, 'locrew.db'));
try {
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') });

  const now = Date.now();
  const permissions = JSON.stringify({
    workspaceAccess: 'approval_required',
    allowAgentToAgent: true,
    allowTaskUpdates: true,
    maxCostPerExecutionUsd: 2,
  });
  const config = JSON.stringify({ autoCompact: true, maxTurnsPerExecution: 24, timeoutMs: 600000 });

  sqlite
    .prepare(
      `INSERT INTO conversations (id, kind, name, autonomy_enabled, created_at, updated_at)
       VALUES ('usage-fixture', 'channel', 'usage-fixture', 1, ?, ?)`,
    )
    .run(now, now);

  const agents = [
    ['fixture-codex', 'Measured Codex', 'codex'],
    ['fixture-claude', 'Legacy Claude', 'claude-code'],
    ['fixture-model', 'Unpriced Model', 'model'],
  ];
  const insertAgent = sqlite.prepare(
    `INSERT INTO agents (id, name, description, runtime_type, avatar, avatar_color,
       working_directory, status, permissions, config, created_at, updated_at)
     VALUES (?, ?, '', ?, '', '#7C6CF6', ?, 'offline', ?, ?, ?, ?)`,
  );
  const insertMember = sqlite.prepare(
    `INSERT INTO conversation_members (conversation_id, member_type, member_id, joined_at)
     VALUES ('usage-fixture', 'agent', ?, ?)`,
  );
  for (const [id, name, runtime] of agents) {
    insertAgent.run(id, name, runtime, dir, permissions, config, now, now);
    insertMember.run(id, now);
  }

  const insertExecution = sqlite.prepare(
    `INSERT INTO agent_executions (id, agent_id, conversation_id, state, trigger,
       chain_id, chain_depth, turns, cost_usd, raw_cost_usd, cost_provenance,
       input_tokens, output_tokens, started_at, ended_at)
     VALUES (?, ?, 'usage-fixture', 'completed', 'human', ?, 0, 1, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const startedAt = now - 60_000;
  insertExecution.run('exec-codex', 'fixture-codex', 'chain-codex', 1.25, 1.25, 'measured', 800, 200, startedAt, now);
  insertExecution.run('exec-claude', 'fixture-claude', 'chain-claude', 4.5, 4.5, 'legacy', 0, 0, startedAt, now);
  insertExecution.run('exec-model', 'fixture-model', 'chain-model', 0, 0, 'unpriced', 900, 300, startedAt, now);
} finally {
  sqlite.close();
}
