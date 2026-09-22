import * as Dialog from '@radix-ui/react-dialog';
import hljs from 'highlight.js/lib/common';
import {
  AlertTriangle,
  AtSign,
  Bot,
  Check,
  Copy,
  FileText,
  ImageOff,
  Layers,
  ShieldAlert,
  SmilePlus,
  X,
} from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Agent, Message } from '@shared/types';
import { Avatar, Chip } from '@/components/ui/primitives';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { EmojiPicker } from '@/components/chat/EmojiPicker';
import { MessageReactions, type MessageReactionsView } from '@/components/chat/MessageReactions';
import { engineLabel } from '@/lib/agents';
import { detectDirection } from '@/lib/direction';
import {
  fileUrlToPath,
  isLocalImageUrl,
  localImageUrl,
  localPathOf,
  pathToFileUrl,
} from '@/lib/local-files';
import { displayNameOf } from '@/lib/people';
import { rehypeIsolateMentions } from '@/lib/rehype-isolate-mentions';
import { basename, cn, formatTime, mentionKey } from '@/lib/utils';
import { useApp } from '@/stores/app';

/**
 * One message in the transcript, laid straight onto the surface: no bubble,
 * no card. Humans and agents share exactly the same structure; an agent is
 * marked only by its rounded-square avatar and a small lavender ✦.
 *
 * Consecutive messages from the same sender within five minutes are collapsed
 * into a single visual block, which is what keeps a long agent exchange
 * readable instead of a wall of repeated avatars.
 */
export const MessageItem = memo(function MessageItem({
  message,
  agent,
  previous,
  reactions,
  onJumpToReply,
  onToggleReaction,
  highlight,
}: {
  message: Message;
  agent?: Agent;
  previous?: Message;
  /** Matches the conversation search: `current` is the one being shown. */
  highlight?: 'match' | 'current';
  /** Agent activity and the user's reactions on this message, and replies it drew. */
  reactions?: MessageReactionsView;
  onJumpToReply?(messageId: string): void;
  /** Adds or removes the user's own reaction. Absent where reacting makes no sense. */
  onToggleReaction?(messageId: string, emoji: string): void;
}) {
  const settings = useApp((s) => s.settings);
  const setEditingAgent = useApp((s) => s.setEditingAgent);
  const providers = useApp((s) => s.providers);
  const [picking, setPicking] = useState(false);

  if (message.kind === 'compaction') return <CompactionMarker message={message} />;
  if (message.kind === 'limit_notice' || message.kind === 'system') {
    return <SystemNotice message={message} />;
  }

  const isHuman = message.senderType === 'human';
  const grouped =
    previous !== undefined &&
    previous.senderId === message.senderId &&
    previous.kind === message.kind &&
    message.createdAt - previous.createdAt < 5 * 60 * 1000;

  const name = isHuman ? displayNameOf(settings) : (agent?.name ?? 'Agent');
  const runtime = agent ? engineLabel(agent, providers) : null;

  return (
    <article
      id={`msg-${message.id}`}
      className={cn(
        'group/message relative flex gap-3 px-5 transition-colors duration-fast ease-out hover:bg-subtle/70',
        grouped ? 'py-0.5' : 'pb-1 pt-2',
        highlight === 'match' && 'bg-warning/[0.06]',
        highlight === 'current' && 'bg-warning/[0.14] shadow-[inset_2px_0_0_hsl(var(--warning))]',
      )}
    >
      <div className="w-8 shrink-0">
        {grouped ? (
          <span className="hidden pt-[3px] text-right text-[10px] leading-4 tabular-nums text-content-faint group-hover/message:block">
            {formatTime(message.createdAt)}
          </span>
        ) : isHuman ? (
          <UserAvatar size={32} />
        ) : (
          <Avatar name={name} color={agent?.avatarColor} emoji={agent?.avatar} size={32} agent ring />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped ? (
          <div className="flex h-5 items-baseline gap-1.5">
            {agent ? (
              <button
                type="button"
                onClick={() => setEditingAgent(agent.id)}
                title={`${agent.name} · ${runtime}`}
                className="bidi-isolate text-nav font-semibold text-content-strong hover:text-primary-ink"
              >
                {name}
              </button>
            ) : (
              <bdi className="text-nav font-semibold text-content-strong">{name}</bdi>
            )}
            {!isHuman ? (
              <span className="translate-y-[-1px] text-[10px] leading-none text-ai-ink" role="img" aria-label="AI agent" title="AI agent">
                ✦
              </span>
            ) : null}
            <time className="ml-0.5 text-2xs tabular-nums text-content-faint">{formatTime(message.createdAt)}</time>
            {message.kind === 'task_update' ? <Chip className="self-center">Task update</Chip> : null}
          </div>
        ) : null}

        <div>
          {message.kind === 'execution_error' ? (
            <div className="mt-0.5 flex items-start gap-2 rounded-md border border-danger/25 bg-danger/[0.05] px-3 py-2">
              <AlertTriangle size={13} className="mt-[3px] shrink-0 text-danger" />
              <p
                className="selectable text-[12.5px] leading-[19px] text-content"
                dir={detectDirection(message.body)}
              >
                {message.body}
              </p>
            </div>
          ) : message.body ? (
            <MarkdownBody body={message.body} baseDir={agent?.workingDirectory} />
          ) : null}
        </div>

        {message.attachments.length ? (
          <div className="mt-1 flex flex-wrap items-start gap-2" aria-label="Attached images">
            {message.attachments.map((attachment) => (
              <MessageImage key={attachment.id} src={localImageUrl(attachment.path)} alt="" name={attachment.name} compact />
            ))}
          </div>
        ) : null}

        {reactions ? (
          <MessageReactions
            view={reactions}
            onToggle={onToggleReaction ? (emoji) => onToggleReaction(message.id, emoji) : undefined}
            onJumpToReply={onJumpToReply ? () => onJumpToReply(message.id) : undefined}
          />
        ) : null}
      </div>

      {/* Stays open while the picker is, even once the pointer leaves the row. */}
      <div
        className={cn(
          'absolute right-5 top-1 hidden items-center gap-px rounded-md border border-line bg-surface p-0.5 shadow-popover group-hover/message:flex',
          picking && 'flex',
        )}
      >
        {onToggleReaction ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setPicking((v) => !v)}
              aria-label="Add reaction"
              title="Add reaction"
              aria-expanded={picking}
              className={TOOL_BUTTON}
            >
              <SmilePlus size={13} />
            </button>
            {picking ? (
              <EmojiPicker
                label="Add reaction"
                placement="below-end"
                onPick={(emoji) => {
                  setPicking(false);
                  onToggleReaction(message.id, emoji);
                }}
                onClose={() => setPicking(false)}
              />
            ) : null}
          </div>
        ) : null}
        <CopyAction text={message.body} />
      </div>
    </article>
  );
});

