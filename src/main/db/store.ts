import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type {
  Agent,
  AgentEvent,
  AgentEventType,
  AgentExecution,
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
import type { CostSummary } from '../../shared/ipc.js';
import type { Db } from './index.js';
import * as t from './schema.js';

const SETTINGS_KEY = 'app';

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

  /** Total spend recorded against one agent-to-agent chain. */
  chainCostUsd(chainId: string): number {
    const row = this.db
      .select({ total: sql<number>`COALESCE(SUM(${t.agentExecutions.costUsd}), 0)` })
      .from(t.agentExecutions)
      .where(eq(t.agentExecutions.chainId, chainId))
      .get();
    return row?.total ?? 0;
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

  costSummary(): CostSummary {
    const total = this.db
      .select({ total: sql<number>`COALESCE(SUM(${t.agentExecutions.costUsd}), 0)` })
      .from(t.agentExecutions)
      .get();

    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = this.db
      .select({ total: sql<number>`COALESCE(SUM(${t.agentExecutions.costUsd}), 0)` })
      .from(t.agentExecutions)
      .where(sql`${t.agentExecutions.startedAt} >= ${since}`)
      .get();

    const byAgent = this.db
      .select({
        agentId: t.agentExecutions.agentId,
        costUsd: sql<number>`COALESCE(SUM(${t.agentExecutions.costUsd}), 0)`,
        executions: sql<number>`COUNT(*)`,
      })
      .from(t.agentExecutions)
      .groupBy(t.agentExecutions.agentId)
      .all();

    return {
      totalUsd: total?.total ?? 0,
      last24hUsd: recent?.total ?? 0,
      byAgent,
    };
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
