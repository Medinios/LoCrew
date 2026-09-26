/**
 * What the usage surfaces actually put on screen.
 *
 * The rule being defended: a number we could not read must never render as
 * "0%". On a bar, "0% used" and "we don't know" look identical and mean
 * opposite things, so every unknown has to arrive on screen as words.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../../src/shared/ipc.js';
import type { QuotaSnapshot } from '../../src/shared/quota.js';
import type { Agent } from '../../src/shared/types.js';
import { DEFAULT_AGENT_CONFIG, DEFAULT_AGENT_PERMISSIONS } from '../../src/shared/types.js';

vi.stubGlobal('window', globalThis.window);
Object.defineProperty(globalThis.window, 'api', {
  writable: true,
  value: {
    invoke: () => Promise.resolve([]),
    onEvent: (_l: (e: AppEvent) => void) => () => undefined,
    platform: 'darwin' as NodeJS.Platform,
  },
});

const { QuotaSection } = await import('../../src/renderer/src/components/usage/QuotaBars.js');
const { UsageChips, UsageBreakdown, describeTotal } = await import(
  '../../src/renderer/src/components/usage/RecordedUsage.js'
);

afterEach(cleanup);

function agentOf(runtimeType: Agent['runtimeType'], id = 'agent:1'): Agent {
  return {
    id,
    name: 'Clark',
    description: '',
    runtimeType,
    avatar: '',
    avatarColor: '#7C6CF6',
    workingDirectory: '/tmp',
    status: 'online',
    statusDetail: null,
    permissions: DEFAULT_AGENT_PERMISSIONS,
    config: DEFAULT_AGENT_CONFIG,
    createdAt: 0,
    updatedAt: 0,
  };
}

const WINDOWS = {
  today: [{ agentId: 'agent:1', costUsd: 1.234, inputTokens: 1000, outputTokens: 500, executions: 3, unverifiedExecutions: 0, unavailableExecutions: 0, unpricedExecutions: 0 }],
  last7Days: [{ agentId: 'agent:1', costUsd: 9.876, inputTokens: 40_000, outputTokens: 12_000, executions: 20, unverifiedExecutions: 0, unavailableExecutions: 0, unpricedExecutions: 0 }],
  todayStartedAt: 0,
  computedAt: 0,
};

/** The same window, but with runs whose spend was never measured. */
const WINDOWS_WITH_UNVERIFIED = {
  ...WINDOWS,
  today: [{ agentId: 'agent:1', costUsd: 1.234, inputTokens: 1000, outputTokens: 500, executions: 5, unverifiedExecutions: 2, unavailableExecutions: 0, unpricedExecutions: 0 }],
};

/** The live Claude Code shape: session, weekly, and a model-scoped weekly. */
const LIVE: QuotaSnapshot = {
  status: 'ok',
  runtimeType: 'claude-code',
  planLabel: 'max',
  windows: [
    { kind: 'session', group: 'session', label: 'Current session', percentUsed: 25, resetsAt: Date.now() + 3_600_000, windowMinutes: null, severity: 'normal', isActive: false },
    { kind: 'weekly_all', group: 'weekly', label: 'Current week (all models)', percentUsed: 15, resetsAt: Date.now() + 86_400_000, windowMinutes: null, severity: 'normal', isActive: true },
    { kind: 'weekly_scoped', group: 'weekly', label: 'Current week (Fable)', percentUsed: 0, resetsAt: Date.now() + 86_400_000, windowMinutes: null, severity: 'normal', isActive: false },
  ],
  observedAt: Date.now() - 120_000,
};

