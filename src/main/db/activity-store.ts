import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type {
  ActivityDetail,
  AgentActivityState,
  MessageActivityRecord,
  MessageReaction,
} from '../../shared/activity.js';
import { ACTIVITY_EMOJI } from '../../shared/activity.js';
import type { Db } from './index.js';
import * as t from './schema.js';

/**
 * Persistence for message reactions: agent activity (one row per message and
 * agent, updated in place) and the user's own emoji reactions. The two live in
 * separate tables so neither can be mistaken for the other.
 */
export class ActivityStore {
  constructor(private readonly db: Db) {}

  /* -------------------------------------------------------- agent activity */

  getActivity(messageId: string, agentId: string): MessageActivityRecord | null {
    const row = this.db
      .select()
      .from(t.messageActivities)
      .where(and(eq(t.messageActivities.messageId, messageId), eq(t.messageActivities.agentId, agentId)))
      .get();
    return row ? toRecord(row) : null;
  }

  getActivityById(id: string): MessageActivityRecord | null {
    const row = this.db.select().from(t.messageActivities).where(eq(t.messageActivities.id, id)).get();
    return row ? toRecord(row) : null;
  }

  /**
   * Starts a new lifecycle for (message, agent), owned by `executionId`. An
   * existing row for the pair is taken over by the new execution, keeping its
   * id and bumping its revision so every copy of the old state loses.
   */
  claim(input: {
    messageId: string;
    conversationId: string;
    agentId: string;
    executionId: string;
    state: AgentActivityState;
    detail: ActivityDetail;
    now: number;
  }): MessageActivityRecord {
    const existing = this.getActivity(input.messageId, input.agentId);
    if (existing) {
      this.db
        .update(t.messageActivities)
        .set({
          executionId: input.executionId,
          state: input.state,
          emoji: ACTIVITY_EMOJI[input.state],
          detail: input.detail,
          active: true,
          revision: sql`${t.messageActivities.revision} + 1`,
          updatedAt: input.now,
        })
        .where(eq(t.messageActivities.id, existing.id))
        .run();
      return this.getActivityById(existing.id)!;
    }

    const row = {
      id: `act:${randomUUID()}`,
      messageId: input.messageId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      executionId: input.executionId,
      state: input.state,
      emoji: ACTIVITY_EMOJI[input.state],
      detail: input.detail,
      active: true,
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.db.insert(t.messageActivities).values(row).run();
    return toRecord(row);
  }

  /**
   * Moves a row to a new state, but only while it still belongs to
   * `executionId`. Returns null when another execution has taken it over, so a
   * late update from an old run can never overwrite a newer one.
   */
  advance(input: {
    id: string;
    executionId: string;
    state: AgentActivityState;
    detail: ActivityDetail;
    active: boolean;
    now: number;
  }): MessageActivityRecord | null {
    const result = this.db
      .update(t.messageActivities)
      .set({
        state: input.state,
        emoji: ACTIVITY_EMOJI[input.state],
        detail: input.detail,
        active: input.active,
        revision: sql`${t.messageActivities.revision} + 1`,
        updatedAt: input.now,
      })
      .where(and(eq(t.messageActivities.id, input.id), eq(t.messageActivities.executionId, input.executionId)))
      .run();
    return result.changes > 0 ? this.getActivityById(input.id) : null;
  }

  listActivities(conversationId: string): MessageActivityRecord[] {
    return this.db
      .select()
      .from(t.messageActivities)
      .where(eq(t.messageActivities.conversationId, conversationId))
      .orderBy(t.messageActivities.createdAt)
      .all()
      .map(toRecord);
  }

  /** Every activity whose run has not ended, across all conversations. */
  listActiveActivities(): MessageActivityRecord[] {
    return this.db
      .select()
      .from(t.messageActivities)
      .where(eq(t.messageActivities.active, true))
      .all()
      .map(toRecord);
  }

  /* -------------------------------------------------------- user reactions */

  listReactions(conversationId: string): MessageReaction[] {
    return this.db
      .select()
      .from(t.messageReactions)
      .where(eq(t.messageReactions.conversationId, conversationId))
      .orderBy(t.messageReactions.createdAt)
      .all();
  }

  listReactionsFor(messageId: string): MessageReaction[] {
    return this.db
      .select()
      .from(t.messageReactions)
      .where(eq(t.messageReactions.messageId, messageId))
      .orderBy(t.messageReactions.createdAt)
      .all();
  }

  /** Adds the reaction, or removes it if this user already has it. */
  toggleReaction(input: { messageId: string; conversationId: string; userId: string; emoji: string }): MessageReaction[] {
    const match = and(
      eq(t.messageReactions.messageId, input.messageId),
      eq(t.messageReactions.userId, input.userId),
      eq(t.messageReactions.emoji, input.emoji),
    );
    const existing = this.db.select().from(t.messageReactions).where(match).get();
    if (existing) {
      this.db.delete(t.messageReactions).where(eq(t.messageReactions.id, existing.id)).run();
    } else {
      this.db
        .insert(t.messageReactions)
        .values({ id: `rx:${randomUUID()}`, ...input, createdAt: Date.now() })
        .run();
    }
    return this.listReactionsFor(input.messageId);
  }
}

function toRecord(row: typeof t.messageActivities.$inferSelect): MessageActivityRecord {
  return {
    id: row.id,
    messageId: row.messageId,
    conversationId: row.conversationId,
    agentId: row.agentId,
    executionId: row.executionId,
    state: row.state,
    emoji: row.emoji,
    detail: row.detail,
    active: row.active,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
