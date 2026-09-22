import * as Tooltip from '@radix-ui/react-tooltip';
import { AlertTriangle, Info, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatView } from '@/components/chat/ChatView';
import { TitleBar } from '@/components/layout/TitleBar';
import { WorkspaceSidebar } from '@/components/sidebar/WorkspaceSidebar';
import { AgentEditor } from '@/components/agents/AgentEditor';
import { AgentWizard } from '@/components/agents/AgentWizard';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { NewChannelDialog } from '@/components/chat/NewChannelDialog';
import { AgentsView } from '@/components/views/AgentsView';
import { InboxView } from '@/components/views/InboxView';
import { WelcomeView } from '@/components/views/WelcomeView';
import { BrandMark } from '@/components/brand/BrandMark';
import { useApp } from '@/stores/app';
import { SHIP } from '@/lib/lexicon';
import { cn } from '@/lib/utils';

export default function App() {
  const bootstrap = useApp((s) => s.bootstrap);
  const applyEvent = useApp((s) => s.applyEvent);
  const ready = useApp((s) => s.ready);
  const view = useApp((s) => s.view);
  const activeConversationId = useApp((s) => s.activeConversationId);
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed);
  const setSidebarWidth = useApp((s) => s.setSidebarWidth);
  const goBack = useApp((s) => s.goBack);
  const goForward = useApp((s) => s.goForward);

  const wizardOpen = useApp((s) => s.wizardOpen);
  const setWizardOpen = useApp((s) => s.setWizardOpen);
  const openSettings = useApp((s) => s.openSettings);
  const [channelDialogOpen, setChannelDialogOpen] = useState(false);
  const editingAgentId = useApp((s) => s.editingAgentId);
  const setEditingAgent = useApp((s) => s.setEditingAgent);
  const [bootError, setBootError] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const unsubscribe = window.api.onEvent(applyEvent);
    bootstrap().catch((error: unknown) =>
      setBootError(error instanceof Error ? error.message : String(error)),
    );
    return unsubscribe;
  }, [bootstrap, applyEvent]);

  // Back/forward the way a browser does it: Alt+arrows and the mouse's side buttons.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowLeft') goBack();
      else if (event.key === 'ArrowRight') goForward();
    };
    const onMouse = (event: MouseEvent) => {
      if (event.button === 3) goBack();
      else if (event.button === 4) goForward();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, [goBack, goForward]);

  const dragging = useRef(false);
  const onDragStart = useCallback(() => {
    dragging.current = true;
    setResizing(true);
    const onMove = (event: MouseEvent) => {
      if (dragging.current) setSidebarWidth(event.clientX);
    };
    const onUp = () => {
      dragging.current = false;
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [setSidebarWidth]);

  if (bootError) {
    return (
      <div className="app-backdrop relative flex h-full items-center justify-center p-8">
        <div className="app-drag absolute inset-x-0 top-0 h-[var(--titlebar-h)]" />
        <div className="max-w-md rounded-xl border border-line bg-surface p-5 shadow-dialog">
          <h1 className="flex items-center gap-2 text-title font-semibold text-content-strong">
            <BrandMark size={18} />
            {SHIP.appName} could not start
          </h1>
          <p className="selectable mt-2 whitespace-pre-wrap text-xs leading-relaxed text-content-muted">
            {bootError}
          </p>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="app-backdrop relative flex h-full items-center justify-center">
        <div className="app-drag absolute inset-x-0 top-0 h-[var(--titlebar-h)]" />
        <div className="flex flex-col items-center text-center">
          <BrandMark size={36} className="animate-pulse-soft" />
          <p className="mt-4 text-[17px] font-semibold tracking-[-0.01em] text-ink">{SHIP.appName}</p>
          <p className="mt-0.5 text-xs text-ink-muted">{SHIP.tagline}</p>
        </div>
      </div>
    );
  }

  const main =
    view === 'inbox' ? (
      <InboxView />
    ) : view === 'agents' ? (
      <AgentsView onAddAgent={() => setWizardOpen(true)} />
    ) : activeConversationId ? (
      <ChatView conversationId={activeConversationId} />
    ) : (
      <WelcomeView
        onAddAgent={() => setWizardOpen(true)}
        onNewChannel={() => setChannelDialogOpen(true)}
      />
    );

  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={150}>
    <div className="app-backdrop relative flex h-full overflow-hidden">
      <TitleBar />

      <div
        style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        className={cn(
          'relative shrink-0 overflow-hidden',
          !resizing && 'transition-[width] duration-base ease-out',
        )}
      >
        {/* Fixed inner width, so collapsing slides the column away instead of reflowing it. */}
        <div style={{ width: sidebarWidth }} className="h-full">
          <WorkspaceSidebar
            onAddAgent={() => setWizardOpen(true)}
            onNewChannel={() => setChannelDialogOpen(true)}
            onOpenSettings={() => openSettings('profile')}
          />
        </div>
        <div
          onMouseDown={onDragStart}
          className="absolute right-0 top-[var(--titlebar-h)] z-10 h-[calc(100%-var(--titlebar-h))] w-[5px] cursor-col-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
        />
      </div>

      <main
        className={cn(
          'relative z-[1] mb-2 mr-2 mt-[var(--titlebar-h)] flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-canvas shadow-panel',
          !resizing && 'transition-[margin] duration-base ease-out',
          sidebarCollapsed ? 'ml-2' : 'ml-0',
        )}
      >
        {main}
      </main>

      <AgentWizard open={wizardOpen} onOpenChange={setWizardOpen} />
      <AgentEditor
        agentId={editingAgentId}
        onOpenChange={(open) => !open && setEditingAgent(null)}
      />
      <SettingsDialog />
      <NewChannelDialog open={channelDialogOpen} onOpenChange={setChannelDialogOpen} />
      <ToastStack />
    </div>
    </Tooltip.Provider>
  );
}

function ToastStack() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);

  if (!toasts.length) return null;

  const icons = {
    info: <Info size={14} className="text-primary-ink" />,
    warning: <AlertTriangle size={14} className="text-warning" />,
    error: <XCircle size={14} className="text-danger" />,
  } as const;

  return (
    <div className="pointer-events-none fixed right-5 top-[calc(var(--titlebar-h)+60px)] z-toast flex w-[340px] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto animate-pop-in rounded-lg border border-line bg-surface p-3 shadow-popover"
        >
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5">{icons[toast.level]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-content-strong">{toast.title}</p>
              <p className="selectable mt-0.5 line-clamp-3 text-2xs leading-relaxed text-content-muted">
                {toast.detail}
              </p>
            </div>
            <button
              onClick={() => dismiss(toast.id)}
              className="rounded-sm p-0.5 text-content-faint transition-colors hover:bg-subtle hover:text-content"
              aria-label="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
