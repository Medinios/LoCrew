"""Adds compaction and plugin controls to the crew editor."""

import io

PATH = 'src/renderer/src/components/agents/AgentEditor.tsx'

SECTION = """        <div className="space-y-2">
          <Switchable
            label="Let it compact its own history"
            detail="When the context window fills, the runtime summarises its older turns in place so the crew member can keep working. This transcript is never touched — every message stays in full."
            checked={config.autoCompact}
            onChange={(v) => setConfig({ ...config, autoCompact: v })}
          />

          {plugins.length ? (
            <div className="rounded-md border border-line bg-surface-raised p-3">
              <p className="text-xs font-medium text-content">Plugins</p>
              <p className="mt-0.5 text-2xs leading-relaxed text-content-muted">
                Loaded through the runtime's own plugin mechanism, so each behaves exactly as its
                author intended.
              </p>
              <div className="mt-2 space-y-1.5">
                {plugins.map((plugin) => {
                  const on = (config.plugins ?? []).includes(plugin.path);
                  return (
                    <button
                      key={plugin.id}
                      onClick={() =>
                        setConfig({
                          ...config,
                          plugins: on
                            ? (config.plugins ?? []).filter((p) => p !== plugin.path)
                            : [...(config.plugins ?? []), plugin.path],
                        })
                      }
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-md border p-2.5 text-left transition-colors',
                        on ? 'border-primary/50 bg-primary/10' : 'border-line hover:bg-surface',
                      )}
                    >
                      <Puzzle
                        size={13}
                        className={cn('mt-0.5 shrink-0', on ? 'text-primary' : 'text-content-faint')}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-content">{plugin.name}</span>
                        <span className="mt-0.5 block text-2xs leading-relaxed text-content-muted">
                          {plugin.description}
                        </span>
                        <span className="mt-1 block truncate font-mono text-[10px] text-content-faint">
                          {plugin.path}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="rounded-md border border-line bg-surface-raised px-3 py-2.5 text-2xs leading-relaxed text-content-muted">
              No Claude Code plugins found on this machine. To add ponytail, run{' '}
              <code className="font-mono text-primary">/plugin marketplace add DietrichGebert/ponytail</code>{' '}
              then <code className="font-mono text-primary">/plugin install ponytail@ponytail</code>{' '}
              in Claude Code, and reopen this dialog.
            </p>
          )}

          <Switchable"""

patch_pairs = [
    (
        """import { availablePortraits } from '@/lib/crew';""",
        """import type { DiscoveredPluginView } from '@shared/ipc';
import { availablePortraits } from '@/lib/crew';""",
    ),
    (
        "import { AlertTriangle, FolderOpen, Loader2, Save, ShieldCheck, Trash2 } from 'lucide-react';",
        "import {\n  AlertTriangle,\n  FolderOpen,\n  Loader2,\n  Puzzle,\n  Save,\n  ShieldCheck,\n  Trash2,\n} from 'lucide-react';",
    ),
    (
        "  const portraits = availablePortraits();",
        """  const portraits = availablePortraits();
  const [plugins, setPlugins] = useState<DiscoveredPluginView[]>([]);

  useEffect(() => {
    // Discovery touches the filesystem, so it runs once when the dialog opens.
    if (agentId) void invoke('agents:plugins').then(setPlugins);
  }, [agentId]);""",
    ),
    (
        """        <div className="space-y-2">
          <Switchable
            label="May be hailed by other crew\"""",
        SECTION + """
            label="May be hailed by other crew\"""",
    ),
]

text = io.open(PATH, encoding='utf-8').read()
for old, new in patch_pairs:
    assert old in text, f'not found -> {old[:70]}'
    text = text.replace(old, new)
io.open(PATH, 'w', encoding='utf-8').write(text)
print('editor: compaction + plugin controls')
