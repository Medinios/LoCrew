import type { AppEvent } from '../../shared/ipc.js';
import type {
  AuthMethod,
  ModelCapabilities,
  ProviderCategory,
  ProviderCheck,
  ProviderHeader,
  ProviderKind,
  ProviderModel,
  ProviderOptions,
  ProviderView,
} from '../../shared/integrations.js';
import { checkEndpointUrl, UNKNOWN_CAPABILITIES } from '../../shared/integrations.js';
import { presetById } from '../../shared/provider-presets.js';
import type { IntegrationStore, ProviderRow } from '../db/integration-store.js';
import { isSensitiveHeader, type SecretStore } from '../security/secrets.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter, OllamaAdapter } from './gemini-ollama.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import {
  ProviderError,
  type ChatEvent,
  type ChatRequest,
  type ProviderAdapter,
  type ResolvedProvider,
} from './types.js';

/** What the Add/Edit Provider dialog submits. */
export interface ProviderInput {
  name: string;
  preset: string;
  kind: ProviderKind;
  category: ProviderCategory;
  baseUrl: string;
  authMethod: AuthMethod;
  authHeaderName?: string | null;
  /** New key. Omit or leave empty to keep the stored one; `null` clears it. */
  apiKey?: string | null;
  headers?: ProviderHeader[];
  options?: ProviderOptions;
  timeoutMs?: number;
  /** Models to start with (e.g. one entered manually in the dialog). */
  models?: ProviderModel[];
}

interface ProviderSecret extends Record<string, unknown> {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface ProviderRegistryDeps {
  integrations: IntegrationStore;
  secrets: SecretStore;
  emit(event: AppEvent): void;
  /** Names of agents that use a provider, to refuse deleting it from under them. */
  agentsUsing(providerId: string): string[];
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  models: ProviderModel[];
}

/**
 * Every model provider the user has configured, and the adapters that speak
 * to them.
 *
 * Adapters are registered by wire protocol, not by vendor, so a new
 * OpenAI-compatible service needs no code at all, and a genuinely new
 * protocol needs one adapter registered here -- the conversation engine and
 * everything above it stay unchanged.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<ProviderKind, ProviderAdapter>();

  constructor(private readonly deps: ProviderRegistryDeps) {
    this.register(new OpenAICompatibleAdapter());
    this.register(new AnthropicAdapter());
    this.register(new GeminiAdapter());
    this.register(new OllamaAdapter());
  }

  /** Adds or replaces the adapter for a wire protocol. */
  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  /* ------------------------------------------------------------------ CRUD */

  list(): ProviderView[] {
    return this.deps.integrations.listProviders().map((row) => this.toView(row));
  }

  get(id: string): ProviderView | null {
    const row = this.deps.integrations.getProvider(id);
    return row ? this.toView(row) : null;
  }

  create(input: ProviderInput): ProviderView {
    const clean = this.validate(input);
    if (this.deps.integrations.getProviderByName(clean.name)) {
      throw new Error(`A provider named "${clean.name}" already exists.`);
    }

    const { plain, secret, secretNames } = splitHeaders(input.headers ?? [], {});
    const apiKey = input.apiKey?.trim() || undefined;
    const secretValue: ProviderSecret = { apiKey, headers: secret };
    const secretId = apiKey || secretNames.length ? this.deps.secrets.create(secretValue) : null;

    const row = this.deps.integrations.createProvider({
      name: clean.name,
      kind: input.kind,
      preset: input.preset,
      category: input.category,
      baseUrl: clean.baseUrl,
      authMethod: input.authMethod,
      authHeaderName: input.authHeaderName?.trim() || null,
      secretId,
      headers: plain,
      secretHeaderNames: secretNames,
      options: input.options ?? {},
      timeoutMs: input.timeoutMs ?? 60_000,
      models: (input.models ?? []).map(normaliseModel),
      lastCheck: null,
    });
    return this.publish(row);
  }

