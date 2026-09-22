import type { Agent, Conversation, ExecutionLimits } from '../../shared/types.js';

export interface ActivationRequest {
  agent: Agent;
  conversation: Conversation;
  trigger: 'human' | 'agent' | 'system';
  chainId: string;
  chainDepth: number;
  /** Executions already recorded against this chain. */
  chainLength: number;
  chainCostUsd: number;
  consecutiveAutoActivations: number;
  /** Jobs already queued for this agent. */
  pendingForAgent: number;
}

export type ActivationVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * The single place where "should this agent be woken?" is decided.
 *
 * Every rule here exists to stop a chain of agents talking to each other
 * forever. A human-triggered activation bypasses the autonomy rules -- the
 * operator is always allowed to address an agent directly -- but never bypasses
 * the queue depth or concurrency ceilings.
 */
export function evaluateActivation(
  request: ActivationRequest,
  limits: ExecutionLimits,
): ActivationVerdict {
  const { agent, conversation, trigger } = request;

  if (request.pendingForAgent >= limits.maxPendingMessagesPerAgent) {
    return {
      allowed: false,
      reason: `${agent.name} already has ${request.pendingForAgent} queued messages (limit ${limits.maxPendingMessagesPerAgent})`,
    };
  }

  if (trigger !== 'agent') return { allowed: true };

  if (!limits.autonomousCommunicationEnabled) {
    return { allowed: false, reason: 'autonomous agent-to-agent messaging is disabled globally' };
  }

  if (!conversation.autonomyEnabled) {
    return {
      allowed: false,
      reason: `autonomous messaging is disabled in "${conversation.name}"`,
    };
  }

  if (!agent.permissions.allowAgentToAgent) {
    return {
      allowed: false,
      reason: `${agent.name} is not permitted to be woken by other agents`,
    };
  }

  if (request.chainLength >= limits.maxAgentToAgentTurns) {
    return {
      allowed: false,
      reason: `this chain reached the limit of ${limits.maxAgentToAgentTurns} agent-to-agent turns`,
    };
  }

  if (request.consecutiveAutoActivations >= limits.maxConsecutiveAutoActivations) {
    return {
      allowed: false,
      reason: `${agent.name} has run ${request.consecutiveAutoActivations} times in a row without human input (limit ${limits.maxConsecutiveAutoActivations})`,
    };
  }

  if (limits.maxChainCostUsd > 0 && request.chainCostUsd >= limits.maxChainCostUsd) {
    return {
      allowed: false,
      reason: `this chain has spent $${request.chainCostUsd.toFixed(2)} (limit $${limits.maxChainCostUsd.toFixed(2)})`,
    };
  }

  return { allowed: true };
}

/** Agent-to-agent hops still available on a chain, for get_channel_context. */
export function remainingAgentTurns(chainLength: number, limits: ExecutionLimits): number {
  return Math.max(0, limits.maxAgentToAgentTurns - chainLength);
}
