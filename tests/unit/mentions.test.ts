import { describe, expect, it } from 'vitest';
import { resolveMentions } from '../../src/main/orchestrator/mentions.js';
import { evaluateActivation } from '../../src/main/orchestrator/limits.js';
import type { Agent, Conversation } from '../../src/shared/types.js';
import { DEFAULT_AGENT_CONFIG, DEFAULT_AGENT_PERMISSIONS, DEFAULT_LIMITS } from '../../src/shared/types.js';

function agent(id: string, name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    description: '',
    runtimeType: 'claude-code',
    avatar: '',
    avatarColor: '#7C6CF6',
    workingDirectory: '/tmp',
    status: 'online',
    statusDetail: null,
    permissions: { ...DEFAULT_AGENT_PERMISSIONS },
    config: { ...DEFAULT_AGENT_CONFIG },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const CLAUDE = agent('agent:claude', 'Claude Code');
const CODEX = agent('agent:codex', 'Codex');
const MEMBERS = [CLAUDE, CODEX];

describe('resolveMentions', () => {
  it('finds nothing when there are no mentions', () => {
    expect(resolveMentions('just a note', MEMBERS)).toEqual({
      agentIds: [],
      all: false,
      unknown: [],
    });
  });

  it('matches on the full name and on the first word', () => {
    expect(resolveMentions('@Claude do it', MEMBERS).agentIds).toEqual([CLAUDE.id]);
    expect(resolveMentions('@ClaudeCode do it', MEMBERS).agentIds).toEqual([CLAUDE.id]);
  });

  it('is case and separator insensitive', () => {
    expect(resolveMentions('@claude-code go', MEMBERS).agentIds).toEqual([CLAUDE.id]);
    expect(resolveMentions('@CLAUDE go', MEMBERS).agentIds).toEqual([CLAUDE.id]);
  });

  it('expands @all to every member', () => {
    const result = resolveMentions('@all status', MEMBERS);
    expect(result.all).toBe(true);
    expect(new Set(result.agentIds)).toEqual(new Set([CLAUDE.id, CODEX.id]));
  });

  it('deduplicates repeated mentions', () => {
    expect(resolveMentions('@Claude @Claude @claude', MEMBERS).agentIds).toEqual([CLAUDE.id]);
  });

  it('reports unmatched mentions instead of silently dropping them', () => {
    expect(resolveMentions('@Gemini hello', MEMBERS).unknown).toEqual(['Gemini']);
  });

  it('ignores an email address rather than treating it as a mention', () => {
    expect(resolveMentions('mail me at sam@claude.com', MEMBERS).agentIds).toEqual([]);
  });

  it('matches a mention at the start of the message and inside brackets', () => {
    expect(resolveMentions('@Codex ping', MEMBERS).agentIds).toEqual([CODEX.id]);
    expect(resolveMentions('(@Codex) ping', MEMBERS).agentIds).toEqual([CODEX.id]);
  });
});

describe('evaluateActivation', () => {
  const conversation: Conversation = {
    id: 'conv:1',
    kind: 'channel',
    name: 'dev',
    topic: null,
    icon: null,
    autonomyEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  };

  const base = {
    agent: CLAUDE,
    conversation,
    chainId: 'chain:1',
    chainDepth: 0,
    chainLength: 0,
    chainCostUsd: 0,
    consecutiveAutoActivations: 0,
    pendingForAgent: 0,
  };

  it('always allows a human-triggered activation', () => {
    const verdict = evaluateActivation(
      { ...base, trigger: 'human', chainLength: 999, consecutiveAutoActivations: 999 },
      DEFAULT_LIMITS,
    );
    expect(verdict.allowed).toBe(true);
  });

  it('enforces the queue depth even for a human', () => {
    const verdict = evaluateActivation(
      { ...base, trigger: 'human', pendingForAgent: DEFAULT_LIMITS.maxPendingMessagesPerAgent },
      DEFAULT_LIMITS,
    );
    expect(verdict.allowed).toBe(false);
  });

  it('blocks an agent trigger once the chain is exhausted', () => {
    const verdict = evaluateActivation(
      { ...base, trigger: 'agent', chainLength: DEFAULT_LIMITS.maxAgentToAgentTurns },
      DEFAULT_LIMITS,
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/agent-to-agent turns/);
  });

  it('blocks when the chain has spent its budget', () => {
    const verdict = evaluateActivation(
      { ...base, trigger: 'agent', chainCostUsd: 10 },
      { ...DEFAULT_LIMITS, maxChainCostUsd: 5 },
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/has spent/);
  });

  it('treats a zero spend limit as "no limit"', () => {
    const verdict = evaluateActivation(
      { ...base, trigger: 'agent', chainCostUsd: 999 },
      { ...DEFAULT_LIMITS, maxChainCostUsd: 0 },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('respects per-conversation autonomy', () => {
    const verdict = evaluateActivation(
      { ...base, trigger: 'agent', conversation: { ...conversation, autonomyEnabled: false } },
      DEFAULT_LIMITS,
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/disabled in "dev"/);
  });
});
