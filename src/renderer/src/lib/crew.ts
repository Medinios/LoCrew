/**
 * The crew roster: the portraits a crew member can wear.
 *
 * `Agent.avatar` stores one of these ids. Anything that is not an id is still
 * treated as a literal emoji, and an empty string falls back to initials, so
 * this is additive -- no migration, and agents created before portraits existed
 * keep working.
 *
 * Portrait files are optional at build time. `import.meta.glob` resolves
 * whatever is present in assets/crew and quietly yields nothing for the rest,
 * which means the app runs fine before the artwork is dropped in.
 */
export interface CrewPortrait {
  id: string;
  name: string;
  /** The role the artwork suggests. Used as a hint in the picker. */
  role: string;
}

export const CREW_PORTRAITS: CrewPortrait[] = [
  { id: 'blackbeard', name: 'Blackbeard', role: 'Claude Code' },
  { id: 'red-raven', name: 'Red Raven', role: 'Codex' },
  { id: 'ghost', name: 'Ghost', role: 'Reasoning' },
  { id: 'polly', name: 'Polly', role: 'Research' },
  { id: 'old-salt', name: 'Old Salt', role: 'Planning' },
  { id: 'capn-mira', name: "Cap'n Mira", role: 'Design' },
  { id: 'kraken', name: 'Kraken', role: 'DevOps' },
  { id: 'coco', name: 'Coco', role: 'Automation' },
  { id: 'iron-jack', name: 'Iron Jack', role: 'Security' },
  { id: 'scarlett', name: 'Scarlett', role: 'Frontend' },
  { id: 'navigator', name: 'Navigator', role: 'Data' },
  { id: 'zen', name: 'Zen', role: 'Testing' },
  { id: 'sharky', name: 'Sharky', role: 'Infrastructure' },
  { id: 'rusty', name: 'Rusty', role: 'Backend' },
  { id: 'skipper', name: 'Skipper', role: 'Product' },
  { id: 'shadow', name: 'Shadow', role: 'Stealth' },
  { id: 'whiskers', name: 'Whiskers', role: 'Documentation' },
  { id: 'treasure', name: 'Treasure', role: 'General' },
];

/**
 * Bundled portrait URLs, keyed by id. Vite hashes and copies whatever exists;
 * missing files simply do not appear here.
 */
const FILES = import.meta.glob('../assets/crew/*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const BY_ID = new Map<string, string>(
  Object.entries(FILES).map(([path, url]) => [
    path.replace(/^.*\/(.+)\.png$/, '$1'),
    url,
  ]),
);

/** Resolved URL for a portrait id, or null when the artwork is not present. */
export function portraitUrl(avatar: string | undefined | null): string | null {
  if (!avatar) return null;
  return BY_ID.get(avatar) ?? null;
}

/** True once any artwork has been added to assets/crew. */
export function hasPortraits(): boolean {
  return BY_ID.size > 0;
}

/** Only the portraits whose artwork actually shipped, for the picker. */
export function availablePortraits(): CrewPortrait[] {
  return CREW_PORTRAITS.filter((p) => BY_ID.has(p.id));
}

/** Suggests a portrait for a runtime, so the wizard opens on something sensible. */
export function defaultPortraitFor(runtimeType: string): string | undefined {
  const preferred = runtimeType === 'codex' ? 'red-raven' : 'blackbeard';
  if (BY_ID.has(preferred)) return preferred;
  return availablePortraits()[0]?.id;
}