describe('quota bars', () => {
  it('renders the provider percentages and reset times it was given', () => {
    render(<QuotaSection title="Claude Code" snapshot={LIVE} agentCount={2} />);

    expect(screen.getByText('Current session')).toBeTruthy();
    expect(screen.getByText('25% used')).toBeTruthy();
    expect(screen.getByText('15% used')).toBeTruthy();
    // A genuine zero from the provider is a real reading and does render.
    expect(screen.getByText('0% used')).toBeTruthy();
    expect(screen.getByText('Current week (Fable)')).toBeTruthy();
    expect(screen.getAllByText(/Resets/).length).toBe(3);

    const meters = screen.getAllByRole('meter');
    expect(meters).toHaveLength(3);
    expect(meters[0]?.getAttribute('aria-valuenow')).toBe('25');
  });

  it('says the account is shared without claiming to know every consumer', () => {
    render(<QuotaSection title="Claude Code" snapshot={LIVE} agentCount={3} />);

    const note = screen.getByText(/account-wide/i);
    expect(note.textContent).toContain('3 agents here');
    // Other terminals and the website draw on the same plan, so the agent
    // count must never read as the total number of consumers.
    expect(note.textContent).toMatch(/anything else signed in/i);
  });

  it('renders an unreadable quota as words, never as 0%', () => {
    const snapshot: QuotaSnapshot = {
      status: 'unavailable',
      runtimeType: 'claude-code',
      reason: 'unauthenticated',
      detail: 'not signed in',
      observedAt: Date.now(),
      stale: null,
    };
    render(<QuotaSection title="Claude Code" snapshot={snapshot} agentCount={1} />);

    expect(screen.getByText(/Not signed in/i)).toBeTruthy();
    expect(screen.queryByText(/% used/)).toBeNull();
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('distinguishes a plan that does not apply from one that failed', () => {
    for (const [reason, pattern] of [
      ['not_applicable', /No plan quota/i],
      ['unsupported', /no subscription quota/i],
      ['cli_missing', /was not found/i],
      ['schema_mismatch', /does not recognise/i],
    ] as const) {
      cleanup();
      render(
        <QuotaSection
          title="Runtime"
          snapshot={{ status: 'unavailable', runtimeType: 'model', reason, detail: '', observedAt: Date.now(), stale: null }}
          agentCount={1}
        />,
      );
      expect(screen.getByText(pattern)).toBeTruthy();
    }
  });

  it('keeps the last good numbers when a refresh fails, marked with their age', () => {
    const snapshot: QuotaSnapshot = {
      status: 'unavailable',
      runtimeType: 'claude-code',
      reason: 'error',
      detail: 'network down',
      observedAt: Date.now(),
      stale: { planLabel: 'max', windows: LIVE.status === 'ok' ? LIVE.windows : [], observedAt: Date.now() - 600_000 },
    };
    render(<QuotaSection title="Claude Code" snapshot={snapshot} agentCount={1} />);

    // The real 25% survives rather than collapsing to zero.
    expect(screen.getByText('25% used')).toBeTruthy();
    expect(screen.getByText(/Could not refresh/i)).toBeTruthy();
    expect(screen.getByText(/as of/i)).toBeTruthy();
  });

  it('reports a reset that has come due instead of assuming it happened', () => {
    const snapshot: QuotaSnapshot = {
      status: 'ok',
      runtimeType: 'claude-code',
      planLabel: null,
      windows: [
        { kind: 'session', group: 'session', label: 'Current session', percentUsed: 88, resetsAt: Date.now() - 60_000, windowMinutes: null, severity: 'critical', isActive: true },
      ],
      observedAt: Date.now(),
    };
    render(<QuotaSection title="Claude Code" snapshot={snapshot} agentCount={1} />);

    // We know the window was due to reset; we do not know that it did.
    expect(screen.getByText(/Reset due/i)).toBeTruthy();
    expect(screen.getByText('88% used')).toBeTruthy();
  });

  it('shows a percentage over 100 as reported but never overdraws the bar', () => {
    const snapshot: QuotaSnapshot = {
      status: 'ok',
      runtimeType: 'claude-code',
      planLabel: null,
      windows: [
        { kind: 'session', group: 'session', label: 'Current session', percentUsed: 104, resetsAt: null, windowMinutes: null, severity: 'critical', isActive: true },
      ],
      observedAt: Date.now(),
    };
    const { container } = render(<QuotaSection title="Claude Code" snapshot={snapshot} agentCount={1} />);

    expect(screen.getByText('104% used')).toBeTruthy();
    const fill = container.querySelector('[role="meter"] > div') as HTMLElement | null;
    expect(fill?.style.width).toBe('100%');
  });

  it('handles a missing reset time without inventing one', () => {
    const snapshot: QuotaSnapshot = {
      status: 'ok',
      runtimeType: 'codex',
      planLabel: 'plus',
      windows: [
        { kind: 'primary', group: 'session', label: '5-hour window', percentUsed: 33, resetsAt: null, windowMinutes: 300, severity: null, isActive: true },
      ],
      observedAt: Date.now(),
    };
    render(<QuotaSection title="Codex" snapshot={snapshot} agentCount={1} />);

    expect(screen.getByText(/Reset time not reported/i)).toBeTruthy();
  });
});

describe('totals that know what they do not cover', () => {
  it('prints a plain figure only when everything in it was measured', () => {
    expect(describeTotal(12.5, { unverifiedExecutions: 0, unavailableExecutions: 0, unpricedExecutions: 0 })).toEqual({
      text: '$12.50',
      note: null,
    });
  });

  it('marks a total as a floor when runs behind it were never measured', () => {
    const result = describeTotal(12.5, { unverifiedExecutions: 3, unavailableExecutions: 0, unpricedExecutions: 0 });

    expect(result.text).toBe('+$12.50');
    expect(result.note).toMatch(/3 runs/);
  });

  it('refuses to print a vacuous zero when nothing was measured', () => {
    const result = describeTotal(0, { unverifiedExecutions: 4, unavailableExecutions: 0, unpricedExecutions: 0 });

    // "+$0.00" would say nothing true: there is no figure, not a figure of zero.
    expect(result.text).toBe('not measured');
    expect(result.note).toMatch(/4 runs/);
  });

  it('does not present unpriced-only work as free', () => {
    const result = describeTotal(0, { unverifiedExecutions: 0, unavailableExecutions: 0, unpricedExecutions: 2 });

    expect(result.text).toBe('Not priced');
    expect(result.note).toMatch(/2 runs/);
  });

  it('marks measured spend as partial when unpriced work shares the total', () => {
    const result = describeTotal(12.5, { unverifiedExecutions: 0, unavailableExecutions: 0, unpricedExecutions: 1 });

    expect(result.text).toBe('$12.50 (partial)');
    expect(result.note).toMatch(/1 run/);
  });

});

describe('recorded usage', () => {
  it('shows both windows and labels the trailing week as 7d, not "this week"', () => {
    const { container } = render(<UsageChips agent={agentOf('claude-code')} windows={WINDOWS} />);

    expect(screen.getByText('Today')).toBeTruthy();
    // "This week" would invite the reader to assume a Monday boundary.
    expect(screen.getByText('7d')).toBeTruthy();
    expect(container.textContent).toContain('$1.23');
    expect(container.textContent).toContain('$9.88');
    // Recorded consumption is text, never a bar: there is no allowance to
    // measure an agent against.
    expect(within(container).queryByRole('meter')).toBeNull();
  });

  it('says a model agent cost is not measured rather than showing $0.00', () => {
    const { container } = render(<UsageBreakdown agent={agentOf('model')} windows={WINDOWS} />);

    expect(screen.getAllByText(/Not measured/i).length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('$0.00');
    // Tokens are real for a model agent even when cost is not.
    expect(container.textContent).toContain('1.5k');
  });

  it('says an external agent reports nothing at all', () => {
    render(<UsageChips agent={agentOf('a2a')} windows={WINDOWS} />);

    expect(screen.getByText(/Usage not reported/i)).toBeTruthy();
  });

  it('renders zero for an agent with no runs in the window', () => {
    const { container } = render(
      <UsageChips agent={agentOf('codex', 'agent:absent')} windows={WINDOWS} />,
    );

    // The store omits agents with no rows; the UI supplies the zero.
    expect(container.textContent).toContain('$0.00');
  });

  it('stays on one compact line in a narrow panel', () => {
    const { container } = render(
      <div style={{ width: 300 }}>
        <UsageChips agent={agentOf('codex')} windows={WINDOWS} />
      </div>,
    );

    // Chips wrap rather than overflow when the panel is narrow.
    const row = container.querySelector('span.flex') as HTMLElement | null;
    expect(row?.className).toContain('flex-wrap');
  });

  it('marks a figure as a floor when some runs were never measured', () => {
    const { container } = render(
      <UsageChips agent={agentOf('claude-code')} windows={WINDOWS_WITH_UNVERIFIED} />,
    );

    // "+$1.23" rather than "$1.23": the measured figure is a lower bound, and a
    // bare number would claim a precision that does not exist.
    expect(container.textContent).toContain('+$1.23');
  });

  it('says at least, rather than an exact figure, in the breakdown', () => {
    render(<UsageBreakdown agent={agentOf('claude-code')} windows={WINDOWS_WITH_UNVERIFIED} />);

    // The breakdown uses the same helper as the chips and the Spend rows, so
    // one policy governs every figure rather than three similar ones.
    expect(screen.getByText('+$1.23')).toBeTruthy();
    expect(screen.getByText(/what was measured, not the full amount/i)).toBeTruthy();
  });

  it('says nothing was measured rather than showing a vacuous zero', () => {
    const windows = {
      ...WINDOWS,
      today: [{ agentId: 'agent:1', costUsd: 0, inputTokens: 900, outputTokens: 300, executions: 4, unverifiedExecutions: 4, unavailableExecutions: 0, unpricedExecutions: 0 }],
    };
    const { container } = render(<UsageChips agent={agentOf('claude-code')} windows={windows} />);

    // Every run here predates measurement. "+$0.00" would say nothing true:
    // the answer is that there is no figure, not that the figure is zero.
    expect(container.textContent).toContain('not measured');
    expect(container.textContent).not.toContain('+$0.00');
  });

  it('withholds Claude token totals rather than showing an unreliable number', () => {
    render(<UsageBreakdown agent={agentOf('claude-code')} windows={WINDOWS} />);

    // The recorded field is main-loop-only: no cached input, no subagent or
    // compaction calls. Printing it beside a Codex count -- which includes
    // cache -- invites a comparison that is simply false.
    expect(screen.getAllByText(/Not reliably measured/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/cached input/i)).toBeTruthy();
  });

  it('still shows Codex tokens, which are reported whole', () => {
    const { container } = render(<UsageBreakdown agent={agentOf('codex')} windows={WINDOWS} />);

    expect(container.textContent).toContain('1.5k');
    expect(container.textContent).not.toMatch(/Not reliably measured/i);
  });

  it('renders nothing at all before the first summary arrives', () => {
    const { container } = render(<UsageChips agent={agentOf('codex')} windows={undefined} />);

    // No summary yet is not the same as zero usage.
    expect(container.textContent).toBe('');
  });
});
