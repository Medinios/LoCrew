# Architecture

How Locrew is put together, and why. Written for someone about to change the code.

Agents on any model provider, MCP servers with per-agent tool permissions, and external A2A agents are described in [UNIVERSAL_AI_ARCHITECTURE.md](UNIVERSAL_AI_ARCHITECTURE.md), with the research behind them in [UNIVERSAL_AI_RESEARCH.md](UNIVERSAL_AI_RESEARCH.md). This document covers the core they plug into.

---

## 1. The shape of the problem

Two things make this app different from a chat UI with model selectors.

**Agents are processes, not requests.** Claude Code and Codex are long-lived local programs with their own sessions, their own permission systems and their own view of a working directory. The app drives them; it does not reimplement them. (Agents on a model provider are the exception: the app runs their loop itself, through the same interfaces. See UNIVERSAL_AI_ARCHITECTURE.md §4.)

**Routing cannot come from model text.** If an agent writing "@Codex" were enough to wake Codex, any agent could impersonate any other by typing a name, and a prompt-injected agent could address anyone. So routing is a tool call with a cryptographic sender, and the model's prose is only ever prose.

Everything below follows from those two facts.

---

## 2. Process boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│ Renderer  (sandboxed, no Node, no filesystem, no shell)         │
│   React 19 · Zustand · Tailwind                                 │
└───────────────┬─────────────────────────────────────────────────┘
                │ window.api.invoke(channel, payload)
                │ window.api.onEvent(cb)
┌───────────────┴─────────────────────────────────────────────────┐
│ Preload  (CommonJS, contextBridge, no other dependency)         │
│   Fixed channel allowlist from shared/channels.ts               │
└───────────────┬─────────────────────────────────────────────────┘
                │ ipcRenderer.invoke
┌───────────────┴─────────────────────────────────────────────────┐
│ Main process  (all privilege lives here)                        │
│                                                                 │
│   ipc/handlers ──► Zod validation ──► Store · Orchestrator      │
│                                                                 │
│   Orchestrator ──► queues, limits, cancellation, state          │
│        │                                                        │
│        ├──► Runtime adapters ──► claude / codex child processes │
│        ├──► WorkspaceLockManager                                │
│        └──► Store (SQLite via Drizzle)                          │
│                                                                 │
│   GatewayServer  (MCP over HTTP on 127.0.0.1)                   │
│        ▲                                                        │
└────────┼────────────────────────────────────────────────────────┘
         │ per-agent bearer token
   ┌─────┴──────┬──────────────┐
   │ Claude Code│ Codex CLI    │   ← the agents connect back in
   └────────────┴──────────────┘
```

The loop back through the gateway is the interesting part: agents are not only driven by the app, they call into it.

### Why the formats differ

| Target | Format | Reason |
|---|---|---|
| main | CommonJS | Electron only exposes its own `electron` module to `require`. An ESM main process gets the npm shim instead and `app` is undefined. |
| preload | CommonJS | Electron supports ESM preload only with the sandbox off, and the sandbox stays on. |
| renderer | ESM | Bundled by Vite; irrelevant at runtime. |

The three runtime SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@modelcontextprotocol/sdk`) are ESM-only, so the CommonJS main process loads them with dynamic `import()`, cached after first use. That also keeps them off the startup path until an agent actually runs.

`better-sqlite3` is a native CommonJS addon and is required normally.

---

## 3. The IPC contract

`src/shared/ipc.ts` is the whole renderer-facing API. It maps every channel to a Zod schema; `registerIpcHandlers` parses each payload before a handler sees it.

`src/shared/channels.ts` holds the same channel names with **no dependencies at all**, because the sandboxed preload cannot require arbitrary modules and must not drag Zod in. A compile-time assertion in `ipc.ts` fails the build if the two lists ever diverge:

```ts
type _SchemasCoverAllowlist = InvokeChannelName extends InvokeChannel ? true : never;
type _AllowlistCoversSchemas = InvokeChannel extends InvokeChannelName ? true : never;
```

Events flow the other way as a single discriminated union on one channel, which keeps the renderer's event handling exhaustive.

---

## 4. Runtime adapters

`src/main/runtimes/types.ts` defines the contract:

