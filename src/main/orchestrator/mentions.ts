import type { Agent } from '../../shared/types.js';

export interface MentionResolution {
  /** Agent ids explicitly addressed. */
  agentIds: string[];
  /** True when the author wrote @all. */
  all: boolean;
  /** Mention tokens that matched no member, for a gentle UI warning. */
  unknown: string[];
}

/**
 * Resolves `@name` tokens to stable agent ids.
 *
 * Display names are only ever an input to this function: everything downstream
 * -- routing, permissions, persistence -- uses ids, so renaming an agent can
 * never redirect a message to the wrong participant.
 */
export function resolveMentions(body: string, members: Agent[]): MentionResolution {
  const tokens = [...body.matchAll(/(^|[\s(\[{])@([A-Za-z0-9._-]+)/g)].map((m) => m[2] ?? '');
  if (!tokens.length) return { agentIds: [], all: false, unknown: [] };

  const byKey = new Map<string, string>();
  for (const member of members) {
    byKey.set(normalise(member.name), member.id);
    // Allow "@claude" for an agent named "Claude Code".
    const firstWord = member.name.split(/\s+/)[0];
    if (firstWord) byKey.set(normalise(firstWord), member.id);
  }

  const agentIds = new Set<string>();
  const unknown: string[] = [];
  let all = false;

  for (const token of tokens) {
    const key = normalise(token);
    if (key === 'all' || key === 'everyone' || key === 'channel') {
      all = true;
      continue;
    }
    const id = byKey.get(key);
    if (id) agentIds.add(id);
    else unknown.push(token);
  }

  if (all) for (const member of members) agentIds.add(member.id);

  return { agentIds: [...agentIds], all, unknown };
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/[\s._-]/g, '');
}

/** Renders "@Name" for each id, for display inside message bodies. */
export function formatMentions(agentIds: string[], members: Agent[]): string {
  const byId = new Map(members.map((m) => [m.id, m.name]));
  return agentIds.map((id) => `@${byId.get(id) ?? id}`).join(' ');
}
