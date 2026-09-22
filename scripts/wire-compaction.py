"""Records runtime compaction in the transcript and renders a marker for it."""

import io


def patch(path, pairs):
    text = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in text, f'{path}: not found -> {old[:70]}'
        text = text.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(text)
    print('wired', path)


ORCH_OLD = """          case 'state':
            this.setState(job, event.state);
            break;"""

ORCH_NEW = """          case 'state':
            this.setState(job, event.state);
            break;

          case 'compaction': {
            record('compaction', { ...event });
            // A compaction changes what the agent remembers, so it belongs in
            // the transcript. Stored history is untouched: this only marks
            // where the model's own view of the session was condensed.
            const before = event.preTokens.toLocaleString();
            const after = event.postTokens?.toLocaleString();
            const marker = store.insertMessage({
              conversationId: job.conversationId,
              senderType: 'agent',
              senderId: agent.id,
              kind: 'compaction',
              body:
                after === undefined
                  ? `${agent.name} compacted its own history at ${before} tokens. Nothing was removed from this transcript.`
                  : `${agent.name} compacted its own history: ${before} to ${after} tokens. Nothing was removed from this transcript.`,
              executionId: job.executionId,
            });
            this.deps.emit({ type: 'message', message: marker });
            break;
          }"""

patch('src/main/orchestrator/orchestrator.ts', [(ORCH_OLD, ORCH_NEW)])

MARKER = """/** A hairline through the transcript where the runtime condensed its memory. */
function CompactionMarker({ message }: { message: Message }) {
  return (
    <div className="my-3 flex items-center gap-3" title={message.body}>
      <span className="h-px flex-1 bg-line" />
      <span className="flex items-center gap-1.5 whitespace-nowrap text-2xs text-content-faint">
        <Layers size={11} />
        {message.body}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function MarkdownBody({ body }: { body: string }) {"""

patch('src/renderer/src/components/chat/MessageItem.tsx', [
    (
        "import { AlertTriangle, Check, Copy, ShieldAlert } from 'lucide-react';",
        "import { AlertTriangle, Check, Copy, Layers, ShieldAlert } from 'lucide-react';",
    ),
    (
        """  const isSystemish = message.kind === 'limit_notice' || message.kind === 'system';

  if (isSystemish) return <SystemNotice message={message} />;""",
        """  if (message.kind === 'compaction') return <CompactionMarker message={message} />;

  const isSystemish = message.kind === 'limit_notice' || message.kind === 'system';
  if (isSystemish) return <SystemNotice message={message} />;""",
    ),
    ('function MarkdownBody({ body }: { body: string }) {', MARKER),
])
