import { ChevronLeft, ChevronRight, PanelLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useApp } from '@/stores/app';

/**
 * The strip across the top of the window.
 *
 * The window has no native title bar, so this is what the user drags. On
 * macOS the traffic lights sit at its left end, so the controls start after
 * them; on Windows and Linux the native caption buttons are overlaid on its
 * right end by Electron (see `titleBarOverlay` in main).
 */
export function TitleBar() {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const goBack = useApp((s) => s.goBack);
  const goForward = useApp((s) => s.goForward);
  const canGoBack = useApp((s) => s.historyIndex > 0);
  const canGoForward = useApp((s) => s.historyIndex < s.history.length - 1);
  const mac = window.api.platform === 'darwin';

  return (
    <>
      <div className="app-drag absolute inset-x-0 top-0 z-0 h-[var(--titlebar-h)]" />
      <div
        className={cn(
          'absolute top-0 z-20 flex h-[var(--titlebar-h)] items-center gap-0.5',
          mac ? 'left-[76px]' : 'left-[10px]',
        )}
      >
        <StripButton
          label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={toggleSidebar}
          className="mr-1.5"
        >
          <PanelLeft size={15} strokeWidth={1.8} />
        </StripButton>
        <StripButton label="Back" onClick={goBack} disabled={!canGoBack}>
          <ChevronLeft size={17} strokeWidth={1.9} />
        </StripButton>
        <StripButton label="Forward" onClick={goForward} disabled={!canGoForward}>
          <ChevronRight size={17} strokeWidth={1.9} />
        </StripButton>
      </div>
    </>
  );
}

function StripButton({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'app-no-drag flex h-[26px] w-[26px] items-center justify-center rounded-md text-ink-muted transition-colors duration-fast',
        'hover:bg-shell-hover hover:text-ink disabled:text-ink-faint/50 disabled:hover:bg-transparent',
        className,
      )}
    >
      {children}
    </button>
  );
}
