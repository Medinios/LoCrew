import * as Dialog from '@radix-ui/react-dialog';
import { FilePlus2, FileText, Terminal, Wrench } from 'lucide-react';
import { useState } from 'react';
import type { ApprovalFileChange, ApprovalRequestView, DiffHunk } from '@shared/types';
import { Avatar, Button, Chip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { useApp } from '@/stores/app';

/** An hour is the session length most of a working sitting needs. */
const SESSION_HOUR_MS = 60 * 60 * 1000;

/**
 * The question an agent's write stops on: what it would change, and whether to
 * allow it.
 *
 * Shown in the app rather than as a native message box, because a decision
 * about a write needs the diff in front of it. Closing it is a denial: the
 * safe direction, and the agent is told so rather than left hanging.
 */
export function ApprovalDialog() {
  const approvals = useApp((s) => s.approvals);
  const respond = useApp((s) => s.respondToApproval);
  const request = approvals[0];

  if (!request) return null;
  return (
    <ApprovalPrompt
      key={request.id}
      request={request}
      waiting={approvals.length - 1}
      onRespond={(choice) => void respond(request.id, choice)}
    />
  );
}

function ApprovalPrompt({
  request,
  waiting,
  onRespond,
}: {
  request: ApprovalRequestView;
  waiting: number;
  onRespond(choice: Parameters<ReturnType<typeof useApp.getState>['respondToApproval']>[1]): void;
}) {
  const [wholeDirectory, setWholeDirectory] = useState(false);
  const deny = () => onRespond({ decision: 'deny' });
  const session = (durationMs: number | null) =>
    onRespond({
      decision: 'session',
      durationMs,
      scope: wholeDirectory && request.workingDirectory ? 'directory' : 'agent',
    });

  return (
    <Dialog.Root open onOpenChange={(open) => !open && deny()}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-no-drag fixed inset-0 z-overlay bg-shell/55 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            'app-no-drag fixed left-1/2 top-1/2 z-overlay flex max-h-[85vh] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden outline-none',
            'rounded-xl border border-line bg-surface shadow-dialog',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=open]:duration-base',
          )}
        >
          <header className="flex items-start gap-3 border-b border-line px-5 py-4">
            <Avatar
              name={request.agentName}
              color={request.agentColor}
              emoji={request.agentAvatar}
              size={32}
              agent
              ring
            />
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-title font-semibold text-content-strong">
                <bdi>{request.agentName}</bdi> wants to {describe(request)}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-content-muted">
                <Chip tone="neutral">
                  {request.kind === 'tool' ? <Wrench size={10} /> : <Terminal size={10} />}
                  {request.toolName}
                </Chip>
                {request.workingDirectory ? (
                  <span className="truncate font-mono" title={request.workingDirectory}>
                    {request.workingDirectory}
                  </span>
                ) : null}
              </Dialog.Description>
            </div>
            {waiting > 0 ? (
              <Chip tone="warning" className="shrink-0">
                {waiting} more waiting
              </Chip>
            ) : null}
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {request.file ? <FileDiff file={request.file} /> : null}

            {request.command ? (
              <section>
                <p className="mb-1 text-2xs font-semibold uppercase tracking-label text-content-faint">Command</p>
                <pre className="selectable overflow-x-auto rounded-md border border-line bg-subtle px-3 py-2 font-mono text-xs leading-5 text-content-strong">
                  {request.command}
                </pre>
              </section>
            ) : null}

            {request.details ? (
              <section>
                <p className="mb-1 text-2xs font-semibold uppercase tracking-label text-content-faint">
                  {request.kind === 'tool' ? 'Arguments' : 'Other details'}
                </p>
                <pre className="selectable max-h-48 overflow-auto rounded-md border border-line bg-subtle px-3 py-2 font-mono text-2xs leading-5 text-content">
                  {request.details}
                </pre>
              </section>
            ) : null}

            {!request.file && !request.command && !request.details ? (
              <p className="text-xs text-content-muted">This tool was called with no arguments.</p>
            ) : null}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-canvas px-5 py-3">
            {request.canOpenSession && request.workingDirectory ? (
              <label className="flex items-center gap-2 text-2xs text-content-muted">
                <input
                  type="checkbox"
                  checked={wholeDirectory}
                  onChange={(event) => setWholeDirectory(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                />
                Apply to every agent working in this directory
              </label>
            ) : (
              <span />
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={deny} className="text-danger-ink hover:bg-danger/[0.07]">
                Deny
              </Button>
              {request.canOpenSession ? (
                <>
                  <Button variant="surface" size="sm" onClick={() => session(SESSION_HOUR_MS)}>
                    Allow for 1 hour
                  </Button>
                  <Button variant="surface" size="sm" onClick={() => session(null)}>
                    Until I end it
                  </Button>
                </>
              ) : null}
              <Button variant="primary" size="sm" onClick={() => onRespond({ decision: 'once' })}>
                Allow once
              </Button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** "edit src/auth.ts", "create a file", "run a command", "use notes → append". */
function describe(request: ApprovalRequestView): string {
  if (request.file) {
    return `${request.file.kind === 'create' ? 'create' : 'edit'} ${request.file.display}`;
  }
  if (request.command) return 'run a command';
  if (request.kind === 'tool') return `use ${request.toolName}`;
  return `run ${request.toolName}`;
}

function FileDiff({ file }: { file: ApprovalFileChange }) {
  return (
    <section className="overflow-hidden rounded-md border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-subtle px-3 py-2">
        <span className="shrink-0 text-content-muted">
          {file.kind === 'create' ? <FilePlus2 size={13} /> : <FileText size={13} />}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-content-strong" title={file.path}>
          {file.display}
        </span>
        {file.kind === 'create' ? <Chip tone="success">New file</Chip> : null}
        {file.added ? <span className="shrink-0 text-2xs font-medium tabular-nums text-success-ink">+{file.added}</span> : null}
        {file.removed ? <span className="shrink-0 text-2xs font-medium tabular-nums text-danger-ink">-{file.removed}</span> : null}
      </div>

      {file.note ? (
        <p className="border-b border-line bg-warning/[0.08] px-3 py-2 text-2xs leading-relaxed text-warning-ink">
          {file.note}
        </p>
      ) : null}

      {file.hunks.length ? (
        <div className="max-h-[42vh] overflow-auto bg-surface font-mono text-[11.5px] leading-[18px]">
          {file.hunks.map((hunk, index) => (
            <Hunk key={`${hunk.oldStart}-${hunk.newStart}-${index}`} hunk={hunk} first={index === 0} />
          ))}
          {file.truncated ? (
            <p className="border-t border-line bg-subtle px-3 py-1.5 font-sans text-2xs text-content-muted">
              The rest of this change is too long to show here.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Hunk({ hunk, first }: { hunk: DiffHunk; first: boolean }) {
  return (
    <div className={cn(!first && 'border-t border-line')}>
      <p className="bg-subtle/70 px-3 py-1 text-2xs text-content-faint">
        Line {hunk.newStart || hunk.oldStart}
      </p>
      {hunk.lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            'flex',
            line.kind === 'add' && 'bg-success/[0.1]',
            line.kind === 'remove' && 'bg-danger/[0.08]',
          )}
        >
          <span className="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-content-faint/70">
            {line.oldLine ?? ''}
          </span>
          <span className="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-content-faint/70">
            {line.newLine ?? ''}
          </span>
          <span
            className={cn(
              'w-4 shrink-0 select-none text-center',
              line.kind === 'add' && 'text-success-ink',
              line.kind === 'remove' && 'text-danger-ink',
              line.kind === 'context' && 'text-content-faint/60',
            )}
          >
            {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
          </span>
          <span
            className={cn(
              'selectable whitespace-pre pr-3',
              line.kind === 'context' ? 'text-content-muted' : 'text-content-strong',
            )}
          >
            {line.text || ' '}
          </span>
        </div>
      ))}
    </div>
  );
}
