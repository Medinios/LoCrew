import { Bot, CircleUserRound, FolderOpen, Gauge, Info, Server, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AppSettings, ExecutionLimits } from '@shared/types';
import { Button, Field, Input, Modal, Switch } from '@/components/ui/primitives';
import { AboutPane } from '@/components/settings/AboutPane';
import { AccessPane } from '@/components/settings/AccessPane';
import { McpServersPane } from '@/components/settings/McpServersPane';
import { ProfilePane } from '@/components/settings/ProfilePane';
import { ProvidersPane } from '@/components/settings/ProvidersPane';
import { SHIP } from '@/lib/lexicon';
import { cn, formatUsd } from '@/lib/utils';
import { invoke, useApp, type SettingsSection } from '@/stores/app';

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: ReactNode }> = [
  { id: 'profile', label: 'Profile', icon: <CircleUserRound size={14} /> },
  { id: 'general', label: 'General', icon: <SlidersHorizontal size={14} /> },
  { id: 'providers', label: 'AI Providers', icon: <Bot size={14} /> },
  { id: 'mcp', label: 'MCP Servers', icon: <Server size={14} /> },
  { id: 'access', label: 'Write access', icon: <ShieldCheck size={14} /> },
  { id: 'limits', label: 'Limits', icon: <Gauge size={14} /> },
  { id: 'about', label: 'About', icon: <Info size={14} /> },
];

