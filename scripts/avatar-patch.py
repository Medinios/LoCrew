"""One-off: teach the Avatar primitive to render bundled crew portraits."""

import io

PATH = 'src/renderer/src/components/ui/primitives.tsx'

OLD = """export function Avatar({
  name,
  color,
  emoji,
  size = 28,
  className,
}: {
  name: string;
  color?: string;
  emoji?: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-semibold text-white/95',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: emoji ? size * 0.55 : size * 0.38,
        background: color
          ? `linear-gradient(145deg, ${color}, ${color}bb)`
          : 'linear-gradient(145deg, #C9A227, #C9A227bb)',
        boxShadow: 'inset 0 1px 0 hsl(0 0% 100% / 0.22)',
      }}
      aria-hidden
    >
      {emoji || initialsOf(name)}
    </span>
  );
}"""

NEW = """/**
 * A crew member's mark.
 *
 * Three tiers, in order: a bundled portrait when `emoji` names one, a literal
 * emoji, then initials on a tinted plate. The tiers matter because the
 * portraits are optional artwork -- the app still has to look deliberate
 * before any of it has been added.
 */
export function Avatar({
  name,
  color,
  emoji,
  size = 28,
  className,
}: {
  name: string;
  color?: string;
  emoji?: string;
  size?: number;
  className?: string;
}) {
  const portrait = portraitUrl(emoji);

  if (portrait) {
    return (
      <img
        src={portrait}
        alt=""
        aria-hidden
        draggable={false}
        className={cn('shrink-0 rounded-md object-cover', className)}
        style={{
          width: size,
          height: size,
          boxShadow: `inset 0 1px 0 hsl(0 0% 100% / 0.2), 0 0 0 1px ${color ?? '#C9A227'}55`,
        }}
      />
    );
  }

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-semibold text-white/95',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: emoji ? size * 0.55 : size * 0.38,
        background: color
          ? `linear-gradient(145deg, ${color}, ${color}bb)`
          : 'linear-gradient(145deg, #C9A227, #C9A227bb)',
        boxShadow: 'inset 0 1px 0 hsl(0 0% 100% / 0.22)',
      }}
      aria-hidden
    >
      {emoji || initialsOf(name)}
    </span>
  );
}"""

text = io.open(PATH, encoding='utf-8').read()
assert OLD in text, 'Avatar block not found'
text = text.replace(OLD, NEW)
text = text.replace(
    "import { cn, initialsOf } from '@/lib/utils';",
    "import { portraitUrl } from '@/lib/crew';\nimport { cn, initialsOf } from '@/lib/utils';",
)
io.open(PATH, 'w', encoding='utf-8').write(text)
print('Avatar now renders crew portraits')
