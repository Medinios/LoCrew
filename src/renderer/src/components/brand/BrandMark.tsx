import { cn } from '@/lib/utils';

/**
 * The LoCrew mark: three connected nodes that form an "L" -- a small crew.
 * Two teal nodes and one lavender node -- you and your agents on one team --
 * joined by the strokes of the letter, the lavender foot being the handoff to
 * an agent. Built on a 24px grid so it stays crisp at its smallest size.
 *
 * `mono` draws everything in the current text colour, for single-colour use.
 * The same geometry is in resources/icon.svg (the application icon).
 */
export function BrandMark({
  size = 24,
  mono = false,
  className,
}: {
  size?: number;
  mono?: boolean;
  className?: string;
}) {
  const teal = mono ? 'currentColor' : 'hsl(var(--primary))';
  const lavender = mono ? 'currentColor' : 'hsl(var(--ai))';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <path d="M7.1 4.6v14.8" stroke={teal} strokeWidth="2.1" strokeLinecap="round" opacity={mono ? 1 : 0.62} />
      <path d="M7.1 19.4h11" stroke={lavender} strokeWidth="2.1" strokeLinecap="round" opacity={mono ? 1 : 0.8} />
      <circle cx="7.1" cy="4.6" r="2.7" fill={teal} />
      <circle cx="7.1" cy="19.4" r="2.7" fill={teal} />
      <circle cx="18.1" cy="19.4" r="2.7" fill={lavender} />
    </svg>
  );
}
