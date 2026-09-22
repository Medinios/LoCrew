import * as Tooltip from '@radix-ui/react-tooltip';
import type { AgentExecution, Message } from '@shared/types';
import type { ReactionPillView } from '@/lib/activity';
import { cn } from '@/lib/utils';

/**
 * Everything shown under one message: agent activity and the user's own
 * reactions, grouped by emoji, plus -- in channels -- how many replies it drew.
 */
export interface MessageReactionsView {
  pills: ReactionPillView[];
  replies: number;
  /** Id of the first reply, for jumping to it. */
  firstReplyId: string | null;
}

export function MessageReactions({
  view,
  onToggle,
  onJumpToReply,
}: {
  view: MessageReactionsView;
  /** Adds or removes the user's own reaction with this emoji. */
  onToggle?(emoji: string): void;
  onJumpToReply?(): void;
}) {
  if (!view.pills.length && !view.replies) return null;

  return (
    <div className="mt-[6px] flex flex-wrap items-center gap-[6px]" role="group" aria-label="Reactions">
      {view.pills.map((pill) => (
        <ReactionPill key={pill.emoji} pill={pill} onToggle={onToggle} />
      ))}
      {view.replies ? (
        <button
          type="button"
          onClick={onJumpToReply}
          disabled={!onJumpToReply}
          title={`${view.replies} ${view.replies === 1 ? 'reply' : 'replies'} · click to jump`}
          className={cn(PILL, onJumpToReply ? 'hover:border-line-strong hover:bg-surface' : 'cursor-default')}
        >
          <span className="font-emoji text-[12.5px] leading-none">💬</span>
          <span className="tabular-nums leading-none">{view.replies}</span>
        </button>
      ) : null}
    </div>
  );
}

const PILL =
  'inline-flex h-6 items-center gap-1.5 rounded-sm border border-line bg-subtle pl-2 pr-2 text-[11.5px] font-medium text-content transition-[background-color,border-color,color] duration-base ease-out';

/**
 * One emoji and how many reacted with it. Agent activity cannot be removed
 * from here -- only the user's own reaction toggles -- so a pill made only of
 * agent activity is not clickable at all.
 */
function ReactionPill({ pill, onToggle }: { pill: ReactionPillView; onToggle?(emoji: string): void }) {
  const toggles = pill.mine && !!onToggle;
  const label = [
    ...pill.agents.map((a) => `${a.name}: ${a.status}${a.operation ? `, ${a.operation}` : ''}`),
    ...(pill.mine ? ['you'] : []),
  ].join('; ');

  // Agents doing something right now: a lavender tint (AI), and a small teal
  // pulse when that something is actual work.
  const working = pill.agents.some((a) => a.state === 'working' || a.state === 'processing');
  const waiting = pill.agents.some((a) => a.state === 'waiting_for_input');
  const className = cn(
    PILL,
    // Mounting fades the pill in, so a state change reads as a soft swap.
    'animate-fade-in',
    pill.live && 'border-ai/30 bg-ai/[0.08]',
    waiting && 'border-warning/35 bg-warning/[0.08]',
    pill.mine && 'border-primary/45 bg-primary/[0.1] text-primary-ink',
    toggles ? (pill.mine ? 'hover:bg-primary/[0.16]' : 'hover:border-line-strong hover:bg-surface') : 'cursor-default',
  );
  const content = (
    <>
      <span className="font-emoji text-[12.5px] leading-none">{pill.emoji}</span>
      {working ? (
        <span className="relative inline-flex h-1.5 w-1.5" aria-hidden>
          <span className="absolute inset-0 animate-pulse-ring rounded-full bg-primary" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-primary" />
        </span>
      ) : null}
      <span className="tabular-nums leading-none">{pill.count}</span>
    </>
  );

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        {toggles ? (
          <button
            type="button"
            onClick={() => onToggle!(pill.emoji)}
            aria-pressed={pill.mine}
            aria-label={`${pill.emoji} ${pill.count}: ${label}`}
            className={className}
          >
            {content}
          </button>
        ) : (
          <span tabIndex={0} role="img" aria-label={`${pill.emoji} ${pill.count}: ${label}`} className={className}>
            {content}
          </span>
        )}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="z-tooltip max-w-[280px] animate-fade-in rounded-md border border-shell-line bg-shell px-2.5 py-1.5 text-[11.5px] leading-[17px] text-ink shadow-popover"
        >
          <AgentActivityTooltip pill={pill} canToggle={toggles} />
          <Tooltip.Arrow className="fill-[hsl(var(--shell))]" width={10} height={5} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Who reacted with this emoji and why: one line per agent, then the user. */
export function AgentActivityTooltip({ pill, canToggle }: { pill: ReactionPillView; canToggle: boolean }) {
  return (
    <div className="space-y-0.5">
      {pill.agents.map((agent) => (
        <div key={agent.agentId}>
          <p>
            <span className="font-semibold">{agent.name}</span>
            <span className="text-ink-muted"> — {agent.status}</span>
          </p>
          {agent.operation ? <p className="text-ink-faint">Current operation: {agent.operation}</p> : null}
        </div>
      ))}
      {pill.mine ? (
        <p>
          <span className="font-semibold">You</span>
          {canToggle ? <span className="text-ink-faint"> · click to remove</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Replies each message drew: executions record the message that triggered
 * them, and replies record the execution that produced them.
 */
export function buildReplyCounts(
  messages: Message[],
  executions: AgentExecution[],
): Map<string, { count: number; first: string }> {
  const triggerOf = new Map<string, string>();
  for (const execution of executions) {
    if (execution.triggeredByMessageId) triggerOf.set(execution.id, execution.triggeredByMessageId);
  }
  const replies = new Map<string, { count: number; first: string }>();
  for (const message of messages) {
    if (!message.executionId || message.senderType !== 'agent') continue;
    if (message.kind !== 'chat' && message.kind !== 'task_update') continue;
    const trigger = triggerOf.get(message.executionId);
    if (!trigger) continue;
    const entry = replies.get(trigger);
    if (entry) entry.count += 1;
    else replies.set(trigger, { count: 1, first: message.id });
  }
  return replies;
}
