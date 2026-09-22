import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Finds Claude Code plugins already installed on this machine.
 *
 * Plugins are loaded through the runtime's own mechanism (`--plugin-dir`), not
 * by copying anyone's ruleset into this repository. That keeps third-party
 * licensing where it belongs and means a plugin behaves exactly as its author
 * intended, including its hooks and slash commands.
 *
 * Nothing here installs anything. The app only reports what it finds and lets
 * the operator switch it on per crew member.
 */
export interface DiscoveredPlugin {
  id: string;
  name: string;
  description: string;
  path: string;
  /** Where it was found, so the operator can tell installs apart. */
  source: string;
}

interface KnownPlugin {
  id: string;
  name: string;
  description: string;
  /** npm package that ships the plugin directory, when there is one. */
  npmPackage?: string;
  /** Directory names to look for under the Claude plugin roots. */
  directoryNames: string[];
}

/**
 * Plugins the app knows how to describe. Anything else can still be added by
 * pointing at its directory; this list only drives the one-click toggles.
 */
const KNOWN: KnownPlugin[] = [
  {
    id: 'ponytail',
    name: 'ponytail',
    description:
      'Pushes the agent to write less: skip it, reuse it, use the stdlib, then write the minimum that works. Reduces output, not context.',
    npmPackage: '@dietrichgebert/ponytail',
    directoryNames: ['ponytail'],
  },
];

/** Directories Claude Code keeps installed plugins in. */
function pluginRoots(): string[] {
  const home = homedir();
  return [
    join(home, '.claude', 'plugins'),
    join(home, '.claude', 'plugins', 'marketplaces'),
    join(home, '.config', 'claude', 'plugins'),
  ].filter((dir) => existsSync(dir));
}

/** A plugin directory is one holding a plugin manifest. */
function isPluginDirectory(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return (
    existsSync(join(dir, '.claude-plugin', 'plugin.json')) ||
    existsSync(join(dir, 'plugin.json')) ||
    existsSync(join(dir, '.claude-plugin', 'marketplace.json'))
  );
}

/** Depth-limited search for a directory by name under the plugin roots. */
function findUnderRoots(names: string[]): { path: string; source: string } | null {
  for (const root of pluginRoots()) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const candidate = join(root, entry);
      if (names.includes(entry.toLowerCase()) && isPluginDirectory(candidate)) {
        return { path: candidate, source: root };
      }

      // Marketplaces nest one level: <root>/<marketplace>/<plugin>.
      try {
        if (!statSync(candidate).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const nested of readdirSync(candidate)) {
        const nestedPath = join(candidate, nested);
        if (names.includes(nested.toLowerCase()) && isPluginDirectory(nestedPath)) {
          return { path: nestedPath, source: candidate };
        }
      }
    }
  }
  return null;
}

/** Resolves an npm-installed plugin through the module graph. */
function findViaNpm(packageName: string): string | null {
  try {
    const selfRequire = createRequire(__filename);
    return dirname(selfRequire.resolve(`${packageName}/package.json`));
  } catch {
    return null;
  }
}

/** Every known plugin that is actually present on this machine. */
export function discoverPlugins(): DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = [];

  for (const known of KNOWN) {
    const installed = findUnderRoots(known.directoryNames);
    if (installed) {
      found.push({ ...known, path: installed.path, source: installed.source });
      continue;
    }

    const viaNpm = known.npmPackage ? findViaNpm(known.npmPackage) : null;
    if (viaNpm) {
      found.push({ ...known, path: viaNpm, source: known.npmPackage! });
    }
  }

  return found;
}

/** Install guidance for a known plugin that was not found. */
export function installHint(id: string): string | null {
  const known = KNOWN.find((k) => k.id === id);
  if (!known) return null;
  return [
    `Not installed. In Claude Code run:`,
    `  /plugin marketplace add DietrichGebert/${known.id}`,
    `  /plugin install ${known.id}@${known.id}`,
    'then reopen this dialog.',
  ].join('\n');
}

export const KNOWN_PLUGIN_IDS = KNOWN.map((k) => k.id);
