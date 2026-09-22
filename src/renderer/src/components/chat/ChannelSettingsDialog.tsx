import { useEffect, useState } from 'react';
import type { Conversation } from '@shared/types';
import { ChannelIconPicker } from '@/components/chat/ChannelIconPicker';
import { Button, Field, Input, Modal, Switch } from '@/components/ui/primitives';
import { invoke, useApp } from '@/stores/app';

/** Icon, name, topic and agent-to-agent autonomy for one conversation. */
export function ChannelSettingsDialog({
  conversation,
  open,
  onOpenChange,
}: {
  conversation: Conversation;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const pushToast = useApp((s) => s.pushToast);
  const isChannel = conversation.kind === 'channel';

  const [name, setName] = useState(conversation.name);
  const [topic, setTopic] = useState(conversation.topic ?? '');
  const [icon, setIcon] = useState<string | null>(conversation.icon);
  const [autonomy, setAutonomy] = useState(conversation.autonomyEnabled);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(conversation.name);
    setTopic(conversation.topic ?? '');
    setIcon(conversation.icon);
    setAutonomy(conversation.autonomyEnabled);
    setConfirmDelete(false);
  }, [open, conversation]);

  const cleanName = name.trim().replace(/^#/, '');

  const save = async () => {
    setBusy(true);
    try {
      await invoke('conversations:update', {
        id: conversation.id,
        patch: {
          ...(isChannel && cleanName ? { name: cleanName } : {}),
          ...(isChannel ? { icon } : {}),
          topic: topic.trim() || null,
          autonomyEnabled: autonomy,
        },
      });
      onOpenChange(false);
    } catch (error) {
      pushToast({
        level: 'error',
        title: 'Could not save',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      await invoke('conversations:delete', { id: conversation.id });
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isChannel ? `#${conversation.name}` : conversation.name}
      description={isChannel ? 'Channel settings' : 'Conversation settings'}
      width={460}
    >
      <div className="space-y-4">
        {isChannel ? (
          <Field label="Name">
            <div className="flex gap-2">
              <ChannelIconPicker value={icon} onChange={setIcon} />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="development"
                aria-label="Channel name"
              />
            </div>
          </Field>
        ) : null}

        <Field label="Topic" hint="Agents can read this with get_channel_context.">
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What this conversation is for"
          />
        </Field>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-line bg-surface px-3 py-2.5">
          <div>
            <p className="text-xs font-medium text-content">Agents can talk to each other</p>
            <p className="mt-0.5 text-2xs leading-relaxed text-content-muted">
              When off, agents here only act when you mention them.
            </p>
          </div>
          <Switch checked={autonomy} onCheckedChange={setAutonomy} label="Agents can talk to each other" />
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            variant="ghost"
            onClick={() => void remove()}
            disabled={busy}
            className="text-danger hover:bg-danger/[0.07] hover:text-danger"
          >
            {confirmDelete ? 'Click again to delete' : isChannel ? 'Delete channel' : 'Delete conversation'}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={busy || (isChannel && !cleanName)}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
