/**
 * The list of IPC channels the renderer is allowed to call.
 *
 * This module is deliberately dependency-free. The preload script runs in a
 * sandboxed context where arbitrary modules cannot be required, so it imports
 * the allowlist from here rather than from `ipc.ts`, which pulls in Zod for the
 * main process's validation.
 *
 * `ipc.ts` asserts at compile time that this list and the schema map agree, so
 * the two cannot drift apart.
 */
export const INVOKE_CHANNELS = [
  'agents:list',
  'agents:create',
  'agents:update',
  'agents:delete',
  'agents:detectRuntime',
  'agents:plugins',

  'conversations:list',
  'conversations:create',
  'conversations:update',
  'conversations:delete',
  'conversations:members',
  'conversations:addAgent',
  'conversations:removeAgent',

  'messages:list',
  'messages:send',

  'tasks:list',
  'tasks:create',
  'tasks:update',
  'tasks:delete',

  'executions:active',
  'executions:forConversation',
  'executions:events',

  'activity:list',
  'activity:live',
  'reactions:toggle',
  'executions:cancel',
  'executions:cancelConversation',

  'workspace:pickDirectory',
  'workspace:pickFiles',
  'workspace:locks',

  'settings:get',
  'settings:update',

  'costs:summary',

  'agents:duplicate',

  'providers:list',
  'providers:create',
  'providers:update',
  'providers:delete',
  'providers:test',
  'providers:discover',
  'providers:setModels',

  'mcp:list',
  'mcp:create',
  'mcp:update',
  'mcp:delete',
  'mcp:connect',
  'mcp:disconnect',
  'mcp:reconnect',

  'grants:list',
  'grants:set',

  'access:list',
  'access:grant',
  'access:revoke',

  'approvals:list',
  'approvals:respond',

  'app:info',

  'a2a:inspect',
] as const;

export type InvokeChannelName = (typeof INVOKE_CHANNELS)[number];

export const EVENT_CHANNEL = 'app:event';

const CHANNEL_SET: ReadonlySet<string> = new Set(INVOKE_CHANNELS);

export function isInvokeChannel(value: unknown): value is InvokeChannelName {
  return typeof value === 'string' && CHANNEL_SET.has(value);
}