const TOOL_BUTTON =
  'flex h-7 w-7 items-center justify-center rounded-[6px] text-content-muted transition-colors duration-fast hover:bg-subtle hover:text-content-strong';

/** Copy the raw message, revealed on hover. */
function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
      aria-label="Copy message"
      title="Copy message"
      className={TOOL_BUTTON}
    >
      {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
    </button>
  );
}

function SystemNotice({ message }: { message: Message }) {
  return (
    <div className="mx-5 my-2 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/[0.06] px-3 py-2">
      <ShieldAlert size={13} className="mt-[3px] shrink-0 text-warning-ink" />
      <p
        className="selectable text-[12.5px] leading-[19px] text-content-muted"
        dir={detectDirection(message.body)}
      >
        {message.body}
      </p>
    </div>
  );
}

/** A hairline through the transcript where the runtime condensed its memory. */
function CompactionMarker({ message }: { message: Message }) {
  return (
    <div className="my-3 flex items-center gap-3 px-5" title={message.body}>
      <span className="h-px flex-1 bg-line" />
      <span className="flex items-center gap-1.5 whitespace-nowrap text-2xs font-medium text-content-faint">
        <Layers size={11} />
        {message.body}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * Decides what each URL in a message may become.
 *
 * Local paths are what agents naturally write (`D:/app/shot.png`), and the
 * default filter would blank them because `D:` looks like an unknown scheme.
 * Images are routed through the main process's `aw-image://` scheme; links to
 * local files become copy-the-path chips. Everything else keeps the default
 * filter, plus inline `data:image/` for images.
 */
function transformUrl(url: string, key: string, baseDir?: string): string {
  const local = localPathOf(url, baseDir);
  if (key === 'src') {
    if (local) return localImageUrl(local);
    if (/^data:image\/(png|jpe?g|gif|webp);/i.test(url)) return url;
  } else if (local && (/^file:/i.test(url) || /^[A-Za-z]:[\\/]/.test(url))) {
    return pathToFileUrl(local);
  }
  return defaultUrlTransform(url);
}

export function MarkdownBody({ body, baseDir }: { body: string; baseDir?: string }) {
  // Weighted detection rather than dir="auto": a Hebrew message that opens with
  // an @mention would otherwise render left-to-right.
  return (
    <div className="prose-message selectable" dir={detectDirection(body)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeIsolateMentions]}
        urlTransform={(url, key) => transformUrl(url, key, baseDir)}
        components={{
          // Every fenced block, with or without a language, arrives as <pre><code>.
          // Blocks are handled here so `code` below only ever sees inline spans.
          pre({ node, children }) {
            const inner = node?.children[0];
            if (inner?.type === 'element' && inner.tagName === 'code') {
              const classes = inner.properties?.className;
              const list = Array.isArray(classes) ? classes.map(String) : [];
              const language =
                list.find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? '';
              return <CodeBlock language={language} code={hastText(inner).replace(/\n$/, '')} />;
            }
            return <pre>{children}</pre>;
          },
          code({ className, children }) {
            return <code className={className}>{children}</code>;
          },
          a({ children, href }) {
            if (href?.startsWith('file:')) return <AttachmentChip href={href}>{children}</AttachmentChip>;
            // Links open in the system browser via the main process handler.
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            return <MessageImage src={typeof src === 'string' ? src : ''} alt={alt ?? ''} />;
          },
          bdi({ className, children }) {
            if (typeof className === 'string' && className.includes('mention-token')) {
              return <MentionToken text={flatText(children)} />;
            }
            return <bdi className={className}>{children}</bdi>;
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

/** Concatenated text of a hast subtree. */
function hastText(node: { type: string; value?: unknown; children?: unknown[] }): string {
  if (node.type === 'text') return String(node.value ?? '');
  return (node.children ?? [])
    .map((child) => hastText(child as { type: string; value?: unknown; children?: unknown[] }))
    .join('');
}

function flatText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(flatText).join('');
  return String(children ?? '');
}

/**
 * An `@agent` or `#channel` token.
 *
 * A real agent becomes a grey pill with a bot glyph; a real channel becomes a
 * link to it; anything else stays text. Every variant is still a single
 * isolated `<bdi>`, which is what keeps it readable inside RTL paragraphs.
 */
function MentionToken({ text }: { text: string }) {
  const agents = useApp((s) => s.agents);
  const conversations = useApp((s) => s.conversations);
  const select = useApp((s) => s.selectConversation);

  const sigil = text[0];
  const key = mentionKey(text.slice(1));

  if (sigil === '@') {
    if (key === 'all' || key === 'everyone' || key === 'channel') {
      return (
        <bdi className="mention-token mention-chip" title="Everyone in this channel">
          <AtSign size={11} strokeWidth={2.4} />
          {text.slice(1)}
        </bdi>
      );
    }
    const agent =
      agents.find((a) => mentionKey(a.name) === key) ??
      agents.find((a) => mentionKey(a.name.split(/\s+/)[0] ?? '') === key);
    if (agent) {
      return (
        <bdi className="mention-token mention-chip" title={`@${agent.name}`}>
          <Bot size={12} strokeWidth={2} />
          {agent.name}
        </bdi>
      );
    }
  }

  if (sigil === '#') {
    const channel = conversations.find(
      (c) => c.kind === 'channel' && c.name.toLowerCase() === text.slice(1).toLowerCase(),
    );
    if (channel) {
      return (
        <bdi className="mention-token mention-link" role="link" onClick={() => void select(channel.id)}>
          {text}
        </bdi>
      );
    }
  }

  return <bdi className="mention-token font-medium">{text}</bdi>;
}

/** A referenced local file. Clicking copies its path; nothing is opened. */
function AttachmentChip({ href, children }: { href: string; children: ReactNode }) {
  const path = useMemo(() => fileUrlToPath(href), [href]);
  const [copied, setCopied] = useState(false);
  const label = flatText(children) || basename(path);

  return (
    <button
      type="button"
      title={`${path}\nClick to copy the path`}
      onClick={() => {
        void navigator.clipboard.writeText(path).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
      className="my-[1px] inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2 align-middle text-xs font-medium text-content transition-colors duration-fast hover:border-line-strong hover:bg-subtle"
    >
      {copied ? (
        <Check size={12} className="shrink-0 text-success" />
      ) : (
        <FileText size={12} className="shrink-0 text-content-muted" />
      )}
      <span className="truncate">{copied ? 'Path copied' : label}</span>
    </button>
  );
}

/**
 * An image in a message. Local screenshots come over `aw-image://` and open
 * full size on click. Web images are not fetched automatically -- that would
 * tell a third party when you read the message -- so they show as a link.
 */
function MessageImage({
  src,
  alt,
  name,
  compact = false,
}: {
  src: string;
  alt: string;
  /** Display name for an attached image, whose file has a generated name. */
  name?: string;
  /** Smaller, captionless, for a row of attached images. */
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const path = isLocalImageUrl(src)
    ? decodeURIComponent(src.replace(/^aw-image:\/\/local\//, ''))
    : '';
  const label = name || alt || basename(path) || 'Image';

  if (/^https?:/i.test(src)) {
    return (
      <a href={src} target="_blank" rel="noreferrer noopener" title={src}>
        {alt || src}
      </a>
    );
  }

  if (!src || failed) {
    return (
      <span
        title={path || src}
        className="my-1 flex w-fit max-w-full items-center gap-2 rounded-md border border-line bg-subtle px-2.5 py-1.5 text-xs text-content-muted"
      >
        <ImageOff size={14} className="shrink-0 text-content-faint" />
        <span className="min-w-0">
          <span className="block truncate font-medium text-content">{label}</span>
          <span className="block truncate text-[11px] text-content-faint">
            {name
              ? 'This image is no longer available.'
              : path
                ? 'Could not open this file. Images are shown from agent working directories only.'
                : 'This image could not be shown.'}
          </span>
        </span>
      </span>
    );
  }

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          title={path ? `${label} · click to enlarge` : label}
          className={cn('group/img block w-fit max-w-full cursor-zoom-in text-start', compact ? '' : 'my-1')}
        >
          <img
            src={src}
            alt={alt || name || ''}
            loading="lazy"
            draggable={false}
            onError={() => setFailed(true)}
            className={cn(
              'block w-auto rounded-md border border-line bg-subtle object-contain transition-[filter] duration-fast group-hover/img:brightness-[0.97]',
              // A fixed cap in compact mode: a percentage inside the fit-content
              // button would keep the button as wide as the image's natural size.
              compact ? 'max-h-[220px] max-w-[320px]' : 'max-h-[320px] max-w-[min(100%,460px)]',
            )}
          />
          {alt ? <span className="mt-1 block text-[11.5px] text-content-faint">{alt}</span> : null}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="app-no-drag fixed inset-0 z-overlay bg-shell/85 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="app-no-drag fixed inset-0 z-overlay flex flex-col items-center justify-center gap-3 p-8 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          <Dialog.Close asChild>
            <img
              src={src}
              alt={alt}
              className="max-h-[calc(100vh-120px)] max-w-full cursor-zoom-out rounded-lg bg-white object-contain shadow-dialog"
            />
          </Dialog.Close>
          <div className="flex max-w-full items-center gap-2 text-[12px] text-white/85">
            <span className="truncate">{label}</span>
            {path ? (
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(path)}
                className="shrink-0 rounded-md bg-white/10 px-2 py-1 font-medium text-white transition-colors hover:bg-white/20"
              >
                Copy path
              </button>
            ) : null}
            <Dialog.Close
              aria-label="Close"
              className="shrink-0 rounded-md bg-white/10 p-1 text-white transition-colors hover:bg-white/20"
            >
              <X size={14} />
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const highlighted = useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(code, { language }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      return null;
    }
  }, [code, language]);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div dir="ltr" className="group/code relative my-1.5 overflow-hidden rounded-md border border-line bg-surface">
      <div className="flex h-7 items-center justify-between border-b border-line bg-subtle/70 pl-3 pr-1">
        <span className="font-mono text-[10.5px] text-content-faint">{language || 'code'}</span>
        <button
          onClick={() => void copy()}
          className="flex h-5 items-center gap-1 rounded-sm px-1.5 text-[10.5px] text-content-faint opacity-0 transition-[opacity,color] duration-fast hover:text-content group-hover/code:opacity-100"
        >
          {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        {highlighted ? (
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
}