  update(id: string, input: ProviderInput): ProviderView {
    const current = this.requireRow(id);
    const clean = this.validate(input);
    const clash = this.deps.integrations.getProviderByName(clean.name);
    if (clash && clash.id !== id) throw new Error(`A provider named "${clean.name}" already exists.`);

    const stored = this.deps.secrets.read<ProviderSecret>(current.secretId);
    const { plain, secret, secretNames } = splitHeaders(input.headers ?? [], stored.headers ?? {});
    const apiKey =
      input.apiKey === null ? undefined : input.apiKey?.trim() ? input.apiKey.trim() : stored.apiKey;
    const secretValue: ProviderSecret = { apiKey, headers: secret };

    let secretId = current.secretId;
    if (apiKey || secretNames.length) secretId = this.deps.secrets.put(current.secretId, secretValue);
    else {
      this.deps.secrets.delete(current.secretId);
      secretId = null;
    }

    const row = this.deps.integrations.updateProvider(id, {
      name: clean.name,
      kind: input.kind,
      preset: input.preset,
      category: input.category,
      baseUrl: clean.baseUrl,
      authMethod: input.authMethod,
      authHeaderName: input.authHeaderName?.trim() || null,
      secretId,
      headers: plain,
      secretHeaderNames: secretNames,
      options: input.options ?? current.options,
      timeoutMs: input.timeoutMs ?? current.timeoutMs,
      ...(input.models ? { models: input.models.map(normaliseModel) } : {}),
    });
    return this.publish(row);
  }

  delete(id: string): void {
    const row = this.requireRow(id);
    const users = this.deps.agentsUsing(id);
    if (users.length) {
      throw new Error(
        `${row.name} is used by ${users.join(', ')}. Move ${users.length === 1 ? 'that agent' : 'those agents'} to another provider first.`,
      );
    }
    this.deps.secrets.delete(row.secretId);
    this.deps.integrations.deleteProvider(id);
    this.deps.emit({ type: 'provider-deleted', providerId: id });
  }

  /** Replaces the model list (manual additions, removals, capability overrides). */
  setModels(id: string, models: ProviderModel[]): ProviderView {
    this.requireRow(id);
    const row = this.deps.integrations.updateProvider(id, { models: models.map(normaliseModel) });
    return this.publish(row);
  }

  /**
   * Records a capability learned from a provider's own answer, e.g. a 400 that
   * says the model does not take tools. User overrides still win over it.
   */
  learnCapability(id: string, modelId: string, patch: Partial<ModelCapabilities>): void {
    const row = this.deps.integrations.getProvider(id);
    if (!row) return;
    const models = [...row.models];
    const index = models.findIndex((m) => m.id === modelId);
    if (index >= 0) {
      const model = models[index]!;
      models[index] = { ...model, capabilities: { ...model.capabilities, ...patch } };
    } else {
      models.push({ id: modelId, source: 'manual', capabilities: { ...UNKNOWN_CAPABILITIES, ...patch }, overrides: {} });
    }
    this.publish(this.deps.integrations.updateProvider(id, { models }));
  }

  /* ------------------------------------------------------- live operations */

  /**
   * Checks reachability and credentials by listing models, which costs nothing
   * on every provider. Where discovery is unavailable, a one-token request to
   * the configured model is the fallback probe.
   */
  async test(id: string): Promise<ConnectionTestResult> {
    const provider = this.resolve(id);
    const result = await this.probe(provider, this.requireRow(id).models[0]?.id);
    const check: ProviderCheck = {
      ok: result.ok,
      message: result.message,
      at: Date.now(),
      latencyMs: result.latencyMs,
      modelCount: result.models.length,
    };
    this.publish(this.deps.integrations.updateProvider(id, { lastCheck: check }));
    return result;
  }

