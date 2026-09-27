/**
 * Turning each provider's raw usage payload into meters.
 *
 * The payloads below are trimmed copies of what the installed SDK and CLI
 * actually returned on this machine, so a shape change upstream shows up here
 * rather than as a wrong number on screen.
 */
import { describe, expect, it } from 'vitest';
import { describeWindowLength, sharedAccountNote } from '../../src/shared/quota.js';
import { parseClaudeWindows } from '../../src/main/quota/claude.js';
import { parseCodexWindows } from '../../src/main/quota/codex.js';
import type { QuotaWindow } from '../../src/shared/quota.js';

/** Index into a parsed result, failing loudly rather than on `undefined`. */
function at(windows: QuotaWindow[], index: number): QuotaWindow {
  const w = windows[index];
  if (!w) throw new Error(`expected a window at index ${index}, got ${windows.length}`);
  return w;
}

describe('Claude Code usage parsing', () => {
  // Shape observed from the installed SDK (0.3.278) against a real login.
  const live = {
    five_hour: { utilization: 5, resets_at: '2026-09-23T22:40:00.437204+00:00' },
    seven_day: { utilization: 15, resets_at: '2026-09-24T12:00:00.437229+00:00' },
    limits: [
      { kind: 'session', group: 'session', percent: 5, severity: 'normal', resets_at: '2026-09-23T22:40:00.437204+00:00', scope: null, is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 15, severity: 'normal', resets_at: '2026-09-24T12:00:00.437229+00:00', scope: null, is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: '2026-09-24T12:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' } }, is_active: false },
    ],
  };

  it('prefers the server-driven rows and keeps their labels', () => {
    const windows = parseClaudeWindows(live);

    expect(windows).toHaveLength(3);
    expect(windows.map((w) => w.kind)).toEqual(['session', 'weekly_all', 'weekly_scoped']);
    expect(at(windows, 0)).toMatchObject({ label: 'Current session', percentUsed: 5, isActive: false });
    expect(at(windows, 1)).toMatchObject({ label: 'Current week (all models)', percentUsed: 15, isActive: true });
    // The scoped row must name the model the server named, not a guess.
    expect(at(windows, 2).label).toBe('Current week (Fable)');
    expect(at(windows, 0).resetsAt).toBe(Date.parse('2026-09-23T22:40:00.437204+00:00'));
  });

  it('keeps an unfamiliar meter rather than forcing it into a known label', () => {
    const windows = parseClaudeWindows({
      limits: [{ kind: 'monthly_surface', group: 'monthly', percent: 42, severity: 'warning', resets_at: null, scope: { surface: { display_name: 'Cowork' } }, is_active: false }],
    });

    // A new server meter must survive without a client release.
    expect(windows).toHaveLength(1);
    expect(at(windows, 0)).toMatchObject({ kind: 'monthly_surface', percentUsed: 42, severity: 'warning', resetsAt: null });
    expect(at(windows, 0).label).toContain('Cowork');
  });

  it('falls back to the named windows when no rows are sent', () => {
    const windows = parseClaudeWindows({ five_hour: live.five_hour, seven_day: live.seven_day });

    expect(windows.map((w) => w.kind)).toEqual(['five_hour', 'seven_day']);
    expect(at(windows, 1).percentUsed).toBe(15);
  });

  it('drops rows whose percentage is not really a number', () => {
    // Number(null), Number('') and Number(false) are all 0. Coercing here would
    // turn "the provider told us nothing" into a confident "0% used".
    const windows = parseClaudeWindows({
      limits: [
        { kind: 'a', group: 'g', percent: null, severity: 'normal', resets_at: null, scope: null, is_active: false },
        { kind: 'b', group: 'g', percent: '', severity: 'normal', resets_at: null, scope: null, is_active: false },
        { kind: 'c', group: 'g', percent: false, severity: 'normal', resets_at: null, scope: null, is_active: false },
        { kind: 'd', group: 'g', percent: Number.NaN, severity: 'normal', resets_at: null, scope: null, is_active: false },
        { kind: 'e', group: 'g', percent: '15', severity: 'normal', resets_at: null, scope: null, is_active: false },
        { kind: 'f', group: 'g', percent: -1, severity: 'normal', resets_at: null, scope: null, is_active: false },
        { kind: 'ok', group: 'g', percent: 15, severity: 'normal', resets_at: null, scope: null, is_active: false },
      ],
    });

    expect(windows.map((w) => w.kind)).toEqual(['ok']);
  });

  it('reports a percentage above 100 as sent, without clamping the data', () => {
    const windows = parseClaudeWindows({
      limits: [{ kind: 'session', group: 'session', percent: 104, severity: 'critical', resets_at: null, scope: null, is_active: true }],
    });

    // Clamping belongs to the drawn bar, not to the number we report.
    expect(at(windows, 0).percentUsed).toBe(104);
  });

  it('survives a malformed rows array without inventing meters', () => {
    expect(parseClaudeWindows({ limits: 'nonsense' })).toEqual([]);
    expect(parseClaudeWindows({ limits: [null, 7, 'x'] })).toEqual([]);
    expect(parseClaudeWindows({})).toEqual([]);
  });

  it('ignores an unparseable reset timestamp instead of guessing one', () => {
    const windows = parseClaudeWindows({
      limits: [{ kind: 'session', group: 'session', percent: 3, severity: 'normal', resets_at: 'not a date', scope: null, is_active: false }],
    });

    expect(at(windows, 0).resetsAt).toBeNull();
  });
});

