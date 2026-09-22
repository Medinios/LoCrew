import { Avatar, type Presence } from '@/components/ui/primitives';
import { humanAvatarOf } from '@/lib/people';
import { useApp } from '@/stores/app';

/** The local human's avatar: their photo, portrait or initials, from Settings → Profile. */
export function UserAvatar({ size = 28, presence, className }: { size?: number; presence?: Presence; className?: string }) {
  const settings = useApp((s) => s.settings);
  const { name, color, emoji, src } = humanAvatarOf(settings);
  return <Avatar name={name} color={color} emoji={emoji} src={src} size={size} presence={presence} className={className} />;
}
