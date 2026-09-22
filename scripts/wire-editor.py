"""Wires the crew editor into every place a crew member is listed."""

import io


def patch(path, pairs):
    text = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in text, f'{path}: not found -> {old[:70]}'
        text = text.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(text)
    print('wired', path)


# --- App owns the dialog, so any list can ask for it -------------------------
patch('src/renderer/src/App.tsx', [
    (
        "import { AgentWizard } from '@/components/agents/AgentWizard';",
        "import { AgentEditor } from '@/components/agents/AgentEditor';\n"
        "import { AgentWizard } from '@/components/agents/AgentWizard';",
    ),
    (
        "  const [wizardOpen, setWizardOpen] = useState(false);",
        "  const [wizardOpen, setWizardOpen] = useState(false);\n"
        "  const editingAgentId = useApp((s) => s.editingAgentId);\n"
        "  const setEditingAgent = useApp((s) => s.setEditingAgent);",
    ),
    (
        "      <AgentWizard open={wizardOpen} onOpenChange={setWizardOpen} />",
        "      <AgentWizard open={wizardOpen} onOpenChange={setWizardOpen} />\n"
        "      <AgentEditor\n"
        "        agentId={editingAgentId}\n"
        "        onOpenChange={(open) => !open && setEditingAgent(null)}\n"
        "      />",
    ),
])

# --- Store holds which crew member is being edited ---------------------------
patch('src/renderer/src/stores/app.ts', [
    (
        "  /** Agent ids per conversation. Shared so the header and panel never disagree. */\n"
        "  conversationMemberIds: Record<string, string[]>;",
        "  /** Agent ids per conversation. Shared so the header and panel never disagree. */\n"
        "  conversationMemberIds: Record<string, string[]>;\n"
        "  /** Crew member currently open in the editor, if any. */\n"
        "  editingAgentId: string | null;",
    ),
    (
        "  setRightPanelOpen(open: boolean): void;",
        "  setEditingAgent(agentId: string | null): void;\n"
        "  setRightPanelOpen(open: boolean): void;",
    ),
    (
        "  conversationMemberIds: {},",
        "  conversationMemberIds: {},\n  editingAgentId: null,",
    ),
    (
        "  setRightPanelOpen(open) {",
        "  setEditingAgent(agentId) {\n    set({ editingAgentId: agentId });\n  },\n\n"
        "  setRightPanelOpen(open) {",
    ),
])

# --- Sidebar crew rows become buttons ----------------------------------------
patch('src/renderer/src/components/layout/Sidebar.tsx', [
    (
        """              agents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-content-muted"
                  title={CREW_STATUS[agent.status].hint}
                >""",
        """              agents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => setEditingAgent(agent.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-content-muted transition-colors hover:bg-surface/70 hover:text-content"
                  title={`${CREW_STATUS[agent.status].hint} Click to edit.`}
                >""",
    ),
    (
        """                  <StatusDot
                    status={agent.status}
                    state={busyAgents.has(agent.id) ? 'working' : 'idle'}
                  />
                </div>
              ))""",
        """                  <StatusDot
                    status={agent.status}
                    state={busyAgents.has(agent.id) ? 'working' : 'idle'}
                  />
                </button>
              ))""",
    ),
    (
        "  const costs = useApp((s) => s.costs);",
        "  const costs = useApp((s) => s.costs);\n  const setEditingAgent = useApp((s) => s.setEditingAgent);",
    ),
])

# --- Settings crew tab: edit instead of delete-only --------------------------
patch('src/renderer/src/components/settings/SettingsDialog.tsx', [
    (
        """              <Button
                variant="ghost"
                size="sm"
                className="px-1.5 text-content-faint hover:text-danger"
                onClick={async () => {
                  await invoke('agents:delete', { id: agent.id });
                  await refreshAgents();
                }}
                aria-label={`Delete ${agent.name}`}
              >
                <Trash2 size={13} />
              </Button>""",
        """              <Button
                variant="surface"
                size="sm"
                onClick={() => {
                  setEditingAgent(agent.id);
                  onOpenChange(false);
                }}
                aria-label={`Edit ${agent.name}`}
              >
                <Pencil size={12} />
                Edit
              </Button>""",
    ),
    (
        "import { FolderOpen, Trash2 } from 'lucide-react';",
        "import { FolderOpen, Pencil } from 'lucide-react';",
    ),
    (
        "  const refreshAgents = useApp((s) => s.refreshAgents);",
        "  const setEditingAgent = useApp((s) => s.setEditingAgent);",
    ),
])

# --- Participants panel: click a crew member to edit -------------------------
patch('src/renderer/src/components/layout/RightPanel.tsx', [
    (
        """                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-content">{agent.name}</p>
                  <p className="truncate text-2xs text-content-faint">
                    {execution ? EXECUTION_LABEL[execution.state] : CREW_STATUS[agent.status].label}
                  </p>
                </div>""",
        """                <button
                  onClick={() => setEditingAgent(agent.id)}
                  className="min-w-0 flex-1 text-left"
                  title="Edit this crew member"
                >
                  <p className="truncate text-xs text-content hover:text-primary">{agent.name}</p>
                  <p className="truncate text-2xs text-content-faint">
                    {execution ? EXECUTION_LABEL[execution.state] : CREW_STATUS[agent.status].label}
                  </p>
                </button>""",
    ),
    (
        "  const refreshCosts = useApp((s) => s.refreshCosts);",
        "  const refreshCosts = useApp((s) => s.refreshCosts);\n  const setEditingAgent = useApp((s) => s.setEditingAgent);",
    ),
])