describe('Codex usage parsing', () => {
  // Shape observed from codex-cli 0.155.1 against a real login.
  const live = {
    primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: 1_790_198_114 },
    secondary: { usedPercent: 16, windowDurationMins: 10_080, resetsAt: 1_790_574_593 },
    planType: 'plus',
  };

  it('labels windows from the duration the provider states', () => {
    const windows = parseCodexWindows(live);

    expect(windows).toHaveLength(2);
    // 300 minutes is five hours and 10080 is seven days. Neither is "daily",
    // and the label has to come from the number rather than from an assumption.
    expect(at(windows, 0)).toMatchObject({ kind: 'primary', label: '5-hour window', percentUsed: 33, windowMinutes: 300 });
    expect(at(windows, 1)).toMatchObject({ kind: 'secondary', label: '7-day window', percentUsed: 16, windowMinutes: 10_080 });
  });

  it('converts unix seconds to epoch milliseconds', () => {
    expect(at(parseCodexWindows(live), 0).resetsAt).toBe(1_790_198_114_000);
  });

  it('keeps a neutral name when no duration is given', () => {
    const windows = parseCodexWindows({ primary: { usedPercent: 4 } });

    expect(at(windows, 0).label).toBe('Current session');
    expect(at(windows, 0).windowMinutes).toBeNull();
    expect(at(windows, 0).resetsAt).toBeNull();
  });

  it('drops a window whose percentage is not really a number', () => {
    expect(parseCodexWindows({ primary: { usedPercent: null, windowDurationMins: 300 } })).toEqual([]);
    expect(parseCodexWindows({ primary: { usedPercent: '' } })).toEqual([]);
    expect(parseCodexWindows({ primary: { usedPercent: false } })).toEqual([]);
    expect(parseCodexWindows({ primary: {} })).toEqual([]);
    expect(parseCodexWindows({})).toEqual([]);
  });
});

describe('window length wording', () => {
  it('names only lengths it can state exactly', () => {
    expect(describeWindowLength(300)).toBe('5-hour');
    expect(describeWindowLength(10_080)).toBe('7-day');
    expect(describeWindowLength(1440)).toBe('24-hour');
    expect(describeWindowLength(90)).toBe('90-minute');
    expect(describeWindowLength(null)).toBeNull();
    expect(describeWindowLength(0)).toBeNull();
  });
});

describe('shared-account wording', () => {
  it('never claims to know how many things consume the quota', () => {
    const one = sharedAccountNote(1);
    const many = sharedAccountNote(4);

    expect(many).toContain('4 agents here');
    // Other terminals, the desktop app and the website draw on the same plan,
    // so the count must never read as the total number of consumers.
    for (const text of [one, many]) expect(text).toMatch(/account-wide/i);
    expect(many).toMatch(/anything else signed in/i);
  });
});