  /** Tests a configuration the user has not saved yet. Nothing is persisted. */
  async testDraft(input: ProviderInput, existingId?: string): Promise<ConnectionTestResult> {
    const clean = this.validate(input);
    const stored = existingId ? this.deps.secrets.read<ProviderSecret>(this.requireRow(existingId).secretId) : {};
    const headers: Record<string, string> = {};
    for (const header of input.headers ?? []) {
      if (!header.name.trim()) continue;
      const value = header.value || stored.headers?.[header.name] || '';
      if (value) headers[header.name.trim()] = value;
    }
    const provider: ResolvedProvider = {
      id: existingId ?? 'draft',
      name: clean.name || 'The provider',
      kind: input.kind,
      preset: input.preset,
      baseUrl: clean.baseUrl,
      authMethod: input.authMethod,
      authHeaderName: input.authHeaderName?.trim() || null,
      apiKey: input.apiKey?.trim() || stored.apiKey || null,
      headers,
      options: input.options ?? {},
      timeoutMs: Math.min(input.timeoutMs ?? 30_000, 30_000),
    };
    return this.probe(provider, input.models?.[0]?.id);
  }

  /** Fetches the model list and merges it with manual models and overrides. */
  async discover(id: string): Promise<ProviderView> {
    const provider = this.resolve(id);
    const adapter = this.adapterFor(provider.kind);
    const discovered = await adapter.listModels(provider, AbortSignal.timeout(provider.timeoutMs));
    const current = this.requireRow(id).models;

    const merged: ProviderModel[] = discovered.map((model) => {
      const existing = current.find((m) => m.id === model.id);
      return existing
        ? {
            ...model,
            // Keep anything learned at runtime that discovery did not report.
            capabilities: mergeKnown(existing.capabilities, model.capabilities),
            overrides: existing.overrides,
          }
        : model;
    });
    for (const model of current) {
      if (model.source === 'manual' && !merged.some((m) => m.id === model.id)) merged.push(model);
    }

    const row = this.deps.integrations.updateProvider(id, {
      models: merged,
      lastCheck: {
        ok: true,
        message: `Found ${discovered.length} model${discovered.length === 1 ? '' : 's'}.`,
        at: Date.now(),
        modelCount: discovered.length,
      },
    });
    return this.publish(row);
  }

  /** Streams one model turn through the provider's adapter. */
  chat(providerId: string, request: ChatRequest): AsyncIterable<ChatEvent> {
    const provider = this.resolve(providerId);
    return this.adapterFor(provider.kind).chat(provider, request);
  }

