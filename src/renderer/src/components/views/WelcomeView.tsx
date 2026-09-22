import { Hash, Plus } from 'lucide-react';
import { BrandMark } from '@/components/brand/BrandMark';
import { Button } from '@/components/ui/primitives';
import { SHIP } from '@/lib/lexicon';
import { useApp } from '@/stores/app';

/** What the main panel shows when no conversation is open. */
export function WelcomeView({
  onAddAgent,
  onNewChannel,
}: {
  onAddAgent(): void;
  onNewChannel(): void;
}) {
  const hasAgents = useApp((s) => s.agents.length > 0);
  const hasConversations = useApp((s) => s.conversations.length > 0);
  const fresh = !hasAgents && !hasConversations;

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-shell shadow-panel">
        <BrandMark size={36} />
      </div>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-content-strong">
        {fresh ? SHIP.empty.welcome : SHIP.empty.noConversation}
      </h2>
      {fresh ? <p className="mt-1 text-nav font-medium text-primary-ink">{SHIP.tagline}</p> : null}
      <p className="mt-2 max-w-sm text-body text-content-muted">
        {fresh ? SHIP.empty.welcomeDetail : SHIP.empty.noConversationDetail}
      </p>
      <div className="mt-6 flex items-center gap-2">
        {!hasAgents ? (
          <Button variant="primary" onClick={onAddAgent}>
            <Plus size={14} />
            {SHIP.empty.firstAgent}
          </Button>
        ) : null}
        <Button variant={hasAgents ? 'primary' : 'surface'} onClick={onNewChannel}>
          <Hash size={13} />
          {SHIP.actions.newChannel}
        </Button>
      </div>
    </div>
  );
}
