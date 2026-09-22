import { Camera, Loader2, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { AppSettings } from '@shared/types';
import { Avatar, Button, Field, FieldGroup, Input } from '@/components/ui/primitives';
import { PaneHeader } from '@/components/settings/SettingsDialog';
import { AGENT_COLORS } from '@/lib/agents';
import { availablePortraits } from '@/lib/crew';
import { AVATAR_ACCEPT, squareAvatarDataUrl } from '@/lib/image';
import { HUMAN_AVATAR_COLOR, humanAvatarOf } from '@/lib/people';
import { cn } from '@/lib/utils';
import { invoke, useApp } from '@/stores/app';

const COLORS = [HUMAN_AVATAR_COLOR, ...AGENT_COLORS];

/** Settings → Profile: the name and picture the user appears with. */
export function ProfilePane() {
  const settings = useApp((s) => s.settings);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const [name, setName] = useState(settings?.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => setName(settings?.displayName ?? ''), [settings?.displayName]);

  if (!settings) return null;
  const avatar = humanAvatarOf(settings);
  const portraits = availablePortraits();

  const save = async (patch: Partial<AppSettings>) => {
    setError(null);
    try {
      await invoke('settings:update', patch);
      await refreshSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveName = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(settings.displayName ?? '');
      return;
    }
    if (trimmed !== settings.displayName) void save({ displayName: trimmed });
  };

  const applyPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const avatarImage = await squareAvatarDataUrl(file);
      await save({ avatarImage });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void applyPhoto(event.dataTransfer.files[0]);
  };

  const hasPhoto = !!settings.avatarImage;

  return (
    <div className="space-y-5">
      <PaneHeader title="Profile" detail="How you appear in the sidebar, on your messages and to the agents you talk to." />

      <div className="flex items-center gap-5">
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'group relative shrink-0 rounded-full outline-none ring-offset-2 ring-offset-white focus-visible:ring-2 focus-visible:ring-primary/50',
            dragging && 'ring-2 ring-primary',
          )}
          aria-label="Change photo"
          title="Change photo — or drop an image here"
        >
          <Avatar name={avatar.name} color={avatar.color} emoji={avatar.emoji} src={avatar.src} size={80} />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-shell/55 text-white opacity-0 transition-opacity group-hover:opacity-100">
            {busy ? <Loader2 size={20} className="animate-spin" /> : <Camera size={20} />}
          </span>
        </button>

        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="surface" size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
              {hasPhoto ? 'Change photo' : 'Upload photo'}
            </Button>
            {hasPhoto ? (
              <Button variant="ghost" size="sm" onClick={() => void save({ avatarImage: null })} disabled={busy}>
                <Trash2 size={13} />
                Remove photo
              </Button>
            ) : null}
          </div>
          <p className="text-2xs leading-relaxed text-content-faint">
            PNG, JPEG, WebP or GIF. It is cropped to a square and stored on this computer only.
          </p>
          {error ? <p className="text-2xs text-danger">{error}</p> : null}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept={AVATAR_ACCEPT}
          className="hidden"
          onChange={(e) => void applyPhoto(e.target.files?.[0])}
          aria-label="Photo file"
        />
      </div>

      <Field label="Your name" hint="Shown in the sidebar and on your messages.">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveName();
          }}
          placeholder="Your name"
          maxLength={64}
        />
      </Field>

      <div className={cn('space-y-4 transition-opacity', hasPhoto && 'opacity-60')}>
        {hasPhoto ? (
          <p className="text-2xs text-content-muted">Your photo is in use. Choosing a portrait or initials below replaces it.</p>
        ) : null}

        {portraits.length ? (
          <FieldGroup label="Or choose a portrait">
            <div className="grid max-h-[152px] grid-cols-10 gap-1.5 overflow-y-auto pr-1">
              <button
                type="button"
                onClick={() => void save({ avatarImage: null, avatarPortrait: '' })}
                title="Initials"
                className={cn(
                  'flex aspect-square items-center justify-center rounded-full border text-2xs transition-colors',
                  !hasPhoto && !avatar.emoji ? 'border-primary bg-primary/[0.06] text-content' : 'border-line text-content-faint hover:bg-subtle',
                )}
              >
                Aa
              </button>
              {portraits.map((portrait) => (
                <button
                  key={portrait.id}
                  type="button"
                  onClick={() => void save({ avatarImage: null, avatarPortrait: portrait.id })}
                  title={portrait.name}
                  aria-label={`Portrait ${portrait.name}`}
                  className={cn(
                    'aspect-square overflow-hidden rounded-full ring-offset-2 ring-offset-white transition-all',
                    !hasPhoto && avatar.emoji === portrait.id ? 'ring-2 ring-primary' : 'opacity-70 hover:opacity-100',
                  )}
                >
                  <Avatar name={portrait.name} emoji={portrait.id} fill />
                </button>
              ))}
            </div>
          </FieldGroup>
        ) : null}

        <FieldGroup label="Colour behind your initials">
          <div className="flex flex-wrap gap-1.5">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => void save({ avatarImage: null, avatarPortrait: '', avatarColor: c })}
                style={{ background: c }}
                className={cn(
                  'h-6 w-6 rounded-full transition-transform',
                  !hasPhoto && !avatar.emoji && avatar.color === c ? 'ring-2 ring-primary/50 ring-offset-2 ring-offset-white' : 'hover:scale-110',
                )}
                aria-label={`Colour ${c}`}
              />
            ))}
          </div>
        </FieldGroup>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-content">Preview</p>
        <div className="flex gap-[10px] rounded-lg border border-line px-4 py-3">
          <Avatar name={avatar.name} color={avatar.color} emoji={avatar.emoji} src={avatar.src} size={32} />
          <div className="min-w-0">
            <p className="text-[13px] leading-5">
              <bdi className="font-bold text-content-strong">{avatar.name}</bdi>
              <span className="ml-2 text-[11px] text-content-faint">now</span>
            </p>
            <p className="text-[13px] leading-5 text-content">This is how your messages look.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
