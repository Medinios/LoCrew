"""Makes the message styles direction-agnostic.

Physical properties (`padding-left`, `border-left`) are wrong the moment a
message reads right-to-left: the bullet indent and the quote bar end up on the
wrong side. The logical equivalents (`padding-inline-start`, `border-inline-
start`) follow the element's own direction, so one rule serves both.

Code is the exception and is pinned to LTR, because source code reads
left-to-right no matter what language surrounds it.
"""

import io

PATH = 'src/renderer/src/styles/globals.css'

PAIRS = [
    # Lists: indent follows the reading direction.
    ('.prose-message ul {\n    @apply list-disc space-y-1 pl-5 marker:text-content-faint;\n  }',
     '.prose-message ul {\n    @apply list-disc space-y-1 ps-5 marker:text-content-faint;\n  }'),
    ('.prose-message ol {\n    @apply list-decimal space-y-1 pl-5 marker:text-content-faint;\n  }',
     '.prose-message ol {\n    @apply list-decimal space-y-1 ps-5 marker:text-content-faint;\n  }'),
    # Quote bar sits on the side the text starts from.
    ('.prose-message blockquote {\n    @apply border-l-2 border-primary/40 pl-3 text-content-muted;\n  }',
     '.prose-message blockquote {\n    @apply border-s-2 border-primary/40 ps-3 text-content-muted;\n  }'),
    # Table cells align to the start edge, not always to the left.
    ('.prose-message th,\n  .prose-message td {\n    @apply border border-line px-2 py-1 text-left;\n  }',
     '.prose-message th,\n  .prose-message td {\n    @apply border border-line px-2 py-1 text-start;\n  }'),
]

EXTRA = """
  /*
   * Code never flips. A fenced block or an inline span inside a Hebrew or
   * Arabic message still reads left-to-right, and `unicode-bidi: isolate`
   * stops it from reordering the text around it.
   */
  .prose-message pre,
  .prose-message code {
    direction: ltr;
    text-align: left;
    unicode-bidi: isolate;
  }

  /*
   * Anything that interpolates a name into a sentence -- a channel title, a
   * mention, a task row -- isolates it, so an RTL name cannot drag the
   * surrounding LTR chrome around with it.
   */
  .bidi-isolate {
    unicode-bidi: isolate;
  }
"""

text = io.open(PATH, encoding='utf-8').read()
for old, new in PAIRS:
    assert old in text, f'not found: {old[:60]}'
    text = text.replace(old, new)

marker = '  .prose-message pre code {\n    @apply bg-transparent p-0 text-content;\n  }\n'
assert marker in text, 'pre code rule not found'
text = text.replace(marker, marker + EXTRA)

io.open(PATH, 'w', encoding='utf-8').write(text)
print('globals.css: logical properties + code isolation')
