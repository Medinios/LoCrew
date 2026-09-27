# Agent usage and provider quota

LoCrew shows two distinct quantities. **Recorded usage** is spend and token activity observed during LoCrew executions, attributed to agents. **Provider quota** is the subscription allowance for the signed-in account, shared with other apps and all agents using that runtime. The UI renders recorded usage as text and provider quota as percentage bars so an agent's spend is never mistaken for its share of an account allowance.

## Windows and surfaces

Recorded **Today** begins at local midnight. **7d** is the trailing 168 hours, not a calendar week. An execution belongs wholly to the window containing its `started_at`; splitting its spend across a midnight boundary would require timing data the runtime does not provide. Failed and cancelled executions remain included because they can consume tokens. The agent directory, conversation members, and agent details show per-agent recorded usage. The conversation panel, Settings, and activity views use the same accounting policy.

Claude Code exposes a session quota window; Codex identifies its short window as 300 minutes. Both also expose a weekly window, with reset times. Claude Code can additionally expose a weekly model-specific window. Neither source exposes a daily quota, so the UI does not call the short provider window "daily." Provider quota is cached by runtime type, not agent, because agents of one runtime share the same login. The cache lasts about five minutes; the open panel requests a non-forced refresh each minute. Unavailable, unsupported, stale, and error states remain distinct from 0% used.

The Claude quota source uses the Agent SDK's experimental usage control request on a prompt-less query. Its `settingSources: []` isolation is essential: a normal project settings load can execute `SessionStart` hooks even when no model turn is made. The Codex source asks its app-server for `account/rateLimits/read`. Neither quota read should spend model tokens.

## Cost accounting

`agent_executions.cost_usd` is a per-execution amount **only** when `cost_provenance = 'measured'`. Every displayed dollar total sums measured rows and carries coverage counts for rows it cannot price or verify. It never sums intermediate `agent_events` cost events, because those are cumulative reports within a run.

Codex computes cost from token usage for each execution, starting at zero when an execution starts. Its historical rows are valid per-run estimates and migration `0006` marks those rows measured when they reported cost or tokens. This does not turn the price estimate into a provider bill. Model and A2A runtimes have no comparable price; their rows are `unpriced`, not free. A completed CLI execution with no usage report is `unreported`, not a measured zero.

Claude Code's `total_cost_usd` can cover an entire native session, including earlier LoCrew executions. The runtime emits the native session id before its cost report. At write time, LoCrew records the raw report and a baseline keyed by `(runtime_type, agent_id, conversation_id, runtime_session_id)`, and updates the execution and baseline in one transaction. Each execution freezes its entry baseline so repeated writes, including the final write at completion, produce the same delta. The baseline is not keyed only by agent and conversation: that is a resume scope, which can outlive or replace a native session.

When a trusted baseline exists, the increase is `measured`. A first observation of an already resumed session is `baseline_only`, since its earlier cumulative total was not observed. A zero or decreased counter is `ambiguous`; the session must re-anchor before another delta can be trusted. A fork that reports a different native session id after a resume request likewise cannot be assumed fresh. Historical Claude rows are `legacy`: their per-execution amounts cannot be reconstructed from session totals, so migration preserves the raw value without presenting it as exact spend.

The provenance states have distinct display meanings:

| Provenance | Meaning in totals |
| --- | --- |
| `measured` | Included in the displayed dollar subtotal |
| `baseline_only`, `ambiguous`, `legacy` | Cost could not be established; subtotal is a lower bound |
| `unreported` | Finished without usage data; subtotal is a lower bound |
| `unpriced` | Runtime has no price; subtotal is partial or reads "Not priced" |

The chain spend limit uses the same measured deltas. It treats a CLI execution with observed model output but no usable cost bound conservatively. A run that spent before producing observable output may still escape that evidence test, so limit enforcement is best-effort in that case. Unpriced model and A2A executions currently contribute zero to the dollar limit, a separate pricing gap.

## Tokens and verification

Claude token totals are withheld from the UI: the currently recorded SDK `usage` field covers the main loop but can omit cached input, subagent work, and compaction. Codex tokens include cache usage and are not comparable with that Claude figure. A future token display needs `modelUsage` normalization and an explicit cache-read/write convention. This limitation does not affect the provider's reported quota percentages or Claude's reported dollar figure.

The migration tests exercise a genuine pre-`0006` database and verify that Codex estimates survive while old Claude rows remain unverified. Accounting tests cover session replacement, reset, zeroed results, idempotence, restart, and per-runtime differences. Rendering tests cover measured, unknown, partial, and unpriced labels. A synthetic seeded-profile Electron test verifies that nonzero measured spend reaches the agent directory and conversation Spend panel without opening or copying a person's database. Rebuild before running Electron tests so the checked UI matches the source under test.
