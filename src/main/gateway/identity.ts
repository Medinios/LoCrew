import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Maps gateway bearer tokens to agent ids.
 *
 * This is the single most important security object in the application. The
 * sender of every agent-originated message is resolved here, from the token on
 * the HTTP request -- never from text the model produced. An agent that writes
 * "I am Codex" in its message body changes nothing.
 *
 * Tokens are minted per app launch, held only in memory and never persisted, so
 * a token that leaks into a log or a transcript stops working when the app
 * restarts.
 */
export class AgentIdentityRegistry {
  private readonly tokenToAgent = new Map<string, string>();
  private readonly agentToToken = new Map<string, string>();

  /** Returns the existing token for an agent, minting one on first use. */
  issue(agentId: string): string {
    const existing = this.agentToToken.get(agentId);
    if (existing) return existing;

    const token = randomBytes(32).toString('base64url');
    this.tokenToAgent.set(token, agentId);
    this.agentToToken.set(agentId, token);
    return token;
  }

  tokenFor(agentId: string): string | null {
    return this.agentToToken.get(agentId) ?? null;
  }

  /**
   * Resolves a bearer token to an agent id in constant time with respect to the
   * token contents, so a caller cannot probe for valid tokens by timing.
   */
  resolve(token: string | undefined | null): string | null {
    if (!token) return null;

    let match: string | null = null;
    const candidate = Buffer.from(token);
    for (const [known, agentId] of this.tokenToAgent) {
      const knownBuf = Buffer.from(known);
      if (knownBuf.length !== candidate.length) continue;
      if (timingSafeEqual(knownBuf, candidate)) match = agentId;
    }
    return match;
  }

  revoke(agentId: string): void {
    const token = this.agentToToken.get(agentId);
    if (token) this.tokenToAgent.delete(token);
    this.agentToToken.delete(agentId);
  }

  clear(): void {
    this.tokenToAgent.clear();
    this.agentToToken.clear();
  }
}

/** Extracts a bearer token from an Authorization header. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
