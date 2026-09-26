import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type {
  Agent,
  AgentEvent,
  AgentEventType,
  AgentExecution,
  CostProvenance,
  RuntimeType,
  AppSettings,
  Conversation,
  ConversationMember,
  ExecutionState,
  MemberType,
  Message,
  MessageAttachment,
  MessageKind,
  Task,
  TaskStatus,
} from '../../shared/types.js';
import { DEFAULT_LIMITS, TERMINAL_EXECUTION_STATES } from '../../shared/types.js';
import type { CostSummary, RecordedUsageRow, RecordedUsageWindows } from '../../shared/ipc.js';
import type { Db } from './index.js';
import * as t from './schema.js';

const SETTINGS_KEY = 'app';

/**
 * Midnight today in the machine's own timezone.
 *
 * Built from the local calendar fields rather than by subtracting a fixed
 * number of hours, so a day that is 23 or 25 hours long because the clocks
 * changed still starts where the user's calendar says it does.
 */
export function startOfLocalDay(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * All database access in the application goes through this class. Keeping it in
 * one place is what lets the orchestrator stay free of SQL, and makes the whole
 * persistence layer replaceable in tests with an in-memory database.
 */
export class Store {
  constructor(private readonly db: Db) {}

  /* ---------------------------------------------------------------- agents */

  listAgents(): Agent[] {
    return this.db.select().from(t.agents).orderBy(t.agents.createdAt).all().map(toAgent);
  }

  getAgent(id: string): Agent | null {
    const row = this.db.select().from(t.agents).where(eq(t.agents.id, id)).get();
    return row ? toAgent(row) : null;
  }

  getAgentByName(name: string): Agent | null {
    const row = this.db.select().from(t.agents).where(eq(t.agents.name, name)).get();
    return row ? toAgent(row) : null;
  }

  createAgent(
    input: Omit<Agent, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'statusDetail' | 'description'> & {
      description?: string;
    },
  ): Agent {
    const now = Date.now();
    const row = {
      id: `agent:${randomUUID()}`,
      name: input.name,
      description: input.description ?? '',
      runtimeType: input.runtimeType,
      avatar: input.avatar,
      avatarColor: input.avatarColor,
      workingDirectory: input.workingDirectory,
      status: 'offline' as const,
      statusDetail: null,
      permissions: input.permissions,
      config: input.config,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(t.agents).values(row).run();
    return toAgent(row);
  }

  updateAgent(id: string, patch: Partial<Agent>): Agent {
    this.db
      .update(t.agents)
      .set({ ...stripUndefined(patch), updatedAt: Date.now() })
      .where(eq(t.agents.id, id))
      .run();
    const agent = this.getAgent(id);
    if (!agent) throw new Error(`Agent ${id} no longer exists.`);
    return agent;
  }

  deleteAgent(id: string): void {
    this.db.transaction((tx) => {
      // Remove the agent from every conversation first so no dangling member
      // rows survive (membership has no FK to agents by design: members can be
      // humans too).
      tx.delete(t.conversationMembers)
        .where(and(eq(t.conversationMembers.memberType, 'agent'), eq(t.conversationMembers.memberId, id)))
        .run();
      tx.delete(t.agents).where(eq(t.agents.id, id)).run();
    });
  }

  /* --------------------------------------------------------- conversations */

  listConversations(): Conversation[] {
    return this.db
      .select()
      .from(t.conversations)
      .orderBy(t.conversations.createdAt)
      .all()
      .map(toConversation);
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.select().from(t.conversations).where(eq(t.conversations.id, id)).get();
    return row ? toConversation(row) : null;
  }

  createConversation(input: {
    kind: 'dm' | 'channel';
    name: string;
    topic: string | null;
    icon?: string | null;
    memberAgentIds: string[];
    humanMemberId: string;
  }): Conversation {
    const now = Date.now();
    const row = {
      id: `conv:${randomUUID()}`,
      kind: input.kind,
      name: input.name,
      topic: input.topic,
      icon: input.icon ?? null,
      autonomyEnabled: true,
      createdAt: now,
      updatedAt: now,
    };

    this.db.transaction((tx) => {
      tx.insert(t.conversations).values(row).run();
      tx.insert(t.conversationMembers)
        .values({
          conversationId: row.id,
          memberType: 'human',
          memberId: input.humanMemberId,
          joinedAt: now,
        })
        .run();
      for (const agentId of new Set(input.memberAgentIds)) {
        tx.insert(t.conversationMembers)
          .values({
            conversationId: row.id,
            memberType: 'agent',
            memberId: agentId,
            joinedAt: now,
          })
          .run();
      }
    });

    return toConversation(row);
  }

  updateConversation(id: string, patch: Partial<Conversation>): Conversation {
    this.db
      .update(t.conversations)
      .set({ ...stripUndefined(patch), updatedAt: Date.now() })
      .where(eq(t.conversations.id, id))
      .run();
    const conversation = this.getConversation(id);
    if (!conversation) throw new Error(`Conversation ${id} no longer exists.`);
    return conversation;
  }

  deleteConversation(id: string): void {
    this.db.delete(t.conversations).where(eq(t.conversations.id, id)).run();
  }

  listMembers(conversationId: string): ConversationMember[] {
    return this.db
      .select()
      .from(t.conversationMembers)
      .where(eq(t.conversationMembers.conversationId, conversationId))
      .all();
  }

  isMember(conversationId: string, memberId: string, memberType: MemberType = 'agent'): boolean {
    const row = this.db
      .select({ id: t.conversationMembers.memberId })
      .from(t.conversationMembers)
      .where(
        and(
          eq(t.conversationMembers.conversationId, conversationId),
          eq(t.conversationMembers.memberType, memberType),
          eq(t.conversationMembers.memberId, memberId),
        ),
      )
      .get();
    return Boolean(row);
  }

  addAgentToConversation(conversationId: string, agentId: string): void {
    if (this.isMember(conversationId, agentId)) return;
    this.db
      .insert(t.conversationMembers)
      .values({ conversationId, memberType: 'agent', memberId: agentId, joinedAt: Date.now() })
      .run();
  }

  removeAgentFromConversation(conversationId: string, agentId: string): void {
    this.db
      .delete(t.conversationMembers)
      .where(
        and(
          eq(t.conversationMembers.conversationId, conversationId),
          eq(t.conversationMembers.memberType, 'agent'),
          eq(t.conversationMembers.memberId, agentId),
        ),
      )
      .run();
  }

  listAgentIdsIn(conversationId: string): string[] {
    return this.db
      .select({ id: t.conversationMembers.memberId })
      .from(t.conversationMembers)
      .where(
        and(
          eq(t.conversationMembers.conversationId, conversationId),
          eq(t.conversationMembers.memberType, 'agent'),
        ),
      )
      .all()
      .map((r) => r.id);
  }

  /* -------------------------------------------------------------- messages */

  listMessages(conversationId: string, limit = 200, before?: number): Message[] {
    const conditions = before
      ? and(eq(t.messages.conversationId, conversationId), lt(t.messages.createdAt, before))
      : eq(t.messages.conversationId, conversationId);

    const rows = this.db
      .select()
      .from(t.messages)
      .where(conditions)
      .orderBy(desc(t.messages.createdAt))
      .limit(limit)
      .all();

    return this.withAttachments(rows.reverse());
  }

  getMessage(id: string): Message | null {
    const row = this.db.select().from(t.messages).where(eq(t.messages.id, id)).get();
    return row ? this.withAttachments([row])[0]! : null;
  }

  /** Records files already written to disk as attachments of a message. */
  insertAttachments(rows: MessageAttachment[], conversationId: string): void {
    if (!rows.length) return;
    this.db
      .insert(t.messageAttachments)
      .values(rows.map((row) => ({ ...row, conversationId })))
      .run();
  }

  private withAttachments(rows: Array<Omit<Message, 'attachments'>>): Message[] {
    if (!rows.length) return [];
    const found = this.db
      .select()
      .from(t.messageAttachments)
      .where(inArray(t.messageAttachments.messageId, rows.map((r) => r.id)))
      .orderBy(t.messageAttachments.createdAt)
      .all();
    const byMessage = new Map<string, MessageAttachment[]>();
    for (const { conversationId: _conversation, ...attachment } of found) {
      const list = byMessage.get(attachment.messageId);
      if (list) list.push(attachment);
      else byMessage.set(attachment.messageId, [attachment]);
    }
    return rows.map((row) => ({ ...row, attachments: byMessage.get(row.id) ?? [] }));
  }

  insertMessage(input: {
    conversationId: string;
    senderType: MemberType;
    senderId: string;
    body: string;
    kind?: MessageKind;
    mentions?: string[];
    taskId?: string | null;
    executionId?: string | null;
  }): Message {
    const row: Message = {
      id: `msg:${randomUUID()}`,
      conversationId: input.conversationId,
      senderType: input.senderType,
      senderId: input.senderId,
      kind: input.kind ?? 'chat',
      body: input.body,
      mentions: input.mentions ?? [],
      taskId: input.taskId ?? null,
      executionId: input.executionId ?? null,
      attachments: [],
      createdAt: Date.now(),
    };
    const { attachments: _none, ...columns } = row;
    this.db.insert(t.messages).values(columns).run();
    this.db
      .update(t.conversations)
      .set({ updatedAt: row.createdAt })
      .where(eq(t.conversations.id, input.conversationId))
      .run();
    return row;
  }

  /* -------------------------------------------------------------- sessions */

  getRuntimeSessionId(agentId: string, conversationId: string): string | null {
    const row = this.db
      .select()
      .from(t.agentSessions)
      .where(
        and(eq(t.agentSessions.agentId, agentId), eq(t.agentSessions.conversationId, conversationId)),
      )
      .get();
    return row?.runtimeSessionId ?? null;
  }

  saveRuntimeSessionId(input: {
    agentId: string;
    conversationId: string;
    runtimeType: Agent['runtimeType'];
    runtimeSessionId: string;
  }): void {
    const existing = this.db
      .select()
      .from(t.agentSessions)
      .where(
        and(
          eq(t.agentSessions.agentId, input.agentId),
          eq(t.agentSessions.conversationId, input.conversationId),
        ),
      )
      .get();

    if (existing) {
      this.db
        .update(t.agentSessions)
        .set({ runtimeSessionId: input.runtimeSessionId, lastUsedAt: Date.now() })
        .where(eq(t.agentSessions.id, existing.id))
        .run();
      return;
    }

    this.db
      .insert(t.agentSessions)
      .values({
        id: `sess:${randomUUID()}`,
        agentId: input.agentId,
        conversationId: input.conversationId,
        runtimeType: input.runtimeType,
        runtimeSessionId: input.runtimeSessionId,
        lastUsedAt: Date.now(),
      })
      .run();
  }

  /**
   * Forgets every native session this agent holds, and reports how many.
   *
   * Called when an agent's working directory changes: a Claude Code session or
   * Codex thread was started in the old directory, and resuming it somewhere
   * else would give the agent a stale picture of where it is. Dropping the ids
   * simply means the next run starts fresh.
   */
  clearAgentSessions(agentId: string): number {
    const existing = this.db
      .select({ id: t.agentSessions.id })
      .from(t.agentSessions)
      .where(eq(t.agentSessions.agentId, agentId))
      .all();

    if (existing.length) {
      this.db.delete(t.agentSessions).where(eq(t.agentSessions.agentId, agentId)).run();
    }
    return existing.length;
  }

  /* ----------------------------------------------------------------- tasks */

  listTasks(conversationId: string): Task[] {
    const rows = this.db
      .select()
      .from(t.tasks)
      .where(eq(t.tasks.conversationId, conversationId))
      .orderBy(t.tasks.createdAt)
      .all();
    return rows.map((row) => ({ ...row, assignedAgentIds: this.listTaskAssignees(row.id) }));
  }

  getTask(id: string): Task | null {
    const row = this.db.select().from(t.tasks).where(eq(t.tasks.id, id)).get();
    return row ? { ...row, assignedAgentIds: this.listTaskAssignees(row.id) } : null;
  }

  private listTaskAssignees(taskId: string): string[] {
    return this.db
      .select({ agentId: t.taskAssignees.agentId })
      .from(t.taskAssignees)
      .where(eq(t.taskAssignees.taskId, taskId))
      .all()
      .map((r) => r.agentId);
  }

  createTask(input: {
    conversationId: string;
    title: string;
    description: string;
    assignedAgentIds: string[];
  }): Task {
    const now = Date.now();
    const row = {
      id: `task:${randomUUID()}`,
      conversationId: input.conversationId,
      title: input.title,
      description: input.description,
      status: 'pending' as TaskStatus,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    this.db.transaction((tx) => {
      tx.insert(t.tasks).values(row).run();
      for (const agentId of new Set(input.assignedAgentIds)) {
        tx.insert(t.taskAssignees).values({ taskId: row.id, agentId }).run();
      }
    });

    return { ...row, assignedAgentIds: [...new Set(input.assignedAgentIds)] };
  }

  updateTask(id: string, patch: Partial<Task>): Task {
    const { assignedAgentIds, ...rest } = patch;
    const completedAt =
      rest.status === 'completed' ? Date.now() : rest.status ? null : undefined;

    this.db.transaction((tx) => {
      tx.update(t.tasks)
        .set({
          ...stripUndefined(rest),
          ...(completedAt === undefined ? {} : { completedAt }),
          updatedAt: Date.now(),
        })
        .where(eq(t.tasks.id, id))
        .run();

      if (assignedAgentIds) {
        tx.delete(t.taskAssignees).where(eq(t.taskAssignees.taskId, id)).run();
        for (const agentId of new Set(assignedAgentIds)) {
          tx.insert(t.taskAssignees).values({ taskId: id, agentId }).run();
        }
      }
    });

    const task = this.getTask(id);
    if (!task) throw new Error(`Task ${id} no longer exists.`);
    return task;
  }

  deleteTask(id: string): void {
    this.db.delete(t.tasks).where(eq(t.tasks.id, id)).run();
  }

  /* ------------------------------------------------------------ executions */

  createExecution(input: {
    agentId: string;
    conversationId: string;
    taskId: string | null;
    trigger: 'human' | 'agent' | 'system';
    triggeredByMessageId: string | null;
    chainId: string;
    chainDepth: number;
  }): AgentExecution {
    const row = {
      id: `exec:${randomUUID()}`,
      agentId: input.agentId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      state: 'queued' as ExecutionState,
      trigger: input.trigger,
      triggeredByMessageId: input.triggeredByMessageId,
      chainId: input.chainId,
      chainDepth: input.chainDepth,
      turns: 0,
      costUsd: 0,
      costProvenance: 'unreported' as CostProvenance,
      rawCostUsd: null,
      baselineCostUsd: null,
      nativeSessionId: null,
      inputTokens: 0,
      outputTokens: 0,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.db.insert(t.agentExecutions).values(row).run();
    return toExecution(row);
  }

  updateExecution(id: string, patch: Partial<AgentExecution> & { chainDepth?: number }): AgentExecution {
    this.db.update(t.agentExecutions).set(stripUndefined(patch)).where(eq(t.agentExecutions.id, id)).run();
    const execution = this.getExecution(id);
    if (!execution) throw new Error(`Execution ${id} no longer exists.`);
    return execution;
  }

  getExecution(id: string): AgentExecution | null {
    const row = this.db.select().from(t.agentExecutions).where(eq(t.agentExecutions.id, id)).get();
    return row ? toExecution(row) : null;
  }

  getExecutionRow(id: string) {
    return this.db.select().from(t.agentExecutions).where(eq(t.agentExecutions.id, id)).get();
  }

  listActiveExecutions(): AgentExecution[] {
    return this.db
      .select()
      .from(t.agentExecutions)
      .where(
        sql`${t.agentExecutions.state} NOT IN (${sql.join(
          TERMINAL_EXECUTION_STATES.map((s) => sql`${s}`),
          sql`, `,
        )})`,
      )
      .all()
      .map(toExecution);
  }

  listExecutionsForConversation(conversationId: string, limit = 100): AgentExecution[] {
    return this.db
      .select()
      .from(t.agentExecutions)
      .where(eq(t.agentExecutions.conversationId, conversationId))
      .orderBy(desc(t.agentExecutions.startedAt))
      .limit(limit)
      .all()
      .map(toExecution);
  }

  /**
   * Records what one execution spent, measuring against its session's baseline.
   *
   * Claude Code reports `total_cost_usd` for a whole native session and this app
   * resumes a session on every run, so the reported figure is a session total,
   * not a run's spend. The difference is only knowable when the session's
   * earlier total was recorded -- and this method is honest about the cases
   * where it was not, rather than presenting a guess as a measurement.
   *
   * The execution row and the session baseline move together in one
   * transaction. A crash between them would otherwise leave the baseline
   * advanced past a run that was never credited, and every later run in that
   * session would be undercounted for good.
   *
   * Idempotent on purpose. `finish()` re-applies the last cost after the cost
   * events have already run, so the delta is always recomputed from the entry
   * baseline frozen on the execution, never from the live one -- otherwise the
   * second call would measure against its own result and collapse to zero.
   *
   * Runtimes that already report per-run figures (Codex, and the API-model
   * runtime) pass through untouched: `measured`, with no baseline involved.
   */
  recordExecutionCost(input: {
    executionId: string;
    runtimeType: RuntimeType;
    agentId: string;
    conversationId: string;
    /** Native session id reported by this run, when the runtime has one. */
    nativeSessionId: string | null;
    /** Whether this run asked to resume an existing session. */
    resumeRequested: boolean;
    /** The runtime's figure, verbatim. */
    rawCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    turns: number;
  }): AgentExecution {
    const {
      executionId,
      runtimeType,
      agentId,
      conversationId,
      nativeSessionId,
      resumeRequested,
      rawCostUsd,
      inputTokens,
      outputTokens,
      turns,
    } = input;

    this.db.transaction((tx) => {
      const tokens = { inputTokens, outputTokens, turns };
      const write = (patch: {
        costUsd: number;
        baselineCostUsd: number | null;
        costProvenance: CostProvenance;
      }) =>
        tx
          .update(t.agentExecutions)
          .set({ ...tokens, ...patch, rawCostUsd, nativeSessionId })
          .where(eq(t.agentExecutions.id, executionId))
          .run();

      // Runtimes that report no cost at all. An API-model agent records a
      // literal zero because pricing was never implemented, and an external
      // agent reports nothing. Calling either "measured" would turn "we never
      // priced this" into "this was free", which is the opposite of true.
      if (runtimeType === 'model' || runtimeType === 'a2a') {
        write({ costUsd: rawCostUsd, baselineCostUsd: null, costProvenance: 'unpriced' });
        return;
      }

      // Codex accumulates from zero inside each execution, so its figure is
      // already this run's own spend.
      if (runtimeType !== 'claude-code') {
        write({ costUsd: rawCostUsd, baselineCostUsd: null, costProvenance: 'measured' });
        return;
      }

      // Claude Code reports a session cumulative, so without a session id there
      // is nothing to anchor it to. Whether that matters depends on whether
      // anything came before: a run that resumed nothing started from zero, so
      // its cumulative is its own spend. A run that asked to resume did have a
      // history, and its figure covers a span we cannot separate.
      if (!nativeSessionId) {
        write(
          resumeRequested
            ? { costUsd: 0, baselineCostUsd: null, costProvenance: 'ambiguous' }
            : { costUsd: rawCostUsd, baselineCostUsd: 0, costProvenance: 'measured' },
        );
        return;
      }

      const current = tx
        .select({
          baselineCostUsd: t.agentExecutions.baselineCostUsd,
          costProvenance: t.agentExecutions.costProvenance,
        })
        .from(t.agentExecutions)
        .where(eq(t.agentExecutions.id, executionId))
        .get();

      const key = and(
        eq(t.sessionCostBaselines.runtimeType, runtimeType),
        eq(t.sessionCostBaselines.agentId, agentId),
        eq(t.sessionCostBaselines.conversationId, conversationId),
        eq(t.sessionCostBaselines.runtimeSessionId, nativeSessionId),
      );
      const stored = tx.select().from(t.sessionCostBaselines).where(key).get();

      let entryBaseline = current?.baselineCostUsd ?? null;
      let provenance: CostProvenance = current?.costProvenance ?? 'ambiguous';
      /** Where the session's counter ends up, and whether we trust it. */
      let sessionRaw = Math.max(stored?.rawCostUsd ?? 0, rawCostUsd);
      let sessionUncertain = stored?.uncertain ?? false;

      if (entryBaseline === null) {
        if (stored && !stored.uncertain) {
          // Watched before and trusted: the difference is real.
          entryBaseline = stored.rawCostUsd;
          provenance = 'measured';
        } else if (stored) {
          // The session's recorded position is only a lower bound, because
          // something before it reported zero while possibly having spent. Any
          // difference measured from it would silently absorb that run's spend,
          // so this run re-anchors and claims nothing.
          entryBaseline = rawCostUsd;
          provenance = 'ambiguous';
          sessionUncertain = false;
          sessionRaw = rawCostUsd;
        } else if (!resumeRequested) {
          // Nobody asked to resume, so the session really did start at zero.
          entryBaseline = 0;
          provenance = 'measured';
        } else {
          // A session that already existed before this accounting watched it --
          // one predating the change, or a fork we cannot tell from a fresh
          // session. Its earlier total was never recorded, so this run's spend
          // cannot be recovered. It anchors the next run and claims nothing.
          entryBaseline = rawCostUsd;
          provenance = 'baseline_only';
        }
      }

      let costUsd = rawCostUsd - entryBaseline;

      if (rawCostUsd === 0 && entryBaseline > 0) {
        // A crashed or startup-failed result reports zero -- but it may still
        // have spent before dying. The session's true position is therefore
        // unknown, so it is flagged and the next run re-anchors instead of
        // measuring a difference that would quietly include this run's spend.
        costUsd = 0;
        provenance = 'ambiguous';
        sessionUncertain = true;
        sessionRaw = stored?.rawCostUsd ?? entryBaseline;
      } else if (costUsd < 0) {
        // The counter went backwards: a mid-run reset. What was spent before it
        // is in no figure we hold. The session's counter genuinely restarted,
        // so the stored high-water mark must follow it down -- leaving it at the
        // old peak would keep every later run ambiguous until that peak was
        // passed again.
        costUsd = 0;
        provenance = 'ambiguous';
        sessionRaw = rawCostUsd;
        sessionUncertain = false;
      }

      write({ costUsd, baselineCostUsd: entryBaseline, costProvenance: provenance });

      const row = { rawCostUsd: sessionRaw, uncertain: sessionUncertain, updatedAt: Date.now() };
      if (stored) {
        tx.update(t.sessionCostBaselines).set(row).where(key).run();
      } else {
        tx.insert(t.sessionCostBaselines)
          .values({
            runtimeType,
            agentId,
            conversationId,
            runtimeSessionId: nativeSessionId,
            ...row,
          })
          .run();
      }
    });

    const execution = this.getExecution(executionId);
    if (!execution) throw new Error(`Execution ${executionId} no longer exists.`);
    return execution;
  }

  /**
   * Total spend recorded against one agent-to-agent chain, for the spend limit.
   *
   * This is a ceiling, so where spend is unknown the answer must never be a
   * number smaller than the truth: stopping a chain early is recoverable,
   * letting it run past its budget is not.
   *
   *  - `measured` contributes its real figure.
   *  - `legacy` and `baseline_only` contribute their raw reported total, which
   *    for a Claude Code session cumulative is a genuine upper bound on what
   *    that run could have spent.
   *  - `ambiguous` splits in two, and it is **not** true that every ambiguous
   *    cost is unbounded. Where the run's figure still covers its own spend --
   *    a cumulative for a span we could not identify -- that figure is a real
   *    ceiling and is used. Only where the session had already reached a
   *    positive total and the run then reported the same or less is the missing
   *    amount bounded by nothing we hold: a zeroed result may have spent before
   *    dying, and a reset run's pre-reset spend is in no figure at all. Those
   *    return Infinity so the limit fails closed rather than reading a silent
   *    zero as "nothing was spent". A human message starts a new chain, so this
   *    stops a cascade rather than wedging the app.
   *  - `unreported` depends on evidence. If the run produced output -- text,
   *    reasoning or a tool call, none of which can happen before model work --
   *    then it spent something unknowable, and the limit fails closed. With no
   *    such evidence it contributes nothing, so a run that failed before
   *    reaching the model does not wedge its chain.
   *
   * This is therefore conservative where there is evidence and **best effort
   * where there is not**: a run that spent and produced no observable output
   * before dying still contributes zero. That is a real bound on this limit,
   * not a guarantee against it.
   *  - `unpriced` contributes zero, because no price exists to contribute. This
   *    is a real gap in enforcement for API-model agents and it predates this
   *    change; it is recorded in the usage report rather than hidden here.
   */
  chainCostUsd(chainId: string): number {
    const row = this.db
      .select({
        bounded: sql<number>`COALESCE(SUM(
          CASE ${t.agentExecutions.costProvenance}
            WHEN 'measured' THEN ${t.agentExecutions.costUsd}
            WHEN 'unpriced' THEN 0
            -- Handled below: whether a run that reported nothing still spent
            -- depends on evidence outside this row.
            WHEN 'unreported' THEN 0
            ELSE COALESCE(${t.agentExecutions.rawCostUsd}, ${t.agentExecutions.costUsd})
          END), 0)`,
        unbounded: sql<number>`COALESCE(SUM(
          CASE
            WHEN ${t.agentExecutions.costProvenance} = 'ambiguous'
             AND ${t.agentExecutions.baselineCostUsd} IS NOT NULL
             AND ${t.agentExecutions.baselineCostUsd} > 0
             AND COALESCE(${t.agentExecutions.rawCostUsd}, 0) <= ${t.agentExecutions.baselineCostUsd}
            THEN 1
            -- A run that reported no usage, but demonstrably reached the model.
            -- These event types cannot be produced before model work begins, so
            -- their presence is affirmative evidence that something was spent
            -- even though no figure ever arrived.
            --
            -- Only for runtimes that report cost at all. A model or external
            -- agent has no price whatever it did, so its missing figure is not
            -- unbounded spend -- it is the absence of pricing, and blocking a
            -- chain over it would stop work for a cost that does not exist.
            WHEN ${t.agentExecutions.costProvenance} = 'unreported'
             AND EXISTS (
               SELECT 1 FROM agents
               WHERE agents.id = agent_executions.agent_id
                 AND agents.runtime_type IN ('claude-code', 'codex')
             )
             AND EXISTS (
               SELECT 1 FROM agent_events
               WHERE agent_events.execution_id = agent_executions.id
                 AND agent_events.type IN ('text', 'text_delta', 'thinking', 'tool_use')
             )
            THEN 1
            ELSE 0
          END), 0)`,
      })
      .from(t.agentExecutions)
      .where(eq(t.agentExecutions.chainId, chainId))
      .get();

    if ((row?.unbounded ?? 0) > 0) return Number.POSITIVE_INFINITY;
    return row?.bounded ?? 0;
  }

  /** How many executions this chain has already produced. */
  chainLength(chainId: string): number {
    const row = this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(t.agentExecutions)
      .where(eq(t.agentExecutions.chainId, chainId))
      .get();
    return row?.count ?? 0;
  }

  /**
   * Consecutive automatic (agent-triggered) executions for one agent, counting
   * back until the most recent human-triggered run.
   */
  consecutiveAutoActivations(agentId: string): number {
    const rows = this.db
      .select({ trigger: t.agentExecutions.trigger })
      .from(t.agentExecutions)
      .where(eq(t.agentExecutions.agentId, agentId))
      .orderBy(desc(t.agentExecutions.startedAt))
      .limit(50)
      .all();

    let count = 0;
    for (const row of rows) {
      if (row.trigger === 'agent') count += 1;
      else break;
    }
    return count;
  }

  /* ---------------------------------------------------------------- events */

  appendEvent(executionId: string, seq: number, type: AgentEventType, payload: Record<string, unknown>): AgentEvent {
    const row: AgentEvent = {
      id: `evt:${randomUUID()}`,
      executionId,
      seq,
      type,
      payload,
      createdAt: Date.now(),
    };
    this.db.insert(t.agentEvents).values(row).run();
    return row;
  }

  listEvents(executionId: string, limit = 2000): AgentEvent[] {
    return this.db
      .select()
      .from(t.agentEvents)
      .where(eq(t.agentEvents.executionId, executionId))
      .orderBy(t.agentEvents.seq)
      .limit(limit)
      .all();
  }

  /* -------------------------------------------------------------- settings */

  getSettings(defaults: AppSettings): AppSettings {
    const row = this.db.select().from(t.appSettings).where(eq(t.appSettings.key, SETTINGS_KEY)).get();
    if (!row) return defaults;
    const stored = row.value as Partial<AppSettings>;
    return {
      ...defaults,
      ...stored,
      limits: { ...DEFAULT_LIMITS, ...defaults.limits, ...(stored.limits ?? {}) },
    };
  }

  saveSettings(settings: AppSettings): AppSettings {
    const existing = this.db
      .select()
      .from(t.appSettings)
      .where(eq(t.appSettings.key, SETTINGS_KEY))
      .get();

    if (existing) {
      this.db
        .update(t.appSettings)
        .set({ value: settings, updatedAt: Date.now() })
        .where(eq(t.appSettings.key, SETTINGS_KEY))
        .run();
    } else {
      this.db
        .insert(t.appSettings)
        .values({ key: SETTINGS_KEY, value: settings, updatedAt: Date.now() })
        .run();
    }
    return settings;
  }

  /* ----------------------------------------------------------------- costs */

  costSummary(now: number = Date.now()): CostSummary {
    // One basis everywhere: these rows sum measured spend only, exactly like
    // the windows below. Two totals on one screen computed differently is a
    // bug the user has to notice for us, and they should not have to.
    const measured = sql<number>`COALESCE(SUM(
      CASE WHEN ${t.agentExecutions.costProvenance} = 'measured'
        THEN ${t.agentExecutions.costUsd} ELSE 0 END), 0)`;

    // Coverage travels with every total. A sum of measured spend beside a count
    // of runs nobody could measure is the only honest way to show it; the
    // number alone would read as the whole story.
    const unverified = sql<number>`COALESCE(SUM(
      CASE WHEN ${t.agentExecutions.costProvenance} IN ('legacy', 'baseline_only', 'ambiguous')
        THEN 1 ELSE 0 END), 0)`;
    const unavailable = sql<number>`COALESCE(SUM(
      CASE WHEN ${t.agentExecutions.costProvenance} = 'unreported'
            AND ${t.agentExecutions.endedAt} IS NOT NULL
        THEN 1 ELSE 0 END), 0)`;
    const unpriced = sql<number>`COALESCE(SUM(
      CASE WHEN ${t.agentExecutions.costProvenance} = 'unpriced' THEN 1 ELSE 0 END), 0)`;

    const total = this.db
      .select({ total: measured, unverified, unavailable, unpriced })
      .from(t.agentExecutions)
      .get();

    const since = now - 24 * 60 * 60 * 1000;
    const recent = this.db
      .select({ total: measured, unverified, unavailable, unpriced })
      .from(t.agentExecutions)
      .where(sql`${t.agentExecutions.startedAt} >= ${since}`)
      .get();

    const byAgent = this.db
      .select({
        agentId: t.agentExecutions.agentId,
        costUsd: measured,
        executions: sql<number>`COUNT(*)`,
      })
      .from(t.agentExecutions)
      .groupBy(t.agentExecutions.agentId)
      .all();

    return {
      totalUsd: total?.total ?? 0,
      totalCoverage: {
        unverifiedExecutions: total?.unverified ?? 0,
        unavailableExecutions: total?.unavailable ?? 0,
        unpricedExecutions: total?.unpriced ?? 0,
      },
      last24hUsd: recent?.total ?? 0,
      last24hCoverage: {
        unverifiedExecutions: recent?.unverified ?? 0,
        unavailableExecutions: recent?.unavailable ?? 0,
        unpricedExecutions: recent?.unpriced ?? 0,
      },
      byAgent,
      windows: this.recordedUsage(now),
    };
  }

  /**
   * Recorded consumption per agent for the two windows the UI shows.
   *
   * An execution is attributed whole to the window containing its `startedAt`.
   * A run that straddles local midnight therefore counts against the day it
   * began: splitting it would mean inventing a distribution of spend across
   * time that nothing in the data supports.
   *
   * Aggregated from `agent_executions` rows, never from `agent_events`. A row
   * already holds the run's final running total, while the events table holds
   * every intermediate total for the same run -- summing those would count the
   * same spend many times over.
   *
   * Failed, cancelled and timed-out runs are included. The tokens were spent.
   */
  recordedUsage(now: number = Date.now()): RecordedUsageWindows {
    const dayStart = startOfLocalDay(now);
    return {
      today: this.usageBetween(dayStart, now),
      last7Days: this.usageBetween(now - 7 * 24 * 60 * 60 * 1000, now),
      todayStartedAt: dayStart,
      computedAt: now,
    };
  }

  /**
   * Both ends are bounded. The upper bound is not redundant: a clock that was
   * wrong, or moved backwards, leaves rows stamped in the future, and those
   * would otherwise land in every window forever.
   *
   * Only `measured` rows contribute to the total. Everything else is counted
   * but not summed, because a figure that blends measured spend with spend
   * nobody recorded is not a total -- it is a guess wearing a total's clothes.
   * The caller gets both numbers and says so on screen.
   */
  private usageBetween(since: number, until: number): RecordedUsageRow[] {
    return this.db
      .select({
        agentId: t.agentExecutions.agentId,
        costUsd: sql<number>`COALESCE(SUM(
          CASE WHEN ${t.agentExecutions.costProvenance} = 'measured'
            THEN ${t.agentExecutions.costUsd} ELSE 0 END), 0)`,
        inputTokens: sql<number>`COALESCE(SUM(${t.agentExecutions.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${t.agentExecutions.outputTokens}), 0)`,
        executions: sql<number>`COUNT(*)`,
        /**
         * Runs whose spend is not known: recorded before this accounting
         * existed, or a session first seen mid-flight, or a counter that moved
         * in a way we cannot read. Only counted for runtimes that report cost
         * at all -- a model agent reporting zero is a separate, known state.
         */
        unverifiedExecutions: sql<number>`COALESCE(SUM(
          CASE WHEN ${t.agentExecutions.costProvenance} IN ('legacy', 'baseline_only', 'ambiguous')
            THEN 1 ELSE 0 END), 0)`,
        /**
         * Finished runs on a cost-reporting runtime that reported no usage at
         * all.
         *
         * Kept apart from the unverified count because the reason differs and
         * so should the wording: those runs reported a figure we could not
         * anchor, these reported nothing. An earlier version excluded them when
         * tokens were zero, on the theory that meant no model work -- but
         * tokens are written by the same event as the cost, so no report is
         * exactly why tokens stay zero. That test proved nothing.
         */
        unavailableExecutions: sql<number>`COALESCE(SUM(
          CASE WHEN ${t.agentExecutions.costProvenance} = 'unreported'
                AND ${t.agentExecutions.endedAt} IS NOT NULL
                AND ${t.agents.runtimeType} IN ('claude-code', 'codex')
            THEN 1 ELSE 0 END), 0)`,
        /**
         * Runs on a runtime this app cannot price at all. Distinct from the
         * unverified count: nothing failed here, there simply is no price, so
         * any dollar total covering these runs is partial by construction.
         */
        unpricedExecutions: sql<number>`COALESCE(SUM(
          CASE WHEN ${t.agentExecutions.costProvenance} = 'unpriced' THEN 1 ELSE 0 END), 0)`,
      })
      .from(t.agentExecutions)
      .innerJoin(t.agents, eq(t.agents.id, t.agentExecutions.agentId))
      .where(
        sql`${t.agentExecutions.startedAt} >= ${since} AND ${t.agentExecutions.startedAt} <= ${until}`,
      )
      .groupBy(t.agentExecutions.agentId)
      .all();
  }

  /**
   * Marks executions left running by a crash or a force quit as failed.
   * Called once at startup so the UI never shows a permanently "working" agent.
   */
  reconcileOrphanedExecutions(): number {
    const active = this.listActiveExecutions();
    for (const execution of active) {
      this.updateExecution(execution.id, {
        state: 'failed',
        error: 'The application stopped while this execution was running.',
        endedAt: Date.now(),
      });
    }
    return active.length;
  }

  agentsByIds(ids: string[]): Agent[] {
    if (!ids.length) return [];
    return this.db.select().from(t.agents).where(inArray(t.agents.id, ids)).all().map(toAgent);
  }
}

/* -------------------------------------------------------------------------- */

function toAgent(row: typeof t.agents.$inferSelect): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    runtimeType: row.runtimeType,
    avatar: row.avatar,
    avatarColor: row.avatarColor,
    workingDirectory: row.workingDirectory,
    status: row.status,
    statusDetail: row.statusDetail,
    permissions: row.permissions,
    config: row.config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toConversation(row: typeof t.conversations.$inferSelect): Conversation {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    topic: row.topic,
    icon: row.icon ?? null,
    autonomyEnabled: row.autonomyEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExecution(row: typeof t.agentExecutions.$inferSelect): AgentExecution {
  return {
    id: row.id,
    agentId: row.agentId,
    conversationId: row.conversationId,
    taskId: row.taskId,
    state: row.state,
    trigger: row.trigger,
    triggeredByMessageId: row.triggeredByMessageId,
    turns: row.turns,
    costUsd: row.costUsd,
    costProvenance: row.costProvenance,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    error: row.error,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
