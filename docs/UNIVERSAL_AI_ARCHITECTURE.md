# Universal AI integration: architecture

How Locrew connects arbitrary model providers, custom agents, MCP servers and external agents, and how that fits into the application described in [ARCHITECTURE.md](ARCHITECTURE.md). The research behind each decision is in [UNIVERSAL_AI_RESEARCH.md](UNIVERSAL_AI_RESEARCH.md).

**Contents**

1. [What changed, in one picture](#1-what-changed-in-one-picture)
2. [Vocabulary](#2-vocabulary)
3. [Provider registry](#3-provider-registry)
4. [Custom agents](#4-custom-agents)
5. [MCP client manager](#5-mcp-client-manager)
6. [Tool permissions: one enforcement point](#6-tool-permissions-one-enforcement-point)
7. [External agents (A2A)](#7-external-agents-a2a)
8. [Unified routing and loop prevention](#8-unified-routing-and-loop-prevention)
9. [Security model](#9-security-model)
10. [Persistence](#10-persistence)
11. [IPC and renderer](#11-ipc-and-renderer)
12. [Testing](#12-testing)
13. [Extending it](#13-extending-it)
14. [Limitations](#14-limitations)

---

## 1. What changed, in one picture

Before, an agent was one of two local CLIs (Claude Code or Codex) driven through its SDK. The orchestrator, the gateway, the limits and the chat UI were already runtime-agnostic, so the new work plugs in behind the existing `AgentRuntime` interface instead of beside it.

```
                         ┌──────────────────── main process ─────────────────────┐
 renderer (sandboxed)    │                                                        │
 ┌────────────────────┐  │  IPC (zod) ──► handlers ──► Orchestrator (unchanged    │
 │ Settings           │  │                               routing, queues, limits) │
 │  · AI Providers    │──┼─► providers:*                    │                     │
 │  · MCP Servers     │──┼─► mcp:*                          │ runtime by type     │
 │ Create agent wizard│──┼─► agents:*, grants:*, a2a:*      ▼                     │
 │ Agent directory    │  │        ┌───────────┬───────────┬──────────┬──────────┐ │
 │ Chat (unchanged)   │  │        │claude-code│   codex   │  model   │   a2a    │ │
 └────────────────────┘  │        │ (CLI SDK) │ (CLI SDK) │ (new)    │  (new)   │ │
        ▲  events only,  │        └─────┬─────┴─────┬─────┴────┬─────┴────┬─────┘ │
        │  never secrets │              │ MCP       │ MCP      │ MCP      │ HTTPS │
        │                │              ▼           ▼          ▼          ▼       │
        │                │   ┌─── MCP gateway, 127.0.0.1, per-agent token ───┐    │
        │                │   │ /mcp        workspace tools (send_message …)  │  external
        │                │   │ /mcp/tools  granted MCP tools  ◄── the one    │  A2A agent
        │                │   └──────────────────┬──── permission check ──────┘    │
        │                │                      ▼                                  │
        │                │   ToolAccessService ──► McpClientManager ──► stdio / HTTP MCP servers
        │                │   ProviderRegistry ──► adapters ──► model APIs (HTTPS / loopback)
        │                │   SecretStore (safeStorage) · IntegrationStore (SQLite)  │
        │                └────────────────────────────────────────────────────────┘
```

Three properties hold throughout:

1. **Every agent, whatever it runs on, goes through the same orchestrator** and therefore the same mentions, queues, chains and limits.
2. **Every MCP tool call, from every runtime, passes one permission check** in the gateway.
3. **Credentials exist in plaintext only in the main process, only while in use.** The renderer sees "key stored: yes/no".

---

## 2. Vocabulary

| Term | Meaning | Where |
|---|---|---|
| **Provider** | A configured endpoint: kind, base URL, auth, headers, timeout, models | `providers` table, `ProviderRegistry` |
| **Provider kind** | The wire adapter: `openai-compatible`, `anthropic`, `gemini`, `ollama` | `src/shared/integrations.ts` |
| **Preset** | A template that pre-fills a provider form (OpenAI, Groq, Ollama, …). Not stored; every field stays editable | `src/shared/provider-presets.ts` |
| **Model** | An ID on a provider, with reported capabilities and user overrides | `providers.models` (JSON) |
| **Agent** | Identity + instructions + engine + settings + permissions. Many agents can share one model | `agents` table |
| **Runtime** | How an agent executes: `claude-code`, `codex`, `model`, `a2a` | `src/main/runtimes/` |
| **MCP server** | A tool provider the user configured (stdio or Streamable HTTP) | `mcp_servers`, `McpClientManager` |
| **Grant** | Permission for one agent to call one tool on one server, mode `allow` or `ask` | `agent_tool_grants`, `ToolAccessService` |
| **External agent** | An A2A agent reached over HTTPS, pinned to the endpoint the user approved | `a2a` runtime |

---

## 3. Provider registry

`src/main/providers/`

### 3.1 Adapters

```ts
interface ProviderAdapter {
  readonly kind: ProviderKind;
  listModels(provider: ResolvedProvider, signal: AbortSignal): Promise<ProviderModel[]>;
  chat(provider: ResolvedProvider, request: ChatRequest): AsyncIterable<ChatEvent>;
}

type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCall }   // emitted once, with complete arguments
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: string | null };
```

| Adapter | File | Covers |
|---|---|---|
| `OpenAICompatibleAdapter` | `openai-compatible.ts` | OpenAI, Azure (v1), OpenRouter, Groq, Together, Fireworks, Hugging Face, Bedrock `/openai/v1`, LM Studio, vLLM, llama.cpp, LiteLLM/Portkey proxies, anything else speaking Chat Completions |
| `AnthropicAdapter` | `anthropic.ts` | Anthropic Messages API through `@anthropic-ai/sdk` (already a dependency) |
| `GeminiAdapter` | `gemini-ollama.ts` | Native model list (token limits), chat through Gemini's OpenAI-compatible endpoint |
| `OllamaAdapter` | `gemini-ollama.ts` | `/api/tags` + `/api/show` discovery (real capabilities and context length), chat through `/v1` |

The generic `streamChatCompletions` handles what real servers do rather than what the reference says: tool-call argument deltas keyed by `index`, SSE comment lines, an `error` object inside a 200 stream, a final chunk with empty `choices`, a missing `[DONE]`, servers that ignore `stream: true` and answer with JSON, and `reasoning_content`.

**Discovery enrichers** fill the capability gaps of `/models`: `context_length`, `context_window`, `top_provider`, `meta.n_ctx_train`, `supported_parameters`, `architecture.input_modalities`, and LM Studio's `/api/v1/models`.

### 3.2 Registry

`ProviderRegistry` (`registry.ts`) owns provider CRUD and everything that needs a decrypted credential:

| Method | Does |
|---|---|
| `create` / `update` / `delete` | Validates the URL, stores the key and secret headers in `SecretStore`, keeps the stored key when an edit leaves the field empty. **Refuses to delete a provider an agent still uses** |
| `test(id)` / `testDraft(input, existingId?)` | Connection check with latency. A draft is tested **without persisting anything**, so the dialog can test before saving. When the models endpoint is missing, it falls back to a one-token chat probe |
| `discover(id)` | Re-lists models and **merges**: manual models and capability overrides survive rediscovery |
| `setModels` | Manual model list and per-model overrides from the UI |
| `chat(id, request)` | Resolves credentials and runs the adapter |
| `learnCapability(id, model, feature)` | Records that a model refused a feature (see 3.3) |

### 3.3 Capabilities

`ModelCapabilities` fields are `boolean | number | null`, where **`null` means "not reported"**. The effective value is: user override, else reported value, else unknown (`effectiveCapabilities()`).

Unknown is not the same as unsupported. The model agent *tries* a feature whose support is unknown. When a provider answers 400 and the error names the feature (`rejectedFeature()` recognises `tools`, `temperature`, `stream_options`, `max_tokens`), the turn is retried without it, and for tools the refusal is stored, so the next turn does not pay for the same error. Each feature is dropped at most once per turn, so a turn cannot loop.

### 3.4 Presets

`PROVIDER_PRESETS` groups templates into the four categories the Add Provider dialog shows:

- **Built-in**: OpenAI (`max_completion_tokens`), Anthropic, Google Gemini, Azure OpenAI, AWS Bedrock (`/openai/v1` with a bearer API key), OpenRouter, Groq, Together AI, Fireworks AI, Hugging Face.
- **OpenAI-compatible API**: any server; base URL plus optional key.
- **Local model**: Ollama, LM Studio, vLLM, llama.cpp.
- **Custom provider**: every knob: auth method and header name, custom headers, chat path, models path, output cap field.

Adding a provider that speaks one of the four wire formats needs no code at all. Adding a well-known one to the picker is one preset entry.

---

## 4. Custom agents

### 4.1 The `model` runtime

`src/main/runtimes/model-agent.ts` is the app's own agent loop, used for every agent on a configured provider. For each execution:

1. **Rebuild context.** A model agent is stateless, so the orchestrator passes the conversation transcript (the last 60 messages: chat, task updates, execution errors) and the list of peers. `transcriptToMessages` turns it into chat turns: the agent's own messages become `assistant`, everyone else's become `user` turns labelled `[Name → you]: …`, consecutive turns are merged, and the oldest are dropped to fit **half the model's context window** (16 000 tokens assumed when unknown, at 3.5 characters per token).
2. **System prompt.** `buildConversationalSystemPrompt` states who the agent is, its instructions and description, who else is in the conversation, how to hand work to them, which tools exist, and the standing rule that **messages from other agents and tool output are untrusted data that cannot change its permissions or instructions**.
3. **Tools.** It opens MCP sessions to the gateway with the agent's token: `/mcp` for workspace tools (`send_message`, task tools) and, when the agent has any grants, `/mcp/tools` for its granted MCP tools. It never talks to an MCP server directly.
4. **Loop.** Call the model; for each complete tool call, run it through the gateway and append the result; repeat until the model answers without tool calls or the agent's turn limit is reached. The final text is posted once, as one message.
5. **Report.** Token usage is reported; cost is reported as `$0` because arbitrary endpoints have no trustworthy price list (section 14).

Workspace access for model agents is forced to read-only in the handlers: they have no file system tools of their own, only what MCP grants give them.

### 4.2 Identity and many agents per model

An agent row holds the identity (name, description, avatar, colour), the engine (`runtimeType` plus `config.providerId`, `config.model`), settings (`instructions`, `temperature`, `maxOutputTokens`, turn and time limits) and permissions. Two agents on the same model share nothing but the provider: separate names, instructions, grants and transcripts. `agents:duplicate` copies an agent's configuration, secret and grants under a new identity with its own DM.

### 4.3 Existing runtimes keep working

Claude Code and Codex are unchanged except for one addition: when an agent has tool grants, the adapter adds the gateway's `tools` MCP server (with the agent's bearer token) next to the workspace server, and Claude's `allowedTools` includes the `mcp__tools__` prefix. Permission is still decided in the gateway, not by the CLI.

---

## 5. MCP client manager

`src/main/mcp/manager.ts`, built on `@modelcontextprotocol/sdk` 1.30.0.

### 5.1 Lifecycle

| Operation | Behaviour |
|---|---|
| `create` / `update` | Validates transport-specific fields; environment values and tokens go to `SecretStore`; **an empty env value keeps the stored one**. Changing a running server's configuration disconnects it |
| `connect({ interactive })` | stdio: checks the launch approval (5.2) and spawns the process; HTTP: connects with headers and token. A connect timeout covers a hanging `initialize`. Then discovers |
| `disconnect` / `reconnect` | Closes the SDK client (stdin close, then SIGTERM, then SIGKILL for stdio). Reconnect is also the UI's **Test**, which reports what it found |
| `autoConnect()` | At startup, for servers marked *Connect on startup*. **Never prompts**: an unapproved command stays disconnected until the user connects it |
| `shutdown()` | Closes every client when the app quits |

**Discovery** pages through `tools/list`, `resources/list` and `prompts/list` (capped at 1 000 entries each) and records `serverInfo`, `protocolVersion`, `instructions` and capabilities. `listChanged` notifications trigger rediscovery. The last 40 lines of a stdio server's stderr are kept for the UI.

**Error isolation.** A failed server is marked `error` with a message; nothing else is affected. `callTool` on a disconnected server makes one quiet reconnect attempt (never a launch prompt), and otherwise returns an `isError` result that the model sees as a tool failure, not an exception that ends the turn. Every call has a per-request timeout and a `maxTotalTimeout`, and the agent's abort signal cancels it.

### 5.2 Launch approval for local servers

Before a stdio server starts for the first time, the main process shows a native dialog with:

- the **exact command line, untruncated**, the working directory and the environment variable *names*;
- the statement that it runs with the user's own permissions;
- warnings from `launchWarnings()` for elevated privileges, destructive file commands, download-and-execute pipes, encoded commands, and package runners (`npx -y`, `uvx`) that fetch code on first run.

The approval is stored as `approvedFingerprint`: a SHA-256 over command, arguments, working directory and the sorted env **keys**. Any change to those asks again; changing a secret value does not. The spawned process gets the SDK's safe default environment plus the configured variables, never the app's full environment.

### 5.3 Remote servers

Streamable HTTP with no auth, a bearer token or a named header, plus custom headers (sensitive-looking names are stored encrypted). `https` is required except to loopback, unless the user ticks *Allow plain http* for that server. SSE and WebSocket are not offered (deprecated and non-standard respectively).

---

## 6. Tool permissions: one enforcement point

`src/main/mcp/tool-access.ts`, `src/main/gateway/server.ts`

### 6.1 Why one place

Three runtimes call tools in three different ways: the Claude Agent SDK, the Codex SDK and the model loop. Enforcing permissions in each would mean three implementations and three chances to get it wrong. Instead **no runtime connects to a user MCP server directly**. Each connects to the app's gateway at `/mcp/tools` with its per-agent bearer token, and the gateway, built per request around the token's agent ID, exposes and executes only what that agent was granted.

```
runtime ──POST /mcp/tools, Bearer <agent token>──► gateway
                                                     │ token → agentId (constant-time)
                                                     │ Origin present → 403; Host must be 127.0.0.1/localhost:port
                                                     ▼
                                     ToolAccessService.listTools(agentId)
                                     ToolAccessService.callTool(agentId, name, args)
                                        1. resolve qualified name → (server, tool)
                                        2. re-read the grant from the database   ← revocation is immediate
                                        3. mode 'ask' → operator dialog, run paused (waiting_for_human)
                                        4. McpClientManager.callTool(…, timeout, signal)
                                        5. bound the result; audit log (no arguments)
```

### 6.2 Rules

- **Nothing by default.** A new agent has no grants. A new server grants nothing.
- **Grants default to `ask` regardless of annotations.** `readOnlyHint` and friends are shown as risk chips ("read-only", "writes", "destructive", with the spec's defaults when absent) and labelled "as described by the server; not verified". They never change a grant. This follows the MCP rule that annotations from untrusted servers must not drive decisions.
- **Names are namespaced by the app**, not by the server: `<server-slug>__<tool>`, sanitised and capped at 50 characters with a hash suffix. A server cannot shadow another server's tool or a workspace tool.
- **Checked at call time.** Listing is a convenience; `callTool` re-reads the grant, so a revoked grant stops working mid-conversation, and a tool the model invents or remembers from an earlier turn is refused.
- **Ask mode** uses the same approval path as the CLI runtimes' mutating tools: the execution goes to `waiting_for_human`, a native dialog shows the agent, the tool and a summary of the arguments, and a denial is returned to the model as a tool error.
- **Results are untrusted data.** They go back to the model as tool results, never into the system prompt. Text is capped at 100 000 characters and images at 5 MB. A tool result cannot change grants, instructions or configuration, because no code path reads configuration from tool output.
- **Audit.** Each call is logged as `agent -> server/tool: ok | refused | declined | error`, without arguments or results.

### 6.3 Gateway hardening

The gateway predates this work (per-agent tokens minted per launch, loopback only). This work added a second endpoint, `Origin` rejection (browsers always send `Origin`; the SDK clients do not), and `Host` validation against DNS rebinding.

---

## 7. External agents (A2A)

`src/main/runtimes/a2a.ts`, built on `@a2a-js/sdk` 1.2.0 (A2A v1.0 with the v0.3 compatibility layer).

### 7.1 Registration

1. The user pastes a URL. `inspectAgentCard` fetches `/.well-known/agent-card.json`, falling back to `/.well-known/agent.json` for v0.2 peers, with a 15 s timeout, redirects refused, and `https` required except to loopback (opt-in override).
2. The UI shows the card: name, description, skills, streaming support, declared security schemes, and a warning when the card's endpoint is on a different origin from the card.
3. On save, the handler **re-inspects the card** (so the renderer cannot supply a forged one) and pins `endpointUrl` and `protocolVersion` into the agent's config. The credential goes to `SecretStore`. Editing other fields of an existing agent does not re-fetch the card, so an offline agent stays editable.

### 7.2 Execution

- `connect` reads the card again and uses the interface matching the **pinned** endpoint. If the card no longer lists it, the run fails with "no longer lists the approved endpoint", so a compromised card cannot silently redirect conversations.
- The credential is sent as a header (`serviceParameters`) on every request and redacted from any error text. The `A2A-Version` header matches the pinned version.
- One A2A `contextId` per (agent, conversation), taken from the server's first reply and stored as the runtime session (`{contextId, taskId?}`); the app never invents one.
- The first message of a context carries the conversational system prompt (who is here, the rules above) followed by the new message; later turns send only what is new.
- Streaming is used when the card declares it; status updates drive the typing indicator, and artifacts and agent messages are assembled into the reply (the status message is used when there are no artifacts). `INPUT_REQUIRED` and `AUTH_REQUIRED` end the turn with the agent's question posted, and the task ID is kept so the next message answers that same task. `FAILED` and `REJECTED` are reported as errors.
- Stopping an execution sends `CancelTask`.

---

## 8. Unified routing and loop prevention

Routing is the existing orchestrator (ARCHITECTURE.md §5–6), untouched in its rules. What changed is what it passes to runtimes: `RuntimeExecuteContext` now also carries the transcript, the peer list, the conversation kind, the trigger, and the gateway tool endpoint. CLI runtimes ignore the new fields; model and A2A runtimes need them because they hold no session of their own.

Consequences:

- A custom agent appears in the sidebar, DMs, channel member lists and the `@` mention picker exactly like a CLI agent. Adding it to a channel is the existing `conversations:addAgent`.
- In a channel it replies only when mentioned; in a DM it always replies.
- A model agent can hand work to any other agent, on any runtime, through `send_message`, and that hop is subject to the same limits.

**Loop prevention** is unchanged and runtime-independent: `evaluateActivation` (a pure function) enforces the master switch for autonomous communication, `maxAgentToAgentTurns` per chain, `maxConsecutiveAutoActivations` per agent without human input, queue depth and concurrency, and a `(agent, message)` deduplication key. Spend ceilings do not apply to agents that report $0 (section 14), so for them the turn and hop limits are the brake. A test drives two model agents that keep handing work to each other and asserts the chain stops.

---

## 9. Security model

Additions to ARCHITECTURE.md §10.

**Credentials at rest.** `SecretStore` (`src/main/security/secrets.ts`) encrypts with Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux) and stores base64 ciphertext in the `secrets` table. Covered: provider API keys, sensitive provider headers, MCP tokens, sensitive MCP headers, MCP environment values, and A2A credentials. **If OS encryption is unavailable, saving a secret fails with an explanation instead of falling back to plaintext.** Headers are treated as secret when their name matches `authorization|api-key|token|secret|password|cookie|session`, whatever the user ticks. An e2e test scans every file in the profile directory for a test key after saving it and asserts it is absent.

**Credentials in the renderer.** Never sent. Views carry `hasApiKey`, `hasToken`, `envKeys` and header names; edit forms show "Stored — leave empty to keep". Tests run on unsaved drafts in the main process.

**Network.**
- `https` required for anything but loopback; per-connection opt-in for plain http on a LAN.
- Credentials in URLs (`https://user:pass@…`) are refused.
- `redirect: 'error'` on every provider request, so a key is never replayed to another host.
- Every request has a timeout and honours cancellation.
- Error messages are scrubbed of the key before they are stored, shown or logged, even when the server echoes it.

**Logging.** Request and response bodies are never logged. Tool calls are logged by name and outcome only.

**MCP servers are untrusted**: launch consent with a fingerprint (5.2), explicit grants (6.2), annotations as hints only, timeouts, error isolation, results bounded and treated as data, never able to modify permissions or prompts.

**External agents are untrusted**: pinned endpoint, credential scoped to that agent, replies treated like any other agent's message (the standing untrusted-peer rule in every system prompt).

**The boundary this app still does not cross.** A granted local MCP server runs as the user's account. Grants limit what an agent can *ask* a server to do; they do not sandbox the server itself.

---

## 10. Persistence

Migration `src/main/db/migrations/0001_universal_integrations.sql` (generated with drizzle-kit) is **purely additive**: one new column and four new tables; no existing column changes type and no data is rewritten. Existing workspaces upgrade in place.

| Table / column | Holds |
|---|---|
| `agents.description` | The directory description, also told to the agent |
| `secrets` | `id`, ciphertext (base64), timestamps |
| `providers` | Name (unique), kind, preset, base URL, auth method and header, `secretId`, plain headers, secret header names, options (paths, token field, API version), timeout, models (JSON with capabilities and overrides), last check |
| `mcp_servers` | Transport, command, args, cwd, env keys, URL, auth, `secretId`, headers, timeout, auto-connect, allow-insecure, **approved fingerprint**, cached tools/resources/prompts and server info |
| `agent_tool_grants` | Primary key (agent, server, tool), mode; cascades on agent or server deletion |

Agent-level configuration (provider, model, temperature, output cap, A2A card and pinned endpoint) lives in the existing `agents.config` JSON. A2A context IDs use the existing `agent_sessions` table. Conversation history is the existing `messages` table.

`IntegrationStore` (`src/main/db/integration-store.ts`) is the data-access layer; grant replacement is transactional.

---

## 11. IPC and renderer

**New channels**, each with a zod schema and an allowlist entry (the build fails otherwise):

- `providers:list | create | update | delete | test | discover | setModels`
- `mcp:list | create | update | delete | connect | disconnect | reconnect`
- `grants:list | set`
- `a2a:inspect`
- `agents:duplicate`

**Events:** `provider`, `provider-deleted`, `mcp-server`, `mcp-server-deleted`, `grants`. MCP status changes (connecting, connected, error) stream to the UI as they happen.

**Store** (`stores/app.ts`): `providers`, `mcpServers`, `grants` (grouped by agent), `settingsSection` and `wizardOpen`. Settings open to a section from anywhere (`openSettings('providers')`) and stack above the wizard, so "Add provider" mid-wizard returns to the wizard with the draft intact.

**Screens**, all built from the existing primitives and tokens:

| Screen | File |
|---|---|
| Settings → AI Providers: cards with test, refresh models, edit, remove; a models table with capability badges, manual models and overrides | `settings/ProvidersPane.tsx` |
| Add/edit provider: category → preset → form; test connection before saving | `settings/ProviderDialog.tsx` |
| Settings → MCP Servers: status, connect/disconnect/test, edit, remove; tools with risk and assigned agents, resources, prompts, server capabilities, stderr | `settings/McpServersPane.tsx` |
| Add/edit MCP server: local (command, arguments one per line, cwd, encrypted env) or remote (URL, auth, headers) | `settings/McpServerDialog.tsx` |
| Create agent wizard: name & avatar → provider & model → instructions & settings → MCP tools → review | `agents/AgentWizard.tsx` |
| Agent editor for every runtime, with duplicate and delete | `agents/AgentEditor.tsx` |
| Agent directory: search, filter by engine, message/edit/duplicate/delete | `views/AgentsView.tsx` |

Shared form pieces (engine chooser, model picker, A2A fields, tool grants editor, validation per step) live in `agents/fields.tsx`. Labels such as "Team Gateway · llama-3.3-70b" come from `lib/agents.ts` (`engineLabel`), used by messages, the mention picker, the member panel and the directory.

---

## 12. Testing

### 12.1 The fifteen required scenarios

| # | Scenario | Test | Against |
|---|---|---|---|
| 1 | Registering a custom provider | `providers.test.ts` › registering a custom provider (4 tests); e2e `integrations.spec.ts` › adds an OpenAI-compatible provider | Mock HTTP server |
| 2 | Connecting an OpenAI-compatible API | `providers.test.ts` › OpenAI-compatible API (6 tests); e2e, through the UI | Mock server speaking the Chat Completions wire format |
| 3 | Connecting a local Ollama model | `providers.test.ts` › local Ollama (mocked Ollama API) | Mock of `/api/tags`, `/api/show`, `/v1` |
| 4 | Creating a custom agent | `model-agents.test.ts` › creating and talking to a custom agent; e2e › creates an agent … through the wizard | Real app code, mock model |
| 5 | Sending messages to a custom agent | `model-agents.test.ts` (DM reply, history carried into the next turn, several agents on one model); e2e DM | Mock model |
| 6 | Adding a custom agent to a channel | `model-agents.test.ts` › replies only when mentioned, next to a CLI agent; hands work to another runtime through `send_message` | Mock model + scripted CLI runtime |
| 7 | Connecting an MCP server | `mcp.test.ts` › connecting an MCP server (stdio with approval, approval pinning, secret env, Streamable HTTP with bearer, http refusal); e2e through the UI | **Real MCP SDK server** (stdio child process and in-process HTTP) |
| 8 | Discovering MCP tools | `mcp.test.ts` › lists tools with descriptions and annotations, plus resources, prompts and capabilities | Real MCP SDK server |
| 9 | Assigning tools to an agent | `mcp.test.ts` › grants nothing by default and only what is assigned; e2e wizard grant | Real MCP SDK server |
| 10 | Executing an authorized MCP tool | `model-agents.test.ts` › executes an authorized tool and feeds the result back; e2e: the agent calls `echo` through the gateway and answers with its output | Real MCP server, mock model |
| 11 | Rejecting unauthorized tool execution | `mcp.test.ts` › rejects a call to a tool the agent was not granted; stops working the moment a grant is revoked; `model-agents.test.ts` › rejects a tool the model invents; asks first and honours a refusal | Real MCP server |
| 12 | Handling unavailable providers | `providers.test.ts` › handling unavailable providers (refused connection, key never echoed, redirect refused, draft test); `model-agents.test.ts` › unavailable provider is a failed run, not a crash | Closed port / mock |
| 13 | Handling disconnected MCP servers | `mcp.test.ts` › reports a server that dies and fails tool calls cleanly; notices when a stdio process exits | Real server process, killed |
| 14 | Preserving configuration after restart | `model-agents.test.ts` › keeps providers, agents, MCP servers and grants, with secrets still readable; e2e `app.spec.ts` › persists the channel across a restart (the built app, relaunched) | Real SQLite file, reopened |
| 15 | Preventing uncontrolled agent response loops | `model-agents.test.ts` › stops two model agents that keep handing work to each other; `orchestrator.test.ts` limits suite | Mock model |

A2A has its own suite, `a2a.test.ts` (8 tests), against the **official `@a2a-js/sdk` server** running in-process: card discovery, http refusal, context continuity, streaming artifacts, credential handling, a rejected credential, a **v0.3-only peer** (asserting the `A2A-Version` header on the wire), and a card that changed its endpoint.

### 12.2 What is and is not proven

- **Mock providers are test doubles** (`tests/support/mock-provider.ts` says so). They prove the adapters and the agent loop against the documented wire formats. **No test contacts OpenAI, Anthropic, Gemini, Ollama or any other real provider.**
- **MCP tests use a real MCP server** built with the official SDK (`tests/fixtures/mcp-notes-server.mjs`), over real stdio and real HTTP.
- **A2A tests use the official A2A SDK server**, v1.0 and v0.3 modes, in the same process. No third-party A2A service was contacted.
- **The e2e spec** (`tests/e2e/integrations.spec.ts`) drives the built Electron app through the new UI end to end: add a provider (mock) and test it, add a stdio MCP server and approve its launch (the native dialog is answered programmatically, and the test asserts what it showed), create an agent with one granted tool, send it a message, and see the tool's output in its reply. It then scans the profile directory for the API key.

---

## 13. Extending it

| To add | Do |
|---|---|
| A provider speaking one of the four wire formats | Nothing: the user adds it in Settings. Optionally add a preset to `provider-presets.ts` |
| A provider quirk (field name, path, auth header) | A preset option (`tokenParameter`, `chatPath`, `modelsPath`, auth header) |
| Richer discovery for a server | An enricher in `openai-compatible.ts` |
| A new wire format (for example Bedrock Converse) | A `ProviderAdapter` registered in `index.ts`, plus a `ProviderKind` value and its parameter ranges in `PARAMETER_SPECS` |
| A new external-agent protocol | An `AgentRuntime` implementation and a `RuntimeType` value. Orchestration, limits, UI listing and tool grants come for free |

---

## 14. Limitations

- **MCP 2026-07-28 modern-only servers** cannot be reached with SDK 1.30.0; the SDK v2 upgrade path is documented in the research.
- **No OAuth for remote MCP servers**: none, bearer or custom header only.
- **External A2A agents cannot call workspace tools** (`send_message`, tasks) or MCP grants; they answer within their task. The tool grants editor says so for A2A agents.
- **Custom agents report tokens, not cost**, so the spend ceilings do not constrain them; turn, hop, queue and time limits do.
- **Native Bedrock Converse (SigV4), Vertex AI and Azure Entra ID** are not implemented; Bedrock and Azure work with API keys through the generic adapter.
- **Structured output and vision** are recorded as capabilities but not yet used by the model loop, which exchanges text and tool calls.