  /** A provider with credentials decrypted, for the main process only. */
  resolve(id: string): ResolvedProvider {
    const row = this.requireRow(id);
    const secret = this.deps.secrets.read<ProviderSecret>(row.secretId);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      preset: row.preset,
      baseUrl: row.baseUrl,
      authMethod: row.authMethod,
      authHeaderName: row.authHeaderName,
      apiKey: secret.apiKey ?? null,
      headers: { ...row.headers, ...(secret.headers ?? {}) },
      options: row.options,
      timeoutMs: row.timeoutMs,
    };
  }

  /* -------------------------------------------------------------- internal */

  private async probe(provider: ResolvedProvider, fallbackModel?: string): Promise<ConnectionTestResult> {
    const adapter = this.adapterFor(provider.kind);
    const started = Date.now();
    try {
      const models = await adapter.listModels(provider, AbortSignal.timeout(provider.timeoutMs));
      return {
        ok: true,
        message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`,
        latencyMs: Date.now() - started,
        models,
      };
    } catch (error) {
      const discoveryUnavailable =
        error instanceof ProviderError && (error.kind === 'not_found' || error.kind === 'bad_request');
      if (discoveryUnavailable && fallbackModel) {
        return this.probeByChat(provider, fallbackModel, started);
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
        models: [],
      };
    }
  }

  /** Last-resort probe for providers without a model list: a one-token turn. */
  private async probeByChat(provider: ResolvedProvider, model: string, started: number): Promise<ConnectionTestResult> {
    try {
      const events = this.adapterFor(provider.kind).chat(provider, {
        model,
        messages: [{ role: 'user', content: 'Reply with: ok' }],
        maxOutputTokens: 5,
        signal: AbortSignal.timeout(provider.timeoutMs),
      });
      for await (const event of events) if (event.type === 'done') break;
      return {
        ok: true,
        message: `Connected. ${model} answered (this provider has no model list).`,
        latencyMs: Date.now() - started,
        models: [],
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
        models: [],
      };
    }
  }

  private adapterFor(kind: ProviderKind): ProviderAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new ProviderError(`No adapter is registered for "${kind}" providers.`, 'bad_request');
    return adapter;
  }

  private validate(input: ProviderInput): { name: string; baseUrl: string } {
    const name = input.name.trim();
    if (!name) throw new Error('Give the provider a name.');
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    // Local servers (Ollama, LM Studio) are plain HTTP on loopback by design;
    // anything remote must use TLS so the key never crosses the network in clear.
    const problem = checkEndpointUrl(baseUrl);
    if (problem) throw new Error(problem);
    if (baseUrl.includes('YOUR-RESOURCE')) throw new Error('Replace YOUR-RESOURCE in the base URL with your Azure resource name.');
    if (input.authMethod === 'header' && !input.authHeaderName?.trim()) {
      throw new Error('Name the header that carries the key.');
    }
    const preset = presetById(input.preset);
    if (preset && preset.kind !== input.kind) throw new Error('That preset and provider type do not match.');
    return { name, baseUrl };
  }

  private requireRow(id: string): ProviderRow {
    const row = this.deps.integrations.getProvider(id);
    if (!row) throw new Error('That provider no longer exists.');
    return row;
  }

  private publish(row: ProviderRow): ProviderView {
    const view = this.toView(row);
    this.deps.emit({ type: 'provider', provider: view });
    return view;
  }

  private toView(row: ProviderRow): ProviderView {
    const secret = this.deps.secrets.read<ProviderSecret>(row.secretId);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      preset: row.preset,
      category: row.category,
      baseUrl: row.baseUrl,
      authMethod: row.authMethod,
      authHeaderName: row.authHeaderName,
      hasApiKey: !!secret.apiKey,
      headers: [
        ...Object.entries(row.headers).map(([name, value]) => ({ name, value, secret: false })),
        ...row.secretHeaderNames.map((name) => ({ name, value: '', secret: true, hasValue: !!secret.headers?.[name] })),
      ],
      options: row.options,
      timeoutMs: row.timeoutMs,
      models: row.models,
      lastCheck: row.lastCheck ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/* -------------------------------------------------------------------------- */

function splitHeaders(
  headers: ProviderHeader[],
  storedSecret: Record<string, string>,
): { plain: Record<string, string>; secret: Record<string, string>; secretNames: string[] } {
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.trim();
    if (!name) continue;
    if (header.secret || isSensitiveHeader(name)) {
      const value = header.value || storedSecret[name];
      if (value) secret[name] = value;
    } else {
      plain[name] = header.value;
    }
  }
  return { plain, secret, secretNames: Object.keys(secret) };
}

function normaliseModel(model: ProviderModel): ProviderModel {
  return {
    id: model.id.trim(),
    ...(model.label ? { label: model.label } : {}),
    source: model.source,
    capabilities: { ...UNKNOWN_CAPABILITIES, ...model.capabilities },
    overrides: model.overrides ?? {},
  };
}

/** Fresh discovery wins where it has an answer; learned values fill its gaps. */
function mergeKnown(previous: ModelCapabilities, next: ModelCapabilities): ModelCapabilities {
  const result = { ...next };
  for (const key of Object.keys(next) as Array<keyof ModelCapabilities>) {
    if (result[key] === null && previous[key] !== null) (result as Record<string, unknown>)[key] = previous[key];
  }
  return result;
}
