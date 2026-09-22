import { describe, expect, it } from 'vitest';
import { isReactionEmoji } from '../../src/shared/activity.js';
import {
  initialMachine,
  sanitizeToolName,
  transition,
  type ActivityMachine,
  type ActivitySignal,
} from '../../src/main/activity/state-machine.js';

/** Applies signals in order, recording each visible state ("state/detail"). */
function run(signals: ActivitySignal[], start: ActivityMachine = initialMachine()) {
  let machine = start;
  const seen: string[] = [`${machine.state}${machine.detail ? `/${machine.detail}` : ''}`];
  for (const signal of signals) {
    const next = transition(machine, signal);
    if (!next) continue;
    const label = `${next.state}${next.detail ? `/${next.detail}` : ''}`;
    if (label !== seen[seen.length - 1]) seen.push(label);
    machine = next;
  }
  return { machine, seen };
}

describe('activity state machine: detailed runtimes', () => {
  it('moves through reading, thinking and working only on real events', () => {
    const { machine, seen } = run([
      { type: 'started', profile: 'detailed' },
      { type: 'output', kind: 'reasoning' },
      { type: 'output', kind: 'reasoning' },
      { type: 'tool', name: 'Read' },
      { type: 'output', kind: 'text' },
      { type: 'output', kind: 'text' },
      { type: 'finished', outcome: 'completed' },
    ]);
    expect(seen).toEqual([
      'received',
      'reading',
      'thinking/reasoning',
      'working/Read',
      'thinking/responding',
      'completed',
    ]);
    expect(machine.active).toBe(false);
  });

  it('shows nothing it cannot verify: no output before the run starts, no thinking without output', () => {
    expect(transition(initialMachine(), { type: 'output', kind: 'text' })).toBeNull();
    expect(transition(initialMachine(), { type: 'tool', name: 'Bash' })).toBeNull();
    const started = run([{ type: 'started', profile: 'detailed' }]);
    expect(started.machine.state).toBe('reading');
  });

  it('waits for approval, then returns to working on the same tool', () => {
    const { seen, machine } = run([
      { type: 'started', profile: 'detailed' },
      { type: 'tool', name: 'Write' },
      { type: 'approval_requested' },
      { type: 'approval_resolved' },
    ]);
    expect(seen).toEqual(['received', 'reading', 'working/Write', 'waiting_for_input/approval', 'working/Write']);
    expect(machine.active).toBe(true);
  });

  it('marks a timeout as a failure, and a quit as interrupted', () => {
    const started = run([{ type: 'started', profile: 'detailed' }]).machine;
    expect(transition(started, { type: 'finished', outcome: 'timeout' })).toMatchObject({ state: 'failed', detail: 'timeout', active: false });
    expect(transition(started, { type: 'finished', outcome: 'cancelled' })).toMatchObject({ state: 'cancelled', active: false });
    expect(transition(started, { type: 'finished', outcome: 'interrupted' })).toMatchObject({ state: 'interrupted', active: false });
    expect(transition(started, { type: 'finished', outcome: 'failed' })).toMatchObject({ state: 'failed', detail: null });
  });

  it('ignores everything once the run has ended', () => {
    const done = run([{ type: 'started', profile: 'detailed' }, { type: 'finished', outcome: 'completed' }]).machine;
    for (const signal of [
      { type: 'tool', name: 'Bash' },
      { type: 'output', kind: 'text' },
      { type: 'approval_requested' },
      { type: 'finished', outcome: 'failed' },
    ] as ActivitySignal[]) {
      expect(transition(done, signal)).toBeNull();
    }
  });

  it('shows the workspace wait while still received', () => {
    const { seen } = run([{ type: 'waiting_for_workspace' }, { type: 'started', profile: 'detailed' }]);
    expect(seen).toEqual(['received', 'received/workspace', 'reading']);
  });
});

describe('activity state machine: basic runtimes (external agents)', () => {
  it('shows processing for the whole run, whatever it streams', () => {
    const { seen } = run([
      { type: 'started', profile: 'basic' },
      { type: 'output', kind: 'text' },
      { type: 'tool', name: 'search' },
      { type: 'finished', outcome: 'completed' },
    ]);
    expect(seen).toEqual(['received', 'processing', 'completed']);
  });

  it('ends on a question when the agent asked for input', () => {
    const { machine } = run([
      { type: 'started', profile: 'basic' },
      { type: 'awaiting_input', reason: 'input' },
      { type: 'finished', outcome: 'completed' },
    ]);
    expect(machine).toMatchObject({ state: 'waiting_for_input', detail: 'input', active: false });
  });
});

describe('tool names and reaction emoji', () => {
  it('bounds tool names and strips control characters', () => {
    expect(sanitizeToolName('mcp__tools__notes__echo')).toBe('mcp__tools__notes__echo');
    expect(sanitizeToolName('bad\u0000\nname')).toBe('badname');
    expect(sanitizeToolName('x'.repeat(200))).toHaveLength(80);
    expect(sanitizeToolName('\u0007')).toBe('tool');
  });

  it('accepts single emoji and nothing else', () => {
    for (const emoji of ['👍', '⚙️', '❤️', '🏴‍☠️', '👍🏽', '🇮🇱', '#️⃣', '✅']) {
      expect(isReactionEmoji(emoji), emoji).toBe(true);
    }
    for (const text of ['', 'hello', '👍 nice', '<b>', '1', '#', 'x'.repeat(40)]) {
      expect(isReactionEmoji(text), text).toBe(false);
    }
  });
});
