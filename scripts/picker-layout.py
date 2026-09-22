"""One-off: tighten the portrait picker so faces read as faces.

Was: 6 wide, each cell ~90px, with a 40px image floating in the middle and the
whole grid pushing the dialog past the fold. Now: denser grid, portraits fill
their cell, and the roster scrolls instead of growing the modal.
"""

import io

PATH = 'src/renderer/src/components/agents/AgentWizard.tsx'

OLD = """            {portraits.length ? (
              <div className="grid grid-cols-6 gap-1.5">
                <button
                  onClick={() => setAvatar('')}
                  title="Initials"
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-md border text-2xs transition-colors',
                    avatar === ''
                      ? 'border-primary/60 bg-primary/15 text-content'
                      : 'border-line text-content-faint hover:bg-surface-raised',
                  )}
                >
                  Aa
                </button>
                {portraits.map((portrait) => (
                  <button
                    key={portrait.id}
                    onClick={() => setAvatar(portrait.id)}
                    title={`${portrait.name} - ${portrait.role}`}
                    className={cn(
                      'aspect-square overflow-hidden rounded-md border transition-all',
                      avatar === portrait.id
                        ? 'border-primary scale-[1.04] shadow-[0_0_0_2px_hsl(var(--primary)/0.35)]'
                        : 'border-line opacity-80 hover:opacity-100',
                    )}
                  >
                    <Avatar name={portrait.name} color={color} emoji={portrait.id} size={40} className="h-full w-full" />
                  </button>
                ))}
              </div>
            ) : ("""

NEW = """            {portraits.length ? (
              <div className="grid max-h-[188px] grid-cols-10 gap-1.5 overflow-y-auto pr-1">
                <button
                  onClick={() => setAvatar('')}
                  title="Initials instead of a portrait"
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-md border text-2xs transition-colors',
                    avatar === ''
                      ? 'border-primary bg-primary/15 text-content'
                      : 'border-line text-content-faint hover:bg-surface-raised',
                  )}
                >
                  Aa
                </button>
                {portraits.map((portrait) => (
                  <button
                    key={portrait.id}
                    onClick={() => setAvatar(portrait.id)}
                    title={`${portrait.name} - ${portrait.role}`}
                    className={cn(
                      'aspect-square overflow-hidden rounded-md ring-offset-2 ring-offset-surface transition-all',
                      avatar === portrait.id
                        ? 'ring-2 ring-primary'
                        : 'opacity-70 hover:opacity-100',
                    )}
                  >
                    <Avatar name={portrait.name} emoji={portrait.id} fill className="rounded-md" />
                  </button>
                ))}
              </div>
            ) : ("""

text = io.open(PATH, encoding='utf-8').read()
assert OLD in text, 'portrait grid not found'
text = text.replace(OLD, NEW)

# Name the chosen face, so the grid does not have to carry every label.
text = text.replace(
    """          <Field
            label="Portrait"
            hint={
              portraits.length
                ? 'Pick a face for this crew member.'
                : 'No portraits installed yet. Initials are used until artwork is added to src/renderer/src/assets/crew.'
            }
          >""",
    """          <Field
            label="Portrait"
            hint={
              portraits.length
                ? (portraits.find((p) => p.id === avatar)?.name ?? 'Initials') +
                  (portraits.find((p) => p.id === avatar)
                    ? ` - suits ${portraits.find((p) => p.id === avatar)?.role}`
                    : '')
                : 'No portraits installed. Run "npm run crew:slice <sheet.png>" to add them.'
            }
          >""",
)

io.open(PATH, 'w', encoding='utf-8').write(text)
print('picker: denser grid, portraits fill their cells')
