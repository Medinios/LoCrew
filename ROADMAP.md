# Roadmap

What exists today, and what might come next. **The unchecked items are
candidates, not commitments** - they come from the current limitations rather
than from a schedule, and nothing here carries a date.

---

## Built

- [x] Direct messages, channels and `@mentions`
- [x] Agent-to-agent hand-offs with hop, run and spend limits
- [x] Claude Code agents, verified against the real CLI
- [x] Custom agents on hosted, OpenAI-compatible and local models
- [x] MCP servers over stdio and Streamable HTTP, with per-agent tool grants
- [x] Activity reactions and presence driven by runtime events
- [x] Images in messages
- [x] Review a diff before an agent writes, and work sessions to stop being
      asked for every file
- [x] Per-agent recorded usage and provider quota, with unmeasurable figures
      shown as unknown rather than zero
- [x] External A2A agents *(beta)*
- [x] OpenAI Codex agents *(beta)*

## Candidates

Roughly in order of how much they would change what the app can do.

- [ ] **Cost for agents on AI providers.** Their runs currently record no price,
      so the spend ceiling cannot see them. This is the largest known gap in the
      accounting.
- [ ] **Trustworthy token totals for Claude Code.** The field recorded today
      covers the main loop only, omitting cached input and subagent work, so the
      figure is withheld rather than shown misleadingly. Fixing it means moving
      to `modelUsage` and settling a cache-token convention.
- [ ] **A live Codex turn in the test suite.** Install detection is covered;
      an actual turn is not.
- [ ] **A git worktree per agent**, so several can work in one repository at once.
- [ ] **Approvals that can be remembered** at a finer grain than a work session.
- [ ] **OAuth for remote MCP servers**, and servers that speak only the newest
      protocol revision.
- [ ] **Workspace and MCP tools for A2A agents**, which today have neither.
- [ ] **Native AWS Bedrock (SigV4), Vertex AI and Azure Entra ID authentication.**
- [ ] **Linux packaging**, and installers verified on each platform.

## Open questions

Not engineering tasks - decisions the project has to make.

- **Licence.** No `LICENSE` file is present and the metadata records
  `UNLICENSED`. Choosing a licence and naming the copyright holder is a
  prerequisite for release.
- **Artwork rights.** The origin of the crew portraits and the application icon
  is undocumented. A repository licence is normally read as covering the
  repository's contents, so the position of these files has to be settled
  alongside it - either by establishing the rights, by excluding the assets
  explicitly in the licensing notes, or by replacing them. Whether they may be
  distributed here at all is the question that comes first.
- **Distributing an installer.** Publishing this source and shipping a built
  binary are different questions: not every dependency carries permissive
  open-source terms.
