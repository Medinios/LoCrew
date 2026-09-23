# Universal AI integration: research

What LoCrew needs to connect arbitrary models, tool servers and external agents, what the current standards actually say, and why the implementation looks the way it does.

All facts here were checked against primary sources (specifications, official docs, npm/PyPI registries, LICENSE files, source code) on **2026-09-21**. Anything that could not be confirmed is marked **UNVERIFIED**. The companion document, [UNIVERSAL_AI_ARCHITECTURE.md](UNIVERSAL_AI_ARCHITECTURE.md), describes what was built.

**Contents**

1. [The questions](#1-the-questions)
2. [Model providers](#2-model-providers)
3. [Provider abstraction libraries](#3-provider-abstraction-libraries)
4. [Model Context Protocol](#4-model-context-protocol-mcp)
5. [External agents](#5-external-agents)
6. [How existing open-source apps do it](#6-how-existing-open-source-apps-do-it)
7. [Selected approach](#7-selected-approach)
8. [Known gaps and follow-ups](#8-known-gaps-and-follow-ups)
9. [Sources](#9-sources)

---

## 1. The questions

LoCrew (then called AgentWorkspace) already ran two agent runtimes (Claude Code and Codex, each a local CLI driven through its official SDK) in Slack-style channels, with an authenticated MCP gateway for agent-to-agent messages. The goal was to let a user add, without changing source code:

- **any model**: hosted APIs, OpenAI-compatible servers, local models;
- **custom agents**: a name, instructions, a model and a tool set, where one model can back many agents;
- **MCP servers**: local (stdio) or remote, with explicit per-agent tool permissions;
- **external agents**: agents running elsewhere, on another machine or framework.

Four research questions followed:

1. Which providers can share one wire adapter, and which need their own?
2. Should the app adopt an abstraction library (Vercel AI SDK, LiteLLM, LangChain, LlamaIndex) or write a thin one?
3. What does the current MCP specification require of a client, especially for security?
4. What standard lets an external agent take part in a conversation?

A constraint shaped every answer: the main process runs on **Electron 34, which ships Node 20**. Electron 34 is the last release on Node 20, and Node 20 is end-of-life [P54][P55]. Several current libraries require Node 22 or later (section 3).

---

## 2. Model providers

### 2.1 Provider survey

| Provider | Endpoint and API | Auth | Model discovery | Notes that matter to an adapter | Own adapter? |
|---|---|---|---|---|---|
| **OpenAI** | `api.openai.com/v1`: Chat Completions (CC) and Responses. CC "remains supported"; Responses is recommended for new projects. The Assistants API shut down on 2026-08-26 [P5] | `Authorization: Bearer` [P1] | `GET /v1/models` returns `id, created, object, owned_by`. **No capability data** [P1] | SSE chunks with `delta.tool_calls[{index,id,function.arguments}]` [P2]. A usage chunk arrives before `[DONE]` when `stream_options.include_usage` is set [P3]. Newer models take `max_completion_tokens` | No: this is the reference format |
| **Anthropic** | `api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` [P7][P8] | `GET /v1/models` (paged) returns `max_input_tokens`, `max_tokens` and a `capabilities` object (image/PDF input, thinking, structured outputs, and more) [P7] | Named SSE events; deltas are `text_delta`, `input_json_delta`, `thinking_delta` [P8]. `max_tokens` is required | **Yes.** Its OpenAI-compat layer is "not considered a long-term or production-ready solution" and ignores `response_format` and `strict` [P6] |
| **Google Gemini** | Native `generateContent` / `streamGenerateContent?alt=sse` [P11]. OpenAI-compat at `/v1beta/openai/`, "still in beta" [P13] | `x-goog-api-key` [P12] or Bearer (compat) [P13] | Native `GET /v1beta/models` returns `inputTokenLimit`, `outputTokenLimit` and temperature ranges [P10] | Compat supports streaming, tools and structured output [P13] | Discovery only: native list, compat chat |
| **Ollama** | `localhost:11434`. Native `/api/chat`; OpenAI-compat `/v1/chat/completions`, `/v1/models` [P16][P21] | None locally [P16] | `/api/tags` lists models [P18]; `POST /api/show` returns a **`capabilities` array** and `<arch>.context_length` [P17]. `/v1/models` has no capability data [P21] | `/v1` supports `stream_options.include_usage` but **not `tool_choice`** [P21] | Discovery only |
| **LM Studio** | `localhost:1234/v1` [P22] | Optional Bearer [P23] | Native `GET /api/v1/models` returns `max_context_length`, `capabilities.vision`, `trained_for_tool_use` [P23] | Tools, streaming and `json_schema` are supported [P22] | No |
| **OpenRouter** | `openrouter.ai/api/v1/chat/completions` [P25] | Bearer; optional `HTTP-Referer`, `X-OpenRouter-Title` [P25] | `/api/v1/models` returns `context_length`, `architecture.input_modalities`, `supported_parameters`, `top_provider` [P24] | SSE comment lines (`: OPENROUTER PROCESSING`). **Mid-stream errors arrive as HTTP 200** with a top-level `error` [P26] | No |
| **Groq** | `api.groq.com/openai/v1` [P29] | Bearer [P29] | `/models` returns `context_window` [P30] | `logprobs`, `logit_bias` and `messages[].name` return 400; `n` must be 1 [P29] | No |
| **Together AI** | `api.together.ai/v1` [P32] | Bearer [P32] | `/v1/models` returns `context_length` [P33] | Namespaced model IDs [P32] | No |
| **Fireworks AI** | `api.fireworks.ai/inference/v1` [P34] | Bearer [P34] | Model endpoint UNVERIFIED | Reasoning in `reasoning_content`; overlong prompts are silently truncated by default [P34] | No |
| **Azure OpenAI (v1)** | `https://RESOURCE.openai.azure.com/openai/v1/`; **`api-version` is no longer required** [P37] | `api-key` header, or an Entra ID bearer token [P37][P38] | `GET /openai/v1/models` returns only `id, created, object, owned_by` [P38]. `model` takes the **deployment name** [P37] | Same wire format as OpenAI | No (Entra ID is an auth plugin, not a wire format) |
| **AWS Bedrock** | Native Converse/ConverseStream [P40]. OpenAI-compatible CC at `bedrock-runtime.{region}.amazonaws.com/openai/v1` [P41][P42] | SigV4, or a **Bedrock API key as `Authorization: Bearer`** [P39] | `bedrock-runtime` has **no `/models`** (use ListFoundationModels) [P41] | CC only works for models whose card lists it [P41] | No for `/openai/v1` + bearer key; yes for Converse or SigV4 |
| **Hugging Face Inference Providers** | `router.huggingface.co/v1` (CC only) [P43] | Bearer HF token [P43] | `/v1/models` returns per-provider context length and pricing [P43] | Tools, `tool_choice`, `json_schema`, `stream_options` [P44]; model suffixes `:fastest` / `:cheapest` pick the backend [P43] | No |
| **vLLM** | `localhost:8000/v1` [P46] | `--api-key`, which does not protect every endpoint [P46] | `max_model_len` in `/v1/models`: UNVERIFIED | Tools need `--enable-auto-tool-choice --tool-call-parser` [P45] | No |
| **llama.cpp server** | `127.0.0.1:8080/v1` [P47] | `--api-key` [P47] | `/v1/models` has one entry with `meta.n_ctx_train` (null while loading) [P47] | `--jinja` is on by default now; some models still need a chat template for tools [P47] | No |

### 2.2 What this means

**One OpenAI Chat Completions adapter covers every surveyed provider except Anthropic**: OpenAI, Azure v1, Groq, Together, Fireworks, OpenRouter, Hugging Face, Gemini's compat endpoint, Ollama `/v1`, LM Studio, vLLM, llama.cpp, Bedrock's `/openai/v1` (API key, supported models), any other OpenAI-compatible server, and any LiteLLM or Portkey proxy a user runs themselves. The differences between them are configuration, not code:

- base URL, chat path and models path;
- auth style: `Bearer`, a named header (`api-key`, `x-goog-api-key`), or none;
- extra headers (OpenRouter's attribution headers, gateway keys);
- the output cap field: `max_tokens` or `max_completion_tokens`;
- whether `stream_options.include_usage`, `tool_choice` and `temperature` are accepted.

The SSE parser must tolerate comment lines, errors inside a 200 stream, a final chunk with empty `choices`, a missing `[DONE]`, and servers that ignore `stream: true` and return plain JSON.

**Model discovery is the weak point of the common format.** OpenAI-style `/models` carries no capability data [P1], so a useful model picker needs small per-provider *enrichers* that read what each server does expose: OpenRouter `context_length` and `supported_parameters` [P24], Groq `context_window` [P30], Together `context_length` [P33], Ollama `/api/show` [P17], LM Studio `/api/v1/models` [P23], llama.cpp `meta.n_ctx_train` [P47], Gemini `inputTokenLimit` [P10]. Where nothing is exposed, capabilities are unknown, and the app must either let the user set them or learn them (a 400 naming `tools` or `temperature` is informative).

**Anthropic needs its own adapter.** Its compat layer drops structured output, caching and thinking, and Anthropic says it is not production-grade [P6]. The app already depends on `@anthropic-ai/sdk` (through the Claude Agent SDK), so native support costs nothing.

**Gemini** works through its compat endpoint for chat, but its native model list is worth reading for token limits [P10].

---

## 3. Provider abstraction libraries

| Library | License / runtime | Offers | Footprint (measured) | Fit for this app |
|---|---|---|---|---|
| **Vercel AI SDK** `ai` 7.0.107 | Apache-2.0, TypeScript [P51] | Tool calling with Zod/JSON schema, multi-step loops, tool approval, `@ai-sdk/openai-compatible` with custom `fetch` and headers [P48][P50] | 13 packages, about 24 MB; pulls in `@ai-sdk/gateway` and `@vercel/oidc` | **v7 is Node ≥22 and ESM-only**: "Node.js 18 and 20 are no longer supported" [P49][P51]. It cannot run in this app's Electron 34 main process. v6 still gets releases |
| **LiteLLM** | MIT, except `enterprise/` (commercial) [P52] | OpenAI-compatible proxy for 100+ providers [P53] | Python or Docker | Cannot be embedded in an Electron app. A user-run LiteLLM proxy already works through the generic adapter |
| **LangChain.js** 1.5 | MIT, Node ≥20 [P51] | Chains, agents, LangGraph | 26 packages, about 91 MB | Heavy and opinionated for "chat + tools" |
| **LlamaIndex.TS** 0.12 | MIT [P51] | RAG and workflows | 47 packages, about 69 MB; pulls a **native addon** (`tree-sitter`) | Native rebuilds under Electron; RAG-centred |

**Decision: a thin custom abstraction.** One internal `ProviderAdapter` interface emitting normalised events (text delta, reasoning delta, complete tool call, usage, done), with four adapters: the generic Chat Completions adapter over `fetch`, Anthropic over its official SDK, and Gemini and Ollama as discovery variants of the generic one.

Reasons:

1. **Runtime compatibility.** AI SDK v7, the only credible framework, will not load on Node 20 [P49]. Adopting v6 now means a forced migration later.
2. **Almost no new dependencies.** The generic adapter is `fetch` plus an SSE reader, and the Anthropic SDK is already present.
3. **No lowest-common-denominator flattening.** Anthropic's rich model capabilities [P7] and each server's discovery quirks stay visible.
4. **The security boundary stays in one place.** Credentials, redirects and error scrubbing are handled by code the app owns (section 7).

If the provider list grows beyond what configuration covers (native Bedrock Converse, Vertex), AI SDK v7 is the one library worth adopting, **after** moving to an Electron release on Node 24 [P55].

---

## 4. Model Context Protocol (MCP)

### 4.1 Versions

- **The current specification is 2026-07-28** [M1]. It is *stateless*: it removes the `initialize` handshake, `Mcp-Session-Id`, the HTTP GET stream, `ping` and `logging/setLevel`, and adds `server/discover` and a required `resultType` on results [M2].
- **The TypeScript SDK the app uses, `@modelcontextprotocol/sdk` 1.30.0** (npm `latest`, 2026-07-27), speaks up to **2025-11-25**, the handshake-based "legacy" era [M3].
- **SDK v2** (`@modelcontextprotocol/client` / `server` 2.0.0) implements 2026-07-28 and can negotiate both eras with `versionNegotiation: 'auto'` [M4][M5].
- **Compatibility:** a legacy client can talk to 2025-era servers and to dual-era servers, but **not to modern-only servers** [M6]. Almost every server published today is 2025-era or dual-era, so 1.30.0 reaches them.

### 4.2 What a client must do

**Primitives.** Servers offer *tools* (model-controlled), *resources* (application-controlled) and *prompts* (user-controlled) [M7]. Roots, Sampling and Logging are deprecated in 2026-07-28 [M8]. An MCP server is a tool provider, not a conversational peer.

**Lifecycle (2025-11-25, what 1.30.0 does).** `initialize` MUST come first; the response carries `serverInfo`, `capabilities` and optional `instructions`; the client MUST send `initialized`. "Implementations SHOULD establish timeouts for all sent requests" and "SHOULD always enforce a maximum timeout, regardless of progress notifications" [M9].

**Tools** [M10]:
- Names SHOULD be 1–128 characters from `[A-Za-z0-9_.-]`. Clients aggregating several servers SHOULD disambiguate, for example by prefixing; `serverInfo.name` "SHOULD NOT be relied upon".
- **"Clients MUST consider tool annotations to be untrusted unless they come from trusted servers."** The schema adds: "Clients should never make tool use decisions based on `ToolAnnotations` received from untrusted servers." Defaults: `readOnlyHint` false, `destructiveHint` true, `openWorldHint` true [M11].
- Execution errors come back as `isError: true` results and "SHOULD" be given to the model; protocol errors are JSON-RPC errors.
- "There SHOULD always be a human in the loop with the ability to deny tool invocations." Clients SHOULD confirm sensitive operations, show tool inputs before calling, validate results, time out, and log tool usage [M10]. The spec index lists "Hosts must obtain explicit user consent before invoking any tool" as a key principle [M12].

**Transports.**
- **stdio** [M13]: newline-delimited JSON-RPC. The server MUST NOT write non-MCP output to stdout; stderr is for logs and does not imply an error. Shutdown: close stdin, wait, then terminate. The client SHOULD restart a crashed server.
- **Streamable HTTP** [M14][M15]: POST (plus, in 2025-era, an optional GET stream and `MCP-Session-Id`). The `MCP-Protocol-Version` header is required. **Servers MUST validate `Origin` and return 403 when it is present and invalid**, SHOULD bind to localhost when local, and SHOULD authenticate.
- **HTTP+SSE** (2024-11-05) is deprecated [M8]; the SDK marks its client `@deprecated` [M3].

**Authorization** [M16]: optional; OAuth 2.1 based for HTTP (RFC 9728 protected resource metadata, PKCE, RFC 8707 resource indicators). **"Implementations using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment."**

### 4.3 Security best practices that apply directly [M17]

- **Local server compromise.** "If an MCP client supports one-click local MCP server configuration, it MUST implement proper consent mechanisms prior to executing commands." It MUST "show the exact command that will be executed, without truncation", require explicit approval and allow cancelling; it SHOULD highlight dangerous patterns (`sudo`, `rm -rf`, network) and warn that servers run "with the same privileges as the client".
- **Token passthrough.** Servers MUST NOT accept tokens not issued for them.
- **Session hijacking.** Servers MUST NOT use sessions for authentication and MUST use non-deterministic session IDs [M18].
- **SSRF and URL safety.** Clients SHOULD require HTTPS (loopback excepted), and MUST NOT open URLs through shell commands.

### 4.4 SDK facts the implementation relies on [M3]

- `callTool(params, resultSchema?, options?)`: **options is the third argument**. `RequestOptions` includes `signal`, `timeout`, `maxTotalTimeout` and `resetTimeoutOnProgress`; the default timeout is 60 s, and an abort sends `notifications/cancelled`.
- `StdioClientTransport` spawns with `shell: false` and merges a **safe default environment** (PATH, SYSTEMROOT, APPDATA and similar on Windows) with the given `env`. It does not inherit the app's whole environment. `stderr: 'pipe'` captures logs; `close()` ends stdin, then escalates to SIGTERM and SIGKILL.
- `StreamableHTTPClientTransport(url, { requestInit: { headers } })` takes static headers.
- `listChanged` handlers on the `Client` refresh tools, resources and prompts.
- `InMemoryTransport` and a real `McpServer` with `StdioServerTransport` or `StreamableHTTPServerTransport` make realistic tests possible.
- The transport's `allowedHosts` / `allowedOrigins` options are deprecated in favour of host-validation middleware.

---

## 5. External agents

### 5.1 Agent2Agent protocol (A2A)

**Status and governance.** Created by Google and a Linux Foundation project since 2025-06-23, with AWS, Cisco, Google, Microsoft, Salesforce, SAP and ServiceNow as founding backers [A3]. An eight-seat Technical Steering Committee (Google, Microsoft, Cisco, AWS, Salesforce, ServiceNow, SAP, IBM) governs it [A4]. Apache-2.0 [A2].

**Version.** The current spec is **v1.0** (tagged 2026-03-12; 1.0.1 patch 2026-05-28) [A1][A5]. It has **breaking changes against v0.3**, which most tutorials still show:
- PascalCase JSON-RPC methods (`SendMessage` instead of `message/send`);
- no `kind` discriminator; no `final` on status updates;
- enums as ProtoJSON strings (`TASK_STATE_WORKING`);
- clients MUST send an **`A2A-Version` header**, and servers MUST treat a missing header as 0.3 [A1 §3.6].

**Discovery.** The Agent Card lives at `/.well-known/agent-card.json` (v0.3+; v0.2.x used `agent.json`) [A1 §8.2][A6]. In v1.0 the endpoint moved from a top-level `url` into `supportedInterfaces[]` (`url`, `protocolBinding` of JSONRPC / GRPC / HTTP+JSON, `protocolVersion`); the first entry is preferred [A1 §8.3]. Cards declare `capabilities` (streaming, push notifications), `skills`, `defaultInputModes` / `defaultOutputModes`, and `securitySchemes`.

**Conversation model.** `contextId` groups tasks and messages into one conversation. The server MAY generate it, clients SHOULD treat server values as opaque, and "SHOULD NOT invent a contextId" [A1 §3.4]. Task IDs are server-generated. A `SendMessage` result is either a direct `Message` or a `Task` with status and artifacts; the spec says task outputs SHOULD be returned as Artifacts [A1 §3.7].

**Streaming.** `SendStreamingMessage` returns SSE where each event is a full JSON-RPC response: one Message then close, or a Task followed by status and artifact updates until a terminal state [A1 §3.1.2, §9.4.2].

**Authentication.** Declared in `securitySchemes` (API key, HTTP, OAuth2, OIDC, mTLS); credentials are obtained out of band and sent as HTTP headers on every request; HTTPS is required in production [A1 §7].

**Official JS SDK, `@a2a-js/sdk` 1.2.0** (Apache-2.0, published 2026-09-18) [A7]:
- implements v1.0 across all three bindings, with an opt-in **v0.3 compatibility layer** (`legacyCompat`) [A8];
- its only runtime dependency is `jose`; Express is an optional peer;
- client: `ClientFactory` → `createFromAgentCard(card)` → `sendMessage`, `sendMessageStream`, `cancelTask`, with per-call `signal` and `serviceParameters` (HTTP headers) [A8][A9];
- server: `AgentExecutor` + `DefaultRequestHandler` + Express handlers, usable as a real test peer [A10].

**Tooling.** The A2A Inspector (Apache-2.0) fetches a card, checks compliance and chats: a good model for a "Test connection" button [A11]. The spec's samples warn that Agent Cards, messages and artifacts from remote agents are **untrusted input** and a prompt-injection risk [O27].

### 5.2 Alternatives considered

| Option | What it is | Verdict |
|---|---|---|
| **IBM ACP (Agent Communication Protocol)** | Merged into A2A; development wound down on 2025-08-25 and the repo is archived [A12][A13] | Do not build on it |
| **ACP (Agent *Client* Protocol)** | stdio JSON-RPC used by IDE-style clients to drive coding agents (`cline --acp`, `goose acp`, LobeHub adapters) [O9][O12] | Local-process integration, like the app's existing CLI runtimes. Not a network protocol for agents on another machine |
| **AG-UI** | Agent-to-frontend event protocol (MIT) that calls itself complementary to MCP and A2A [A14] | Relevant for rendering a remote agent's UI events, not for peers in a channel |
| **MCP** | Tool integration; in 2026-07-28 requests are stateless and servers do not initiate requests [M1][A15] | An agent can be wrapped as a tool, but there is no peer identity, no conversation model and no agent-initiated message. Right for tools, wrong for channel members |
| **OpenAI-compatible endpoint** | Stateless request/response; the app owns the history [A16] | Already covered: any service exposing Chat Completions can be a *provider* behind a custom agent |
| **LangChain Agent Protocol** | OpenAPI spec (threads, runs); LangSmith Agent Server **also exposes A2A** at `/a2a/{assistant_id}` [A17][A18] | Covered by A2A |
| **Agent Network Protocol** | DID-based identity, discovery and messaging suite (Apache-2.0) [A19] | Ambitious and early; too heavy now |

**Conclusion.** A2A is the practical standard for "an agent on another computer takes part in a conversation": LF-governed, stable v1.0, official JS SDK, `contextId` maps directly onto a conversation, streaming maps onto the typing indicator, auth is ordinary headers, and LangGraph, LiteLLM and others already expose A2A endpoints [A18][O20]. Its main gap is direction: A2A is client-to-server, so a remote agent answers within a task and cannot post to a channel on its own initiative.

---

## 6. How existing open-source apps do it

Licenses were read from each repository's LICENSE file; code claims come from the source trees. This informed patterns only; **no code was copied from any of these projects.**

| Project | License | Providers | MCP | Secrets at rest | Tool approval | External agents |
|---|---|---|---|---|---|---|
| **LibreChat** [O1] | MIT | `endpoints.custom`: `baseURL`, `apiKey` (literal, `${ENV}` or `user_provided`), `models.fetch` → `${baseURL}/models`, header templates, `addParams`/`dropParams` [O2] | stdio (operator-defined only), SSE, WebSocket, streamable HTTP, OAuth [O3] | User keys "stored encrypted" [O4] | `toolApproval` with allow/deny/ask globs like `mcp:<server>:<tool>` [O5] | No A2A (discussion only) [O6] |
| **Open WebUI** [O7] | "Open WebUI License": BSD-3 **plus a branding clause** (≤50 users/30 days, else permission or enterprise license) since v0.6.6 [O7][O8] | Ollama, OpenAI-compatible, Anthropic via its compat endpoint; per-connection `/models` discovery and ID allowlist | **Streamable HTTP only**, admins only; stdio via the mcpo proxy | Config rows in the DB, no app-level encryption | Not documented | **Channels** where models reply only when @mentioned: the closest UX precedent |
| **Continue** [O10] | Apache-2.0; **now read-only / unmaintained** | `config.yaml` models with `apiBase`, `capabilities`, headers | stdio, SSE, streamable HTTP | Plaintext `.env` files | Ask First / Automatic / Excluded per tool | None |
| **Cline** [O9] | Apache-2.0 | 30+ providers incl. OpenAI Compatible (base URL + model ID) | stdio, `streamableHttp`, SSE (**SSE is the default when `type` is omitted**); per-server `autoApprove[]` | **Plaintext `~/.cline/data/secrets.json` (0600)** | Auto-approve categories, YOLO mode | Runs *as* an ACP agent |
| **Goose** (moved to `aaif-goose/goose`, Linux Foundation AAIF) [O11] | Apache-2.0 | JSON custom providers with `engine` openai/anthropic/ollama, `base_url`, `api_key_env`, `headers` | stdio, streamable HTTP; **no SSE** | **OS keyring**, plaintext fallback | Autonomous (default) / Manual / Smart; per tool Always / Ask / Never | ACP both ways [O12] |
| **AnythingLLM** [O13] | MIT | Generic OpenAI + many named providers | stdio, SSE (default), streamable | **Provider keys in plaintext `server/.env`** | Env-var allowlist, 120 s auto-reject | None |
| **Jan** [O14] | Apache-2.0 (was AGPL until 2025-05-20) | OpenAI- or Anthropic-compatible custom endpoints, `/models` auto-fetch, **multiple keys with fallback on 401/403/429** | stdio, HTTP, SSE; OAuth PKCE | **OS keyring, AES-256-GCM file fallback** [O15] | Inline approval panels | `jan mcp serve`: "anything that would otherwise wait for an approval returns an error instead of blocking, so a peer never hangs" |
| **LobeHub** (was LobeChat) [O16] | "LobeHub Community License": Apache-2.0 plus conditions; **derivative distribution needs a commercial license; not OSI open source** | 87 provider modules on OpenAI/Anthropic-compatible factories | Streamable HTTP; stdio on desktop only | Server key vault, AES-GCM | Per-tool `never/required/always` policy plus per-user mode | Adapter registry for 15 external agent runtimes (ACP, stream-JSON) [O17] |
| **Cherry Studio** [O18] | AGPL-3.0 (commercial license available) | Electron 44 + AI SDK v6; provider registry with presets resolved at read time | stdio, SSE, streamableHttp, in-memory; `isTrusted` flag | **Keys appear to be plaintext** (reading of the code) | Main process is the sole writer of approval state | A2A issue open, no code |
| **Chatbox** [O19] | GPL-3.0 | `defineProvider()` registry; discovery merges curated IDs, provider `/models`, and models.dev as a fallback | stdio (main-process proxy), HTTP with SSE fallback; tools named `mcp__<server>__<tool>` | `electron-store` JSON, unencrypted | Pause reasons for exec/mutation; no MCP-specific gate found | None |
| **LiteLLM proxy** [O20] | MIT except `enterprise/` (commercial) | 100+ providers; `check_provider_endpoint` discovery | Gateway with `allowed_tools` / `disallowed_tools`, per-key scoping | NaCl SecretBox with a salt key | Allow/deny lists | **A2A gateway**, 0.3 and 1.0 pinned per agent [O21] |
| **Portkey Gateway** [O22] | MIT | One OpenAI-style API, retries, fallbacks | Hosted MCP gateway; OSS code on a branch only | — | Tool allow/block lists | A2A proxy documented; no OSS code found (UNVERIFIED) |
| **Vercel Chatbot** (was ai-chatbot) [O23] | Apache-2.0 notice | Vercel AI Gateway only | None | — | AI SDK approval states | None |
| **MCP Inspector** [O24] | MIT / Apache-2.0 transition; **inconsistent between branches** | — | stdio, SSE, streamable HTTP | OS keychain or 0600 file | — | — |
| **a2a-samples** [O27] | Apache-2.0 | — | — | — | — | Host agent that adds remote agents by Agent Card URL |

**Lessons taken:**

1. **Encrypt keys at rest.** Several popular apps store keys in plaintext (Cline, Continue, AnythingLLM, apparently Cherry Studio and Chatbox). Jan and Goose use the OS keyring. Electron's `safeStorage` gives the same OS-level protection (DPAPI, Keychain, libsecret) without a native module.
2. **Local MCP servers are remote code execution by design.** MCP Inspector's CVE-2025-49596 was exactly that: an unauthenticated local proxy that anyone could make launch stdio commands. The fix was a bearer token, an `Origin` check and loopback-only binding [O25][O26]. The app's own gateway needs all three.
3. **Tool policy belongs to the host, per tool, per agent.** LibreChat's allow/ask globs, Goose's three levels and LobeHub's policy-plus-mode converge on the same model. Default to *ask*.
4. **Model discovery with manual fallback.** LibreChat's `models.fetch`, Jan's auto-fetch and Chatbox's layered sources all fall back to hand-entered model IDs, because not every endpoint lists its models.
5. **Namespace tools by the host's own config, not by `serverInfo.name`** (Chatbox's `mcp__<server>__<tool>`, and the MCP spec itself [M10]).
6. **No project had merged an A2A client.** LibreChat, Cline and Goose A2A PRs were closed unmerged; Cherry Studio has an open research issue. LiteLLM's gateway is the most complete A2A implementation found, and it is a proxy.
7. **License hygiene.** AGPL (Cherry Studio), GPL (Chatbox), the Open WebUI branding clause and the LobeHub community license all rule out copying code. Only patterns were used.

---

## 7. Selected approach

| Area | Choice | Why |
|---|---|---|
| **Provider layer** | Thin custom abstraction: one generic Chat Completions adapter (`fetch` + SSE), a native Anthropic adapter, Gemini and Ollama discovery variants, per-provider discovery enrichers | Reaches every surveyed provider, all but Anthropic through one adapter (Bedrock and Azure with API keys; see section 8); no framework that breaks on Node 20; Anthropic features preserved (sections 2–3) |
| **Provider configuration** | Presets (built-in, OpenAI-compatible, local, custom) that pre-fill base URL, auth style, headers and quirks; every field stays editable | Users add any compatible endpoint without code; presets remove the guesswork for known services |
| **Capabilities** | Read from discovery where exposed; user overrides; **learned** from provider 400s that name a feature (`tools`, `temperature`, `stream_options`, `max_tokens`) | OpenAI-style `/models` carries no capability data [P1] |
| **Custom agents** | An agent = identity + instructions + provider/model + settings + tool grants. Stateless model agents rebuild context from the conversation transcript each turn | "A model is not an agent": many agents can share one model with separate identities and memory |
| **MCP** | `@modelcontextprotocol/sdk` 1.30.0 client for stdio and Streamable HTTP; SSE and WebSocket not offered | Current stable SDK; reaches 2025-era and dual-era servers [M6]; SSE is deprecated [M8] |
| **Tool permissions** | Explicit per-agent, per-tool grants (`allow` or `ask`), **defaulting to ask regardless of annotations**, enforced at **one** point: the app's MCP gateway, which every runtime reaches | The spec says annotations from untrusted servers must not drive decisions [M10][M11]; one enforcement point means no runtime can bypass it |
| **Local server launch** | Exact command, arguments, working directory and environment variable *names* shown in a native dialog, with risk warnings; approval pinned to a fingerprint and re-requested when anything changes; auto-connect never prompts | Directly implements the spec's local-server consent rules [M17] |
| **External agents** | A2A v1.0 through `@a2a-js/sdk` 1.2.0 with v0.3 compatibility; card at `/.well-known/agent-card.json` (fallback `agent.json`); endpoint pinned at registration; one `contextId` per conversation | The one LF-governed, stable, SDK-backed standard for peers (section 5) |
| **Secrets** | Electron `safeStorage` ciphertext in the app database; renderer only ever sees "key stored: yes/no"; keys scrubbed from errors; redirects refused | "Never store API keys in plaintext" and "do not expose credentials to the renderer" |
| **Transport safety** | `https` required except to loopback (opt-in override per server); gateway validates `Origin` and `Host` | SSRF and DNS-rebinding guidance [M14][M17] |

---

## 8. Known gaps and follow-ups

- **MCP 2026-07-28 modern-only servers are unreachable** with SDK 1.30.0 [M6]. Moving to SDK v2 with `versionNegotiation: 'auto'` fixes it [M5].
- **MCP OAuth is not implemented.** Remote servers support no auth, a bearer token or a custom header. The SDK has the pieces (`OAuthClientProvider`, `finishAuth`) [M3]; a loopback redirect and encrypted token storage are the remaining work.
- **External A2A agents cannot call the workspace's own tools** (send a message, update a task). A2A is client-to-server; the remote agent answers inside its task.
- **Native Bedrock Converse, Vertex AI and Azure Entra ID** are not implemented. Bedrock via `/openai/v1` with an API key, and Azure with an API key, work through the generic adapter.
- **Cost.** Custom agents report tokens but no price (provider prices are not published in a machine-readable, trustworthy form for arbitrary endpoints), so spend ceilings do not apply to them; turn and hop limits do.
- **Electron upgrade.** Node 20 is end-of-life [P54]. Moving to an Electron release on Node 24 would also make AI SDK v7 and `openai@7` available [P51][P55].

---

## 9. Sources

### Providers and libraries

- [P1] OpenAI, list models — https://developers.openai.com/api/reference/resources/models/methods/list
- [P2] OpenAI, chat streaming events — https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
- [P3] OpenAI, create chat completion — https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- [P4] OpenAI, structured outputs — https://developers.openai.com/api/docs/guides/structured-outputs
- [P5] OpenAI, migrate to Responses — https://developers.openai.com/api/docs/guides/migrate-to-responses
- [P6] Anthropic, OpenAI SDK compatibility — https://platform.claude.com/docs/en/api/openai-sdk
- [P7] Anthropic, list models — https://platform.claude.com/docs/en/api/models-list
- [P8] Anthropic, streaming — https://platform.claude.com/docs/en/build-with-claude/streaming
- [P9] Anthropic, structured outputs — https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- [P10] Gemini, models — https://ai.google.dev/api/models
- [P11] Gemini, generate content — https://ai.google.dev/api/generate-content
- [P12] Gemini, API keys — https://ai.google.dev/gemini-api/docs/api-key
- [P13] Gemini, OpenAI compatibility — https://ai.google.dev/gemini-api/docs/openai
- [P14] Gemini, Interactions API — https://ai.google.dev/gemini-api/docs/interactions
- [P16] Ollama API — https://docs.ollama.com/api
- [P17] Ollama, show model details — https://docs.ollama.com/api-reference/show-model-details.md
- [P18] Ollama API reference — https://raw.githubusercontent.com/ollama/ollama/main/docs/api.md
- [P21] Ollama, OpenAI compatibility — https://docs.ollama.com/api/openai-compatibility.md
- [P22] LM Studio, OpenAI compatibility — https://lmstudio.ai/docs/developer/openai-compat
- [P23] LM Studio, REST API — https://lmstudio.ai/docs/developer/rest/list
- [P24] OpenRouter, models — https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
- [P25] OpenRouter, quickstart — https://openrouter.ai/docs/quickstart
- [P26] OpenRouter, streaming — https://openrouter.ai/docs/api/reference/streaming
- [P29] Groq, OpenAI compatibility — https://console.groq.com/docs/openai
- [P30] Groq, API reference — https://console.groq.com/docs/api-reference
- [P32] Together, OpenAI compatibility — https://docs.together.ai/docs/openai-api-compatibility
- [P33] Together, models — https://docs.together.ai/reference/models-1
- [P34] Fireworks, OpenAI compatibility — https://docs.fireworks.ai/tools-sdks/openai-compatibility
- [P37] Azure OpenAI v1 API lifecycle — https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle
- [P38] Azure OpenAI, models REST — https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/models
- [P39] Bedrock API keys — https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html
- [P40] Bedrock ConverseStream — https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
- [P41] Bedrock Chat Completions — https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html
- [P42] Bedrock endpoints — https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html
- [P43] Hugging Face Inference Providers — https://huggingface.co/docs/inference-providers/index
- [P44] Hugging Face chat completion — https://huggingface.co/docs/inference-providers/tasks/chat-completion
- [P45] vLLM tool calling — https://docs.vllm.ai/en/latest/features/tool_calling.html
- [P46] vLLM OpenAI-compatible server — https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/
- [P47] llama.cpp server README — https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md
- [P48] AI SDK, OpenAI-compatible providers — https://ai-sdk.dev/providers/openai-compatible-providers
- [P49] AI SDK 7 migration guide — https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0
- [P50] AI SDK tools — https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- [P51] npm registry (`ai`, `@ai-sdk/*`, `openai`, `langchain`, `llamaindex`) — https://registry.npmjs.org/ai
- [P52] LiteLLM — https://github.com/BerriAI/litellm
- [P53] LiteLLM proxy — https://docs.litellm.ai/docs/simple_proxy
- [P54] Node.js releases — https://nodejs.org/en/about/previous-releases
- [P55] Electron release schedule — https://releases.electronjs.org/schedule

### Model Context Protocol

- [M1] Versioning — https://modelcontextprotocol.io/specification/versioning
- [M2] 2026-07-28 changelog — https://modelcontextprotocol.io/specification/2026-07-28/changelog
- [M3] TypeScript SDK v1 (read from the installed `@modelcontextprotocol/sdk` 1.30.0 package) — https://github.com/modelcontextprotocol/typescript-sdk
- [M4] TypeScript SDK repository — https://github.com/modelcontextprotocol/typescript-sdk
- [M5] Supporting 2026-07-28 (SDK v2 migration) — https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/migration/support-2026-07-28.md
- [M6] Version compatibility — https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- [M7] Server primitives — https://modelcontextprotocol.io/specification/2026-07-28/server
- [M8] Deprecated features — https://modelcontextprotocol.io/specification/2026-07-28/deprecated
- [M9] Lifecycle (2025-11-25) — https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- [M10] Tools — https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- [M11] Schema — https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts
- [M12] Specification index — https://modelcontextprotocol.io/specification/latest
- [M13] stdio transport — https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
- [M14] Streamable HTTP (2026-07-28) — https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- [M15] Transports (2025-11-25) — https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- [M16] Authorization — https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- [M17] Security best practices — https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices
- [M18] Security best practices (2025-11-25) — https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices

### External agents

- [A1] A2A specification — https://raw.githubusercontent.com/a2aproject/A2A/main/docs/specification.md
- [A2] A2A repository — https://github.com/a2aproject/A2A
- [A3] Linux Foundation launch — https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents
- [A4] A2A governance — https://raw.githubusercontent.com/a2aproject/A2A/main/GOVERNANCE.md
- [A5] A2A releases — https://api.github.com/repos/a2aproject/A2A/releases
- [A6] A2A v0.3.0 specification — https://raw.githubusercontent.com/a2aproject/A2A/v0.3.0/docs/specification.md
- [A7] `@a2a-js/sdk` on npm — https://registry.npmjs.org/@a2a-js/sdk
- [A8] a2a-js README — https://raw.githubusercontent.com/a2aproject/a2a-js/main/README.md
- [A9] a2a-js migration guide — https://raw.githubusercontent.com/a2aproject/a2a-js/main/docs/migration-guide.md
- [A10] a2a-js sample agent — https://raw.githubusercontent.com/a2aproject/a2a-js/main/src/samples/agents/sample-agent/index.ts
- [A11] A2A Inspector — https://github.com/a2aproject/a2a-inspector
- [A12] ACP merges into A2A — https://github.com/orgs/i-am-bee/discussions/5
- [A13] i-am-bee/acp (archived) — https://github.com/i-am-bee/acp
- [A14] AG-UI — https://github.com/ag-ui-protocol/ag-ui
- [A15] MCP transports (2026-07-28) — https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
- [A16] OpenAI deprecations — https://developers.openai.com/api/docs/deprecations
- [A17] LangChain Agent Protocol — https://github.com/langchain-ai/agent-protocol
- [A18] LangSmith Agent Server A2A — https://docs.langchain.com/langsmith/server-a2a
- [A19] Agent Network Protocol — https://github.com/agent-network-protocol/AgentNetworkProtocol

### Open-source projects

- [O1] LibreChat — https://github.com/danny-avila/LibreChat (LICENSE: https://raw.githubusercontent.com/danny-avila/LibreChat/main/LICENSE)
- [O2] LibreChat custom endpoints — https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/custom_endpoint
- [O3] LibreChat MCP servers — https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers
- [O4] LibreChat custom endpoints quick start — https://www.librechat.ai/docs/quick_start/custom_endpoints
- [O5] LibreChat agents — https://www.librechat.ai/docs/features/agents
- [O6] LibreChat A2A discussion — https://github.com/danny-avila/LibreChat/discussions/9238
- [O7] Open WebUI LICENSE — https://raw.githubusercontent.com/open-webui/open-webui/main/LICENSE
- [O8] Open WebUI license page — https://docs.openwebui.com/license
- [O9] Cline — https://github.com/cline/cline; MCP: https://docs.cline.bot/mcp/mcp-overview.md; ACP: https://docs.cline.bot/usage/acp.md; storage rules: https://github.com/cline/cline/blob/main/.clinerules/storage.md
- [O10] Continue — https://github.com/continuedev/continue
- [O11] Goose — https://github.com/aaif-goose/goose; move announcement: https://goose-docs.ai/blog/2026/04/07/goose-moves-to-aaif/
- [O12] Goose ACP providers — https://github.com/aaif-goose/goose (documentation/docs/guides/acp-providers.md)
- [O13] AnythingLLM — https://github.com/Mintplex-Labs/anything-llm
- [O14] Jan — https://github.com/janhq/jan; custom endpoints: https://www.jan.ai/docs/desktop/remote-models/custom-endpoint
- [O15] Jan provider secrets — https://github.com/janhq/jan/blob/main/src-tauri/src/core/server/provider_secrets.rs
- [O16] LobeHub LICENSE — https://raw.githubusercontent.com/lobehub/lobehub/canary/LICENSE
- [O17] LobeHub tool intervention types — https://github.com/lobehub/lobehub/blob/canary/packages/types/src/tool/intervention.ts
- [O18] Cherry Studio — https://github.com/CherryHQ/cherry-studio; tool approval: https://raw.githubusercontent.com/CherryHQ/cherry-studio/main/docs/references/ai/tool-approval.md
- [O19] Chatbox — https://github.com/chatboxai/chatbox; providers: https://raw.githubusercontent.com/chatboxai/chatbox/main/docs/technical/ai-providers.md
- [O20] LiteLLM MCP gateway — https://docs.litellm.ai/docs/mcp
- [O21] LiteLLM A2A — https://docs.litellm.ai/docs/a2a
- [O22] Portkey Gateway — https://github.com/Portkey-AI/gateway
- [O23] Vercel Chatbot — https://github.com/vercel/chatbot
- [O24] MCP Inspector — https://github.com/modelcontextprotocol/inspector
- [O25] CVE-2025-49596 advisory — https://github.com/modelcontextprotocol/inspector/security/advisories/GHSA-7f8r-222p-6f5g
- [O26] MCP Inspector v1 README — https://raw.githubusercontent.com/modelcontextprotocol/inspector/v1/main/README.md
- [O27] a2a-samples — https://github.com/a2aproject/a2a-samples