```ts
interface AgentRuntime {
  readonly runtimeType: RuntimeType;
  detect(): Promise<RuntimeDetection>;
  execute(ctx: RuntimeExecuteContext): AsyncIterable<RuntimeEvent>;
  dispose(): Promise<void>;
}
```

Three decisions worth knowing:

**Streaming is the only path.** The brief suggested `sendMessage` plus an optional `streamMessage`; both runtimes stream natively, so a single async-iterable method avoids two code paths that would drift.

**Cancellation is an `AbortSignal` in the context**, not a `cancelExecution()` method. One adapter instance serves many agents concurrently, so a method with no execution argument would be ambiguous.

**Adapters are stateless.** All per-run state lives in the context, which is what makes cross-contamination between agents structurally impossible rather than merely avoided.

Adapters never throw for ordinary agent failures — they emit `{type:'error', fatal:true}` so the orchestrator records a failed execution instead of unwinding.

### Normalised events

There are four implementations: `claude-code` and `codex` (local CLIs through their SDKs), `model` (the app's own loop over any configured provider) and `a2a` (an external agent). The last two are described in UNIVERSAL_AI_ARCHITECTURE.md §4 and §7.

Every runtime's native events map onto one union — `session`, `state`, `text_delta`, `text`, `thinking`, `tool_use`, `tool_result`, `cost`, `error` — so the orchestrator and the UI never branch on runtime type.

### Where the two runtimes differ

| | Claude Code | Codex |
|---|---|---|
| Driver | Agent SDK `query()` | Codex SDK `runStreamed()` |
| System prompt | `systemPrompt: {type:'preset', append}` | none — persona prepended to the first turn |
| Session resume | `resume: <uuid>` | `resumeThread(threadId)` |
| Turn ceiling | `maxTurns` | enforced by us |
| Spend ceiling | `maxBudgetUsd` | enforced by us from token counts |
| Reported cost | real dollars | derived estimate |
| Interrupt | `query.interrupt()` | close the stream |
| Permission hook | `canUseTool` callback | `sandboxMode` + `approvalPolicy` |
| Gateway wiring | `mcpServers: {type:'http'}` | `config.mcp_servers` + `bearer_token_env_var` |
| Binary location | user's global install, on `PATH` | vendored by `@openai/codex`, resolved through the module graph |

The Claude side is richer, so the Codex adapter emulates the gaps. Those emulations are the least-proven part of the codebase.

**Codex binary resolution deserves its own note**, because getting it wrong is invisible until you package the app. `@openai/codex-sdk` depends on `@openai/codex`, which ships the CLI as a vendored per-platform binary and resolves it with `require.resolve`, not via `PATH`. Detection originally shelled out to `codex --version` and would therefore have reported "not installed" inside a packaged build that ships the binary. `resolveBundledCodex()` now mirrors the SDK's lookup, with a `PATH` fallback for people who prefer a global install, and the vendored binaries are listed in `asarUnpack` so they stay executable.

Nothing in the type system could have caught that: `CodexOptions.config` is an untyped object and `PATH` lookups are strings. It was found by reading the SDK's own resolution code.

Adding a runtime means writing one adapter and registering it. The messaging system does not change.

---

## 5. Message routing

Two entry points, one set of rules.

**Human message** → `Orchestrator.handleHumanMessage`. Mentions are resolved to stable ids (`orchestrator/mentions.ts`). In a DM the agent always replies; in a channel only mentioned agents do. `@all` expands to members. Unmatched mentions produce a warning rather than silence.

**Agent message** → `Orchestrator.sendAgentMessage`, only ever reached through the gateway. The sender is the token holder. Self-addressing and non-members are refused.

Both funnel into `tryEnqueue`, which is the single place that decides whether an agent may be woken.

### Deduplication

A `(agentId, messageId)` key is recorded when a job is enqueued, so one message can never wake the same agent twice, however many paths reach it.

---

## 6. Orchestration

```
tryEnqueue ──► evaluateActivation ──► createExecution('queued') ──► queue
                     │
                     └── refused ──► limit notice posted in the conversation
                                      (the chain says why it stopped)

pump() ──► for each agent with no running job, and a free global slot:
             runJob ──► acquire workspace lock (if the agent can write)
                    ──► state: thinking
                    ──► stream adapter events, persisting each one
                    ──► post the agent's text as a message
                    ──► state: completed | failed | cancelled
                    ──► release lock, pump again
```

**Invariants**

1. One execution per agent at a time. A per-agent queue, not a mutex, so ordering is preserved.
2. At most `maxConcurrentExecutions` across all agents.
3. A new message never interrupts a running execution. Interrupting an agent mid-edit is how you get half-written files.
4. Writes to one directory are serialised.

### Chains

Every human instruction opens a `chainId`. Every execution it spawns, directly or transitively, carries it. That is what makes "six agent-to-agent turns" and "five dollars per chain" measurable at all — without it, each hop looks like a fresh conversation. `chainDepth` records how far from the human a given execution is.

### Limits

`orchestrator/limits.ts` is deliberately a pure function: request in, verdict out. It is the easiest part of the system to test and the most important to get right.

A human-triggered activation bypasses the autonomy rules — the operator may always address an agent — but never bypasses queue depth or concurrency.

### Prompt construction

A resumed session contains only what *that* agent saw. Anything said by others since its last turn would be missing, so `buildTurnPrompt` replays messages after that agent's previous execution ended, labelled by sender, with a note when a message came from another agent and is therefore untrusted.

### Activity reactions

Each agent shows what it is doing about a message as one emoji on that message — 📨 received, 👀 reading, 💭 thinking, ⚙️ working, ⏳ processing, ❓ waiting for you, then ✅ / ❌ / 🚫, or ⚠️ if the app stopped mid-run. One reaction per (message, agent), replaced in place as the run moves on.

**Only observed events move it.** Timers never do, and neither does the execution's own `state`: `thinking` there is set the moment a run starts, before the model has done anything, so it cannot mean "is reasoning". The mapping (`src/main/activity/state-machine.ts`, a pure function):

| Event the orchestrator saw | Reaction |
|---|---|
| message routed, execution queued | 📨 received (plus "waiting for the workspace" while another agent holds the lock) |
| prompt handed to the runtime, no output yet | 👀 reading — or ⏳ processing for a `basic` runtime |
| first `thinking` / `text_delta` / `text` event | 💭 thinking (`reasoning` or `responding`) |
| `tool_use`, including MCP tools | ⚙️ working, with the tool's name — never its input or output |
| approval requested / answered | ❓ waiting, then back to ⚙️ |
| run finished | ✅ completed, ❌ failed (a timeout is a failure), 🚫 cancelled, or ❓ when the runtime reported `awaiting_input` |
| app quit, or found still active at the next launch | ⚠️ interrupted — never completed |

**What a runtime can observe is declared, not assumed.** `AgentRuntime.activityProfile` is `detailed` for Claude Code, Codex and model agents (they stream output and report tools) and `basic` for A2A agents, which only report running and done. A `basic` runtime shows ⏳ for its whole run even when it streams text; its internal steps are never invented.

**Stale updates lose, three ways.** The manager tracks one machine per *running* execution and drops signals for any other; the store's update is conditional on the row still belonging to that execution (a newer run on the same message and agent claims the row); and every change bumps a `revision`, so the renderer never replaces a newer copy with an older one — including the sidebar's live list, which remembers ended runs' final revisions. `setState` also refuses to move a finished execution back to a running state, which closed an older race where an approval answered after a cancel set the run to `working` again.

**The user's own reactions are a different table** (`message_reactions`). The orchestrator never reads it, so reacting 👀 cannot wake or steer an agent, and the toggle cannot remove agent activity.

Transport is the existing event stream: `activity` and `reactions` events over the one IPC event channel, and `activity:list` / `activity:live` / `reactions:toggle` for loading and toggling.

### Images in messages

Images pasted, dropped or picked in the composer travel with the message to whichever agents it wakes.

**Renderer.** The composer shrinks anything over 2048 px or about 4.5 MB (providers cap images near 5 MB) and sends base64 with `messages:send`. It decides nothing that matters.

**Main process** (`src/main/attachments/images.ts`) decides everything that does: the type comes from the file's own signature — PNG, JPEG, GIF or WebP; SVG and everything else is refused whatever it is called — at most 8 images and 10 MB each per message. Files are written to `userData/attachments/<conversation>/` under generated names; the user's filename is kept only for display. The `aw-image://` scheme serves that folder, and deleting a conversation deletes its folder.

**Delivery.** A turn carries the images of the messages it responds to (the same messages its prompt text covers), at most 8, and the prompt names every image — so a runtime that cannot show one still knows it exists, and images left out are named with their path:

| Runtime | How the images arrive |
|---|---|
| Claude Code | base64 image blocks in one SDK user message; the streaming input stays open until the turn's result, because Claude Code answers permission requests over the same channel |
| Codex | `local_image` inputs by path; Codex reads the files |
| Model agents | an image part per image (`image_url` data URL on Chat Completions, `image` blocks on Anthropic). Only the current turn's images are sent; earlier ones stay named in the rebuilt history. A model marked as not supporting vision gets the note instead, and a provider that refuses images is retried without them and remembered, like tools |
| A2A | file parts with the raw bytes, only when the Agent Card's input modes accept images; otherwise the agent is told images were attached but not sent |

---

## 7. The MCP gateway

`src/main/gateway/` — the mechanism behind agent-to-agent work.

A Node HTTP server on `127.0.0.1:<ephemeral>`, speaking MCP's streamable HTTP transport. One MCP server instance is built **per request**, closing over the agent id the token resolved to. There is no session table and no way for a concurrent execution to cross identities.

```
POST /mcp
Authorization: Bearer <per-agent token>
        │
        ▼
AgentIdentityRegistry.resolve(token) ──► agentId | 401
        │
        ▼
buildServerForAgent(agentId)   ← tools are bound to this id, permanently
        │
        ▼
GatewayServices (implemented by the Orchestrator)
```

Tokens are 32 random bytes, minted per app launch, held only in memory, compared in constant time. A token that leaks into a log stops working at the next restart.

`GatewayServices` is a narrow interface rather than direct access to the store, which bounds what a misbehaving agent can reach and makes the tool surface testable in isolation.

Every tool resolves its conversation through one helper that defaults to the agent's current execution and refuses any conversation the agent is not a member of.

Express was removed in favour of `node:http`: it is CommonJS, which an ESM-capable design had to fight, and one POST route did not justify the dependency.

---

## 8. Database

SQLite through Drizzle, at `app.getPath('userData')/locrew.db`. WAL on, foreign keys on.

The app was called AgentWorkspace before it became Locrew. An existing install keeps its data folder (`agent-workspace` under the OS app-data directory) and its `agent-workspace.db` file, because that folder also holds the key that decrypts stored API keys on Windows. `src/main/user-data.ts` makes that choice; an explicit `--user-data-dir` overrides it.

| Table | Holds |
|---|---|
| `agents` | identity, runtime, working directory, permissions, config |
| `conversations` | DMs and channels in one table, discriminated by `kind` |
| `conversation_members` | humans and agents, by type and id |
| `messages` | transcript, with resolved mentions and execution links |
| `agent_sessions` | native session id per **(agent, conversation)** |
| `tasks`, `task_assignees` | task tracking |
| `agent_executions` | one row per run: state, trigger, chain, turns, cost, tokens |
| `agent_events` | the streamed event log, sequenced per execution |
| `message_activities` | one activity reaction per **(message, agent)**, owned by one execution |
| `message_reactions` | the user's own emoji reactions |
| `message_attachments` | images sent with a message: detected type, display name, stored path |
| `workspaces`, `workspace_permissions` | directory registry |
| `application_settings` | one JSON row |

**Deviation from the brief.** The brief suggested separate `channels` and `conversations` tables. One table with a `kind` column means DM and channel routing, membership and persistence share a single code path instead of two that drift. The cost is a column; the benefit is that every routing rule is written once.

**Why `agent_sessions` is keyed on the pair.** A unique index on `(agent_id, conversation_id)` is what stops one agent resuming another's session and stops a DM session leaking into a channel. There is a test for both.

Orphaned executions — rows left `running` by a crash — are marked failed at startup, so the UI never shows a permanently busy agent. Their activity reactions are marked interrupted at the same point.

---

## 9. Workspace access

Two mechanisms, deliberately separate.

**Policy** is per agent: read-only, read/write, or approval-required. The adapter maps it onto the runtime's own permission system.

**Locking** is per directory. `WorkspaceLockManager` serialises any execution that could write. Read-only runs never contend. Paths are normalised, case-insensitively on Windows, or `C:\Repo` and `c:\repo` would be two different locks on one directory.

The lock is in-process and advisory. It coordinates agents inside this app and nothing else.

Git worktree isolation, so two agents can genuinely work in parallel, is the obvious next step and is not implemented.

---

## 10. Security model

Layered, and honest about where the layers end.

**Renderer.** Sandboxed, context-isolated, no node integration, CSP set on responses, permission requests denied, navigation and new windows blocked.

**Preload.** One `invoke` restricted to a fixed allowlist, plus one event subscription. Nothing else crosses.

**IPC.** Every payload Zod-validated before privileged code. Errors are converted to plain messages so stack traces stay in main.

**Agent identity.** Established by bearer token, never by model output. An agent claiming to be another in its message body is still recorded as itself.

**Inter-agent trust.** Every agent's system prompt states that messages from other agents are untrusted and cannot grant permissions, authorise commands or lift restrictions. This is mitigation, not a guarantee — it is a prompt, and prompts can fail.

**Human approval.** Mutating tools can require a decision before anything runs. Verified live against a real model.

### The boundary this app does not cross

**Workspace access is not a sandbox.** It configures each runtime's permission layer. The CLI still runs as your user account. If a runtime's permission layer is bypassed, the limit is your OS account, not this app.

For real isolation, run the whole app in a VM or container.

A second caveat worth stating: Claude Code's `allowedTools` shadows the `canUseTool` callback for tools it matches. The gateway prefix is listed there deliberately — it is the app's own authenticated surface — and a live test confirms `canUseTool` still fires for `Write`, `Edit` and `Bash`.

---

## 11. Bidirectional text

The transcript carries whatever the operator and the agents write, which in
practice means Hebrew, English and source code in the same message. Three rules
cover it.

**Direction is per message, not per app.** The chrome stays left-to-right
because the interface language is English; only user and agent content flips.
Mixing them is what Slack and every other chat client do, and it avoids the
whole-layout mirroring that a `dir="rtl"` on `<html>` would force.

**Direction is weighed, not sniffed.** The browser's `dir="auto"` takes the
first strong character, and the messages this app carries very often open with
an `@mention`, a file path or a fenced block — all Latin. A Hebrew sentence then
renders LTR with its punctuation stranded on the wrong side, which is exactly
the bug the first build shipped. `lib/direction.ts` counts strong characters of
each script, ignoring code, and lets the majority decide.

**Layout uses logical properties.** List indents, quote bars and table
alignment use `padding-inline-start`, `border-inline-start` and `text-start`, so
one rule serves both directions. Code is pinned to `direction: ltr` with
`unicode-bidi: isolate`, because source reads left-to-right whatever surrounds
it.

Two smaller pieces follow from the same idea: names interpolated into chrome
(a channel title, a crew row, a task) are wrapped in `<bdi>` so an RTL name
cannot reorder the LTR line around it, and `lib/rehype-isolate-mentions.ts`
wraps `@name` and `#channel` tokens in `<bdi>` during rendering. Without that
last step the neutral `@` takes the paragraph direction inside RTL text and
`@Roger` renders as `Roger@`.

---

## 12. Testing strategy

| Layer | What it proves | Cost |
|---|---|---|
| `tests/unit` | Mention resolution, limit evaluation, locking | free |
| `tests/integration/orchestrator` | Routing, queues, limits, cancellation, sessions, recovery — via a scripted double | free |
| `tests/integration/gateway` | The MCP server over real HTTP with a real MCP client, including impersonation resistance | free |
| `tests/integration/providers`, `mcp`, `model-agents`, `a2a` | Provider adapters against a mock wire-format server; MCP against a real SDK server over stdio and HTTP; custom agents, tool permissions, loops and restart; A2A against the official SDK server (v1.0 and v0.3) | free |
| `tests/integration/live-runtimes` | Real CLIs: detection, real replies, session capture, real tool calls, the approval gate | real credit |
| `tests/e2e` | The built Electron app: rendering, renderer isolation, IPC allowlist, wizard, persistence across restart, and the full provider → MCP server → custom agent → tool call path through the UI | free |

The scripted adapter is named `ScriptedRuntime` and documented as a test double, because a fake that reads like an integration is worse than no test.

Live tests skip themselves unless `LOCREW_LIVE=1` and the runtime is both installed and signed in. Detection runs at module scope rather than in `beforeAll`, because `skipIf` is evaluated during collection and a hook would run too late — every live test would silently skip on a working install.

Tests execute through Electron's bundled Node (`ELECTRON_RUN_AS_NODE=1 electron vitest.mjs`) so they share the app's native module ABI. One `better-sqlite3` build serves both.

---

## 13. Things a future change should not break

1. Sender identity comes from the gateway token. Never from message text.
2. Routing uses agent ids. Display names are input to resolution and nothing else.
3. `evaluateActivation` stays a pure function.
4. A new message never interrupts a running execution.
5. `agent_sessions` stays unique on `(agent, conversation)`.
6. The preload stays dependency-free.
7. Every new IPC channel gets a schema and an entry in the allowlist — the build enforces this.
8. Zustand selectors must not build new objects or arrays. `s.tasks[id] ?? []` inside a selector returns a fresh array every render, fails `Object.is`, and loops React forever. This shipped once and was caught by running the app, not by types or unit tests. `tests/renderer/selector-stability.test.tsx` now fails if it regresses — it was validated by reintroducing the bug and confirming the suite goes red.
9. Activity reactions come only from runtime events, through `transition()`. Never from a timer, and never from `ExecutionState`.
10. Anything the compiler cannot see needs a runtime check or a test. The two bugs that reached this codebase both lived in compiler blind spots: a selector's return identity, and an untyped config object plus a `PATH` string. Treat `CodexOptions.config` keys, MCP tool names and binary paths as unverified until something executes them.
11. Status colour and motion come from real state. Presence dots go through `agentPresence()`, the pulsing teal dot appears only while an agent is working, and nothing animates on a timer to look busy. Reduced motion turns animation off entirely.

---

## 14. Design system

The interface uses one identity, *Midnight Aurora*: a midnight-navy shell (window chrome and sidebar) around a light working canvas. Aurora teal marks primary actions, focus and live work. Electric lavender marks AI: the ✦ next to an agent's name, mention chips, and thinking. Amber, red and green are reserved for waiting, errors and success.

**Tokens, not colours.** Every colour is an HSL CSS variable in `src/renderer/src/styles/globals.css`, exposed to Tailwind by role in `tailwind.config.cjs`:

| Role | Tokens |
|---|---|
| Dark shell | `shell`, `shell-hover`, `shell-active`, `shell-line`; text on it: `ink`, `ink-soft`, `ink-muted`, `ink-faint` |
| Light canvas | `canvas` (page), `surface` (cards, composer, dialogs), `subtle` (quiet fills), `line`, `line-strong` |
| Text on light | `content-strong`, `content`, `content-muted`, `content-faint` |
| Brand | `primary` (teal fill, with dark `primary-foreground` text), `primary-ink` (teal readable on white), `ai` / `ai-ink` (lavender) |
| States | `success`, `warning`, `danger`, each with an `-ink` shade for text |

Use `primary-ink` and `ai-ink` rather than the bright fills for text on white: the fills fail contrast as text. `ink-*` is only for the dark shell. Radius (`sm` 6 for pills, `md` 8 for buttons, `xl` 12 for panels and the composer, `2xl` 14 for the window), shadows (`panel`, `composer`, `composer-focus`, `popover`, `dialog`, `focus`), type sizes (`2xs` 11, `xs` 12, `nav` 13, `body` 13.5, `title` 15), durations (`fast` 120 ms, `base` 180 ms) and z-layers are tokens as well. `cn()` teaches tailwind-merge the custom size and shadow names, so `text-nav` is not mistaken for a colour and dropped.

**Agents vs. people.** Agents are rounded squares and may carry a thin ring in their accent colour; people are circles. Accent colours come from a curated set (`AGENT_ACCENTS` in `lib/agents.ts`) and appear only on small elements. Existing agents keep the colour and portrait they were given.

**Brand mark.** `components/brand/BrandMark.tsx` draws three connected nodes forming an L, a small crew. `resources/icon.svg` is the same mark on a navy tile, and `npm run icons` renders it to `resources/icon.png`.

