"""One-off: give Avatar a fill mode, so a portrait can fill its container.

Inline width/height always beat utility classes, so `className="h-full w-full"`
could never work against the inline style. A explicit `fill` prop makes the two
modes distinct instead of fighting.
"""

import io

PATH = 'src/renderer/src/components/ui/primitives.tsx'

OLD_SIG = """export function Avatar({
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

NEW_SIG = """export function Avatar({
  name,
  color,
  emoji,
  size = 28,
  fill = false,
  className,
}: {
  name: string;
  color?: string;
  emoji?: string;
  size?: number;
  /** Stretch to the container instead of the fixed `size`, for grid cells. */
  fill?: boolean;
  className?: string;
}) {
  const portrait = portraitUrl(emoji);
  // Inline dimensions would override any utility class, so fill mode omits them.
  const box = fill ? {} : { width: size, height: size };

  if (portrait) {
    return (
      <img
        src={portrait}
        alt=""
        aria-hidden
        draggable={false}
        className={cn('rounded-md object-cover', fill ? 'h-full w-full' : 'shrink-0', className)}
        style={box}
      />
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-md font-semibold text-white/95',
        fill ? 'h-full w-full' : 'shrink-0',
        className,
      )}
      style={{
        ...box,
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
assert OLD_SIG in text, 'Avatar block not found'
io.open(PATH, 'w', encoding='utf-8').write(text.replace(OLD_SIG, NEW_SIG))
print('Avatar: fill mode added')
