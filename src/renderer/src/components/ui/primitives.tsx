import * as Dialog from '@radix-ui/react-dialog';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { X } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import type { AgentStatus, ExecutionState } from '@shared/types';
export { EXECUTION_LABEL } from '@/lib/lexicon';
import { portraitUrl } from '@/lib/crew';
import { cn, initialsOf, readableTextOn } from '@/lib/utils';

/* --------------------------------------------------------------- Button --- */

type ButtonVariant = 'primary' | 'ghost' | 'surface' | 'danger';
type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANTS: Record<ButtonVariant, string> = {
  // Aurora teal with dark text: the one action colour in the product.
  primary:
    'bg-primary text-primary-foreground shadow-[inset_0_-1px_0_rgb(0_0_0/0.08)] hover:bg-primary-hover disabled:bg-subtle disabled:text-content-faint disabled:shadow-none',
  surface:
    'border border-line bg-surface text-content shadow-[0_1px_1px_rgb(15_23_42/0.03)] hover:border-line-strong hover:bg-subtle',
  ghost: 'text-content-muted hover:bg-subtle hover:text-content-strong',
  danger: 'bg-danger text-white hover:bg-danger/90',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3.5 text-nav gap-2 rounded-md',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'surface', size = 'md', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex select-none items-center justify-center font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-fast ease-out',
        'active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
});

/** A compact square icon button, for headers and toolbars on light surfaces. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }
>(function IconButton({ label, active, className, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 text-content-muted transition-colors duration-fast ease-out',
        'hover:bg-subtle hover:text-content-strong',
        active && 'bg-subtle text-content-strong shadow-[inset_0_0_0_1px_hsl(var(--line))]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

/* ---------------------------------------------------------------- Input --- */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-8 w-full rounded-md border border-line bg-surface px-3 text-nav text-content-strong transition-[border-color,box-shadow] duration-fast',
          'placeholder:text-content-faint hover:border-line-strong focus:border-primary focus:shadow-focus focus:outline-none',
          'disabled:bg-subtle disabled:opacity-70',
          className,
        )}
        {...props}
      />
    );
  },
);

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-content">{label}</span>
      {children}
      {hint ? <span className="block text-2xs text-content-faint">{hint}</span> : null}
    </label>
  );
}

/**
 * `Field`'s look for a group of buttons (swatches, avatar grids). Not a
 * `<label>`: a label forwards clicks on its caption to the first button inside
 * it, which would silently pick the first option.
 */
export function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="space-y-1.5">
      <span className="block text-xs font-medium text-content">{label}</span>
      {children}
      {hint ? <span className="block text-2xs text-content-faint">{hint}</span> : null}
    </div>
  );
}

/* --------------------------------------------------------------- Switch --- */

export function Switch({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange(value: boolean): void;
  label?: string;
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className="relative h-[18px] w-8 shrink-0 rounded-full bg-line-strong transition-colors duration-fast data-[state=checked]:bg-primary"
    >
      <SwitchPrimitive.Thumb className="block h-[14px] w-[14px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_2px_rgb(15_23_42/0.25)] transition-transform duration-base ease-out data-[state=checked]:translate-x-[16px]" />
    </SwitchPrimitive.Root>
  );
}

/* --------------------------------------------------------------- Avatar --- */

/**
 * What an agent (or person) is doing, as a dot on the avatar's corner. Every
 * value maps to something observed: see `agentPresence` in lib/activity.
 */
export type Presence = 'available' | 'thinking' | 'working' | 'waiting' | 'offline' | 'error';

const PRESENCE_COLOR: Record<Presence, string> = {
  available: 'bg-primary',
  thinking: 'bg-ai',
  working: 'bg-primary',
  waiting: 'bg-warning',
  offline: 'bg-[var(--presence-ring,hsl(var(--surface)))] shadow-[inset_0_0_0_1.5px_hsl(var(--text-faint))]',
  error: 'bg-danger',
};

export const PRESENCE_LABEL: Record<Presence, string> = {
  available: 'Available',
  thinking: 'Thinking',
  working: 'Working',
  waiting: 'Waiting for you',
  offline: 'Offline',
  error: 'Error',
};

