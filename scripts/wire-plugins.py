"""Exposes plugin discovery over IPC and adds the editor controls."""

import io


def patch(path, pairs):
    text = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in text, f'{path}: not found -> {old[:70]}'
        text = text.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(text)
    print('wired', path)


# --- IPC contract ------------------------------------------------------------
patch('src/shared/channels.ts', [
    ("  'agents:detectRuntime',", "  'agents:detectRuntime',\n  'agents:plugins',"),
])

patch('src/shared/ipc.ts', [
    (
        "  'agents:detectRuntime': detectRuntimeInput,",
        "  'agents:detectRuntime': detectRuntimeInput,\n  'agents:plugins': z.void(),",
    ),
    (
        "  'agents:detectRuntime': RuntimeDetection;",
        "  'agents:detectRuntime': RuntimeDetection;\n  'agents:plugins': DiscoveredPluginView[];",
    ),
    (
        "export interface WorkspaceLockInfo {",
        """/** A Claude Code plugin found on this machine, offered per crew member. */
export interface DiscoveredPluginView {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
}

export interface WorkspaceLockInfo {""",
    ),
])

patch('src/shared/ipc.ts', [
    (
        "  maxTurnsPerExecution: z.number().int().min(1).max(200),",
        """  autoCompact: z.boolean().default(true),
  autoCompactWindow: z.number().int().min(1000).max(1_000_000).optional(),
  plugins: z.array(z.string().min(1).max(4096)).max(16).optional(),
  maxTurnsPerExecution: z.number().int().min(1).max(200),""",
    ),
])

# --- Main process handler ----------------------------------------------------
patch('src/main/ipc/handlers.ts', [
    (
        "    'agents:detectRuntime': async (input) => {",
        """    'agents:plugins': () => discoverPlugins(),

    'agents:detectRuntime': async (input) => {""",
    ),
    (
        "import type { Orchestrator } from '../orchestrator/orchestrator.js';",
        "import type { Orchestrator } from '../orchestrator/orchestrator.js';\n"
        "import { discoverPlugins } from '../runtimes/plugins.js';",
    ),
])
