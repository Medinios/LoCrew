import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { TypingDots } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * A sidebar section: a small uppercase label, an optional action that appears
 * on hover, and its rows. Clicking the label folds it; a folded section still
 * shows the row you are on and anything unread, so nothing important hides.
 */
export function SidebarSection({
  label,
  open,
  onToggle,
  action,
  children,
}: {
  label: string;
  open: boolean;
  onToggle(): void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-5 first:mt-0">
      <div className="group/section mb-0.5 flex h-6 items-center justify-between">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-sm px-2 text-left text-2xs font-semibold uppercase tracking-label text-ink-faint transition-colors duration-fast hover:text-ink-muted"
        >
          <span className="truncate">{label}</span>
          <ChevronRight
            size={11}
            strokeWidth={2.4}
            className={cn(
              'shrink-0 opacity-0 transition-[transform,opacity] duration-base ease-out group-hover/section:opacity-100',
              open && 'rotate-90',
            )}
          />
        </button>
        {action ? (
          <div className="opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover/section:opacity-100">
            {action}
          </div>
        ) : null}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function SectionAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="mr-1 flex h-[22px] w-[22px] items-center justify-center rounded-sm text-ink-muted transition-colors duration-fast hover:bg-shell-hover hover:text-ink"
    >
      {children}
    </button>
  );
}

/**
 * One navigable row: channel, DM, or a primary destination. The selected row
 * gets a deep-slate fill, white text and a thin teal bar at its left edge --
 * recognisable at a glance without shouting.
 */
export function SidebarRow({
  active,
  unread,
  onClick,
  icon,
  label,
  trailing,
  title,
  muted,
}: {
  active?: boolean;
  unread?: boolean;
  onClick(): void;
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  title?: string;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-current={active ? 'page' : undefined}
      aria-description={unread ? 'Unread messages' : undefined}
      className={cn(
        'group/row relative mb-px flex h-[30px] w-full items-center gap-2.5 rounded-md px-2 text-left text-nav transition-colors duration-fast ease-out',
        active
          ? 'bg-shell-active font-medium text-ink'
          : unread
            ? 'font-semibold text-ink hover:bg-shell-hover'
            : muted
              ? 'text-ink-faint hover:bg-shell-hover hover:text-ink-muted'
              : 'text-ink-muted hover:bg-shell-hover hover:text-ink-soft',
      )}
    >
      {active ? (
        <span aria-hidden className="absolute bottom-[7px] left-0 top-[7px] w-[2px] rounded-full bg-primary" />
      ) : null}
      <span
        className={cn(
          'flex w-4 shrink-0 items-center justify-center transition-colors duration-fast',
          active ? 'text-primary' : unread ? 'text-ink-soft' : 'text-ink-faint group-hover/row:text-ink-muted',
        )}
      >
        {icon}
      </span>
      <span className="bidi-isolate min-w-0 flex-1 truncate">{label}</span>
      {trailing ? <span className="flex shrink-0 items-center gap-1.5">{trailing}</span> : null}
    </button>
  );
}

/** Unread, but no count worth showing: a small teal dot. */
export function UnreadDot() {
  return <span className="mr-1 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />;
}

/** A compact unread count. */
export function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      aria-hidden
      className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** An agent is composing in this conversation. */
export function WorkingIndicator() {
  return (
    <span className="mr-0.5 text-primary/80" aria-hidden>
      <TypingDots />
    </span>
  );
}