/**
 * An agent's or person's mark.
 *
 * Four tiers, in order: a photo (`src`), a bundled portrait when `emoji`
 * names one, a literal emoji, then initials on a tinted plate. People are
 * round; agents (`agent`) are rounded squares, the one shape difference
 * between the two kinds of team member. `ring` draws the agent's accent
 * colour as a thin outline.
 */
export function Avatar({
  name,
  color,
  emoji,
  src,
  size = 28,
  fill = false,
  presence,
  agent = false,
  ring = false,
  className,
}: {
  name: string;
  color?: string;
  emoji?: string;
  /** A photo, such as the user's own. Wins over `emoji`. */
  src?: string | null;
  size?: number;
  /** Stretch to the container instead of the fixed `size`, for grid cells. */
  fill?: boolean;
  presence?: Presence;
  /** An AI agent: drawn as a rounded square rather than a circle. */
  agent?: boolean;
  /** Outline the avatar in its accent colour. */
  ring?: boolean;
  className?: string;
}) {
  const portrait = src || portraitUrl(emoji);
  // Inline dimensions would override any utility class, so fill mode omits them.
  const box = fill ? {} : { width: size, height: size };
  const radius = agent ? { borderRadius: fill ? '28%' : Math.round(size * 0.28) } : undefined;
  const outline =
    ring && color ? { outline: `1.5px solid ${color}`, outlineOffset: size >= 28 ? 2 : 1.5 } : undefined;

  const face = portrait ? (
    <img
      src={portrait}
      alt=""
      aria-hidden
      draggable={false}
      className={cn('object-cover', !agent && 'rounded-full', fill ? 'h-full w-full' : 'shrink-0', className)}
      style={{ ...box, ...radius, ...outline }}
    />
  ) : (
    <span
      className={cn(
        'inline-flex select-none items-center justify-center font-semibold',
        !agent && 'rounded-full',
        fill ? 'h-full w-full' : 'shrink-0',
        className,
      )}
      style={{
        ...box,
        ...radius,
        ...outline,
        fontSize: emoji ? size * 0.56 : Math.max(9, size * 0.4),
        letterSpacing: '0.01em',
        background: emoji ? 'hsl(var(--subtle))' : (color ?? '#64748B'),
        color: emoji ? undefined : readableTextOn(color ?? '#64748B'),
      }}
      aria-hidden
    >
      {emoji || initialsOf(name)}
    </span>
  );

  if (!presence) return face;

  const dot = Math.max(7, Math.round(size * 0.3));
  return (
    <span className="relative inline-flex shrink-0" style={box}>
      {face}
      <span
        className="absolute flex items-center justify-center"
        style={{ width: dot, height: dot, right: agent ? -2 : -1, bottom: agent ? -2 : -1 }}
        // Decorative for assistive tech: wherever a dot appears, the status is
        // also given in text, so a row reads "Codex", not "Working Codex".
        aria-hidden
        title={PRESENCE_LABEL[presence]}
      >
        {presence === 'working' ? (
          <span className="absolute inset-0 animate-pulse-ring rounded-full bg-primary" aria-hidden />
        ) : null}
        <span
          className={cn(
            'relative h-full w-full rounded-full ring-2 ring-[var(--presence-ring,hsl(var(--surface)))]',
            PRESENCE_COLOR[presence],
          )}
        />
      </span>
    </span>
  );
}

/** Maps an agent's runtime status and whether it is running to a presence. */
export function presenceOf(status: AgentStatus, busy: boolean): Presence {
  if (busy) return 'working';
  if (status === 'error') return 'error';
  if (status === 'offline') return 'offline';
  return 'available';
}

/* ------------------------------------------------------------ StatusDot --- */

const STATE_COLOR: Record<ExecutionState, string> = {
  idle: 'bg-content-faint',
  queued: 'bg-content-faint',
  thinking: 'bg-primary',
  working: 'bg-primary',
  waiting_for_agent: 'bg-ai',
  waiting_for_human: 'bg-warning',
  completed: 'bg-success',
  failed: 'bg-danger',
  cancelled: 'bg-content-faint',
};

