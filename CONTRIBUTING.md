# Contributing to LoCrew

Contributions are welcome, from bug reports to new integrations. LoCrew is in
early development, so the most valuable contributions are often the ones that
find where the app and its documentation disagree.

---

## Before you start

Open an issue first for anything larger than a fix. Describe the problem before
the solution - it is cheaper to disagree about a problem than about a patch.

**Bug reports** need your OS, your Node.js version, the steps to reproduce, and
what you expected instead. Include log output with API keys and tokens removed.

---

## Working on the code

```bash
npm install          # also compiles the SQLite native module for Electron
npm run dev          # the app, with hot reload
```

Before opening a pull request:

```bash
npm run typecheck
npm test
```

If the change touches the interface or IPC, also run `npm run build` and
`npm run test:e2e`. The end-to-end tests drive the **built** app, so a stale
`out/` will happily test code you did not write - rebuild first.

> [!TIP]
> If you have `npm run dev` running in another terminal, it exports
> `ELECTRON_RENDERER_URL`. The app honours that variable and loads the renderer
> from the dev server instead of the build. The test helpers strip it for this
> reason; if you write a new Electron test, strip it too, or you will spend an
> afternoon debugging a renderer from a different checkout.

Then:

1. Keep each pull request to one change.
2. Add or update tests for the behaviour you changed.
3. Update the README or `docs/` when behaviour changes.

---

## Conventions this codebase enforces

- **Every IPC channel needs a zod schema and an allowlist entry.** A
  compile-time assertion checks that the schemas, the result types and the
  preload allowlist describe the same set, so a mismatch fails the build rather
  than reaching a user.
- **Activity reactions come from runtime events, never from timers.** If the
  runtime cannot tell us an agent is thinking, the UI does not claim it is.
- **Test doubles are named as doubles.** Nothing is described as verified
  against a live service unless a test actually ran against one.
- **Say what is not known.** Where a figure cannot be established - a cost the
  runtime never reported, a quota the provider does not expose - the UI says so
  instead of showing a zero. A confident wrong number is worse than an honest
  gap. See [docs/AGENT_USAGE_DESIGN.md](docs/AGENT_USAGE_DESIGN.md).

---

## Specific areas

**Adding a dependency.** Run `npm run credits` afterwards so the About screen
credits it with the right version and licence.

**Adding an AI provider.** If it speaks one of the four supported formats it
usually needs no code - users can add it as an OpenAI-compatible or custom
provider. To ship it as a preset, add an entry to
`src/shared/provider-presets.ts` using the endpoint and auth style from the
provider's own documentation. A genuinely new protocol needs a `ProviderAdapter`
in `src/main/providers`, registered in `registry.ts`, with tests against the mock
server in `tests/support/mock-provider.ts`.

**MCP support.** MCP servers themselves need no code; users add them in
Settings. Changes to the client live in `src/main/mcp` and `src/main/gateway`,
and should be tested against the fixture server in
`tests/fixtures/mcp-notes-server.mjs`.

**Documentation.** Corrections are as valuable as code, especially where the
documentation overstates what has been verified.

---

## Security

Please do not open a public issue for a vulnerability. See
[SECURITY.md](SECURITY.md).
