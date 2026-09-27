/**
 * Upgrading a database written before per-execution accounting existed.
 *
 * The rule this defends: the upgrade must not destroy measurements that were
 * already good. Codex rows were per-run figures long before any of this, so
 * sweeping every historical row into "unverified" would have thrown away real
 * data and shown "not measured" over perfectly valid spend -- which is exactly
 * what the first cut of this migration did.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type OpenDbResult } from '../../src/main/db/index.js';
import { Store } from '../../src/main/db/store.js';
import type { RuntimeType } from '../../src/shared/types.js';
import { DEFAULT_AGENT_CONFIG, DEFAULT_AGENT_PERMISSIONS } from '../../src/shared/types.js';

const MIGRATIONS = join(process.cwd(), 'src/main/db/migrations');
const HOUR = 60 * 60 * 1000;

/** Migrations up to but excluding the one under test. */
const PRE_0006 = [
  '0000_tiresome_photon',
  '0001_universal_integrations',
  '0002_agent_activity',
  '0003_backfill_message_activities',
  '0004_message_attachments',
  '0005_channel_icons',
];

describe('upgrading a pre-accounting database', () => {
  let dir: string;
  let path: string;
  let database: OpenDbResult | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'locrew-migrate-'));
    path = join(dir, 'legacy.db');

    // Build the old database with the real migrator over a folder holding only
    // the migrations that existed then. Doing it this way leaves drizzle's own
    // bookkeeping in place, so the upgrade under test later applies exactly one
    // migration -- which is what a user's machine actually does.
    const oldFolder = join(dir, 'migrations-pre-0006');
    mkdirSync(join(oldFolder, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter((e) => PRE_0006.includes(e.tag));
    writeFileSync(join(oldFolder, 'meta/_journal.json'), JSON.stringify(journal, null, 2));
    for (const tag of PRE_0006) {
      copyFileSync(join(MIGRATIONS, `${tag}.sql`), join(oldFolder, `${tag}.sql`));
    }
    const old = openDatabase(path, oldFolder);
    old.close();

    const raw = new Database(path);
    raw.pragma('foreign_keys = ON');

    const now = Date.now();
    const agent = (name: string, runtimeType: RuntimeType) => {
      const id = `agent:${name}`;
      raw
        .prepare(
          `INSERT INTO agents (id, name, description, runtime_type, avatar, avatar_color,
             working_directory, status, permissions, config, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          name,
          '',
          runtimeType,
          '',
          '#7C6CF6',
          dir,
          'offline',
          JSON.stringify(DEFAULT_AGENT_PERMISSIONS),
          JSON.stringify(DEFAULT_AGENT_CONFIG),
          now,
          now,
        );
      return id;
    };

    raw
      .prepare(
        `INSERT INTO conversations (id, kind, name, topic, autonomy_enabled, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run('conv:1', 'channel', 'general', null, 1, now, now);

    const codex = agent('Pablo', 'codex');
    const claude = agent('Clark', 'claude-code');
    const model = agent('Modelled', 'model');

    let n = 0;
    const execution = (
      agentId: string,
      costUsd: number,
      inputTokens: number,
      outputTokens: number,
    ) => {
      const id = `exec:${n++}`;
      raw
        .prepare(
          `INSERT INTO agent_executions (id, agent_id, conversation_id, task_id, state, trigger,
             triggered_by_message_id, chain_id, chain_depth, turns, cost_usd, input_tokens,
             output_tokens, error, started_at, ended_at)
           VALUES (?,?,?,NULL,'completed','human',NULL,?,0,1,?,?,?,NULL,?,?)`,
        )
        .run(id, agentId, 'conv:1', `chain:${id}`, costUsd, inputTokens, outputTokens, now - HOUR, now);
      return id;
    };

    // Real per-run Codex figures, of the shape this machine's database holds.
    execution(codex, 0.044, 100_960, 1238);
    execution(codex, 0.0567, 161_883, 1603);
    // A Codex run that reported nothing at all.
    const silent = execution(codex, 0, 0, 0);
    // Claude session cumulatives: monotonic, which is the giveaway.
    execution(claude, 1.2798, 48, 10_256);
    execution(claude, 3.3339, 48, 13_911);
    // A model agent, always a literal zero because pricing is unimplemented.
    execution(model, 0, 900, 300);

    raw.close();
    void silent;
  });

  afterEach(() => {
    database?.close();
    database = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps historical Codex spend visible instead of discarding it', () => {
    database = openDatabase(path, MIGRATIONS);
    const store = new Store(database.db);
    const windows = store.recordedUsage(Date.now());
    const codex = windows.today.find((r) => r.agentId === 'agent:Pablo');

    // Codex rows were per-run before any of this existed, so they survive the
    // upgrade as measurements.
    expect(codex?.costUsd).toBeCloseTo(0.1007, 4);
    // The silent run is not counted as a measured zero, and not held against
    // the total either: it reported no tokens, so no model work happened.
    expect(codex?.unverifiedExecutions).toBe(0);
    expect(codex?.executions).toBe(3);
  });

  it('marks Claude rows unverified, because theirs are session totals', () => {
    database = openDatabase(path, MIGRATIONS);
    const store = new Store(database.db);
    const claude = store.recordedUsage(Date.now()).today.find((r) => r.agentId === 'agent:Clark');

    // 1.2798 + 3.3339 would be a ~4x overcount of a session that reached 3.33.
    expect(claude?.costUsd).toBe(0);
    expect(claude?.unverifiedExecutions).toBe(2);
  });

  it('marks model rows unpriced rather than a measured zero', () => {
    database = openDatabase(path, MIGRATIONS);
    const store = new Store(database.db);
    const model = store.recordedUsage(Date.now()).today.find((r) => r.agentId === 'agent:Modelled');

    expect(model?.unpricedExecutions).toBe(1);
    expect(model?.unverifiedExecutions).toBe(0);
  });

  it('preserves the original reported figures for every row', () => {
    // Run the migration, then read the file back directly: the point is that
    // the upgrade copied `cost_usd` into `raw_cost_usd` without altering either.
    database = openDatabase(path, MIGRATIONS);
    database.close();
    database = null;
    const raw = new Database(path, { readonly: true });
    const all = raw
      .prepare('SELECT cost_usd, raw_cost_usd, cost_provenance FROM agent_executions')
      .all() as Array<{ cost_usd: number; raw_cost_usd: number; cost_provenance: string }>;
    raw.close();

    expect(all).toHaveLength(6);
    for (const row of all) expect(row.raw_cost_usd).toBeCloseTo(row.cost_usd, 6);
  });

  it('gives the global totals the same coverage the per-agent rows have', () => {
    database = openDatabase(path, MIGRATIONS);
    const store = new Store(database.db);
    const summary = store.costSummary(Date.now());

    // Only Codex spend is measurable, so that is the whole of the total -- and
    // the coverage says how much is missing rather than letting the number read
    // as the full history.
    expect(summary.totalUsd).toBeCloseTo(0.1007, 4);
    expect(summary.totalCoverage.unverifiedExecutions).toBe(2);
    expect(summary.totalCoverage.unpricedExecutions).toBe(1);
    expect(summary.last24hCoverage.unverifiedExecutions).toBe(2);
  });
});
