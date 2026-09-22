import type { Agent } from '@shared/types';
import type { ProviderView } from '@shared/integrations';

/**
 * The curated agent accents. An accent is an agent's signature in small
 * places only -- its avatar ring and initials plate -- never a message
 * background. Existing agents keep whatever colour they were given.
 */
export const AGENT_ACCENTS: Array<{ name: string; color: string }> = [
  { name: 'Aurora Teal', color: '#35D6C1' },
  { name: 'Electric Lavender', color: '#A78BFA' },
  { name: 'Soft Blue', color: '#60A5FA' },
  { name: 'Warm Amber', color: '#F5B544' },
  { name: 'Coral', color: '#FB7185' },
  { name: 'Mint', color: '#6EE7B7' },
  { name: 'Sky', color: '#38BDF8' },
  { name: 'Slate', color: '#94A3B8' },
];

export const AGENT_COLORS = AGENT_ACCENTS.map((accent) => accent.color);

/**
 * What an agent runs on, in one short phrase: "Claude Code", "Codex",
 * "Ollama · qwen3:8b", "External · research.example.com".
 */
export function engineLabel(agent: Agent, providers: ProviderView[]): string {
  switch (agent.runtimeType) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'model': {
      const provider = providers.find((p) => p.id === agent.config.providerId);
      const model = agent.config.model ?? 'no model';
      return provider ? `${provider.name} · ${model}` : `Missing provider · ${model}`;
    }
    case 'a2a': {
      const url = agent.config.a2a?.endpointUrl;
      try {
        return `External · ${url ? new URL(url).host : 'A2A'}`;
      } catch {
        return 'External · A2A';
      }
    }
  }
}

/** The kind of engine, for grouping and short badges. */
export function engineKind(agent: Agent): 'Local CLI' | 'AI model' | 'External agent' {
  if (agent.runtimeType === 'model') return 'AI model';
  if (agent.runtimeType === 'a2a') return 'External agent';
  return 'Local CLI';
}

/** Whether the agent's current model is known not to accept tools. */
export function modelRejectsTools(agent: Agent, providers: ProviderView[]): boolean {
  if (agent.runtimeType !== 'model') return false;
  const provider = providers.find((p) => p.id === agent.config.providerId);
  const model = provider?.models.find((m) => m.id === agent.config.model);
  if (!model) return false;
  const tools = model.overrides.tools ?? model.capabilities.tools;
  return tools === false;
}
