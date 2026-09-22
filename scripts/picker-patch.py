"""One-off: replace the wizard's emoji row with a crew portrait picker."""

import io

PATH = 'src/renderer/src/components/agents/AgentWizard.tsx'

OLD = """          <Field label="Badge">
            <div className="flex flex-wrap gap-1.5">
              {EMOJI.map((e) => (
                <button
                  key={e || 'initials'}
                  onClick={() => setAvatar(e)}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-md border text-sm transition-colors',
                    avatar === e ? 'border-primary/50 bg-primary/15' : 'border-line hover:bg-surface-raised',
                  )}
                >
                  {e || <span className="text-2xs text-content-faint">Aa</span>}
                </button>
              ))}
            </div>
          </Field>"""

NEW = """          <Field
            label="Portrait"
            hint={
              portraits.length
                ? 'Pick a face for this crew member.'
                : 'No portraits installed yet. Initials are used until artwork is added to src/renderer/src/assets/crew.'
            }
          >
            {portraits.length ? (
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
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {EMOJI.map((e) => (
                  <button
                    key={e || 'initials'}
                    onClick={() => setAvatar(e)}
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded-md border text-sm transition-colors',
                      avatar === e
                        ? 'border-primary/50 bg-primary/15'
                        : 'border-line hover:bg-surface-raised',
                    )}
                  >
                    {e || <span className="text-2xs text-content-faint">Aa</span>}
                  </button>
                ))}
              </div>
            )}
          </Field>"""

text = io.open(PATH, encoding='utf-8').read()
assert OLD in text, 'Badge field not found'
text = text.replace(OLD, NEW)

text = text.replace(
    "import { HOLD_ACCESS } from '@/lib/lexicon';",
    "import { availablePortraits, defaultPortraitFor } from '@/lib/crew';\n"
    "import { HOLD_ACCESS } from '@/lib/lexicon';",
)

# Portraits are resolved once; the list cannot change at runtime.
text = text.replace(
    "  const [step, setStep] = useState(0);",
    "  const portraits = availablePortraits();\n\n  const [step, setStep] = useState(0);",
)

# Opening the wizard should land on a sensible face, not a blank plate.
text = text.replace(
    "    setAvatar('');\n",
    "    setAvatar(defaultPortraitFor('claude-code') ?? '');\n",
)
text = text.replace(
    "              onClick={() => {\n                setRuntimeType(item.id);\n                setDetection(null);\n              }}",
    "              onClick={() => {\n                setRuntimeType(item.id);\n                setDetection(null);\n                const suggested = defaultPortraitFor(item.id);\n                if (suggested) setAvatar(suggested);\n              }}",
)

io.open(PATH, 'w', encoding='utf-8').write(text)
print('wizard: portrait picker wired')
