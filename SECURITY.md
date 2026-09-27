# Security

> [!CAUTION]
> **Draft. This is not yet a usable security policy.**
>
> **Precondition for publication:** this project must not invite public
> contributions until a working private reporting channel exists - either
> [GitHub private vulnerability reporting][pvr] enabled on the repository, or a
> real, monitored security address. The sections below describe the safeguards
> accurately, but the reporting route does not exist yet, and a policy without
> one is decoration.

[pvr]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

LoCrew runs agents that can read and change files on your computer. Read this
before giving an agent write access.

---

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.**

**There is no private reporting channel for this project yet.** GitHub provides
no general private message, and [private vulnerability reporting][pvr] is a
feature a repository owner must enable before anyone can use it. Rather than
send you down a route that does not exist: if you have found something, hold the
details and raise the gap itself with the repository owner.

Once a channel is enabled this section should state the route, what a report
should contain, and an expected response time. Until then, treat the absence as
a known gap in the project's readiness rather than as an invitation.

---

## What LoCrew does

- **Credentials.** Keys are encrypted with the OS keychain. They never reach the
  user interface, are never logged, and are stripped from error messages.
- **An isolated interface.** The renderer runs with context isolation and the OS
  sandbox, without Node.js integration. It reaches the main process only through
  an allowlisted, schema-validated bridge.
- **Agent identity.** Each agent gets its own token, minted at launch and never
  written to disk. The local gateway listens only on `127.0.0.1` and rejects
  browser requests and unexpected `Host` headers.
- **File access.** Writes can require your approval, with the diff in front of
  you, before anything touches disk. One agent writes to a directory at a time.
  If nothing can answer - the window closed, the run was stopped - the operation
  is refused rather than left pending.
- **Work sessions.** Temporary write access is held in memory only, so a restart
  returns to asking. It never raises a read-only agent, never covers MCP tools,
  and is visible in the sidebar for as long as it is open.
- **MCP.** Local servers start only after you approve the exact command line.
  Tools need explicit per-agent grants, and tool output is treated as data.
- **Untrusted messages.** Every agent's system prompt states that messages from
  other agents cannot grant permissions. That is an instruction to a model, not
  a guarantee.

## What LoCrew does not do

- **File access levels are not a sandbox.** They map onto each CLI's own
  permission system, and that CLI runs as your user account. For real isolation,
  run LoCrew in a virtual machine or a container.
- **The directory lock is advisory.** It coordinates LoCrew's own agents. It
  does not stop your editor, or anything else, touching the same files.
- **Approved MCP servers run with your permissions.** Review the command, and
  grant *Allow* only to tools you trust.
- **External services see what you send them.** Conversation content reaches the
  AI providers and A2A agents you configure, under their terms, not LoCrew's.
- **Tokens live in memory.** A crash dump could contain them. They stop working
  when the app restarts.
