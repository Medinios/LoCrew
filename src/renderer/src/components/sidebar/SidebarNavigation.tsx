import { Bot, Inbox, Search, X } from 'lucide-react';
import { forwardRef, useEffect } from 'react';
import { SHIP } from '@/lib/lexicon';
import { SidebarRow } from '@/components/sidebar/SidebarParts';
import { useApp } from '@/stores/app';

/**
 * The compact search field. It filters the channel and agent lists in place;
 * Ctrl/Cmd+K focuses it from anywhere, Enter opens the first match.
 */
export const SidebarSearch = forwardRef<
  HTMLInputElement,
  { value: string; onChange(value: string): void; onSubmit(): void }
>(function SidebarSearch({ value, onChange, onSubmit }, ref) {
  const mac = window.api.platform === 'darwin';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        const input = (ref as React.RefObject<HTMLInputElement>).current;
        input?.focus();
        input?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ref]);

  return (
    <div className="group/search relative">
      <Search
        size={14}
        strokeWidth={2}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint transition-colors group-focus-within/search:text-primary"
      />
      <input
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onChange('');
            event.currentTarget.blur();
          } else if (event.key === 'Enter') {
            onSubmit();
          }
        }}
        placeholder={SHIP.nav.search}
        spellCheck={false}
        className="h-8 w-full rounded-md border border-shell-line/70 bg-shell-raised/60 pl-8 pr-14 text-nav text-ink transition-[border-color,background-color,box-shadow] duration-fast placeholder:text-ink-faint hover:border-shell-line hover:bg-shell-raised focus:border-primary/60 focus:bg-shell-raised focus:shadow-[0_0_0_3px_hsl(var(--primary)/0.12)] focus:outline-none"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-ink-muted hover:bg-shell-hover hover:text-ink"
        >
          <X size={12} />
        </button>
      ) : (
        <kbd className="kbd pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 border-shell-line bg-shell text-ink-faint">
          {mac ? '⌘K' : 'Ctrl K'}
        </kbd>
      )}
    </div>
  );
});

/** Inbox and Agents: the two destinations that are not conversations. */
export function SidebarNavigation() {
  const view = useApp((s) => s.view);
  const openView = useApp((s) => s.openView);
  const unreadTotal = useApp((s) => Object.values(s.unread).reduce((sum, n) => sum + n, 0));

  return (
    <div>
      <SidebarRow
        active={view === 'inbox'}
        onClick={() => openView('inbox')}
        icon={<Inbox size={15} strokeWidth={1.8} />}
        label={SHIP.nav.inbox}
        trailing={
          unreadTotal > 0 ? (
            <span aria-hidden className="mr-0.5 text-2xs font-medium tabular-nums text-ink-muted">
              {unreadTotal}
            </span>
          ) : null
        }
      />
      <SidebarRow
        active={view === 'agents'}
        onClick={() => openView('agents')}
        icon={<Bot size={15} strokeWidth={1.8} />}
        label={SHIP.nav.agents}
      />
    </div>
  );
}
