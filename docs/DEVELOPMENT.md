# Development

Everything needed to work on LoCrew itself: the layout of the repository, the
commands, and what each test suite actually covers.

---

## Project structure

```text
.
├── src/
│   ├── main/              Electron main process
│   │   ├── orchestrator/  routing, queues and limits
│   │   ├── runtimes/      Claude Code, Codex, model and A2A agents
│   │   ├── providers/     AI provider registry and adapters
│   │   ├── mcp/           MCP client manager and tool access
│   │   ├── gateway/       local MCP server the agents connect to
│   │   ├── activity/      activity state machine for reactions
│   │   └── db/            SQLite schema, data access and migrations
│   ├── preload/           the renderer's bridge to the main process
│   ├── renderer/          React user interface
│   └── shared/            types, IPC schemas and provider presets
├── tests/
│   ├── unit/              pure logic
│   ├── integration/       orchestrator, gateway, providers, MCP, A2A
│   ├── renderer/          React components and store
│   ├── e2e/               Playwright tests against the built app
│   ├── support/           mock provider and test helpers
│   └── fixtures/          an MCP server used by the tests
├── docs/                  architecture and research documents
├── resources/             app icon, as SVG source and rendered PNG
└── scripts/               icon rendering and maintenance scripts
```

---

## Development

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app with hot reload |
| `npm start` | Run the built app in preview mode (`electron-vite preview`) |
| `npm run build` | Typecheck, then build the main, preload and renderer bundles into `out/` |
| `npm run typecheck` | Typecheck the main, renderer and e2e projects |
| `npm test` | Unit, integration and renderer tests with Vitest |
| `npm run test:watch` | The same tests in watch mode |
| `npm run test:e2e` | Playwright tests that launch the built app |
| `npm run test:live` | Tests against your real, installed agent runtimes; **spends credit** |
| `npm run db:generate` | Generate a Drizzle migration after a schema change |
| `npm run package` | Build an unpacked desktop app into `release/` |
| `npm run dist` | Build installers: NSIS on Windows, DMG on macOS, AppImage on Linux |
| `npm run rebuild` | Recompile the SQLite native module for Electron |
| `npm run icons` | Render `resources/icon.svg` to `resources/icon.png` |
| `npm run credits` | Rebuild the About screen's credits from the installed packages |

### Running tests

```bash
npm test               # no model calls, no cost
npm run build          # the e2e tests launch the built app
npm run test:e2e
```

- **`npm test`** covers routing, limits, locking, queues and cancellation, and the MCP gateway over real HTTP with a real MCP client. It also runs each provider adapter against a mock server, MCP against a real SDK server, and A2A against the official SDK server. Tests run through Electron's bundled Node.js so they share the app's native SQLite build.
- **`npm run test:e2e`** drives the real Electron app, for example: add a provider, approve an MCP server, create an agent, and watch it call a granted tool.
- **`npm run test:live`** runs only on a machine where the runtime is installed and signed in, and skips itself otherwise. It sets `LOCREW_LIVE=1`.

<details>
<summary><strong>Troubleshooting</strong></summary>

<br>

**`NODE_MODULE_VERSION` error on startup.** The SQLite module was built for the wrong runtime. Run `npm run rebuild`.

**Electron starts but no window appears.** `ELECTRON_RUN_AS_NODE` is set in your shell, which makes Electron run as plain Node.js. Unset it.

**Codex is detected but "not signed in".** The CLI ships with the app, but the login does not. Run `npx codex` from the project directory and sign in.

**A CLI sign-in check fails although the CLI works in your terminal.** LoCrew runs the CLI with its own environment. If your login depends on a shell profile that desktop apps don't load, start LoCrew from that terminal.

**A channel message did nothing.** Only agents you `@mention` are woken. LoCrew posts a notice saying nobody was woken and lists who you can address. Direct messages need no mention.

**An agent is stuck in "Queued".** It is waiting for a free slot or for another agent to finish writing in the same directory. The *Working directories* section of the Details panel shows which agent holds the lock.

**A conversation says "Stopped here: …".** A limit stopped the chain. Send a new message to continue, or raise the limit under **Settings > Limits**.

**`npm run dist` fails on Windows.** Building a signed installer needs the code-signing tools, which may require elevated privileges. `npm run package` builds an unpacked app without them.

</details>

---
