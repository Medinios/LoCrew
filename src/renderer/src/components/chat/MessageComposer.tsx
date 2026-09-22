import {
  ArrowUp,
  AtSign,
  Bold,
  Code,
  FileText,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Paperclip,
  Quote,
  SmilePlus,
  SquareCode,
  Strikethrough,
  Type,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '@shared/types';
import { Avatar, PRESENCE_LABEL, type Presence } from '@/components/ui/primitives';
import { EmojiPicker } from '@/components/chat/EmojiPicker';
import { agentPresence } from '@/lib/activity';
import { engineLabel } from '@/lib/agents';
import { detectDirection } from '@/lib/direction';
import { imageFilesIn, prepareImageForSending, type OutgoingImage } from '@/lib/image';
import { basename, cn } from '@/lib/utils';
import { findAgentForDm, invoke, useApp } from '@/stores/app';

/** Unsent text per conversation, so switching away does not lose a draft. */
const drafts = new Map<string, string>();

/** Matches the main process's per-message limit. */
const MAX_IMAGES = 8;

/**
 * The message box: a white field with a compact toolbar underneath and a
 * teal send button.
 *
 * Mentions are what decide which agents wake up, so the @ picker only offers
 * agents that are members of this conversation.
 */
export function MessageComposer({ conversationId }: { conversationId: string }) {
  const conversation = useApp((s) => s.conversations.find((c) => c.id === conversationId));
  const agents = useApp((s) => s.agents);
  const providers = useApp((s) => s.providers);
  const memberIds = useApp((s) => s.conversationMemberIds);
  const liveActivity = useApp((s) => s.liveActivity);
  const executions = useApp((s) => s.executions);
  const sendMessage = useApp((s) => s.sendMessage);

  const [value, setValue] = useState(() => drafts.get(conversationId) ?? '');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [images, setImages] = useState<OutgoingImage[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [showFormatting, setShowFormatting] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousId = useRef(conversationId);

  // Swap drafts when the conversation changes, and put the caret in the box.
  useEffect(() => {
    if (previousId.current !== conversationId) {
      drafts.set(previousId.current, value);
      previousId.current = conversationId;
      setValue(drafts.get(conversationId) ?? '');
      setAttachments([]);
      setImages([]);
      setMentionQuery(null);
      setShowEmoji(false);
    }
    textareaRef.current?.focus();
    // Keyed on the conversation alone: `value` is only read to stash the
    // outgoing draft, and must not re-run this on every keystroke.
  }, [conversationId]);

  const dmAgent = useMemo(
    () => (conversation?.kind === 'dm' ? findAgentForDm(conversation, agents, memberIds) : undefined),
    [conversation, agents, memberIds],
  );

  // The main process is authoritative and ignores mentions of non-members;
  // this only keeps the picker honest about who will actually hear it.
  const candidates = useMemo<Agent[]>(() => {
    if (!conversation) return [];
    if (conversation.kind === 'dm') return dmAgent ? [dmAgent] : [];
    const members = memberIds[conversation.id];
    return members ? agents.filter((a) => members.includes(a.id)) : agents;
  }, [agents, conversation, dmAgent, memberIds]);

  const suggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const needle = mentionQuery.toLowerCase();
    const matches = candidates.filter((a) => a.name.toLowerCase().includes(needle));
    const offerAll = conversation?.kind === 'channel' && (needle === '' || 'all'.startsWith(needle));
    return offerAll ? [ALL_OPTION, ...matches] : matches;
  }, [candidates, mentionQuery, conversation?.kind]);

  useEffect(() => setHighlight(0), [mentionQuery]);

  // What each suggested agent is doing right now, from its real activity.
  const presenceOf = useMemo(() => {
    const running = new Set(
      executions
        .filter((e) => !['completed', 'failed', 'cancelled'].includes(e.state))
        .map((e) => e.agentId),
    );
    return (agent: Agent): Presence => agentPresence(agent, liveActivity[agent.id], running.has(agent.id));
  }, [executions, liveActivity]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [value]);

  const detectMention = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const match = /(?:^|[\s(\[{])@([A-Za-z0-9._-]*)$/.exec(before);
    setMentionQuery(match ? (match[1] ?? '') : null);
  };

  const applySuggestion = (name: string) => {
    const element = textareaRef.current;
    if (!element) return;
    const caret = element.selectionStart;
    const before = value.slice(0, caret);
    const replaced = before.replace(/@([A-Za-z0-9._-]*)$/, `@${name.replace(/\s+/g, '')} `);
    const next = replaced + value.slice(caret);
    setValue(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      element.focus();
      element.selectionStart = element.selectionEnd = replaced.length;
    });
  };

  /** Applies an edit to the textarea and keeps focus + selection sane. */
  const edit = (next: string, caret: number) => {
    setValue(next);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.selectionStart = element.selectionEnd = caret;
    });
  };

  /** Wraps the current selection, or drops the markers at the caret. */
  const wrap = (before: string, after: string) => {
    const element = textareaRef.current;
    if (!element) return;
    const { selectionStart: start, selectionEnd: end } = element;
    const selected = value.slice(start, end);
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    edit(next, start + before.length + selected.length);
  };

  /** Prefixes every line the selection touches, for lists and quotes. */
  const prefixLines = (prefix: string) => {
    const element = textareaRef.current;
    if (!element) return;
    const { selectionStart: start, selectionEnd: end } = element;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const searchEnd = value.indexOf('\n', end);
    const lineEnd = searchEnd === -1 ? value.length : searchEnd;
    const block = value
      .slice(lineStart, lineEnd)
      .split('\n')
      .map((line) => (line.startsWith(prefix) ? line : `${prefix}${line}`))
      .join('\n');
    const next = `${value.slice(0, lineStart)}${block}${value.slice(lineEnd)}`;
    edit(next, lineStart + block.length);
  };

  const insert = (text: string) => {
    const element = textareaRef.current;
    if (!element) return;
    const { selectionStart: start, selectionEnd: end } = element;
    const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
    edit(next, start + text.length);
    detectMention(next, start + text.length);
  };

  const attach = async () => {
    try {
      const { paths } = await invoke('workspace:pickFiles');
      if (paths.length) setAttachments((current) => [...new Set([...current, ...paths])]);
    } finally {
      textareaRef.current?.focus();
    }
  };

  /**
   * Adds pasted, dropped or picked images. Each is checked and, when large,
   * scaled down here, so what is sent is what every agent can accept.
   */
  const addImages = async (files: File[]) => {
    const room = MAX_IMAGES - images.length - preparing;
    if (room <= 0 || files.length > room) {
      useApp.getState().pushToast({
        level: 'warning',
        title: 'Too many images',
        detail: `A message can carry up to ${MAX_IMAGES} images.`,
      });
    }
    const accepted = files.slice(0, Math.max(0, room));
    if (!accepted.length) return;
    setPreparing((n) => n + accepted.length);
    for (const file of accepted) {
      try {
        const image = await prepareImageForSending(file);
        setImages((current) => [...current, image]);
      } catch (error) {
        useApp.getState().pushToast({
          level: 'error',
          title: 'Image not added',
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setPreparing((n) => n - 1);
      }
    }
    textareaRef.current?.focus();
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesIn(event.clipboardData);
    if (!files.length) return;
    // A screenshot carries only the image; copying from a page can carry text
    // too, which then pastes as usual.
    if (!event.clipboardData.types.includes('text/plain')) event.preventDefault();
    void addImages(files);
  };

  const onDragOver = (event: React.DragEvent) => {
    if (![...event.dataTransfer.items].some((item) => item.kind === 'file' && item.type.startsWith('image/'))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };

  const onDrop = (event: React.DragEvent) => {
    setDragging(false);
    const files = imageFilesIn(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  };

  const canSend = (value.trim().length > 0 || attachments.length > 0 || images.length > 0) && !sending && preparing === 0;

  const submit = async () => {
    if (!canSend) return;
    const text = value.trim();
    const files = attachments;
    const pending = images;
    const body = [text, files.map(attachmentLink).join('\n')].filter(Boolean).join('\n\n');
    setSending(true);
    setValue('');
    setAttachments([]);
    setImages([]);
    setMentionQuery(null);
    drafts.delete(conversationId);
    try {
      await sendMessage(
        body,
        pending.map((image) => ({ name: image.name, data: image.data })),
      );
    } catch (error) {
      setValue(text);
      setAttachments(files);
      setImages(pending);
      useApp.getState().pushToast({
        level: 'error',
        title: 'Message not sent',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length && mentionQuery !== null) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlight((h) => (h + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        const picked = suggestions[highlight];
        if (picked) {
          event.preventDefault();
          applySuggestion(picked.name);
          return;
        }
      }
      if (event.key === 'Escape') {
        setMentionQuery(null);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const placeholder =
    conversation?.kind === 'channel'
      ? `Message #${conversation.name}`
      : `Message ${dmAgent?.name ?? conversation?.name ?? ''}`;

  return (
    <div className="shrink-0 px-5">
      <div className="relative">
        {suggestions.length && mentionQuery !== null ? (
          <div
            role="listbox"
            aria-label="Mention an agent"
            className="absolute bottom-full left-0 z-dropdown mb-2 w-[340px] animate-pop-in overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-popover"
          >
            <p className="px-2.5 pb-1.5 pt-1.5 text-[10px] font-semibold uppercase tracking-label text-content-faint">
              Mention an agent
            </p>
            {suggestions.map((agent, index) => {
              const everyone = agent.id === ALL_OPTION.id;
              const presence = everyone ? null : presenceOf(agent);
              return (
                <button
                  key={agent.id}
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applySuggestion(agent.name)}
                  className={cn(
                    'flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-fast',
                    index === highlight ? 'bg-subtle' : 'hover:bg-subtle',
                  )}
                >
                  {everyone ? (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-ai/[0.14] text-ai-ink">
                      <AtSign size={13} strokeWidth={2.2} />
                    </span>
                  ) : (
                    <Avatar
                      name={agent.name}
                      color={agent.avatarColor}
                      emoji={agent.avatar}
                      size={28}
                      agent
                      presence={presence ?? undefined}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-nav font-medium leading-[18px] text-content-strong">
                      {everyone ? '@all' : agent.name}
                    </span>
                    <span className="block truncate text-2xs text-content-muted">
                      {everyone ? 'Everyone in this channel' : engineLabel(agent, providers)}
                    </span>
                  </span>
                  {presence ? (
                    <span
                      className={cn(
                        'shrink-0 text-2xs font-medium',
                        presence === 'working' || presence === 'available'
                          ? 'text-primary-ink'
                          : presence === 'thinking'
                            ? 'text-ai-ink'
                            : presence === 'waiting'
                              ? 'text-warning-ink'
                              : presence === 'error'
                                ? 'text-danger-ink'
                                : 'text-content-faint',
                      )}
                    >
                      {PRESENCE_LABEL[presence]}
                    </span>
                  ) : null}
                </button>
              );
            })}
            <p className="mt-1 flex items-center gap-3 border-t border-line px-2.5 pb-1 pt-2 text-2xs text-content-faint">
              <span>
                <kbd className="font-sans font-semibold text-content-muted">↑↓</kbd> choose
              </span>
              <span>
                <kbd className="font-sans font-semibold text-content-muted">Enter</kbd> mention
              </span>
              <span>
                <kbd className="font-sans font-semibold text-content-muted">Esc</kbd> dismiss
              </span>
            </p>
          </div>
        ) : null}

        <div
          onDragOver={onDragOver}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'rounded-xl border border-line bg-surface shadow-composer transition-[border-color,box-shadow] duration-base ease-out hover:border-line-strong focus-within:border-primary focus-within:shadow-composer-focus focus-within:hover:border-primary',
            dragging && 'border-primary bg-primary/[0.03] shadow-composer-focus',
          )}
        >
          {showFormatting ? (
            <div className="flex animate-fade-in items-center gap-0.5 border-b border-line px-2 py-1">
              <ToolbarButton label="Bold" onClick={() => wrap('**', '**')}>
                <Bold size={14} strokeWidth={2} />
              </ToolbarButton>
              <ToolbarButton label="Italic" onClick={() => wrap('_', '_')}>
                <Italic size={14} strokeWidth={2} />
              </ToolbarButton>
              <ToolbarButton label="Strikethrough" onClick={() => wrap('~~', '~~')}>
                <Strikethrough size={14} strokeWidth={2} />
              </ToolbarButton>
              <Divider />
              <ToolbarButton label="Link" onClick={() => wrap('[', '](url)')}>
                <Link2 size={14} strokeWidth={2} />
              </ToolbarButton>
              <ToolbarButton label="Bulleted list" onClick={() => prefixLines('- ')}>
                <List size={14} strokeWidth={2} />
              </ToolbarButton>
              <ToolbarButton label="Numbered list" onClick={() => prefixLines('1. ')}>
                <ListOrdered size={14} strokeWidth={2} />
              </ToolbarButton>
              <ToolbarButton label="Quote" onClick={() => prefixLines('> ')}>
                <Quote size={14} strokeWidth={2} />
              </ToolbarButton>
              <Divider />
              <ToolbarButton label="Code" onClick={() => wrap('`', '`')}>
                <Code size={14} strokeWidth={2} />
              </ToolbarButton>
              <ToolbarButton label="Code block" onClick={() => wrap('\n```\n', '\n```\n')}>
                <SquareCode size={14} strokeWidth={2} />
              </ToolbarButton>
            </div>
          ) : null}

          {images.length || preparing ? (
            <div className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Images to send">
              {images.map((image) => (
                <div
                  key={image.id}
                  title={image.name}
                  className="group/thumb relative h-16 w-16 animate-fade-in overflow-hidden rounded-md border border-line bg-subtle"
                >
                  <img src={image.previewUrl} alt={image.name} className="h-full w-full object-cover" draggable={false} />
                  <button
                    type="button"
                    onClick={() => setImages((current) => current.filter((i) => i.id !== image.id))}
                    aria-label={`Remove ${image.name}`}
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-shell/75 text-ink opacity-0 transition-opacity duration-fast hover:bg-shell focus:opacity-100 group-hover/thumb:opacity-100"
                  >
                    <X size={11} strokeWidth={2.4} />
                  </button>
                </div>
              ))}
              {Array.from({ length: preparing }, (_, i) => (
                <div
                  key={`preparing-${i}`}
                  className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-line-strong text-content-faint"
                  aria-label="Preparing image"
                >
                  <Loader2 size={16} className="animate-spin" />
                </div>
              ))}
            </div>
          ) : null}

          {attachments.length ? (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {attachments.map((path) => (
                <span
                  key={path}
                  title={path}
                  className="flex h-7 max-w-[260px] items-center gap-1.5 rounded-md border border-line bg-subtle pl-2 pr-1 text-xs font-medium text-content"
                >
                  <FileText size={13} className="shrink-0 text-content-muted" />
                  <span className="truncate">{basename(path)}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((current) => current.filter((p) => p !== path))}
                    aria-label={`Remove ${basename(path)}`}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-content-faint hover:bg-line hover:text-content"
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            value={value}
            rows={1}
            onChange={(event) => {
              setValue(event.target.value);
              detectMention(event.target.value, event.target.selectionStart);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onClick={(event) => detectMention(value, event.currentTarget.selectionStart)}
            placeholder={placeholder}
            aria-label={placeholder}
            title="Enter to send · Shift+Enter for a new line · paste or drop images to send them"
            dir={detectDirection(value)}
            className="block max-h-[240px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-body text-content-strong placeholder:text-content-faint focus:outline-none"
          />

          <div className="flex h-11 items-center justify-between gap-2 pl-2 pr-2">
            <div className="relative flex items-center gap-0.5">
              <ToolbarButton label="Mention an agent" onClick={() => insert('@')}>
                <AtSign size={16} strokeWidth={1.8} />
              </ToolbarButton>
              <ToolbarButton label="Attach files" onClick={() => void attach()}>
                <Paperclip size={16} strokeWidth={1.8} />
              </ToolbarButton>
              <ToolbarButton label="Attach image" onClick={() => imageInputRef.current?.click()}>
                <ImagePlus size={16} strokeWidth={1.8} />
              </ToolbarButton>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
                multiple
                className="hidden"
                aria-label="Image files"
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = '';
                  void addImages(files);
                }}
              />
              <ToolbarButton label="Emoji" active={showEmoji} onClick={() => setShowEmoji((v) => !v)}>
                <SmilePlus size={16} strokeWidth={1.8} />
              </ToolbarButton>
              <ToolbarButton
                label={showFormatting ? 'Hide formatting' : 'Show formatting'}
                active={showFormatting}
                onClick={() => setShowFormatting((v) => !v)}
              >
                <Type size={16} strokeWidth={1.8} />
              </ToolbarButton>
              {showEmoji ? (
                <EmojiPicker
                  onPick={(emoji) => {
                    insert(emoji);
                    setShowEmoji(false);
                  }}
                  onClose={() => setShowEmoji(false)}
                />
              ) : null}
            </div>

            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-[background-color,color,transform] duration-fast ease-out',
                canSend
                  ? 'bg-primary text-primary-foreground hover:bg-primary-hover active:scale-95'
                  : 'cursor-default bg-subtle text-content-faint',
              )}
              aria-label="Send message"
              title="Send (Enter)"
            >
              {sending ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.4} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick(): void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()} // keep the textarea selection
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors duration-fast hover:bg-subtle hover:text-content-strong',
        active && 'bg-subtle text-content-strong',
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-line" />;
}

/**
 * An attachment travels as a link to a local file. Agents run on this
 * machine, so the path is all they need; the transcript renders it as a chip.
 */
function attachmentLink(path: string): string {
  const normalised = path.replace(/\\/g, '/');
  const url = `file://${normalised.startsWith('/') ? '' : '/'}${normalised}`;
  const label = basename(path).replace(/[[\]\\]/g, '\\$&');
  return `[${label}](<${url}>)`;
}

const ALL_OPTION = {
  id: '__all__',
  name: 'all',
  avatarColor: '#A78BFA',
  avatar: '',
  runtimeType: 'claude-code',
} as unknown as Agent;
