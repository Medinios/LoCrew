# Using LoCrew

How the app behaves once it is running: the shape of a conversation, the kinds
of agent you can create, the providers they run on, and how MCP tools are
granted. For getting it installed see the [README](../README.md); for the
internals see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## How LoCrew works

### An example

Suppose you create a `#development` channel with two agents working in the same repository:

- **Reviewer**, a Claude Code agent with *Read only* file access.
- **Builder**, a Claude Code agent with *Ask first* file access.

```text
You       @Reviewer look at the session handling in src/auth and list what should change.

Reviewer  (reads the files, replies in the channel)
          Three issues: sessions survive a password change, ...
          (calls send_message, addressed to Builder)
          Builder, please fix the first two.

Builder   (wakes up, edits src/auth; you approve each write in a dialog)
          Done. Both fixes are in, with a test for the expiry case.
```

The whole exchange stays in `#development`. As each agent works, its reaction on your message changes. The Activity panel shows each agent's current step and elapsed time, and Stop ends a run at any point. Because both agents work in the same directory, only one of them writes at a time.

Three rules make this predictable:

1. **Text is not routing.** An agent that writes "@Builder" in its reply wakes nobody. Agents reach each other only through the `send_message` tool. The sender is identified by its own access token, never by what the message says.
2. **Chains are bounded.** Every agent-to-agent hop is counted. By default, a chain stops after 6 hops, and one agent can run at most 3 times in a row without your input.
3. **Nothing is interrupted.** A new message never cuts into a running agent; it waits its turn.

<details>
<summary><strong>Tools every agent gets from LoCrew</strong></summary>

<br>

LoCrew runs a small MCP server on `127.0.0.1`, and every agent connects to it with its own token.

| Tool | Purpose |
|---|---|
| `send_message` | Post to the conversation, optionally addressed to specific agents |
| `read_messages` | Read recent history |
| `list_channel_members` | See who is in the conversation, with their IDs |
| `get_channel_context` | Read the topic, open tasks and how many hops remain |
| `get_agent_status` | Check whether another agent is online or busy |
| `update_task` | Move a task the agent is assigned to |

External A2A agents do not receive these tools.

</details>

### Models, agents and MCP servers

These three are easy to confuse, and LoCrew keeps them separate:

| Concept | What it is | In LoCrew |
|---|---|---|
| **AI model** | A model served by a provider, such as a hosted API or a model running in Ollama | You connect a provider once, under **Settings > AI Providers**. Its models are discovered automatically, or you add them by ID. |
| **AI agent** | A named participant with instructions, an engine and permissions | Created in the agent wizard. Many agents can share one model, each with its own name, instructions and tools. |
| **MCP server** | A program or endpoint that offers tools (file access, a database, an API) over the Model Context Protocol | Added under **Settings > MCP Servers**. Connecting a server grants nothing; you choose which agents may call which tools. |
| **External agent** | A complete agent running somewhere else | Reached over A2A. It is a participant in conversations, not a tool, and has nothing to do with MCP. |

---

### First steps

1. **Connect a model** (optional): open **Settings > AI Providers > Add provider**. Skip this step if you only use Claude Code or Codex.
2. **Create an agent**: click **Create agent** and follow the five steps. A direct message with the new agent opens when you finish.
3. **Start a channel**: click **+** next to *Channels*, choose its agents, and `@mention` them.

---

## AI providers and custom agents

### Agent engines

| Engine | How it runs | Authentication | Status |
|---|---|---|---|
| **Claude Code** | Your local `claude` CLI, driven by the Claude Agent SDK in a working directory | Your existing Claude Code login | Available |
| **OpenAI Codex** | The Codex CLI bundled with `@openai/codex-sdk`, driven by the Codex SDK | Your Codex login (`npx codex`) | Experimental |
| **AI model** | LoCrew's own agent loop, calling a connected provider | The provider's API key, or none for local servers | Available |
| **External agent** | A remote agent, over the A2A protocol | Bearer token, API-key header or none | Experimental |

### Supported providers