/** App settings, opened to a section from anywhere through the store. */
export function SettingsDialog() {
  const section = useApp((s) => s.settingsSection);
  const openSettings = useApp((s) => s.openSettings);
  const closeSettings = useApp((s) => s.closeSettings);

  return (
    <Modal open={section !== null} onOpenChange={(open) => !open && closeSettings()} title="Settings" width={920}>
      <div className="-mx-5 -mb-5 flex h-[min(640px,72vh)] border-t border-line">
        <nav className="w-48 shrink-0 border-r border-line bg-canvas p-2" aria-label="Settings sections">
          {SECTIONS.map((item) => {
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => openSettings(item.id)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative mb-px flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-nav transition-colors duration-fast',
                  active
                    ? 'bg-surface font-medium text-content-strong shadow-[0_0_0_1px_hsl(var(--line)),0_1px_2px_rgb(15_23_42/0.04)]'
                    : 'text-content-muted hover:bg-subtle hover:text-content-strong',
                )}
              >
                {active ? (
                  <span aria-hidden className="absolute bottom-[7px] left-0 top-[7px] w-[2px] rounded-full bg-primary" />
                ) : null}
                <span className={active ? 'text-primary-ink' : 'text-content-faint'}>{item.icon}</span>
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          {section === 'profile' ? <ProfilePane /> : null}
          {section === 'general' ? <GeneralPane /> : null}
          {section === 'providers' ? <ProvidersPane /> : null}
          {section === 'mcp' ? <McpServersPane /> : null}
          {section === 'access' ? <AccessPane /> : null}
          {section === 'limits' ? <LimitsPane /> : null}
          {section === 'about' ? <AboutPane /> : null}
        </div>
      </div>
    </Modal>
  );
}

export function PaneHeader({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-title font-semibold text-content-strong">{title}</h2>
        <p className="mt-1 max-w-lg text-2xs leading-relaxed text-content-muted">{detail}</p>
      </div>
      {action}
    </div>
  );
}

function useSettingsDraft() {
  const settings = useApp((s) => s.settings);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  useEffect(() => setDraft(settings), [settings]);

  const save = async (patch: Partial<AppSettings>) => {
    if (!draft) return;
    setDraft({ ...draft, ...patch });
    await invoke('settings:update', patch);
    await refreshSettings();
  };
  return { draft, setDraft, save };
}

function GeneralPane() {
  const { draft, setDraft, save } = useSettingsDraft();
  if (!draft) return null;
  return (
    <div className="space-y-4">
      <PaneHeader title="General" detail="The workspace's name, where new agents work by default, and notifications. Your name and picture are under Profile." />

      <Field label="Workspace name" hint="Shown at the top of the sidebar.">
        <Input
          value={draft.workspaceName ?? ''}
          maxLength={64}
          placeholder={SHIP.appName}
          onChange={(e) => setDraft({ ...draft, workspaceName: e.target.value })}
          // Cleared means the default name, which the settings schema requires to be non-empty.
          onBlur={() => void save({ workspaceName: (draft.workspaceName ?? '').trim() || SHIP.appName })}
        />
      </Field>

      <Field label="Default working directory">
        <div className="flex gap-2">
          <Input
            value={draft.defaultWorkspaceDirectory}
            onChange={(e) => setDraft({ ...draft, defaultWorkspaceDirectory: e.target.value })}
            onBlur={() => void save({ defaultWorkspaceDirectory: draft.defaultWorkspaceDirectory })}
            className="font-mono text-xs"
          />
          <Button
            variant="surface"
            className="shrink-0"
            onClick={async () => {
              const result = await invoke('workspace:pickDirectory');
              if (result.path) await save({ defaultWorkspaceDirectory: result.path });
            }}
          >
            <FolderOpen size={14} />
            Browse
          </Button>
        </div>
      </Field>

      <Toggle
        label="Notify when an agent replies"
        detail="Shows a toast for every completed agent turn."
        checked={draft.notifyOnAgentReply}
        onChange={(v) => void save({ notifyOnAgentReply: v })}
      />
      <Toggle
        label="Notify when a limit stops a chain"
        checked={draft.notifyOnLimitReached}
        onChange={(v) => void save({ notifyOnLimitReached: v })}
      />
      <Toggle
        label="Developer mode"
        detail="Keeps raw runtime events visible for debugging."
        checked={draft.developerMode}
        onChange={(v) => void save({ developerMode: v })}
      />
    </div>
  );
}

function LimitsPane() {
  const { draft, save } = useSettingsDraft();
  const costs = useApp((s) => s.costs);
  if (!draft) return null;
  const saveLimit = <K extends keyof ExecutionLimits>(key: K, value: ExecutionLimits[K]) =>
    save({ limits: { ...draft.limits, [key]: value } });

  return (
    <div className="space-y-4">
      <PaneHeader
        title="Limits"
        detail="The safety rails that stop agents talking to each other forever. They apply to every agent, whatever it runs on."
      />
      <Toggle
        label="Let agents talk to each other"
        detail="Master switch. When off, an agent's send_message still posts to the conversation but never wakes another agent."
        checked={draft.limits.autonomousCommunicationEnabled}
        onChange={(v) => void saveLimit('autonomousCommunicationEnabled', v)}
      />

      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Max agent-to-agent hops"
          hint="Per message you send."
          value={draft.limits.maxAgentToAgentTurns}
          min={0}
          max={100}
          onChange={(v) => void saveLimit('maxAgentToAgentTurns', v)}
        />
        <NumberField
          label="Max runs without your input"
          hint="Per agent, before human input is required."
          value={draft.limits.maxConsecutiveAutoActivations}
          min={0}
          max={50}
          onChange={(v) => void saveLimit('maxConsecutiveAutoActivations', v)}
        />
        <NumberField
          label="Max agents working at once"
          hint="Across all agents."
          value={draft.limits.maxConcurrentExecutions}
          min={1}
          max={16}
          onChange={(v) => void saveLimit('maxConcurrentExecutions', v)}
        />
        <NumberField
          label="Max queued messages"
          hint="Per agent."
          value={draft.limits.maxPendingMessagesPerAgent}
          min={1}
          max={200}
          onChange={(v) => void saveLimit('maxPendingMessagesPerAgent', v)}
        />
        <NumberField
          label="Max task duration (minutes)"
          value={Math.round(draft.limits.maxTaskDurationMs / 60000)}
          min={1}
          max={360}
          onChange={(v) => void saveLimit('maxTaskDurationMs', v * 60000)}
        />
        <NumberField
          label="Max spend per chain (USD)"
          hint="0 disables the check. Only Claude Code and Codex report spend."
          value={draft.limits.maxChainCostUsd}
          min={0}
          max={1000}
          step={0.5}
          onChange={(v) => void saveLimit('maxChainCostUsd', v)}
        />
      </div>

      <p className="rounded-lg bg-subtle px-3 py-2.5 text-2xs leading-relaxed text-content-muted">
        Spend figures are estimates at API list prices, not a bill. Agents on your own providers report tokens but no price, so they never count toward the spend ceilings — the turn and hop limits above still apply to them. Recorded so far: {formatUsd(costs?.totalUsd ?? 0)}.
      </p>
    </div>
  );
}

function Toggle({ label, detail, checked, onChange }: { label: string; detail?: string; checked: boolean; onChange(value: boolean): void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-line bg-surface p-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-content">{label}</p>
        {detail ? <p className="mt-0.5 text-2xs leading-relaxed text-content-muted">{detail}</p> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={label} />
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(value: number): void;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (!Number.isNaN(next) && next >= min && next <= max) onChange(next);
        }}
      />
    </Field>
  );
}
