import type { AppSettings } from '@shared/types';

/** The local human's default avatar plate. Agents bring their own colours. */
export const HUMAN_AVATAR_COLOR = '#475569';

/** How the local human is shown: their chosen name, or "You" before one is set. */
export function displayNameOf(settings: Pick<AppSettings, 'displayName'> | null | undefined): string {
  return settings?.displayName?.trim() || 'You';
}

/** Everything `Avatar` needs to draw the local human. */
export function humanAvatarOf(settings: AppSettings | null | undefined): {
  name: string;
  color: string;
  emoji: string;
  src: string | null;
} {
  return {
    name: displayNameOf(settings),
    color: settings?.avatarColor || HUMAN_AVATAR_COLOR,
    emoji: settings?.avatarPortrait ?? '',
    src: settings?.avatarImage ?? null,
  };
}
