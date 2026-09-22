import { useEffect, useState } from 'react';
import { ChannelIconPicker } from '@/components/chat/ChannelIconPicker';
import { Avatar, Button, Field, Input, Modal } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { invoke, useApp } from '@/stores/app';

export function NewChannelDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const agents = useApp((s) => s.agents);
  const refreshConversations = useApp((s) => s.refreshConversations);
  const select = useApp((s) => s.selectConversation);

  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setTopic('');
    setIcon(null);
    setMembers(agents.map((a) => a.id));
    setError(null);
  }, [open, agents]);

  const create = async () => {
    const clean = name.trim().replace(/^#/, '');
    if (!clean) return;
    setBusy(true);
    setError(null);
    try {
      const conversation = await invoke('conversations:create', {
        kind: 'channel',
        name: clean,
        topic: topic.trim() || null,
        icon,
        memberAgentIds: members,
      });
      await refreshConversations();
      await select(conversation.id);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Create a channel"
      description="A channel is where several agents work together. Only the agents you @mention are put to work."
      width={470}
    >
      <div className="space-y-4">
        <Field label="Name" hint="The icon is optional; without one the channel shows a #.">
          <div className="flex gap-2">
            <ChannelIconPicker value={icon} onChange={setIcon} />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="development"
              aria-label="Channel name"
              autoFocus
            />
          </div>
        </Field>

        <Field label="Topic" hint="Optional. Agents can read this with get_channel_context.">
          <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What this channel is for" />
        </Field>

        <Field label="Agents in this channel">
          <div className="flex flex-wrap gap-1.5">
            {agents.map((agent) => {
              const on = members.includes(agent.id);
              return (
                <button
                  key={agent.id}
                  onClick={() =>
                    setMembers((prev) =>
                      on ? prev.filter((id) => id !== agent.id) : [...prev, agent.id],
                    )
                  }
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-md border pl-1 pr-2.5 text-xs transition-colors duration-fast',
                    on
                      ? 'border-primary bg-primary/[0.08] text-content-strong'
                      : 'border-line text-content-muted hover:border-line-strong hover:text-content',
                  )}
                  aria-pressed={on}
                >
                  <Avatar name={agent.name} color={agent.avatarColor} emoji={agent.avatar} size={20} agent />
                  {agent.name}
                </button>
              );
            })}
            {!agents.length ? (
              <span className="text-2xs text-content-faint">Add an agent first.</span>
            ) : null}
          </div>
        </Field>

        {error ? <p className="text-2xs text-danger">{error}</p> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} disabled={!name.trim() || busy}>
            Create channel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
