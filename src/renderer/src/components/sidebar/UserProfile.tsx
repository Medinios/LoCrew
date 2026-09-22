import { Settings } from 'lucide-react';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { SHIP } from '@/lib/lexicon';
import { displayNameOf } from '@/lib/people';
import { useApp } from '@/stores/app';

/** The person at the keyboard, anchored to the bottom of the sidebar. */
export function UserProfile({
  onOpenSettings,
  working,
}: {
  onOpenSettings(): void;
  /** How many agents are running right now. */
  working: number;
}) {
  const settings = useApp((s) => s.settings);
  const name = displayNameOf(settings);

  return (
    <button
      type="button"
      onClick={onOpenSettings}
      title={SHIP.actions.profile}
      className="group/profile flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors duration-fast hover:bg-shell-hover"
    >
      <UserAvatar size={28} presence="available" />
      <span className="min-w-0 flex-1">
        <span className="bidi-isolate block truncate text-nav font-semibold leading-4 text-ink">{name}</span>
        <span className="mt-0.5 flex items-center gap-1.5 truncate text-2xs text-ink-faint">
          {working > 0 ? (
            <>
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inset-0 animate-pulse-ring rounded-full bg-primary" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              <span className="text-ink-muted">
                {working} {working === 1 ? 'agent' : 'agents'} working
              </span>
            </>
          ) : (
            settings?.workspaceName?.trim() || SHIP.appName
          )}
        </span>
      </span>
      <Settings
        size={14}
        strokeWidth={1.8}
        className="mr-1 shrink-0 text-ink-faint opacity-0 transition-opacity duration-fast group-hover/profile:opacity-100"
      />
    </button>
  );
}