const AGENT_STATUS_COLOR: Record<AgentStatus, string> = {
  online: 'bg-primary',
  offline: 'bg-content-faint',
  error: 'bg-danger',
  unverified: 'bg-primary/60',
};

export function StatusDot({
  status,
  state,
  className,
}: {
  status?: AgentStatus;
  state?: ExecutionState;
  className?: string;
}) {
  const busy = state !== undefined && state !== 'idle' && !isTerminal(state);
  // A finished run keeps its outcome colour; an idle agent shows its status.
  const color =
    state && state !== 'idle'
      ? STATE_COLOR[state]
      : status
        ? AGENT_STATUS_COLOR[status]
        : 'bg-content-faint';

  return (
    <span className={cn('relative inline-flex h-[7px] w-[7px] shrink-0', className)}>
      {busy ? <span className="absolute inset-0 animate-pulse-ring rounded-full bg-primary" aria-hidden /> : null}
      <span className={cn('relative h-full w-full rounded-full', color)} />
    </span>
  );
}

export function isTerminal(state: ExecutionState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

/** Three dots breathing in sequence: someone is composing. */
export function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-[3px]', className)} aria-hidden>
      {[0, 160, 320].map((delay) => (
        <span
          key={delay}
          className="h-[4px] w-[4px] animate-typing rounded-full bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

/* ----------------------------------------------------------------- Chip --- */

export function Chip({
  children,
  tone = 'neutral',
  className,
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'primary' | 'ai' | 'success' | 'warning' | 'danger';
  className?: string;
  title?: string;
}) {
  const tones = {
    neutral: 'bg-subtle text-content-muted shadow-[inset_0_0_0_1px_hsl(var(--line))]',
    primary: 'bg-primary/[0.12] text-primary-ink',
    ai: 'bg-ai/[0.14] text-ai-ink',
    success: 'bg-success/[0.12] text-success-ink',
    warning: 'bg-warning/[0.14] text-warning-ink',
    danger: 'bg-danger/10 text-danger-ink',
  } as const;

  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-[18px] items-center gap-1 rounded-sm px-1.5 text-[10.5px] font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- Modal --- */

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 560,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  children: ReactNode;
  width?: number;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* no-drag: an open dialog must not leave the title strip dragging the window. */}
        <Dialog.Overlay className="app-no-drag fixed inset-0 z-overlay bg-shell/45 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-base" />
        <Dialog.Content
          style={{ width }}
          className={cn(
            'app-no-drag fixed left-1/2 top-1/2 z-overlay max-h-[85vh] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden outline-none',
            'rounded-xl border border-line bg-surface shadow-dialog',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=open]:duration-base',
          )}
        >
          <div className="flex items-start justify-between px-5 pb-3 pt-4">
            <div className="min-w-0">
              <Dialog.Title className="text-title font-semibold text-content-strong">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-xs leading-relaxed text-content-muted">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close" className="-mr-1.5 -mt-0.5 px-1.5">
                <X size={15} />
              </Button>
            </Dialog.Close>
          </div>
          <div className="max-h-[calc(85vh-64px)] overflow-y-auto px-5 pb-5 pt-1">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ------------------------------------------------------------- EmptyState -- */

export function EmptyState({
  icon,
  title,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-surface text-primary-ink shadow-composer">
        {icon}
      </div>
      <h2 className="text-title font-semibold text-content-strong">{title}</h2>
      <p className="mt-1.5 max-w-sm text-nav text-content-muted">{detail}</p>
      {action ? <div className="mt-5 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- Section -- */

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-4">
      <span className="text-2xs font-semibold uppercase tracking-label text-content-faint">{children}</span>
      {action}
    </div>
  );
}

/* ----------------------------------------------------------- PanelHeader -- */

/**
 * The bar across the top of the working surface: a title on the left, a few
 * compact actions on the right, a hairline underneath.
 */
export function PanelHeader({
  children,
  actions,
  className,
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'relative z-header flex h-[52px] shrink-0 items-center justify-between gap-3 border-b border-line bg-canvas pl-5 pr-4',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </header>
  );
}
