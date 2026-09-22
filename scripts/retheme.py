"""One-off: finish applying the ship lexicon to the wizard and the e2e specs."""

import io

WIZARD = 'src/renderer/src/components/agents/AgentWizard.tsx'
E2E = 'tests/e2e/app.spec.ts'


def patch(path, pairs):
    text = io.open(path, encoding='utf-8').read()
    missed = []
    for old, new in pairs:
        if old not in text:
            missed.append(old[:70])
            continue
        text = text.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(text)
    print('patched', path)
    for m in missed:
        print('  MISSED:', m)


old_colors = (
    "const COLORS = ['#7C6CF6', '#22C55E', '#F59E0B', '#EF4444', "
    "'#38BDF8', '#F472B6', '#A78BFA', '#2DD4BF'];"
)
new_colors = (
    "// Signal-flag colours: brass, verdigris, rust, sea green, open water.\n"
    "const COLORS = ['#C9A227', '#2E7D6E', '#C4483A', '#3FA66B', "
    "'#4A7CB5', '#B5702E', '#8A6FB0', '#6E8FA3'];"
)

old_access = """const ACCESS_OPTIONS: Array<{ id: WorkspaceAccess; label: string; detail: string }> = [
  {
    id: 'approval_required',
    label: 'Ask before writing',
    detail: 'Reads freely. You approve every edit and shell command.',
  },
  {
    id: 'read_only',
    label: 'Read only',
    detail: 'Can inspect the project but cannot change it.',
  },
  {
    id: 'read_write',
    label: 'Read and write',
    detail: 'No prompts. Only for directories you are happy to let an agent change.',
  },
];"""

new_access = """const ACCESS_OPTIONS: Array<{ id: WorkspaceAccess; label: string; detail: string }> = [
  { id: 'approval_required', ...HOLD_ACCESS.approval_required },
  { id: 'read_only', ...HOLD_ACCESS.read_only },
  { id: 'read_write', ...HOLD_ACCESS.read_write },
];"""

patch(WIZARD, [
    (old_colors, new_colors),
    (old_access, new_access),
    ("import { cn } from '@/lib/utils';",
     "import { HOLD_ACCESS } from '@/lib/lexicon';\nimport { cn } from '@/lib/utils';"),
    ("setColor(COLORS[0] ?? '#7C6CF6');", "setColor(COLORS[0] ?? '#C9A227');"),
    ("const [color, setColor] = useState(COLORS[0] ?? '#7C6CF6');",
     "const [color, setColor] = useState(COLORS[0] ?? '#C9A227');"),
    ("These settings gate the agent through its runtime's own permission system.",
     "These gate the crew member through its runtime's own permission system."),
])

patch(E2E, [
    ("getByPlaceholder('Search conversations')", "getByPlaceholder('Search the ship')"),
    ("getByText('Direct messages', { exact: true })", "getByText('Parley', { exact: true })"),
    ("getByText('Channels', { exact: true })", "getByText('Decks', { exact: true })"),
    ("getByText('Agents', { exact: true })", "getByText('Crew', { exact: true })"),
    ("getByText('No conversation selected')", "getByText('Nothing on the water')"),
    ("{ name: 'Add your first agent' }", "{ name: 'Sign on your first crew member' }"),
    ("getByText('Add an agent', { exact: true })",
     "getByText('Sign on a crew member', { exact: true })"),
    ("getByText('Workspace access', { exact: true })",
     "getByText('Access to the hold', { exact: true })"),
    ("getByLabel('New channel')", "getByLabel('New deck')"),
    ("getByText('New channel', { exact: true })", "getByText('Open a new deck', { exact: true })"),
    ("{ name: 'Create channel' }", "{ name: 'Open deck' }"),
    ("getByPlaceholder(/Message the channel/)", "getByPlaceholder(/Message the deck/)"),
])
