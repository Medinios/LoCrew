import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/** A short, curated set: the reactions people actually type in a work chat. */
const EMOJI = [
  '👍', '👎', '👀', '🙏', '👏', '🙌', '💪', '🤝',
  '✅', '❌', '⚠️', '🚀', '🎉', '🔥', '✨', '💡',
  '🐛', '🔧', '🧪', '📦', '📝', '📌', '🔍', '🧠',
  '😀', '😅', '😂', '🙂', '😉', '🤔', '😬', '😎',
  '❤️', '💯', '⏳', '⭐', '🏴‍☠️', '⚓', '🦜', '💬',
];

/**
 * A small emoji grid. It opens above its trigger in the composer, or below
 * and right-aligned when picking a reaction from a message's hover toolbar.
 */
export function EmojiPicker({
  onPick,
  onClose,
  label = 'Insert emoji',
  placement = 'above',
}: {
  onPick(emoji: string): void;
  onClose(): void;
  label?: string;
  placement?: 'above' | 'below-end';
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Deferred so the click that opened the picker does not close it again.
    const timer = setTimeout(() => window.addEventListener('mousedown', onDown));
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={cn(
        'absolute z-dropdown w-[284px] animate-pop-in rounded-lg border border-line bg-surface p-1.5 shadow-popover',
        placement === 'above' ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-1.5',
      )}
    >
      <div className="grid grid-cols-8 gap-0.5">
        {EMOJI.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onMouseDown={(event) => event.preventDefault()} // keep the textarea caret
            onClick={() => onPick(emoji)}
            aria-label={emoji}
            className="flex h-8 w-8 items-center justify-center rounded-md font-emoji text-[17px] transition-colors duration-fast hover:bg-subtle"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
