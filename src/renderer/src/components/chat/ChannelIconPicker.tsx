import { Hash } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** Icons that say what a channel is for at a glance. */
const CHANNEL_ICONS = [
  '💬', '📣', '🛠️', '🚀', '🏛️', '🧪', '🐛', '📦',
  '🎨', '📊', '🔒', '🧠', '📝', '🔍', '💡', '⚙️',
  '🌐', '📱', '🗂️', '🤝', '🎯', '📈', '🧰', '⚡',
];

/**
 * A channel's icon: an emoji, or the plain hash when there is none. Shown
 * as a square button beside the name field, opening a small grid.
 */
export function ChannelIconPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange(icon: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Close the grid, not the dialog around it.
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const pick = (icon: string | null) => {
    onChange(icon);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={value ? `Channel icon ${value}. Change icon` : 'Choose a channel icon'}
        aria-expanded={open}
        title="Channel icon"
        className={cn(
          'flex h-8 w-9 items-center justify-center rounded-md border bg-surface text-content-muted transition-[border-color,box-shadow] duration-fast',
          open ? 'border-primary shadow-focus' : 'border-line hover:border-line-strong',
        )}
      >
        {value ? (
          <span className="font-emoji text-[15px] leading-none">{value}</span>
        ) : (
          <Hash size={14} strokeWidth={2.2} />
        )}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Channel icon"
          className="absolute left-0 top-full z-dropdown mt-1.5 w-[284px] animate-pop-in rounded-lg border border-line bg-surface p-1.5 shadow-popover"
        >
          <div className="grid grid-cols-8 gap-0.5">
            {CHANNEL_ICONS.map((icon) => (
              <button
                key={icon}
                type="button"
                onClick={() => pick(icon)}
                aria-label={icon}
                aria-pressed={value === icon}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-md font-emoji text-[16px] transition-colors duration-fast hover:bg-subtle',
                  value === icon && 'bg-primary/[0.12] hover:bg-primary/[0.16]',
                )}
              >
                {icon}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => pick(null)}
            className={cn(
              'mt-1 flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-content-muted transition-colors duration-fast hover:bg-subtle hover:text-content-strong',
              !value && 'text-primary-ink',
            )}
          >
            <Hash size={13} strokeWidth={2.2} />
            No icon
          </button>
        </div>
      ) : null}
    </div>
  );
}
