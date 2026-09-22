/**
 * Read-only inspection of the live database.
 *
 * Run with: npm run diagnose
 * (through Electron's Node so it shares the app's better-sqlite3 ABI)
 */
const { join } = require('node:path');
const Database = require('better-sqlite3');

const dbPath =
  process.argv[2] ??
  join(process.env.APPDATA ?? '', 'agent-workspace', 'agent-workspace.db');

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const q = (sql, ...args) => db.prepare(sql).all(...args);

const line = (t) => console.log(`\n=== ${t} ===`);

line('AGENTS');
for (const a of q('SELECT id, name, runtime_type, status, status_detail FROM agents')) {
  console.log(`  ${a.name.padEnd(10)} ${a.runtime_type.padEnd(12)} status=${a.status} detail=${a.status_detail ?? '-'}`);
}

line('CONVERSATIONS');
for (const c of q('SELECT id, kind, name, autonomy_enabled FROM conversations')) {
  console.log(`  ${c.kind.padEnd(8)} ${c.name.padEnd(14)} autonomy=${c.autonomy_enabled} ${c.id}`);
}

line('EXECUTIONS (most recent 25)');
const execs = q(`
  SELECT e.id, a.name AS agent, e.state, e.trigger, e.chain_id, e.chain_depth,
         e.turns, e.cost_usd, e.error, e.started_at, e.ended_at
  FROM agent_executions e LEFT JOIN agents a ON a.id = e.agent_id
  ORDER BY e.started_at DESC LIMIT 25`);
for (const e of execs) {
  const dur = e.ended_at ? `${Math.round((e.ended_at - e.started_at) / 1000)}s` : 'running';
  console.log(
    `  ${new Date(e.started_at).toLocaleTimeString()} ${(e.agent ?? '?').padEnd(8)} ` +
      `${e.state.padEnd(10)} trig=${e.trigger.padEnd(6)} depth=${e.chain_depth} ` +
      `turns=${e.turns} $${Number(e.cost_usd).toFixed(4)} ${dur}` +
      (e.error ? `\n        ERROR: ${String(e.error).slice(0, 220)}` : ''),
  );
}

line('CHAIN SUMMARY');
for (const c of q(`
  SELECT chain_id, COUNT(*) AS runs, SUM(cost_usd) AS cost,
         MIN(started_at) AS first_at, MAX(chain_depth) AS max_depth
  FROM agent_executions GROUP BY chain_id ORDER BY first_at DESC LIMIT 10`)) {
  console.log(
    `  ${new Date(c.first_at).toLocaleTimeString()} runs=${String(c.runs).padEnd(3)} ` +
      `maxDepth=${String(c.max_depth).padEnd(3)} $${Number(c.cost).toFixed(4)}  ${c.chain_id.slice(0, 20)}`,
  );
}

line('LAST 15 MESSAGES');
for (const m of q(`
  SELECT m.kind, m.sender_type, m.sender_id, m.mentions, m.body, m.created_at,
         COALESCE(a.name, 'human') AS sender
  FROM messages m LEFT JOIN agents a ON a.id = m.sender_id
  ORDER BY m.created_at DESC LIMIT 15`).reverse()) {
  const mentions = JSON.parse(m.mentions || '[]');
  console.log(
    `  ${new Date(m.created_at).toLocaleTimeString()} [${m.kind}] ${m.sender} ` +
      `-> ${mentions.length ? `${mentions.length} agent(s)` : 'nobody'}: ` +
      String(m.body).replace(/\s+/g, ' ').slice(0, 130),
  );
}

line('EXECUTION STATE TOTALS');
for (const r of q('SELECT state, COUNT(*) n FROM agent_executions GROUP BY state')) {
  console.log(`  ${r.state.padEnd(12)} ${r.n}`);
}

db.close();
