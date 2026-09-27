import { Bug, Check, Code2, Copy, MessagesSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/types';
import { BrandMark } from '@/components/brand/BrandMark';
import { Button } from '@/components/ui/primitives';
import { CREDITS } from '@/lib/credits';
import { SHIP } from '@/lib/lexicon';
import { LINKS } from '@/lib/links';
import { cn } from '@/lib/utils';
import { invoke } from '@/stores/app';

/**
 * What this app is, where it lives, and what it is built on.
 *
 * The credits list is generated from the installed packages by
 * `npm run credits`, so it says what actually ships rather than what someone
 * remembered to write down.
 */
export function AboutPane() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void invoke('app:info')
      .then((result) => !cancelled && setInfo(result))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const copyDiagnostics = async () => {
    if (!info) return;
    const lines = [
      `${SHIP.appName} ${info.version}`,
      `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}`,
      `Platform ${info.platform}`,
    ];
    await navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-shell shadow-panel">
          <BrandMark size={32} />
        </span>
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-content-strong">{SHIP.appName}</h2>
          <p className="text-nav font-medium text-primary-ink">{SHIP.tagline}</p>
          <p className="mt-1 text-2xs tabular-nums text-content-muted">
            {info ? `Version ${info.version}` : 'Version …'}
          </p>
        </div>
      </header>

      <p className="max-w-xl text-body leading-relaxed text-content">
        A desktop workspace where AI agents are members of a conversation: direct messages, channels, and hand-offs
        between agents, running on your own machine. Built as an open-source project — contributions and bug reports
        are welcome.
      </p>

      <section className="grid gap-2 sm:grid-cols-2">
        <LinkCard
          href={LINKS.repository}
          icon={<Code2 size={15} />}
          title="Source code"
          detail="github.com/Medinios/LoCrew"
        />
        <LinkCard
          href={LINKS.issues}
          icon={<Bug size={15} />}
          title="Report a bug"
          detail="Open an issue on GitHub"
        />
        <LinkCard
          href={LINKS.discord}
          icon={<MessagesSquare size={15} />}
          title="Discord"
          detail={LINKS.discord ? 'Join the community' : 'Coming soon'}
        />
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-content-strong">Built with</h3>
        <p className="text-2xs leading-relaxed text-content-muted">
          {SHIP.appName} ships these open-source projects. Versions and licences are read from what is installed.
        </p>
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {CREDITS.map((credit) => (
            <li key={credit.name} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <a
                  href={credit.homepage || undefined}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block truncate font-mono text-xs text-content-strong hover:text-primary-ink"
                >
                  {credit.name}
                </a>
                {credit.role ? <span className="block truncate text-2xs text-content-muted">{credit.role}</span> : null}
              </span>
              <span className="shrink-0 text-2xs tabular-nums text-content-faint">{credit.version}</span>
              <span className="w-32 shrink-0 truncate text-right text-2xs text-content-muted" title={credit.license}>
                {credit.license}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold text-content-strong">This installation</h3>
          <Button variant="ghost" size="sm" onClick={() => void copyDiagnostics()} disabled={!info}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? 'Copied' : 'Copy versions'}
          </Button>
        </div>
        <dl className="overflow-hidden rounded-lg border border-line bg-surface text-xs">
          <Row label="Electron" value={info?.electron} />
          <Row label="Chromium" value={info?.chrome} />
          <Row label="Node.js" value={info?.node} />
          <Row label="Platform" value={info?.platform} />
          <Row label="Data folder" value={info?.dataDirectory} mono />
        </dl>
      </section>

      <p className="text-2xs leading-relaxed text-content-muted">
        No licence has been set for {SHIP.appName} itself yet, so the terms for reusing its code are still open.
      </p>
    </div>
  );
}

function LinkCard({
  href,
  icon,
  title,
  detail,
}: {
  href: string | null;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  const className = cn(
    'flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5 text-left transition-colors duration-fast',
    href ? 'hover:border-line-strong hover:bg-subtle' : 'opacity-60',
  );
  const body = (
    <>
      <span className={cn('shrink-0', href ? 'text-primary-ink' : 'text-content-faint')}>{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold text-content-strong">{title}</span>
        <span className="block truncate text-2xs text-content-muted">{detail}</span>
      </span>
    </>
  );

  if (!href) {
    return (
      <div className={className} aria-disabled>
        {body}
      </div>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
      {body}
    </a>
  );
}

function Row({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-0">
      <dt className="shrink-0 text-content-muted">{label}</dt>
      <dd
        className={cn('min-w-0 truncate text-right text-content-strong', mono && 'font-mono text-2xs')}
        title={value}
      >
        {value ?? '…'}
      </dd>
    </div>
  );
}