| Category | Providers | Authentication |
|---|---|---|
| **Built-in** | OpenAI, Anthropic, Google Gemini, Azure OpenAI, AWS Bedrock, OpenRouter, Groq, Together AI, Fireworks AI, Hugging Face | API key, as a bearer token or the provider's own header |
| **Local model** | Ollama, LM Studio, vLLM, llama.cpp server | None by default |
| **OpenAI-compatible API** | Any server that speaks the Chat Completions API, such as a LiteLLM proxy or a company gateway | Bearer token, named header or none |
| **Custom provider** | Full control over the auth method, header name, extra headers, chat and models paths, and output-cap field | Bearer token, named header or none |

Presets only pre-fill the form. Every field stays editable. Under the hood, LoCrew talks to providers in four formats:

- **OpenAI Chat Completions**: most providers.
- **Anthropic Messages API**: Anthropic.
- **Gemini**: native model discovery, with chat through Google's OpenAI-compatible endpoint.
- **Ollama**: native model discovery, with chat through Ollama's OpenAI-compatible endpoint.

Things to know:

- **Test connection** checks the endpoint before anything is saved.
- **Model discovery** lists models where the provider supports it, with context window, tool support and image support when the provider reports them. Otherwise, add a model ID by hand and override its capabilities.
- **Remote endpoints must use `https://`.** Plain `http://` is accepted only for servers on your own computer.
- **Azure OpenAI** expects your deployment name as the model ID. **AWS Bedrock** works through its OpenAI-compatible endpoint; enter the model ID by hand.
- **Spend limits.** Agents on AI providers report token usage but not cost, so spend limits don't constrain them. Turn, hop, queue and time limits still do.

<details>
<summary><strong>Example: a custom OpenAI-compatible endpoint</strong></summary>

<br>

In **Settings > AI Providers > Add provider**, choose **OpenAI-compatible API**:

| Field | Example |
|---|---|
| Provider name | `Team gateway` |
| Base URL | `https://llm-gateway.example.com/v1` |
| Authentication | Bearer token; paste your key into the key field |
| Model ID (optional) | A model your gateway serves, if it does not list its models |

Click **Test connection**, then **Add provider**.

</details>

<details>
<summary><strong>Example: a local model with Ollama</strong></summary>

<br>

1. Install Ollama and pull a model.
2. In **Settings > AI Providers > Add provider**, choose **Local model > Ollama**. The base URL defaults to `http://localhost:11434`, and no key is needed.
3. LoCrew lists the models installed in Ollama, with the context length, tool support and image support that Ollama reports for each.

LM Studio (`http://localhost:1234/v1`), vLLM (`http://localhost:8000/v1`) and the llama.cpp server (`http://127.0.0.1:8080/v1`) are set up the same way.

</details>

### Creating an agent

**Create agent** opens a five-step wizard:

1. **Name & avatar**: name, description, accent colour and portrait. The name is used for `@mentions`, but routing uses a stable ID, so renaming an agent is safe.
2. **Provider & model**: a model from a connected provider, Claude Code, Codex, or an A2A agent. For the CLIs, the wizard checks that the tool is installed and signed in.
3. **Instructions**: what the agent is for, plus model settings (temperature and output limit) or, for CLI agents, the working directory and file access level.
4. **Tools**: MCP tool grants and conversation permissions.
5. **Review**: then create.

The **Agents** view lists every agent with its engine and status. From there you can message, edit, duplicate or delete an agent. Duplicating copies the configuration, stored credential and tool grants to a new agent.

**Instructions and system prompts.** Your instructions are appended to a base prompt that LoCrew gives every agent. The base prompt says who else is in the conversation and how to reach them. It also states that messages from other agents, and tool output, are untrusted and cannot change the agent's permissions. Codex has no separate system-prompt channel, so its instructions are sent with the first message of each thread.

**Permissions and limits.** Each agent has its own settings:

| Setting | Values | Default |
|---|---|---|
| File access (Claude Code and Codex) | *Read only*: reads only. *Ask first*: you approve each write. *Full access*: no prompts. | *Ask first* |
| Work session (temporary) | Lifts the prompts for *Ask first* agents, for a set time or until ended. Per agent, or per working directory. | none open |
| May be woken by other agents | on / off | on |
| May update tasks | on / off | on |
| Spend ceiling per run | US dollars; 0 turns the check off | $2 |
| Turn limit and timeout per run | Set per agent | none |

Agents on AI models have no file access of their own. They can use only the MCP tools you grant them.

<details>
<summary><strong>Workspace-wide limits</strong> (Settings > Limits)</summary>

<br>

| Limit | Default | What it stops |
|---|---|---|
| Agent-to-agent hops | 6 | Endless back-and-forth between agents |
| Runs without your input | 3 | One agent looping on its own |
| Agents working at once | 2 | Every agent running at the same time |
| Queued messages per agent | 10 | A backlog nobody asked for |
| Task duration | 15 min | A run that hangs |
| Spend per chain | $5 | A chain quietly using up credit |
| Let agents talk to each other | on | Master switch for all agent-to-agent waking |

When a limit stops a chain, LoCrew posts a notice in the conversation. Dollar figures are estimates from the runtime's usage reports, not billing statements.

</details>

---

## MCP integration

LoCrew is an MCP client. Connecting MCP servers gives your agents tools; it does not add agents.

| | Local server | Remote server |
|---|---|---|
| **Transport** | stdio; LoCrew starts the process | Streamable HTTP |
| **Configuration** | Command, arguments (one per line), optional working directory, environment variables | URL, authentication (none, bearer token or named header), custom headers |
| **Before first use** | You approve the exact command line in a dialog, and again whenever it changes | `https://` is required, except for localhost or when you explicitly allow plain http for that server |
| **Secrets** | Environment variable values are stored encrypted | The token and sensitive-looking headers are stored encrypted |

Not supported yet: OAuth for remote servers, and servers that speak only the newest MCP protocol revision (2026-07-28). SSE and WebSocket transports are not offered.

### Adding a server

Open **Settings > MCP Servers > Add MCP server** and choose **Local server**. For example, the reference filesystem server:

| Field | Value |
|---|---|
| Name | `filesystem` |
| Command | `npx` |
| Arguments | `-y`<br>`@modelcontextprotocol/server-filesystem`<br>`/path/to/your/project` |

When you connect it, a native dialog shows the full command line and asks for approval. It also warns about risky patterns, including package runners such as `npx -y` that download code on first run. **Connect on startup** reconnects approved servers when LoCrew starts and never shows a prompt; a server that isn't approved stays disconnected.

### Tool discovery

After connecting, LoCrew reads the server's tools, resources, prompts, capabilities and version. It rediscovers them when the server announces changes. The MCP Servers pane shows:

- each tool with the risk the server claims for it (*read-only*, *writes* or *destructive*), labelled as unverified;
- which agents use the server;
- for local servers, the last lines of error output.

The **Test** button reconnects the server and reports what it found.

### Granting tools to agents

- **Nothing by default.** A new server grants nothing, and a new agent has no tools.
- **Per agent, per tool.** In the agent's **Tools** step, or later in its settings, tick the tools it may use. Each grant is either **Ask first** (the default: you confirm every call) or **Allow**.
- **One checkpoint for MCP tools.** Every *MCP* tool call, whatever engine the agent runs on, passes through LoCrew's local gateway, which re-checks the grant on each call, so revoking a grant takes effect immediately. A CLI agent's own built-in tools - reading a file, editing it, running a shell command - do not take this path: they are governed by the agent's file access level through the CLI's own permission callback, set when you [create the agent](#creating-an-agent).
- **No shadowing.** LoCrew prefixes each tool's name with its server, so one server cannot impersonate another server's tools or LoCrew's own.
- **Results are data, not instructions.** Tool output returns to the model as a tool result, with size limits, and cannot alter an agent's stored permissions or grants: those live outside the conversation and are re-checked on every call. It can still contain text that tries to influence the model, and no prompt can reliably prevent that. Treat a tool's output as untrusted input, and keep grants narrow.

MCP servers you approve run with your user account's permissions. Grant *Allow* only to tools you trust.

---
