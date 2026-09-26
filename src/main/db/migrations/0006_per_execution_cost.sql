-- Per-execution cost accounting for Claude Code.
--
-- Its runtime reports a cumulative figure for a whole native session, and the
-- app resumes a session on every run, so `cost_usd` on existing rows holds a
-- session total rather than that run's spend. Nothing here rewrites those rows:
-- they are preserved and marked, because the per-run figures they would need
-- were never recorded and cannot be reconstructed.

ALTER TABLE `agent_executions` ADD `raw_cost_usd` real;--> statement-breakpoint
ALTER TABLE `agent_executions` ADD `baseline_cost_usd` real;--> statement-breakpoint
ALTER TABLE `agent_executions` ADD `native_session_id` text;--> statement-breakpoint
ALTER TABLE `agent_executions` ADD `cost_provenance` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint

-- Preserve what the runtime actually reported. `cost_usd` is left untouched, so
-- the two columns together still describe every pre-existing row exactly.
UPDATE `agent_executions` SET `raw_cost_usd` = `cost_usd`;--> statement-breakpoint

-- Provenance for historical rows, decided by the runtime that wrote them. The
-- runtime of an agent never changes, so this is re-derivable rather than a
-- guess, and it is the only reason it is safe to set here at all.
--
-- Codex accumulates from zero inside every execution, so its rows were already
-- this-run figures before any of this existed. Marking them unverified would
-- discard measurements that are perfectly good.
UPDATE `agent_executions` SET `cost_provenance` = 'measured'
  WHERE `agent_id` IN (SELECT `id` FROM `agents` WHERE `runtime_type` = 'codex')
    AND (`cost_usd` > 0 OR `input_tokens` > 0 OR `output_tokens` > 0);--> statement-breakpoint

-- A Codex row with no cost and no tokens reported nothing at all. Its zero is
-- an absence, not a measurement, so it stays unverified rather than becoming a
-- confident $0.00.
UPDATE `agent_executions` SET `cost_provenance` = 'unreported'
  WHERE `agent_id` IN (SELECT `id` FROM `agents` WHERE `runtime_type` = 'codex')
    AND `cost_usd` = 0 AND `input_tokens` = 0 AND `output_tokens` = 0;--> statement-breakpoint

-- Model and external agents were never priced, so their zero has always meant
-- "no price exists", never "this was free".
UPDATE `agent_executions` SET `cost_provenance` = 'unpriced'
  WHERE `agent_id` IN (SELECT `id` FROM `agents` WHERE `runtime_type` IN ('model', 'a2a'));--> statement-breakpoint

-- Claude Code rows keep 'legacy'. Theirs are session cumulatives, and the
-- per-run figures they would need were never recorded.

-- Starts empty on purpose. Seeding a baseline from the historical maximum over
-- (agent, conversation) would look authoritative while being a guess: that
-- scope can span replaced and reset sessions, so the figure it yields is not
-- the session's earlier total. Instead the first run to report a cost in a
-- pre-existing session establishes the baseline honestly and records its own
-- spend as unknown; the run after it is the first that can be measured.
CREATE TABLE `session_cost_baselines` (
	`runtime_type` text NOT NULL,
	`agent_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`runtime_session_id` text NOT NULL,
	`raw_cost_usd` real NOT NULL,
	`uncertain` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`runtime_type`, `agent_id`, `conversation_id`, `runtime_session_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
