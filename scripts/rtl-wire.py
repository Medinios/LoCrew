"""Applies detected direction to every surface that carries user or agent text."""

import io


def patch(path, pairs):
    text = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in text, f'{path}: not found -> {old[:70]}'
        text = text.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(text)
    print('wired', path)


# --- Message bodies ----------------------------------------------------------
patch('src/renderer/src/components/chat/MessageItem.tsx', [
    (
        "import { cn, formatTime } from '@/lib/utils';",
        "import { detectDirection } from '@/lib/direction';\n"
        "import { cn, formatTime } from '@/lib/utils';",
    ),
    (
        """function MarkdownBody({ body }: { body: string }) {
  return (
    <div className="prose-message selectable">""",
        """function MarkdownBody({ body }: { body: string }) {
  // Weighted detection rather than dir="auto": a Hebrew message that opens with
  // an @mention would otherwise render left-to-right.
  return (
    <div className="prose-message selectable" dir={detectDirection(body)}>""",
    ),
    (
        """          <div className="flex items-start gap-2 rounded-md border border-danger/35 bg-danger/10 px-3 py-2">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
            <p className="selectable text-xs leading-relaxed text-content">{message.body}</p>
          </div>""",
        """          <div className="flex items-start gap-2 rounded-md border border-danger/35 bg-danger/10 px-3 py-2">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
            <p
              className="selectable text-xs leading-relaxed text-content"
              dir={detectDirection(message.body)}
            >
              {message.body}
            </p>
          </div>""",
    ),
    (
        """      <p className="selectable text-xs leading-relaxed text-content-muted">{message.body}</p>""",
        """      <p
        className="selectable text-xs leading-relaxed text-content-muted"
        dir={detectDirection(message.body)}
      >
        {message.body}
      </p>""",
    ),
    # A sender name in another script must not reorder the byline around it.
    (
        '<span className="text-[13px] font-semibold tracking-tight">{name}</span>',
        '<bdi className="text-[13px] font-semibold tracking-tight">{name}</bdi>',
    ),
])

# --- Composer ----------------------------------------------------------------
patch('src/renderer/src/components/chat/Composer.tsx', [
    (
        "import { cn } from '@/lib/utils';",
        "import { detectDirection } from '@/lib/direction';\nimport { cn } from '@/lib/utils';",
    ),
    (
        """            onClick={(event) => detectMention(value, event.currentTarget.selectionStart)}
            placeholder={placeholder}""",
        """            onClick={(event) => detectMention(value, event.currentTarget.selectionStart)}
            placeholder={placeholder}
            dir={detectDirection(value)}""",
    ),
])

# --- Streaming reply ---------------------------------------------------------
patch('src/renderer/src/components/chat/ChatView.tsx', [
    (
        "import { formatDay } from '@/lib/utils';",
        "import { detectDirection } from '@/lib/direction';\nimport { formatDay } from '@/lib/utils';",
    ),
    (
        """            <div className="prose-message selectable mt-1.5 whitespace-pre-wrap">{text}</div>""",
        """            <div
              className="prose-message selectable mt-1.5 whitespace-pre-wrap"
              dir={detectDirection(text)}
            >
              {text}
            </div>""",
    ),
    (
        """            <span className="text-[13px] font-semibold tracking-tight">{agentName}</span>""",
        """            <bdi className="text-[13px] font-semibold tracking-tight">{agentName}</bdi>""",
    ),
    # Channel name and topic are user-authored and may be in any script.
    (
        """            <h1 className="truncate text-[14px] font-semibold tracking-tight">
              {conversation.name}
            </h1>""",
        """            <h1 className="truncate text-[14px] font-semibold tracking-tight">
              <bdi>{conversation.name}</bdi>
            </h1>""",
    ),
    (
        """                <span className="truncate">{conversation.topic}</span>""",
        """                <bdi className="truncate">{conversation.topic}</bdi>""",
    ),
])

# --- Sidebar rows ------------------------------------------------------------
patch('src/renderer/src/components/layout/Sidebar.tsx', [
    (
        """      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}""",
        """      {icon}
      <bdi className="min-w-0 flex-1 truncate">{label}</bdi>
      {trailing}""",
    ),
    (
        """                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>""",
        """                  <bdi className="min-w-0 flex-1 truncate">{agent.name}</bdi>""",
    ),
])

# --- Details panel -----------------------------------------------------------
patch('src/renderer/src/components/layout/RightPanel.tsx', [
    (
        """                  <p className="truncate text-xs text-content hover:text-primary">{agent.name}</p>""",
        """                  <bdi className="block truncate text-xs text-content hover:text-primary">
                    {agent.name}
                  </bdi>""",
    ),
    (
        """          <p
            className={cn(
              'truncate text-xs text-content',
              task.status === 'completed' && 'text-content-muted line-through',
            )}
          >
            {task.title}
          </p>""",
        """          <bdi
            className={cn(
              'block truncate text-xs text-content',
              task.status === 'completed' && 'text-content-muted line-through',
            )}
          >
            {task.title}
          </bdi>""",
    ),
])
