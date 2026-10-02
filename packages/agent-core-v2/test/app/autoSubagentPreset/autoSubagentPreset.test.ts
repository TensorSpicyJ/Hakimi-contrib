/**
 * Scenario: the App-scope `autoSubagentPreset` decider scores configured
 * `[subagent]` presets from quota/reset, local priority, route/model fit, token
 * use, and profile-aware reliability/latency evidence, then applies the quota
 * floor, score margin, switch cooldown, and provider circuit breaker. Aggregate
 * cases cover the shared role set, fixed denominators, DeepSeek balance/time
 * policy, capability-safe temporary replacements and pinned dispatch bindings.
 * Legacy scoring-control fixtures explicitly give the four additional default
 * roles weight zero; their route-level assertions read original role evidence,
 * while aggregate cases exercise equal weights and deduplicated candidate totals.
 * Coverage includes deterministic score contributions, low-sample shrinkage,
 * profile fallback, reset timing, unknown evidence, weighted priority overtake,
 * cooldown and unhealthy escape, circuit recovery, status/event explanations,
 * retryable ledger hydration, quota-query deadlines, and the shared
 * manual/automatic activation boundary. Manual lock and concurrent human writes
 * remain absolute; failures keep the current preset and expose only structured,
 * sanitized evidence.
 * Wiring: the SUT is resolved by interface through `TestInstantiationService`
 * with a writable layered config stub, a flagged stub, a provider-aligned
 * model catalog, a programmable provider-usage service, and a fake run-usage
 * ledger with a live completion emitter. Config-write race and failure tests
 * use real ConfigService/TOML storage with a gated in-memory storage boundary.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/autoSubagentPreset/autoSubagentPreset.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { Emitter, type Event } from '#/_base/event';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IHostClock } from '#/os/interface/hostClock';
import {
  ConfigTarget,
  type ConfigDiagnostic,
  type ConfigInspectValue,
  IConfigService,
  IConfigRegistry,
  type ResolvedConfig,
} from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAtomicDocumentStore, IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore, TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { LiveRunIdentity } from '#/app/autoSubagentPreset/liveRunIdentity';
import { AgentRunUsageService } from '#/app/agentRunUsage/agentRunUsageService';
import { IProviderUsageLedgerService } from '#/app/providerUsageLedger/providerUsageLedger';
import { ProviderUsageLedgerService, aggregateMeteredUsage } from '#/app/providerUsageLedger/providerUsageLedgerService';
import { stubProviderUsageLedger } from '../providerUsageLedger/stubs';
import { IOAuthService, IOAuthToolkit } from '#/app/auth/auth';
import { OAuthService } from '#/app/auth/authService';
import { ModelOAuthTokenAdapter } from '#/app/kosongConfig/oauthTokenAdapter';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { getScopedServiceDescriptors } from '#/_base/di/scope';
import { KimiOAuthToolkit, OpenAICodexOAuthToolkit, OPENAI_CODEX_PROVIDER_NAME, OPENAI_CODEX_OAUTH_KEY, OPENAI_CODEX_ISSUER, OPENAI_CODEX_API_BASE_URL, KIMI_CODE_PROVIDER_NAME, resolveKimiCodeRuntimeAuth } from '@moonshot-ai/kimi-code-oauth';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { stubBootstrap } from '../bootstrap/stubs';
import { IFlagService } from '#/app/flag/flag';
import { deepMerge } from '#/app/config/configPure';
import { IEventService } from '#/app/event/event';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import { DEEPSEEK_USAGE_FLAG_ID } from '#/app/providerUsage/flag';
import { ModelCatalog } from '#/kosong/model/catalogService';
import { ModelService } from '#/kosong/model/modelService';
import { ProviderService } from '#/kosong/provider/providerService';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { stubModelOAuthTokens } from '../../kosong/stubs';
import { stubFlag } from '../flag/stubs';
import '#/app/kosongConfig/configSection';
import '#/kosong/provider/bases/openai/index';
import '#/kosong/provider/providers/deepseek/deepseek.contrib';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';
import { IProviderUsageService, type ProviderUsageResult } from '#/app/providerUsage/providerUsage';
import {
  type AgentRunUsageEntry,
  type AgentRunUsageFinishedRecord,
  type AgentRunUsageRecord,
  type AgentRunUsageStartedRecord,
  IAgentRunUsageService,
} from '#/app/agentRunUsage/agentRunUsage';
import {
  SUBAGENT_SECTION,
  resolveSubagentAutoPresetConfig,
  type SubagentAutoPresetConfig,
  type SubagentConfig,
  type SubagentRouteRequest,
} from '#/session/subagent/configSection';
import { AUTO_SUBAGENT_PRESET_FLAG_ID } from '#/session/subagent/flag';
import { ISubagentPresetActivationService } from '#/session/subagent/presetActivation';
import { SubagentPresetActivationService } from '#/session/subagent/presetActivationService';
import { ISetSubagentPresetTool } from '#/agent/tools/subagent-preset/subagent-preset';
import { SetSubagentPresetTool } from '#/agent/tools/subagent-preset/subagentPresetTool';

import {
  AutoSubagentPresetService,
  providerQuotaEvidence,
  providerQuotaPercent,
} from '#/app/autoSubagentPreset/autoSubagentPresetService';
import { subscriptionResetPriority } from '#/app/autoSubagentPreset/resetPriority';
import type { BoosterWalletInfo, UsageRow } from '@moonshot-ai/kimi-code-oauth';
import {
  IAutoSubagentPresetService,
  SUBAGENT_PRESET_CHANGED_EVENT_TYPE,
  SUBAGENT_PRESET_EVALUATED_EVENT_TYPE,
} from '#/app/autoSubagentPreset/autoSubagentPreset';

vi.mock('#/app/config/migrations', () => ({ migrateThinkingEffortMaxToHigh: vi.fn(async () => {}) }));

const PRESETS: Record<string, Record<string, { model?: string; thinkingEffort?: string }>> = {
  balanced: { explore: { model: 'route/balanced', thinkingEffort: 'medium' } },
  'kimi-heavy': { explore: { model: 'route/kimi', thinkingEffort: 'high' } },
  'deepseek-heavy': { explore: { model: 'route/deepseek' } },
};

const REQUEST: SubagentRouteRequest = {
  route: 'agent',
  profileName: 'explore',
  caller: { modelAlias: 'caller-model', thinkingLevel: 'low' },
};

/** Shared evaluation context: every call is scoped to the same test session. */
const CTX = { sessionId: 'test-session' };

function originalRoute(candidate: NonNullable<ReturnType<IAutoSubagentPresetService['status']>>['candidates'][number] | undefined) {
  const route = candidate?.roleScores?.find((role) => role.key === 'explore')?.original;
  return { ...candidate, ...route,
    quotaRemainingPercent: route?.resource.kind === 'subscription' ? route.resource.quotaRemainingPercent : undefined,
    quotaResetAt: route?.resource.kind === 'subscription' ? route.resource.quotaResetAt : undefined };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function subagentConfigWith(
  patch: Partial<Pick<SubagentConfig, 'timeoutMs' | 'preset' | 'presets'>> & {
    readonly autoPreset?: Partial<SubagentAutoPresetConfig>;
  } = {},
): SubagentConfig {
  const { autoPreset, ...rest } = patch;
  return {
    timeoutMs: 3_600_000,
    preset: 'balanced',
    autoPreset: { enabled: true, roleWeights: { coder: 0, swarm: 0, tower_worker: 0, tower_reviewer: 0 }, ...autoPreset } as SubagentAutoPresetConfig,
    presets: PRESETS as SubagentConfig['presets'],
    ...rest,
  };
}

function windowRow(used: number, limit: number): ProviderUsageResult {
  return {
    kind: 'ok',
    provider: 'provider',
    summary: null,
    limits: [{ used, limit }],
    extraUsage: null,
  };
}

function okResult(remainingPercent: number): ProviderUsageResult {
  return windowRow((100 - remainingPercent) / 100, 1);
}

/**
 * Layered config stub mirroring the real precedence (memory overrides user):
 * used to verify the decider writes `[subagent].preset` to the User layer and
 * syncs an existing print/headless memory overlay. One instance is shared by
 * the whole suite and mutated per test (`replace` / `set`), because the SUT
 * holds the injected reference for its lifetime.
 */
class LayeredConfigStub implements IConfigService {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  onDidChangeConfiguration = (): { dispose: () => void } => ({ dispose: () => {} });
  onDidSectionChange = (): { dispose: () => void } => ({ dispose: () => {} });
  onDidChangeDiagnostics = (): { dispose: () => void } => ({ dispose: () => {} });
  failWrites = false;
  private readonly user = new Map<string, unknown>();

  constructor(initialUser: Record<string, unknown> = {}) {
    for (const [domain, value] of Object.entries(initialUser)) {
      this.user.set(domain, value);
    }
  }

  private readonly memory = new Map<string, unknown>();

  get<T = unknown>(domain: string): T {
    const userValue = this.user.get(domain);
    const memoryValue = this.memory.get(domain);
    if (memoryValue === undefined) return userValue as T;
    if (userValue === undefined) return memoryValue as T;
    if (isObject(userValue) && isObject(memoryValue)) {
      return { ...userValue, ...memoryValue } as T;
    }
    return memoryValue as T;
  }

  inspect<T = unknown>(domain: string): ConfigInspectValue<T> {
    return {
      value: this.get<T>(domain),
      defaultValue: undefined,
      userValue: this.user.get(domain) as T | undefined,
      memoryValue: this.memory.get(domain) as T | undefined,
    };
  }

  getAll(): ResolvedConfig {
    return Object.fromEntries(this.user) as ResolvedConfig;
  }

  async set(domain: string, patch: unknown, target: ConfigTarget = ConfigTarget.User): Promise<void> {
    if (this.failWrites) throw new Error('disk full');
    const layer = target === ConfigTarget.Memory ? this.memory : this.user;
    const previous = layer.get(domain);
    const value = deepMerge(previous, patch);
    layer.set(domain, value);
  }

  async replace(domain: string, value: unknown, target: ConfigTarget = ConfigTarget.User): Promise<void> {
    if (this.failWrites) throw new Error('disk full');
    const layer = target === ConfigTarget.Memory ? this.memory : this.user;
    if (value === undefined || value === null) {
      layer.delete(domain);
    } else {
      layer.set(domain, value);
    }
  }

  async replaceSections(
    update: Parameters<IConfigService['replaceSections']>[0],
    target: ConfigTarget = ConfigTarget.User,
  ): Promise<void> {
    const layer = target === ConfigTarget.User ? this.user : this.memory;
    const sections = typeof update === 'function' ? update(Object.fromEntries(layer)) : update;
    for (const [domain, value] of Object.entries(sections)) {
      await this.replace(domain, value, target);
    }
  }

  reload(): Promise<void> {
    return Promise.resolve();
  }

  diagnostics(): readonly ConfigDiagnostic[] {
    return [];
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modelCatalogFor(routes: Record<string, { provider: string }>): IModelCatalog {
  return {
    _serviceBrand: undefined,
    get: (id: string): Model => {
      const entry = routes[id];
      if (entry === undefined) throw new Error(`model ${id} not found`);
      return { id, providerName: entry.provider, baseUrl: `https://example.test/${entry.provider}/v1`, protocol: 'openai' } as Model;
    },
    getRequester: () => {
      throw new Error('not used');
    },
    inspect: () => {
      throw new Error('not used');
    },
    ping: () => Promise.reject(new Error('not used')),
    findByName: () => [],
    listModels: () => Promise.resolve([]),
    listProviders: () => Promise.resolve([]),
    getProvider: () => Promise.reject(new Error('not used')),
    setDefaultModel: () => Promise.reject(new Error('not used')),
  } as unknown as IModelCatalog;
}

const ROUTES = {
  'route/balanced': { provider: 'provider-balanced' },
  'route/kimi': { provider: 'provider-kimi' },
  'route/deepseek': { provider: 'provider-deepseek' },
  'route/deepseek-plan': { provider: 'provider-deepseek-plan' },
  'route/other': { provider: 'provider-other' },
  'caller-model': { provider: 'provider-balanced' },
};

function stubScoringRegistries(ix: TestInstantiationService): void {
  const entries = () => {
    const records: Record<string, ModelRecord> = {};
    const providers: Record<string, ProviderConfig> = {};
    for (const alias of [...Object.keys(ROUTES), 'kimi', 'codex', 'deepseek', 'spare', 'matelab', 'alias']) {
      try {
        const model = ix.get(IModelCatalog).get(alias);
        records[model.id ?? alias] = { providerId: model.providerName, name: model.name ?? alias, protocol: model.protocol };
        providers[model.providerName] = { type: model.providerType ?? 'openai', baseUrl: model.baseUrl, apiKey: `synthetic-${model.providerName}` };
      } catch {}
    }
    return { records, providers };
  };
  ix.stub(IModelService, { get: (id: string) => entries().records[id], list: () => entries().records,
    onDidChangeModels: () => ({ dispose() {} }) });
  ix.stub(IProviderService, { get: (id: string) => entries().providers[id], list: () => entries().providers,
    getDefaultProvider: () => undefined, onDidChangeProviders: () => ({ dispose() {} }) });
  ix.set(IProtocolAdapterRegistry, new SyncDescriptor(ProtocolAdapterRegistry));
  ix.stub(IProviderUsageLedgerService, stubProviderUsageLedger());
}

class FakeRunUsageService implements IAgentRunUsageService {
  declare readonly _serviceBrand: undefined;
  private readonly startEmitter = new Emitter<AgentRunUsageStartedRecord>();
  private readonly emitter = new Emitter<AgentRunUsageEntry>();
  readonly onDidStartRun = this.startEmitter.event;
  readonly onDidFinishRun = this.emitter.event;
  private readonly active = new Map<string, AgentRunUsageStartedRecord>();
  entries: readonly AgentRunUsageEntry[] = [];
  readCalls = 0;
  readImpl: (() => Promise<readonly AgentRunUsageEntry[]>) | undefined;

  get liveEntries(): readonly AgentRunUsageEntry[] {
    return this.entries;
  }

  set liveEntries(entries: readonly AgentRunUsageEntry[]) {
    this.entries = [];
    for (const entry of entries) this.completeLiveRun(entry);
  }

  appendStarted(record: AgentRunUsageStartedRecord): void {
    if (this.active.has(record.runId)) return;
    this.active.set(record.runId, record);
    this.startEmitter.fire(record);
  }

  appendFinished(record: AgentRunUsageFinishedRecord): void {
    const started = this.active.get(record.runId);
    if (started === undefined) return;
    this.active.delete(record.runId);
    const entry = { started, finished: record };
    this.entries = [...this.entries, entry];
    this.emitter.fire(entry);
  }

  async *iterate(): AsyncIterable<AgentRunUsageRecord> {
    for (const entry of this.entries) {
      yield entry.started;
      if (entry.finished !== undefined) yield entry.finished;
    }
  }

  async read(): Promise<readonly AgentRunUsageEntry[]> {
    this.readCalls += 1;
    return this.readImpl === undefined ? this.entries : this.readImpl();
  }

  completeLiveRun(entry: AgentRunUsageEntry): void {
    this.appendStarted(entry.started);
    if (entry.finished !== undefined) this.appendFinished(entry.finished);
  }
}

function startedRecord(
  runId: string,
  modelAlias: string,
  startedAt: number,
  profileName: string = 'explore',
): AgentRunUsageStartedRecord {
  return {
    version: 1,
    kind: 'started',
    runId,
    childAgentId: 'agent-child',
    parentAgentId: 'main',
    profileName,
    modelAlias,
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    startedAt,
  };
}

function finishedRecord(
  runId: string,
  endedAt: number,
  totalTokens: number,
  patch: Partial<AgentRunUsageFinishedRecord> = {},
): AgentRunUsageFinishedRecord {
  return {
    version: 1,
    kind: 'finished',
    runId,
    status: 'completed',
    startedAt: endedAt - 60_000,
    endedAt,
    durationMs: 60_000,
    usage: { inputOther: totalTokens, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    contextTokens: totalTokens,
    ...patch,
  };
}

function runEntry(
  runId: string,
  modelAlias: string,
  endedAt: number,
  totalTokens: number,
  options: {
    readonly profileName?: string;
    readonly finished?: Partial<AgentRunUsageFinishedRecord>;
  } = {},
): AgentRunUsageEntry {
  return {
    started: startedRecord(runId, modelAlias, endedAt - 60_000, options.profileName),
    finished: finishedRecord(runId, endedAt, totalTokens, options.finished),
  };
}

describe('providerQuotaPercent', () => {
  it('takes the lowest remaining percent across summary and limits windows', () => {
    const result: ProviderUsageResult = {
      kind: 'ok',
      provider: 'kimi',
      summary: { used: 30, limit: 100 },
      limits: [
        { used: 90, limit: 100 },
        { used: 50, limit: 200 },
      ],
      extraUsage: null,
    };
    expect(providerQuotaPercent(result, false)).toBe(10);
  });

  it.each([
    ['NaN used', { used: Number.NaN, limit: 100 }],
    ['negative used', { used: -1, limit: 100 }],
    ['zero limit', { used: 10, limit: 0 }],
    ['invalid reset', { used: 10, limit: 100, resetAt: 'not-a-date' }],
    ['invalid window duration', { window: { duration: 0, unit: 'day' as const }, used: 10, limit: 100 }],
  ])('reports the whole account as unknown when a reported row has %s', (_label, row) => {
    const result: ProviderUsageResult = {
      kind: 'ok',
      provider: 'kimi',
      summary: { used: 30, limit: 100 },
      limits: [{ used: 90, limit: 100 }, row],
      extraUsage: null,
    };
    expect(providerQuotaEvidence(result, false)).toBeUndefined();
    expect(providerQuotaPercent(result, false)).toBeUndefined();
  });

  it('treats error/unsupported/empty windows as unknown', () => {
    expect(providerQuotaPercent({ kind: 'error', provider: 'kimi', message: 'x' }, false)).toBeUndefined();
    expect(providerQuotaPercent({ kind: 'unsupported', provider: 'kimi', message: 'x' }, false)).toBeUndefined();
    expect(providerQuotaPercent(undefined, false)).toBeUndefined();
    const empty: ProviderUsageResult = {
      kind: 'ok',
      provider: 'kimi',
      summary: null,
      limits: [],
      extraUsage: null,
    };
    expect(providerQuotaPercent(empty, false)).toBeUndefined();
  });

  it('does not treat DeepSeek metered cost as quota evidence', () => {
    const metered: ProviderUsageResult = {
      kind: 'ok',
      provider: 'deepseek',
      summary: null,
      limits: [],
      extraUsage: null,
      meteredUsage: {
        source: 'local',
        costSource: 'estimated',
        currency: 'CNY',
        timezone: 'Asia/Shanghai',
        trackingStartedAt: '2026-09-01T00:00:00.000Z',
        degraded: false,
        today: {
          startAt: '2026-09-07T00:00:00.000Z',
          endAt: '2026-09-08T00:00:00.000Z',
          requestCount: 100,
          measuredRequestCount: 100,
          pendingRequestCount: 0,
          missingUsageRequestCount: 0,
          unpricedRequestCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 0,
          totalTokens: 1_500_000,
          estimatedCost: '27.00',
          isPartial: false,
        },
        month: {
          startAt: '2026-09-01T00:00:00.000Z',
          endAt: '2026-10-01T00:00:00.000Z',
          requestCount: 100,
          measuredRequestCount: 100,
          pendingRequestCount: 0,
          missingUsageRequestCount: 0,
          unpricedRequestCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 0,
          totalTokens: 1_500_000,
          estimatedCost: '27.00',
          isPartial: false,
        },
        balance: { kind: 'error', message: 'unavailable' },
      },
    };
    expect(providerQuotaPercent(metered, false)).toBeUndefined();
    expect(providerQuotaEvidence(metered, false)).toBeUndefined();
  });

  it('uses the wallet percent only when Extra Usage is opted in and has positive balance', () => {
    const wallet = {
      balanceCents: 25,
      totalCents: 100,
      monthlyChargeLimitEnabled: true,
      monthlyChargeLimitCents: 100,
      monthlyUsedCents: 0,
      currency: 'USD',
    };
    const base: ProviderUsageResult = {
      kind: 'ok',
      provider: 'kimi',
      summary: null,
      limits: [],
      extraUsage: wallet,
    };
    expect(providerQuotaPercent(base, true)).toBe(25);
    // Without the opt-in the wallet never counts.
    expect(providerQuotaPercent(base, false)).toBeUndefined();
    // A spent wallet is not positive balance.
    expect(providerQuotaPercent({ ...base, extraUsage: { ...wallet, balanceCents: 0 } }, true)).toBeUndefined();
  });

  it('lets a positive wallet take over a depleted plan window when opted in', () => {
    const wallet = {
      balanceCents: 25,
      totalCents: 100,
      monthlyChargeLimitEnabled: false,
      monthlyChargeLimitCents: 0,
      monthlyUsedCents: 0,
      currency: 'USD',
    };
    const result: ProviderUsageResult = {
      kind: 'ok',
      provider: 'kimi',
      summary: null,
      limits: [{ used: 90, limit: 100 }],
      extraUsage: wallet,
    };
    // Plan window at 10% remaining, wallet at 25%: the effective quota is the
    // larger of the two (wallet covers the depleted plan).
    expect(providerQuotaPercent(result, true)).toBe(25);
    // Without the opt-in the wallet never counts and only the window remains.
    expect(providerQuotaPercent(result, false)).toBe(10);
    // A healthy plan window still governs over the wallet.
    const healthy: ProviderUsageResult = {
      ...result,
      limits: [{ used: 30, limit: 100 }],
    };
    expect(providerQuotaPercent(healthy, true)).toBe(70);
  });

  it('clamps over-quota windows to zero and treats invalid usage/limits as unknown', () => {
    expect(providerQuotaPercent(windowRow(120, 100), false)).toBe(0);
    for (const used of [Number.NaN, Infinity, -1]) expect(providerQuotaPercent(windowRow(used, 100), false)).toBeUndefined();
    expect(providerQuotaPercent(windowRow(0, Infinity), false)).toBeUndefined();
  });

  it('keeps the reset of the tightest valid plan window and ignores stale reset times', () => {
    const now = Date.UTC(2026, 0, 1);
    const tightResetAt = now + 60 * 60 * 1000;
    const result: ProviderUsageResult = {
      kind: 'ok',
      provider: 'provider',
      summary: { used: 20, limit: 100, resetAt: new Date(now + 2 * 60 * 60 * 1000).toISOString() },
      limits: [
        { used: 75, limit: 100, resetAt: new Date(tightResetAt).toISOString() },
        { used: 10, limit: 100, resetAt: new Date(now - 1).toISOString() },
      ],
      extraUsage: null,
    };

    expect(providerQuotaEvidence(result, false, now)).toEqual({
      remainingPercent: 25,
      resetAt: tightResetAt,
    });
    expect(
      providerQuotaEvidence(
        { ...result, limits: [{ used: 75, limit: 100, resetAt: new Date(now - 1).toISOString() }] },
        false,
        now,
      ),
    ).toEqual({ remainingPercent: 25, resetAt: undefined });
  });

  it.each([
    ['future', '2026-01-01T00:30:00.000Z', Date.UTC(2026, 0, 1, 0, 30)],
    ['missing', undefined, undefined],
    ['past', '2025-12-31T23:59:59.999Z', undefined],
  ] as const)('keeps an exhausted window at zero with a %s reset despite healthier windows', (_label, resetAt, expectedResetAt) => {
    const now = Date.UTC(2026, 0, 1);
    const result: ProviderUsageResult = {
      kind: 'ok',
      provider: 'provider',
      summary: { used: 17, limit: 100, resetAt: new Date(now + 2 * 60 * 60 * 1000).toISOString() },
      limits: [
        { used: 100, limit: 100, resetAt },
        { used: 5, limit: 100, resetAt: new Date(now + 3 * 60 * 60 * 1000).toISOString() },
      ],
      extraUsage: null,
    };

    expect(providerQuotaEvidence(result, false, now)).toEqual({
      remainingPercent: 0,
      resetAt: expectedResetAt,
    });
  });

  it('keeps a depleted provider at zero when only one window exists', () => {
    const now = Date.UTC(2026, 0, 1);
    const result: ProviderUsageResult = {
      kind: 'ok',
      provider: 'provider',
      summary: null,
      limits: [{ used: 100, limit: 100, resetAt: new Date(now + 30 * 60 * 1000).toISOString() }],
      extraUsage: null,
    };

    expect(providerQuotaEvidence(result, false, now)).toEqual({
      remainingPercent: 0,
      resetAt: now + 30 * 60 * 1000,
    });
  });

  it.each([90, 100])('drops the plan reset when Extra Usage covers a window at %s percent used', (used) => {
    const now = Date.UTC(2026, 0, 1);
    const result: ProviderUsageResult = {
      kind: 'ok',
      provider: 'provider',
      summary: null,
      limits: [{ used, limit: 100, resetAt: new Date(now + 60_000).toISOString() }],
      extraUsage: {
        balanceCents: 50,
        totalCents: 100,
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimitCents: 100,
        monthlyUsedCents: 0,
        currency: 'USD',
      },
    };

    expect(providerQuotaEvidence(result, true, now)).toEqual({ remainingPercent: 50 });
  });
});

describe('subscriptionResetPriority', () => {
  const now = Date.UTC(2026, 0, 1);
  const policy = { windowMs: 72 * 60 * 60 * 1000, exponent: 3, maxBonus: 200, quotaFloorPercent: 25 };
  const weekly = (hoursToReset: number, used = 50) => ({
    window: { duration: 1, unit: 'week' as const },
    used,
    limit: 100,
    resetAt: new Date(now + hoursToReset * 60 * 60 * 1000).toISOString(),
  });

  it.each([
    [72, 0],
    [48, 18.01],
    [24, 66.95],
    [12, 117.18],
    [1, 191.41],
  ])('follows the exponential curve at %s hours before a weekly reset', (hoursToReset, expected) => {
    const priority = subscriptionResetPriority([weekly(hoursToReset)], policy, now);
    expect(priority).toMatchObject({
      window: { duration: 1, unit: 'week' },
      remainingPercent: 50,
      horizonMs: 72 * 60 * 60 * 1000,
      floorRelaxed: false,
    });
    expect(priority!.bonus).toBeCloseTo(expected, 2);
    expect(priority!.resetAt).toBe(now + hoursToReset * 60 * 60 * 1000);
  });

  it('grows faster as the reset approaches and stops at the horizon', () => {
    const at = (hours: number) => subscriptionResetPriority([weekly(hours)], policy, now)!.bonus;
    expect(at(71)).toBeGreaterThan(0);
    expect(at(48)).toBeLessThan(at(24));
    expect(at(24) - at(48)).toBeLessThan(at(12) - at(24));
    expect(at(1)).toBeLessThan(200);
    expect(at(72)).toBe(0);
    expect(at(100)).toBe(0);
  });

  it('caps the horizon at the window period itself', () => {
    const daily = subscriptionResetPriority(
      [{ window: { duration: 1, unit: 'day' }, used: 50, limit: 100, resetAt: new Date(now + 60 * 60 * 1000).toISOString() }],
      policy,
      now,
    );
    expect(daily!.horizonMs).toBe(24 * 60 * 60 * 1000);
    expect(daily!.bonus).toBeCloseTo(175.27, 2);
    // A month-length period expressed in days is a declared subscription window.
    const monthly = subscriptionResetPriority(
      [{ window: { duration: 30, unit: 'day' }, used: 50, limit: 100, resetAt: new Date(now + 12 * 60 * 60 * 1000).toISOString() }],
      policy,
      now,
    );
    expect(monthly).toMatchObject({ window: { duration: 30, unit: 'day' }, horizonMs: policy.windowMs });
    expect(monthly!.bonus).toBeCloseTo(117.18, 2);
  });

  it('never treats a short rate-limit window as an expiring subscription period', () => {
    for (const window of [
      { duration: 5, unit: 'hour' as const },
      { duration: 30, unit: 'minute' as const },
      { duration: 23, unit: 'hour' as const },
    ]) {
      expect(
        subscriptionResetPriority(
          [{ window, used: 10, limit: 100, resetAt: new Date(now + 30 * 60 * 1000).toISOString() }],
          policy,
          now,
        ),
      ).toBeUndefined();
    }
    // A full day declared in hours does qualify.
    expect(
      subscriptionResetPriority(
        [{ window: { duration: 24, unit: 'hour' }, used: 10, limit: 100, resetAt: new Date(now + 60 * 60 * 1000).toISOString() }],
        policy,
        now,
      ),
    ).toMatchObject({ horizonMs: 24 * 60 * 60 * 1000 });
  });

  it('selects the single most urgent long window instead of stacking bonuses', () => {
    const priority = subscriptionResetPriority(
      [
        { window: { duration: 1, unit: 'day' }, used: 50, limit: 100, resetAt: new Date(now + 60 * 60 * 1000).toISOString() },
        weekly(1),
        weekly(48),
      ],
      policy,
      now,
    );
    expect(priority).toMatchObject({ window: { duration: 1, unit: 'week' } });
    expect(priority!.bonus).toBeCloseTo(191.41, 2);
  });

  it('ignores exhausted, invalid, undeclared and stale rows', () => {
    expect(subscriptionResetPriority([weekly(1, 100)], policy, now)).toBeUndefined();
    expect(subscriptionResetPriority([{ ...weekly(1), used: Number.NaN }], policy, now)).toBeUndefined();
    expect(subscriptionResetPriority([{ ...weekly(1), used: -1 }], policy, now)).toBeUndefined();
    expect(subscriptionResetPriority([{ ...weekly(1), limit: 0 }], policy, now)).toBeUndefined();
    expect(subscriptionResetPriority([{ ...weekly(1), resetAt: 'invalid' }], policy, now)).toBeUndefined();
    expect(subscriptionResetPriority([weekly(-1)], policy, now)).toBeUndefined();
    const { resetAt: _dropped, ...noReset } = weekly(1);
    expect(subscriptionResetPriority([noReset], policy, now)).toBeUndefined();
    const { window: _noWindow, ...undeclared } = weekly(1);
    expect(subscriptionResetPriority([undeclared], policy, now)).toBeUndefined();
  });

  it('is disabled by a zero max bonus and scales with the policy', () => {
    expect(subscriptionResetPriority([weekly(1)], { ...policy, maxBonus: 0 }, now)).toBeUndefined();
    const halved = subscriptionResetPriority([weekly(12)], { ...policy, maxBonus: 100 }, now);
    expect(halved!.bonus).toBeCloseTo(58.59, 2);
    const wider = subscriptionResetPriority([weekly(100)], { ...policy, windowMs: 7 * 24 * 60 * 60 * 1000 }, now);
    expect(wider!.bonus).toBeGreaterThan(0);
  });
});

describe('providerQuotaEvidence reset priority', () => {
  const now = Date.UTC(2026, 0, 1);
  const weeklyRow = (used: number, hoursToReset: number) => ({
    window: { duration: 1, unit: 'week' as const },
    used,
    limit: 100,
    resetAt: new Date(now + hoursToReset * 60 * 60 * 1000).toISOString(),
  });
  const shortRow = (used: number) => ({
    window: { duration: 5, unit: 'hour' as const },
    used,
    limit: 100,
    resetAt: new Date(now + 30 * 60 * 1000).toISOString(),
  });
  const resultOf = (
    rows: readonly UsageRow[],
    extraUsage: BoosterWalletInfo | null = null,
  ): Extract<ProviderUsageResult, { readonly kind: 'ok' }> => ({
    kind: 'ok',
    provider: 'kimi',
    summary: null,
    limits: rows,
    extraUsage,
  });

  it('marks expiring subscription quota below the retention floor as floor-relaxed', () => {
    const evidence = providerQuotaEvidence(resultOf([weeklyRow(88, 12), shortRow(0)]), false, now);
    expect(evidence?.remainingPercent).toBe(12);
    expect(evidence?.resetPriority).toMatchObject({
      window: { duration: 1, unit: 'week' },
      remainingPercent: 12,
      floorRelaxed: true,
    });
    expect(evidence?.resetPriority?.bonus).toBeCloseTo(117.18, 2);
  });

  it('keeps the floor when the reset is beyond the horizon or the bonus is disabled', () => {
    const far = providerQuotaEvidence(resultOf([weeklyRow(88, 5 * 24)]), false, now);
    expect(far?.resetPriority).toMatchObject({ bonus: 0, floorRelaxed: false });
    const disabled = providerQuotaEvidence(
      resultOf([weeklyRow(88, 12)]),
      false,
      now,
      { windowMs: 72 * 60 * 60 * 1000, exponent: 3, maxBonus: 0, quotaFloorPercent: 25 },
    );
    expect(disabled?.resetPriority).toBeUndefined();
  });

  it('never relaxes the floor across an exhausted or unreadable window', () => {
    const exhaustedShort = providerQuotaEvidence(resultOf([weeklyRow(88, 12), shortRow(100)]), false, now);
    expect(exhaustedShort?.remainingPercent).toBe(0);
    expect(exhaustedShort?.resetPriority).toMatchObject({ floorRelaxed: false });
    // An exhausted long window itself earns no expiry evidence at all.
    const exhaustedWeekly = providerQuotaEvidence(resultOf([weeklyRow(100, 1), shortRow(0)]), false, now);
    expect(exhaustedWeekly?.remainingPercent).toBe(0);
    expect(exhaustedWeekly?.resetPriority).toBeUndefined();
    // An unreadable row voids the whole account evidence, not just the bonus.
    expect(
      providerQuotaEvidence(resultOf([weeklyRow(88, 12), { used: Number.NaN, limit: 100 }]), false, now),
    ).toBeUndefined();
  });

  it('attributes the expiry bonus only to a consumable subscription when a wallet takes over', () => {
    const wallet: BoosterWalletInfo = {
      balanceCents: 50,
      totalCents: 100,
      monthlyChargeLimitEnabled: false,
      monthlyChargeLimitCents: 0,
      monthlyUsedCents: 0,
      currency: 'USD',
    };
    // Raw subscription exhausted: the paid wallet alone keeps the account
    // usable and never inherits the plan's expiry bonus.
    const takenOver = providerQuotaEvidence(resultOf([weeklyRow(100, 12), shortRow(100)], wallet), true, now);
    expect(takenOver).toEqual({ remainingPercent: 50 });
    // Raw subscription still positive: the wallet field neither creates nor
    // erases the genuine subscription bonus.
    const kept = providerQuotaEvidence(resultOf([weeklyRow(88, 12), shortRow(0)], wallet), true, now);
    expect(kept?.remainingPercent).toBe(50);
    expect(kept?.resetPriority).toMatchObject({ remainingPercent: 12, floorRelaxed: false });
    expect(kept?.resetPriority?.bonus).toBeCloseTo(117.18, 2);
  });
});

describe('AutoSubagentPresetService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let config: LayeredConfigStub;
  let usage: FakeRunUsageService;
  let usageCalls: string[];
  let autoPreset: IAutoSubagentPresetService;
  /** Core facts published on `IEventService` by the service under test. */
  let publishedEvents: Array<{ type: string; payload: unknown }>;
  const quotaResults = new Map<string, ProviderUsageResult | undefined>();
  let clockNow = Date.now();

  beforeEach(() => {
    disposables = new DisposableStore();
    clockNow = Date.now();
    ix = disposables.add(new TestInstantiationService());
    config = new LayeredConfigStub({ subagent: subagentConfigWith() });
    usage = new FakeRunUsageService();
    usageCalls = [];
    quotaResults.clear();
    publishedEvents = [];
    const flag: IFlagService = {
      _serviceBrand: undefined,
      enabled: vi.fn((id: string) => id === AUTO_SUBAGENT_PRESET_FLAG_ID || id === DEEPSEEK_USAGE_FLAG_ID),
      registry: {
        _serviceBrand: undefined,
        register: () => ({ dispose: () => {} }),
        get: () => undefined,
        list: () => [],
      },
      snapshot: () => ({}),
      enabledIds: () => [],
      explain: () => undefined,
      explainAll: () => [],
      setConfigOverrides: () => {},
    } as unknown as IFlagService;
    ix.stub(IConfigService, config);
    ix.stub(IFlagService, flag);
    ix.stub(IModelCatalog, modelCatalogFor(ROUTES));
    stubScoringRegistries(ix);
    ix.stub(IAgentRunUsageService, usage);
    ix.stub(IProviderUsageLedgerService, stubProviderUsageLedger({
      getMeteredUsage: async (names) => {
        for (const name of typeof names === 'string' ? [names] : names) {
          const result = quotaResults.get(name);
          if (result?.kind === 'ok' && result.meteredUsage !== undefined) return result.meteredUsage;
        }
        return aggregateMeteredUsage([], clockNow, false, null);
      },
    }));
    ix.stub(IProviderUsageService, {
      _serviceBrand: undefined,
      queryUsage: vi.fn(async (providerId?: string): Promise<readonly ProviderUsageResult[]> => {
        if (providerId === undefined) return [];
        usageCalls.push(providerId);
        const result = quotaResults.get(providerId);
        return result === undefined
          ? [{ kind: 'error', provider: providerId, message: 'down' }]
          : [{ ...result, provider: providerId }];
      }),
    } as unknown as IProviderUsageService);
    ix.stub(ILogService, {
      _serviceBrand: undefined,
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: () => ({} as ILogService),
      level: 'warn',
      setLevel: () => {},
      flush: async () => {},
    } as unknown as ILogService);
    ix.stub(IHostClock, {
      _serviceBrand: undefined,
      now: () => new Date(clockNow),
      timeZone: () => 'UTC',
    });
    ix.stub(IEventService, {
      _serviceBrand: undefined,
      publish: vi.fn((event: { type: string; payload: unknown }) => {
        publishedEvents.push(event);
      }),
      subscribe: () => ({ dispose: () => {} }),
      onDidPublish: () => () => {},
      listenerCount: 0,
    } as unknown as IEventService);
    ix.set(
      ISubagentPresetActivationService,
      new SyncDescriptor(SubagentPresetActivationService),
    );
    ix.set(IAutoSubagentPresetService, new SyncDescriptor(AutoSubagentPresetService));
    autoPreset = ix.get(IAutoSubagentPresetService);
  });

  afterEach(() => {
    vi.useRealTimers();
    disposables.dispose();
  });

  function setQuota(provider: string, result: ProviderUsageResult | undefined): void {
    quotaResults.set(provider, result);
  }

  function currentPreset(): string | undefined {
    return config.get<SubagentConfig>(SUBAGENT_SECTION)?.preset;
  }

  async function realConfigRig(actualCatalog = false, extras?: { liveLedger?: boolean; meteredLedger?: boolean; oauth?: boolean; priorRuns?: readonly AgentRunUsageEntry[] }) {
    const services = disposables.add(new TestInstantiationService());
    services.stub(ILogService, ix.get(ILogService));
    services.stub(IBootstrapService, stubBootstrap('/tmp/auto-preset-config'));
    const storage = new InMemoryStorageService();
    services.stub(IFileSystemStorageService, storage);
    services.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    services.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    services.set(IConfigService, new SyncDescriptor(ConfigService));
    services.stub(IFlagService, ix.get(IFlagService));
    services.stub(IModelCatalog, ix.get(IModelCatalog));
    stubScoringRegistries(services);
    services.stub(IProviderUsageService, ix.get(IProviderUsageService));
    services.stub(IProviderUsageLedgerService, ix.get(IProviderUsageLedgerService));
    services.stub(IAgentRunUsageService, ix.get(IAgentRunUsageService));
    services.stub(IEventService, ix.get(IEventService));
    services.stub(IHostClock, ix.get(IHostClock));
    services.set(ISubagentPresetActivationService, new SyncDescriptor(SubagentPresetActivationService));
    services.set(IAutoSubagentPresetService, new SyncDescriptor(AutoSubagentPresetService));
    const realConfig = services.get(IConfigService);
    await realConfig.ready;
    if (!actualCatalog) await realConfig.replaceSections({
      experimental: { other_flag: false, auto_subagent_preset: false },
      subagent: subagentConfigWith({ autoPreset: { enabled: false, manualLock: true, candidates: [] } }),
    });
    if (actualCatalog) {
      services.set(IModelService, new SyncDescriptor(ModelService));
      services.set(IProviderService, new SyncDescriptor(ProviderService));
      services.stub(IModelOAuthTokens, stubModelOAuthTokens());
      services.stub(IHostRequestHeaders, { headers: {}, thirdPartyHeaders: {}, identitySlug: 'test' });
      services.set(IModelCatalog, new SyncDescriptor(ModelCatalog));
      services.get(IModelService).loadAll({}, undefined);
      services.get(IProviderService).loadAll({}, undefined);
      disposables.add(realConfig.onDidChangeConfiguration((event) => {
        if (event.domain === 'models') services.get(IModelService).loadAll(realConfig.get('models'), undefined);
        if (event.domain === 'providers') services.get(IProviderService).loadAll(realConfig.get('providers'), undefined);
      }));
      services.stub(IFlagService, stubFlag((id) => realConfig.get<Record<string, boolean>>('experimental')?.[id] === true));
    }
    if (extras?.liveLedger) {
      services.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
      services.set(IAgentRunUsageService, new SyncDescriptor(AgentRunUsageService));
      for (const entry of extras.priorRuns ?? []) {
        services.get(IAgentRunUsageService).appendStarted(entry.started);
        if (entry.finished !== undefined) services.get(IAgentRunUsageService).appendFinished(entry.finished);
      }
    }
    if (extras?.meteredLedger) {
      services.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
      services.set(IProviderUsageLedgerService, new SyncDescriptor(ProviderUsageLedgerService));
    }
    if (extras?.oauth) {
      const toolkit = getScopedServiceDescriptors('app').find((entry) => entry.id === IOAuthToolkit)!;
      services.set(IOAuthToolkit, toolkit.descriptor as SyncDescriptor<IOAuthToolkit>);
      services.stub(ITelemetryService, { track2: vi.fn() });
      services.set(IOAuthService, new SyncDescriptor(OAuthService));
      services.set(IModelOAuthTokens, new SyncDescriptor(ModelOAuthTokenAdapter));
    }
    return {
      config: realConfig,
      storage,
      evaluator: services.get(IAutoSubagentPresetService),
      store: services.get(IAtomicTomlDocumentStore),
      catalog: services.get(IModelCatalog),
      models: services.get(IModelService),
      providers: services.get(IProviderService),
      runLedger: services.get(IAgentRunUsageService),
      usageLedger: services.get(IProviderUsageLedgerService),
      oauth: extras?.oauth ? services.get(IOAuthService) : undefined,
    };
  }

  describe('real catalog account and decision boundaries', () => {
    const accountA = 'synthetic-account-A';
    const accountB = 'synthetic-account-B';
    const routeRequest: SubagentRouteRequest = { route: 'agent', profileName: 'coder', caller: { modelAlias: 'a', thinkingLevel: 'high' } };
    const allRoutes = (model: string, thinkingEffort = 'high') => Object.fromEntries(
      ['coder', 'swarm', 'tower_worker', 'tower_reviewer'].map((key) => [key, { model, thinkingEffort }]),
    );
    const record = (providerId = 'ds', patch: Partial<ModelRecord> = {}): ModelRecord => ({
      providerId, name: 'deepseek-flash', maxContextSize: 100_000,
      capabilities: ['thinking', 'tool_use', 'image_in'], supportEfforts: ['low', 'high', 'max'], defaultEffort: 'high', ...patch,
    });
    const provider = (apiKey = accountA, baseUrl = 'https://api.deepseek.com/v1'): ProviderConfig => ({ type: 'deepseek', apiKey, baseUrl });
    const balance = (total = '12.00'): ProviderUsageResult => {
      const period = { startAt: '2026-09-19T00:00:00Z', endAt: '2026-09-20T00:00:00Z', requestCount: 1,
        measuredRequestCount: 1, pendingRequestCount: 0, missingUsageRequestCount: 0, unpricedRequestCount: 1,
        inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, totalTokens: 30, estimatedCost: null, isPartial: true };
      return { kind: 'ok', provider: 'ds', summary: null, limits: [], extraUsage: null,
        meteredUsage: { source: 'local', costSource: 'estimated', currency: 'CNY', timezone: 'Asia/Shanghai',
          trackingStartedAt: null, degraded: false, today: period, month: period,
          balance: { kind: 'ok', isAvailable: true, balances: [{ currency: 'CNY', total, granted: '0', toppedUp: total }] } } };
    };
    async function rigFor(models?: Record<string, ModelRecord>, providers?: Record<string, ProviderConfig>, presets?: NonNullable<SubagentConfig['presets']>, extras?: Parameters<typeof realConfigRig>[1]) {
      clockNow = Date.parse('2026-09-19T02:00:00Z');
      const rig = await realConfigRig(true, extras);
      await rig.config.replaceSections({
        models: models ?? { a: record() }, providers: providers ?? { ds: provider() },
        experimental: { auto_subagent_preset: true, deepseek_usage: true },
        subagent: { presets: presets ?? { only: allRoutes('a') }, autoPreset: { enabled: true, priorityWeightPercent: 0, switchCooldownMs: 0 } },
      });
      setQuota('ds', balance());
      return rig;
    }

    describe('final automatic dispatch boundary', () => {
      async function peakRig(current = 'kimi') {
        const rig = await rigFor(
          { a: record(), k: record('kimiP', { name: 'kimi-k3' }) },
          { ds: provider(), kimiP: { type: 'openai', apiKey: accountB, baseUrl: 'https://example.test/kimi/v1' } },
          { deepseek: allRoutes('a'), kimi: allRoutes('k') },
        );
        await rig.config.set(SUBAGENT_SECTION, { preset: current, autoPreset: { deepseekPeakPolicy: 'penalize', switchCooldownMs: 60_000 } });
        setQuota('kimiP', okResult(80));
        return rig;
      }

      it.each([{ candidates: ['kimi'] }, { candidates: [] }])('refuses healthy excluded current routing with unavailable allowed candidates $candidates', async ({ candidates }) => {
        const rig = await peakRig('deepseek');
        await rig.config.set(SUBAGENT_SECTION, { autoPreset: { candidates } });
        setQuota('kimiP', okResult(0));
        await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
        expect(rig.config.get<SubagentConfig>(SUBAGENT_SECTION).preset).toBe('deepseek');
        expect(rig.evaluator.status()).toMatchObject({ reasonCode: candidates.length === 0 ? 'no_candidates' : 'no_healthy_candidate', activatedPreset: undefined });
        expect(rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === 'deepseek')).toMatchObject({ participating: false, selectable: false, score: 103 });
        expect(publishedEvents.filter((event) => event.type === SUBAGENT_PRESET_CHANGED_EVENT_TYPE)).toEqual([]);
      });

      it.each([
        ['2026-09-18T00:59:59Z', '2026-09-18T01:00:00Z', 'kimi', 'k', 43],
        ['2026-09-18T03:59:59Z', '2026-09-18T04:00:00Z', 'deepseek', 'a', 103],
        ['2026-09-18T09:59:59Z', '2026-09-19T02:00:00Z', 'deepseek', 'a', 103],
        ['2026-09-20T02:00:00Z', '2026-09-21T01:00:00Z', 'kimi', 'k', 43],
      ] as const)('corrects a storage-delayed selection across %s to %s before dispatch', async (start, end, current, model, deepseekScore) => {
        const rig = await peakRig(current);
        clockNow = Date.parse(start);
        const entered = deferred<void>();
        const release = deferred<void>();
        const save = rig.store.setText.bind(rig.store);
        let writes = 0;
        vi.spyOn(rig.store, 'setText').mockImplementation(async (...args) => {
          if (++writes === 1) { entered.resolve(); await release.promise; }
          await save(...args);
        });
        const pending = rig.evaluator.resolveBinding(routeRequest, CTX);
        await entered.promise;
        const queriesBeforeCommit = usageCalls.length;
        clockNow = Date.parse(end);
        release.resolve();
        expect(await pending).toMatchObject({ preset: current, model });
        expect(writes).toBe(2);
        expect(usageCalls).toHaveLength(queriesBeforeCommit);
        expect(rig.config.get<SubagentConfig>(SUBAGENT_SECTION).preset).toBe(current);
        expect(rig.evaluator.status()).toMatchObject({ selectedPreset: current, activatedPreset: undefined, reasonCode: 'current_optimal', switchCooldownUntil: undefined });
        expect(rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === 'deepseek')!.score).toBeCloseTo(deepseekScore);
        expect(rig.evaluator.status()!.currentScore).toBeCloseTo(current === 'kimi' ? 83 : 103);
        expect(rig.evaluator.status()!.selectedScore).toBeCloseTo(current === 'kimi' ? 83 : 103);
        expect(publishedEvents.filter((event) => event.type === SUBAGENT_PRESET_CHANGED_EVENT_TYPE)).toEqual([]);
        expect(await rig.evaluator.resolveBinding(routeRequest, CTX)).toMatchObject({ preset: current, model });
        expect(rig.evaluator.status()!.reasonCode).toBe('current_optimal');
        expect(rig.evaluator.status()!.switchCooldownUntil).toBeUndefined();
      });

      it('refuses a stale binding when the preset-changed listener replaces the provider account', async () => {
        const rig = await peakRig();
        clockNow = Date.parse('2026-09-18T00:59:59Z');
        let providerChanged = false;
        vi.spyOn(ix.get(IEventService), 'publish').mockImplementation((event) => {
          publishedEvents.push(event);
          if (event.type !== SUBAGENT_PRESET_CHANGED_EVENT_TYPE) return;
          rig.providers.loadAll({ ...rig.providers.list(), ds: provider(accountB) }, undefined);
          providerChanged = true;
        });

        await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });

        expect(providerChanged).toBe(true);
        expect(rig.evaluator.status()!.reasonCode).toBe('routing_config_changed');
        expect(rig.config.get<SubagentConfig>(SUBAGENT_SECTION).preset).toBe('deepseek');
      });

      it('bounds corrective writes when successive storage waits keep reversing the winner', async () => {
        const rig = await peakRig();
        const offPeak = Date.parse('2026-09-18T00:59:59Z');
        const peak = Date.parse('2026-09-18T01:00:00Z');
        clockNow = offPeak;
        const save = rig.store.setText.bind(rig.store);
        let writes = 0;
        vi.spyOn(rig.store, 'setText').mockImplementation(async (...args) => {
          clockNow = ++writes % 2 === 1 ? peak : offPeak;
          await save(...args);
        });
        await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
        expect(writes).toBe(2);
        expect(rig.evaluator.status()).toMatchObject({ reasonCode: 'evaluation_failed', activatedPreset: undefined, switchCooldownUntil: undefined });
        expect(publishedEvents.filter((event) => event.type === SUBAGENT_PRESET_CHANGED_EVENT_TYPE)).toEqual([]);
      });

      it('refuses dispatch when the corrective storage write fails without announcing the intermediate winner', async () => {
        const rig = await peakRig();
        clockNow = Date.parse('2026-09-18T00:59:59Z');
        const save = rig.store.setText.bind(rig.store);
        let writes = 0;
        vi.spyOn(rig.store, 'setText').mockImplementation(async (...args) => {
          if (++writes === 2) throw new Error('synthetic correction write failure');
          clockNow = Date.parse('2026-09-18T01:00:00Z');
          await save(...args);
        });
        await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
        expect(rig.evaluator.status()).toMatchObject({ reasonCode: 'activation_failed', activatedPreset: undefined, switchCooldownUntil: undefined });
        expect(publishedEvents.filter((event) => event.type === SUBAGENT_PRESET_CHANGED_EVENT_TYPE)).toEqual([]);
      });
    });

    it('bounds active and completed attribution independently without reassigning retained identities', () => {
      let account = 'internal-A';
      const tracker = new LiveRunIdentity(() => ({ account, model: 'wire-model', protocol: 'openai' }), () => 2);
      const entries = Array.from({ length: 5 }, (_, index) => runEntry(`bounded-${index}`, 'a', 100_000 + index, 0));
      for (const entry of entries.slice(0, 3)) tracker.start(entry.started);
      expect(tracker.finish(entries[0]!)).toBe(false);
      expect(tracker.finish(entries[1]!)).toBe(true);
      expect(tracker.finish(entries[2]!)).toBe(true);
      tracker.start(entries[3]!.started); expect(tracker.finish(entries[3]!)).toBe(true);
      expect(tracker.of(entries[1]!)).toBeUndefined();
      tracker.start(entries[4]!.started);
      account = 'internal-B'; tracker.invalidateChanged();
      expect(tracker.finish(entries[4]!)).toBe(false);
      expect(tracker.of(entries[2]!)?.account).toBe('internal-A');
      expect(tracker.of(entries[3]!)?.account).toBe('internal-A');
    });

    it('keeps completed failures on account A after one alias changes to account B', async () => {
      const rig = await rigFor({ a: record(), b: record('dsAlias') }, { ds: provider(), dsAlias: provider() },
        { first: allRoutes('a'), second: allRoutes('b') }, { liveLedger: true });
      for (let i = 0; i < 3; i += 1) {
        const entry = runEntry(`immutable-${i}`, 'a', clockNow + i, 100, { profileName: 'coder', finished: { status: 'failed' } });
        rig.runLedger.appendStarted(entry.started); rig.runLedger.appendFinished(entry.finished!);
      }
      clockNow += 3;
      vi.spyOn(rig.runLedger, 'read').mockRejectedValueOnce(new Error('synthetic ledger read failure'));
      await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      await rig.config.set('providers', { ds: provider(accountB) });
      setQuota('dsAlias', balance());
      expect((await rig.evaluator.resolveBinding(routeRequest, CTX)).model).toBe('a');
      const [fresh, previous] = rig.evaluator.status()!.candidates;
      expect(fresh!.roleScores![0]!.original.localEvidence).toMatchObject({ scope: 'none', sampleCount: 0 });
      expect(previous!.roleScores![0]!.original).toMatchObject({ availability: 'circuit_open', localEvidence: { scope: 'profile', failureCount: 3, tokenCount: 300 } });
      expect(previous!.roleScores![0]!.effective.model).toBe('a');
      const stored = await rig.runLedger.read();
      expect(stored).toHaveLength(3);
      expect(JSON.stringify(stored)).not.toContain(accountA);
      expect(JSON.stringify(stored)).not.toMatch(/[a-f0-9]{64}/);
    });

    it.each(['credentials', 'model', 'credentials-and-back'] as const)('drops uncertain in-progress attribution after %s changes', async (change) => {
      const rig = await rigFor({ a: record(), b: record('dsAlias') }, { ds: provider(), dsAlias: provider() },
        { first: allRoutes('a'), second: allRoutes('b') }, { liveLedger: true });
      const entries = Array.from({ length: 3 }, (_, i) => runEntry(`running-${i}`, 'a', clockNow + i, 100, { profileName: 'coder', finished: { status: 'failed' } }));
      for (const entry of entries) rig.runLedger.appendStarted(entry.started);
      if (change === 'model') await rig.config.set('models', { a: record('ds', { name: 'other-wire-model' }) });
      else await rig.config.set('providers', { ds: provider(accountB) });
      if (change === 'credentials-and-back') await rig.config.set('providers', { ds: provider() });
      for (const entry of entries) rig.runLedger.appendFinished(entry.finished!);
      setQuota('dsAlias', balance());
      await rig.evaluator.evaluate(routeRequest, CTX);
      for (const candidate of rig.evaluator.status()!.candidates) {
        expect(candidate.localEvidence).toMatchObject({ scope: 'none', sampleCount: 0, failureCount: 0 });
        expect(candidate.roleScores![0]!.original.circuitBreakerOpenUntil).toBeUndefined();
        expect(candidate.coverage?.localEvidenceRoleCount).toBe(0);
      }
    });

    it.each([false, true])('does not infer old run ownership from current aliases (already finished: %s)', async (finishedBeforeStartup) => {
      const entries = Array.from({ length: 3 }, (_, i) => runEntry(`old-process-${i}`, 'a', Date.parse('2026-09-19T02:00:00Z') + i, 100, { profileName: 'coder', finished: { status: 'failed' } }));
      const rig = await rigFor(undefined, undefined, undefined, { liveLedger: true,
        priorRuns: finishedBeforeStartup ? entries : entries.map((entry) => ({ started: entry.started })) });
      if (!finishedBeforeStartup) for (const entry of entries) rig.runLedger.appendFinished(entry.finished!);
      const result = await rig.evaluator.evaluate(routeRequest, CTX);
      expect(result.status!.candidates[0]!.localEvidence).toMatchObject({ scope: 'none', sampleCount: 0 });
      expect(result.status!.candidates[0]!.coverage?.localEvidenceRoleCount).toBe(0);
      expect(result.status!.candidates[0]!.roleScores![0]!.original.circuitBreakerOpenUntil).toBeUndefined();
      expect(await rig.runLedger.read()).toEqual(entries);
    });

    it.each([
      { providerRef: { storage: 'file', key: OPENAI_CODEX_OAUTH_KEY, oauthHost: OPENAI_CODEX_ISSUER }, modelRef: { storage: 'file', key: OPENAI_CODEX_OAUTH_KEY } },
      { providerRef: { storage: 'file', key: OPENAI_CODEX_OAUTH_KEY }, modelRef: { storage: 'file', key: OPENAI_CODEX_OAUTH_KEY, oauthHost: OPENAI_CODEX_ISSUER } },
      { providerRef: undefined, modelRef: { storage: 'file', key: OPENAI_CODEX_OAUTH_KEY } },
      { providerRef: { storage: 'file', key: OPENAI_CODEX_OAUTH_KEY, oauthHost: OPENAI_CODEX_ISSUER }, modelRef: undefined },
    ] as const)('matches Codex runtime OAuth defaults on both sides: %j', async ({ providerRef, modelRef }) => {
      const seen: unknown[] = [];
      vi.spyOn(OpenAICodexOAuthToolkit.prototype, 'tokenProvider').mockImplementation((ref) => {
        seen.push(ref);
        return { getAccessToken: async () => 'synthetic-token', getRequestAuth: async () => ({ apiKey: 'synthetic-token' }) };
      });
      const rig = await rigFor({ a: record(OPENAI_CODEX_PROVIDER_NAME, { name: 'gpt-6-astra', oauth: modelRef }) },
        { [OPENAI_CODEX_PROVIDER_NAME]: { type: 'openai', baseUrl: OPENAI_CODEX_API_BASE_URL, oauth: providerRef } }, undefined, { oauth: true });
      expect((await rig.catalog.get('a').authProvider.getAuth())?.apiKey).toBe('synthetic-token');
      const query = vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async (name) => {
        await rig.oauth!.resolveTokenProvider(name!, rig.providers.get(name!)?.oauth)!.getAccessToken();
        return [{ ...okResult(80), provider: name! }];
      });
      const outcome = await rig.evaluator.resolveBinding(routeRequest, CTX).catch((error) => ({ reason: error.details?.reason,
        availability: rig.evaluator.status()?.candidates[0]?.roleScores?.[0]?.original.availability }));
      expect(outcome).toMatchObject({ model: 'a' });
      expect(query).toHaveBeenCalledTimes(1);
      expect(seen).toEqual(Array.from({ length: 2 }, () => ({ storage: 'file', key: OPENAI_CODEX_OAUTH_KEY, oauthHost: OPENAI_CODEX_ISSUER })));
    });

    it.each([false, true])('keeps Managed Kimi runtime slot correction compatible (old model slot: %s)', async (oldSlot) => {
      const baseUrl = 'https://api.kimi.com/coding/v1';
      const expected = resolveKimiCodeRuntimeAuth({ configuredBaseUrl: baseUrl }).oauthRef;
      const seen: unknown[] = [];
      vi.spyOn(KimiOAuthToolkit.prototype, 'tokenProvider').mockImplementation((_provider, ref) => {
        seen.push(ref);
        return { getAccessToken: async () => 'synthetic-kimi-token', getRequestAuth: async () => ({ apiKey: 'synthetic-kimi-token' }) };
      });
      const rig = await rigFor({ a: record(KIMI_CODE_PROVIDER_NAME, { name: 'kimi-k2.5', oauth: oldSlot ? { storage: 'file', key: 'old-synthetic-slot' } : undefined }) },
        { [KIMI_CODE_PROVIDER_NAME]: { type: 'kimi', baseUrl, oauth: expected } }, undefined, { oauth: true });
      expect((await rig.catalog.get('a').authProvider.getAuth())?.apiKey).toBe('synthetic-kimi-token');
      const query = vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async (name) => {
        await rig.oauth!.resolveTokenProvider(name!, rig.providers.get(name!)?.oauth)!.getAccessToken();
        return [{ ...okResult(80), provider: name! }];
      });
      const outcome = await rig.evaluator.resolveBinding(routeRequest, CTX).catch((error) => ({ reason: error.details?.reason,
        availability: rig.evaluator.status()?.candidates[0]?.roleScores?.[0]?.original.availability }));
      expect(outcome).toMatchObject({ model: 'a' });
      expect(query).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([expected, expected]);
    });

    it('keeps noncanonical alias usage and unpriced evidence while querying the balance only once', async () => {
      const rig = await rigFor({ a: record('z-used') }, { 'a-unused': provider(), 'z-used': provider() }, undefined, { meteredLedger: true });
      const addAttempt = () => {
        const id = rig.usageLedger.startAttempt({ providerName: 'z-used', providerType: 'deepseek', modelName: 'unpriced-synthetic-model',
          modelAlias: 'a', baseUrl: 'https://api.deepseek.com/v1', startedAtEpochMs: Date.now() })!;
        rig.usageLedger.finishAttempt(id, { outcome: 'success', usage: { inputOther: 10, output: 20, inputCacheRead: 0, inputCacheCreation: 0 } });
      };
      addAttempt();
      expect((await rig.usageLedger.getMeteredUsage('a-unused')).month.requestCount).toBe(0);
      const localReads = vi.spyOn(rig.usageLedger, 'getMeteredUsage');
      const query = vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async (name) => {
        const local = await rig.usageLedger.getMeteredUsage(name!);
        const funded = balance();
        if (funded.kind !== 'ok' || funded.meteredUsage === undefined) throw new Error('invalid test balance');
        return [{ ...funded, provider: name!, meteredUsage: { ...local, balance: funded.meteredUsage.balance } }];
      });
      await rig.evaluator.resolveBinding(routeRequest, CTX);
      const original = rig.evaluator.status()!.candidates[0]!.roleScores![0]!.original;
      expect(original.provider).toBe('a-unused');
      expect(original.resource).toMatchObject({ kind: 'metered', resourceScore: 100,
        meteredUsage: { month: { requestCount: 1, totalTokens: 30, unpricedRequestCount: 1, estimatedCost: null, isPartial: true } } });
      expect(localReads).toHaveBeenCalledWith(['a-unused', 'z-used'], expect.anything());
      addAttempt();
      await rig.evaluator.resolveBinding(routeRequest, CTX);
      expect(rig.evaluator.status()!.candidates[0]!.roleScores![0]!.original.resource).toMatchObject({
        meteredUsage: { month: { requestCount: 2, totalTokens: 60, unpricedRequestCount: 2, estimatedCost: null } } });
      expect(query).toHaveBeenCalledTimes(1);
    });

    it.each([
      { apiKey: accountB },
      { oauth: { storage: 'file' as const, key: 'synthetic-other-oauth' } },
      { baseUrl: 'https://example.test/other-account/v1' },
    ])('never applies provider A evidence to an overridden model account: %j', async (patch) => {
      const rig = await rigFor({ a: record('ds', patch) });
      if (patch.apiKey !== undefined) expect((await rig.catalog.get('a').authProvider.getAuth())?.apiKey).toBe(accountB);
      await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      expect(usageCalls).toEqual([]);
      const original = rig.evaluator.status()!.candidates[0]!.roleScores![0]!.original;
      expect(original.resource.kind === 'unknown' || (original.resource.kind === 'metered' && original.resource.resourceScore === undefined)).toBe(true);
      expect(JSON.stringify(rig.evaluator.status())).not.toContain(accountA);
      expect(JSON.stringify(rig.evaluator.status())).not.toContain(accountB);
    });

    it('does not trust a catalog-only model with no actual model record', async () => {
      const rig = await rigFor();
      const assembled = rig.catalog.get('a');
      vi.spyOn(rig.models, 'get').mockReturnValue(undefined);
      vi.spyOn(rig.catalog, 'get').mockReturnValue(assembled);
      await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      expect(usageCalls).toEqual([]);
    });

    it('shares queries, coverage and the circuit breaker across equivalent provider aliases', async () => {
      const rig = await rigFor({ a: record(), b: record('dsAlias') }, { ds: provider(), dsAlias: provider(accountA, 'https://api.deepseek.com/') },
        { first: allRoutes('a'), second: allRoutes('b') });
      await rig.evaluator.selectAutomatically(routeRequest, CTX);
      expect(usageCalls).toEqual(['ds']);
      for (const candidate of rig.evaluator.status()!.candidates) {
        expect(candidate.coverage).toMatchObject({ totalProviderCount: 1, resourceProviderCount: 1 });
        expect(candidate.roleScores!.every((role) => role.original.provider === 'ds')).toBe(true);
      }
      for (let i = 0; i < 3; i += 1) usage.completeLiveRun(runEntry(`account-failed-${i}`, 'a', clockNow + i, 0, { finished: { status: 'failed' } }));
      clockNow += 3;
      await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      expect(rig.evaluator.status()!.candidates.every((candidate) => candidate.roleScores!.every((role) => role.original.availability === 'circuit_open' && role.fallback === undefined))).toBe(true);
      expect(usageCalls).toEqual(['ds', 'ds']);
      const publicJson = JSON.stringify([rig.evaluator.status(), publishedEvents]);
      expect(publicJson).not.toContain(accountA);
      expect(publicJson).not.toMatch(/[a-f0-9]{64}/);
    });

    it('does not promote a caller inherited from an excluded provider into the fallback pool', async () => {
      const rig = await rigFor({ a: record(), b: record('external') }, { ds: provider(), external: provider(accountB) },
        { allowed: { coder: { model: 'a', thinkingEffort: 'high' } }, excluded: allRoutes('b') });
      await rig.config.set(SUBAGENT_SECTION, { preset: 'allowed', autoPreset: { candidates: ['allowed'] } });
      setQuota('ds', balance('0')); setQuota('external', balance());
      const request = { ...routeRequest, caller: { modelAlias: 'b', thinkingLevel: 'high' } };
      await expect(rig.evaluator.resolveBinding(request, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      const roles = rig.evaluator.status()!.candidates[0]!.roleScores!;
      expect(roles.find((role) => role.key === 'coder')!.fallback).toBeUndefined();
      expect(roles.find((role) => role.key === 'tower_worker')!.original.availability).toBe('healthy');
    });

    it.each([
      { apiKey: accountB }, { baseUrl: 'https://api.deepseek.com/anthropic' },
    ])('invalidates a warm cache after provider configuration changes: %j', async (patch) => {
      const rig = await rigFor();
      expect((await rig.evaluator.resolveBinding(routeRequest, CTX)).model).toBe('a');
      await rig.config.set('providers', { ds: { ...provider(), ...patch } });
      setQuota('ds', balance('0'));
      await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      expect(usageCalls).toEqual(['ds', 'ds']);
    });

    it('does not join or publish old-account in-flight evidence into the new generation', async () => {
      const rig = await rigFor();
      const entered = deferred<void>(); const oldResult = deferred<readonly ProviderUsageResult[]>();
      const query = vi.spyOn(ix.get(IProviderUsageService), 'queryUsage')
        .mockImplementationOnce(async () => { entered.resolve(); return oldResult.promise; })
        .mockResolvedValue([balance('0')]);
      const old = rig.evaluator.resolveBinding(routeRequest, CTX); await entered.promise;
      await rig.config.set('providers', { ds: provider(accountB) });
      await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      oldResult.resolve([balance()]);
      await expect(old).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('drops funded cache immediately when deepseek_usage is disabled but preserves manual passthrough', async () => {
      const rig = await rigFor();
      await rig.evaluator.resolveBinding(routeRequest, CTX);
      await rig.config.set('experimental', { deepseek_usage: false });
      await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      expect(usageCalls).toEqual(['ds']);
      expect(rig.evaluator.status()!.candidates[0]!.roleScores![0]!.original.resource.kind).toBe('unknown');
      await rig.config.set(SUBAGENT_SECTION, { autoPreset: { manualLock: true } });
      expect((await rig.evaluator.resolveBinding(routeRequest, CTX)).model).toBe('a');
      expect(usageCalls).toEqual(['ds']);
    });

    it('rejects in-flight balance across off/on flag changes and refetches instead of reviving it', async () => {
      const rig = await rigFor();
      const entered = deferred<void>(); const oldResult = deferred<readonly ProviderUsageResult[]>();
      const query = vi.spyOn(ix.get(IProviderUsageService), 'queryUsage')
        .mockImplementationOnce(async () => { entered.resolve(); return oldResult.promise; })
        .mockResolvedValue([balance('0')]);
      const old = rig.evaluator.resolveBinding(routeRequest, CTX); await entered.promise;
      await rig.config.set('experimental', { deepseek_usage: false });
      await rig.config.set('experimental', { deepseek_usage: true });
      oldResult.resolve([balance()]);
      await expect(old).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      await expect(rig.evaluator.resolveBinding(routeRequest, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('successfully activates the first preset through real schema ordering and returns its binding', async () => {
      const rig = await rigFor();
      expect(rig.config.get<SubagentConfig>(SUBAGENT_SECTION).preset).toBeUndefined();
      const before = rig.config.get<SubagentConfig>(SUBAGENT_SECTION);
      const binding = await rig.evaluator.resolveBinding(routeRequest, CTX);
      expect({ ...rig.config.get<SubagentConfig>(SUBAGENT_SECTION), preset: undefined }).toEqual({ ...before, preset: undefined });
      expect(binding).toMatchObject({ model: 'a', preset: 'only' });
      expect(rig.evaluator.status()!.reasonCode).toBe('higher_score');
      expect(rig.config.get<SubagentConfig>(SUBAGENT_SECTION).preset).toBe('only');
    });

    it('activates a better preset with an unresolved native role and dispatches its fallback after reload', async () => {
      const rig = await rigFor(
        { a: record('limited'), b: record('roomy') },
        {
          limited: { type: 'openai', apiKey: accountA, baseUrl: 'https://api.kimi.com/coding/v1' },
          roomy: { type: 'openai', apiKey: accountB, baseUrl: 'https://api.kimi.com/coding/v1' },
        },
        {
          current: { ...allRoutes('a'), helper: { model: 'a', thinkingEffort: 'high' } },
          better: { ...allRoutes('b'), helper: { model: 'missing', thinkingEffort: 'high' } },
        },
      );
      await rig.config.set(SUBAGENT_SECTION, { preset: 'current', autoPreset: { candidates: ['current', 'better'] } });
      setQuota('limited', okResult(40));
      setQuota('roomy', okResult(90));
      const presets = structuredClone(rig.config.get<SubagentConfig>(SUBAGENT_SECTION).presets);

      const binding = await rig.evaluator.resolveBinding(routeRequest, CTX);

      expect(binding).toMatchObject({ preset: 'better', model: 'b' });
      expect(binding.temporaryFallback).toBeUndefined();
      const better = rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === 'better');
      expect(better).toMatchObject({ selectable: true, fallbackRoleCount: 1 });
      expect(better!.roleScores!.find((role) => role.key === 'helper')).toMatchObject({
        original: { availability: 'route_unresolved' },
        effective: { model: 'a', availability: 'healthy' },
        fallback: { reason: 'route_unresolved', sourcePreset: 'current', sourceRole: 'helper' },
      });
      expect(rig.config.get<SubagentConfig>(SUBAGENT_SECTION).preset).toBe('better');
      expect(rig.config.get<SubagentConfig>(SUBAGENT_SECTION).presets).toEqual(presets);

      await rig.config.reload();
      const helper = await rig.evaluator.resolveBinding({ ...routeRequest, profileName: 'helper' }, CTX);

      expect(helper).toMatchObject({ preset: 'better', model: 'a', source: 'auto-fallback',
        temporaryFallback: { reason: 'route_unresolved', sourcePreset: 'current', sourceRole: 'helper' } });
      expect(rig.config.get<SubagentConfig>(SUBAGENT_SECTION).presets).toEqual(presets);
      expect(rig.config.get<SubagentConfig>(SUBAGENT_SECTION).autoPreset?.manualLock).toBe(false);
    });

    it('treats prototype-named profiles as real roles with default weights, not inherited functions', async () => {
      const rig = await rigFor({ a: record() }, { ds: provider() }, { only: { ...allRoutes('a'), ...Object.fromEntries(['constructor', 'toString'].map((role) => [role, { model: 'a', thinkingEffort: 'high' }])) } });
      const result = await rig.evaluator.evaluate(routeRequest, CTX);
      const candidate = result.status!.candidates[0]!;
      expect(candidate.totalRoleWeight).toBe(6); expect(Number.isFinite(candidate.score)).toBe(true);
      expect(candidate.roleScores!.filter((role) => ['constructor', 'toString'].includes(role.key)).map((role) => role.weight)).toEqual([1, 1]);
    });

    it('scores native off/high routes equally when the real model always thinks at high', async () => {
      const rig = await rigFor({ a: record('ds', { capabilities: ['always_thinking', 'thinking', 'tool_use'], supportEfforts: ['high'], defaultEffort: 'high' }) },
        { ds: provider() }, { off: allRoutes('a', 'off'), high: allRoutes('a', 'high') });
      const result = await rig.evaluator.evaluate(routeRequest, CTX);
      const [off, high] = result.status!.candidates;
      expect(off!.score).toBe(high!.score);
      expect(off!.roleScores!.map((role) => role.original.thinking)).toEqual(['high', 'high', 'high', 'high']);
      expect(off!.roleScores![0]!.original.contributions.routeFitBonus).toBe(3);
    });

    it('uses global thinking defaults when neither route nor caller supplies an effort', async () => {
      const rig = await rigFor({ a: record() }, { ds: provider() }, { only: Object.fromEntries(Object.keys(allRoutes('a')).map((role) => [role, { model: 'a' }])) });
      await rig.config.set('thinking', { effort: 'low' });
      const request = { ...routeRequest, caller: { modelAlias: 'a', thinkingLevel: '' } };
      expect((await rig.evaluator.resolveBinding(request, CTX)).thinking).toBe('low');
      expect(rig.evaluator.status()!.candidates[0]!.roleScores![0]!.original.thinking).toBe('low');
    });

    it('honors global defaults and trait-driven forced thinking in native route scoring', async () => {
      const rig = await rigFor();
      await rig.config.set('thinking', { effort: 'low', forcedEffort: 'max' }, ConfigTarget.Memory);
      expect(rig.config.get<{ forcedEffort?: string }>('thinking').forcedEffort).toBe('max');
      const binding = await rig.evaluator.resolveBinding(routeRequest, CTX);
      expect(binding.thinking).toBe('max');
      expect(rig.evaluator.status()!.candidates[0]!.roleScores![0]!.original.thinking).toBe('max');
      await rig.config.set(SUBAGENT_SECTION, { presets: { only: allRoutes('a', 'off') } });
      expect((await rig.evaluator.resolveBinding(routeRequest, CTX)).thinking).toBe('off');
    });

    describe('subscription reset priority', () => {
      const weekly = { duration: 1, unit: 'week' as const };
      const short5h = { duration: 5, unit: 'hour' as const };
      const HOUR = 60 * 60 * 1000;
      const subscriptionQuota = (providerName: string, weeklyUsed: number, weeklyResetInMs: number, shortUsed = 0): Extract<ProviderUsageResult, { readonly kind: 'ok' }> => ({
        kind: 'ok',
        provider: providerName,
        summary: null,
        limits: [
          { window: weekly, used: weeklyUsed, limit: 100, resetAt: new Date(clockNow + weeklyResetInMs).toISOString() },
          { window: short5h, used: shortUsed, limit: 100, resetAt: new Date(clockNow + 30 * 60 * 1000).toISOString() },
        ],
        extraUsage: null,
      });

      async function subscriptionRig(settings?: Record<string, unknown>) {
        const rig = await rigFor(
          { k: record('kimiP', { name: 'kimi-k3' }), c: record('codexP', { name: 'gpt-6-astra' }) },
          {
            kimiP: { type: 'openai', apiKey: accountA, baseUrl: 'https://example.test/kimi/v1' },
            codexP: { type: 'openai', apiKey: accountB, baseUrl: 'https://example.test/codex/v1' },
          },
          { 'kimi-heavy': allRoutes('k'), 'codex-heavy': allRoutes('c') },
        );
        await rig.config.set(SUBAGENT_SECTION, { preset: 'codex-heavy', autoPreset: settings ?? {} });
        return rig;
      }

      function roleResource(rig: Awaited<ReturnType<typeof subscriptionRig>>, preset: string, roleKey: string) {
        const role = rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === preset)!
          .roleScores!.find((role) => role.key === roleKey)!;
        return role.original.resource;
      }

      it.each([1, 12])('promotes a 12%%-remaining weekly subscription %sh before its reset over a comfortable current preset', async (hoursToReset) => {
        const rig = await subscriptionRig();
        setQuota('kimiP', subscriptionQuota('kimiP', 88, hoursToReset * HOUR));
        setQuota('codexP', subscriptionQuota('codexP', 35, 5 * 24 * HOUR));

        const binding = await rig.evaluator.resolveBinding(routeRequest, CTX);

        expect(binding.model).toBe('k');
        const status = rig.evaluator.status()!;
        expect(status.activatedPreset).toBe('kimi-heavy');
        expect(status.reasonCode).toBe('higher_score');
        expect(status.policy).toMatchObject({
          resetPriorityWindowMs: 72 * HOUR,
          resetPriorityExponent: 3,
          resetPriorityMaxBonus: 200,
          quotaFloorPercent: 25,
        });
        const kimi = status.candidates.find((candidate) => candidate.preset === 'kimi-heavy')!;
        const codex = status.candidates.find((candidate) => candidate.preset === 'codex-heavy')!;
        // Every role of the expiring account relaxes the 25% floor with the
        // same bonus; the aggregate carries it once through the role weights.
        expect(kimi.contributions.resetBonus).toBeCloseTo(hoursToReset === 1 ? 191.41 : 117.18, 2);
        for (const role of kimi.roleScores!) {
          expect(role.original.availability).toBe('healthy');
          expect(role.original.resource).toMatchObject({
            kind: 'subscription',
            quotaRemainingPercent: 12,
            resetPriority: { remainingPercent: 12, floorRelaxed: true, window: weekly, horizonMs: 72 * HOUR },
          });
        }
        expect(kimi.roleScores!.every((role) => role.fallback === undefined)).toBe(true);
        expect(codex.contributions.resetBonus).toBe(0);
        for (const role of codex.roleScores!) {
          expect(role.original.availability).toBe('healthy');
          expect(role.original.resource).toMatchObject({
            kind: 'subscription',
            resetPriority: { bonus: 0, floorRelaxed: false },
          });
        }
      });

      it('keeps the 25% floor when the same 12% weekly quota is not near its reset', async () => {
        const rig = await subscriptionRig();
        setQuota('kimiP', subscriptionQuota('kimiP', 88, 5 * 24 * HOUR));
        setQuota('codexP', subscriptionQuota('codexP', 35, 5 * 24 * HOUR));

        const binding = await rig.evaluator.resolveBinding(routeRequest, CTX);

        expect(binding.model).toBe('c');
        expect(rig.evaluator.status()!.reasonCode).toBe('current_optimal');
        expect(roleResource(rig, 'kimi-heavy', 'coder')).toMatchObject({
          kind: 'subscription',
          quotaRemainingPercent: 12,
          resetPriority: { bonus: 0, floorRelaxed: false },
        });
        expect(rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === 'kimi-heavy')!
          .roleScores!.every((role) => role.original.availability === 'quota_below_floor')).toBe(true);
      });

      it('never relaxes the floor for an exhausted weekly or short window, however close the reset', async () => {
        const rig = await subscriptionRig();
        setQuota('codexP', subscriptionQuota('codexP', 35, 5 * 24 * HOUR));
        setQuota('kimiP', subscriptionQuota('kimiP', 100, HOUR));
        await rig.evaluator.evaluate(routeRequest, CTX);
        expect(roleResource(rig, 'kimi-heavy', 'coder')).toMatchObject({
          kind: 'subscription',
          quotaRemainingPercent: 0,
        });
        expect(roleResource(rig, 'kimi-heavy', 'coder')).not.toMatchObject({
          resetPriority: expect.anything(),
        });
        expect(rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === 'kimi-heavy')!
          .roleScores!.every((role) => role.original.availability === 'quota_below_floor')).toBe(true);

        // A drained 5h rate-limit window vetoes the relaxation even while the
        // weekly window itself would qualify. Cross the cached short-window
        // reset boundary so the changed fixture is actually re-queried.
        clockNow += 31 * 60 * 1000;
        setQuota('kimiP', subscriptionQuota('kimiP', 88, HOUR, 100));
        setQuota('codexP', subscriptionQuota('codexP', 35, 5 * 24 * HOUR));
        await rig.evaluator.evaluate(routeRequest, CTX);
        expect(roleResource(rig, 'kimi-heavy', 'coder')).toMatchObject({
          kind: 'subscription',
          quotaRemainingPercent: 0,
          resetPriority: { floorRelaxed: false },
        });
        expect(rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === 'kimi-heavy')!
          .roleScores!.every((role) => role.original.availability === 'quota_below_floor')).toBe(true);
      });

      it('keeps the floor when the reset priority policy is disabled with a zero max bonus', async () => {
        const rig = await subscriptionRig({ resetPriorityMaxBonus: 0 });
        setQuota('kimiP', subscriptionQuota('kimiP', 88, HOUR));
        setQuota('codexP', subscriptionQuota('codexP', 35, 5 * 24 * HOUR));

        const binding = await rig.evaluator.resolveBinding(routeRequest, CTX);

        expect(binding.model).toBe('c');
        expect(roleResource(rig, 'kimi-heavy', 'coder')).toMatchObject({ kind: 'subscription', quotaRemainingPercent: 12 });
        expect(roleResource(rig, 'kimi-heavy', 'coder')).not.toMatchObject({ resetPriority: expect.anything() });
        expect(rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === 'kimi-heavy')!
          .roleScores!.every((role) => role.original.availability === 'quota_below_floor')).toBe(true);
      });

      it('refuses a stale-then-still-stale response even when the future weekly window looks positive and expiring', async () => {
        const rig = await subscriptionRig();
        setQuota('codexP', subscriptionQuota('codexP', 35, 5 * 24 * HOUR));
        setQuota('kimiP', {
          kind: 'ok',
          provider: 'kimiP',
          summary: null,
          limits: [
            { window: weekly, used: 88, limit: 100, resetAt: new Date(clockNow + 12 * HOUR).toISOString() },
            { window: short5h, used: 0, limit: 100, resetAt: new Date(clockNow - HOUR).toISOString() },
          ],
          extraUsage: null,
        });

        const binding = await rig.evaluator.resolveBinding(routeRequest, CTX);

        expect(binding.model).toBe('c');
        // One controlled refresh, then the pre-reset evidence is refused.
        expect(usageCalls.filter((provider) => provider === 'kimiP')).toHaveLength(2);
        expect(roleResource(rig, 'kimi-heavy', 'coder')).toMatchObject({ kind: 'unknown', reason: 'missing' });
        expect(rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === 'kimi-heavy')!
          .roleScores!.every((role) => role.original.availability === 'quota_unknown' && role.original.contributions.resetBonus === 0)).toBe(true);
      });

      it('refuses evidence whose known reset passes between the query and the commit', async () => {
        const rig = await subscriptionRig();
        setQuota('codexP', subscriptionQuota('codexP', 35, 5 * 24 * HOUR));
        setQuota('kimiP', {
          kind: 'ok',
          provider: 'kimiP',
          summary: null,
          limits: [
            { window: weekly, used: 88, limit: 100, resetAt: new Date(clockNow + 12 * HOUR).toISOString() },
            { window: short5h, used: 0, limit: 100, resetAt: new Date(clockNow + 1_000).toISOString() },
          ],
          extraUsage: null,
        });
        vi.mocked(ix.get(IProviderUsageService).queryUsage).mockImplementation(async (providerId?: string) => {
          if (providerId === undefined) return [];
          usageCalls.push(providerId);
          // The other provider answers slowly: the short window's reset passes
          // while the Kimi response is already in flight.
          if (providerId === 'codexP') clockNow += 2_000;
          const result = quotaResults.get(providerId);
          return result === undefined
            ? [{ kind: 'error', provider: providerId, message: 'down' }]
            : [{ ...result, provider: providerId }];
        });

        const binding = await rig.evaluator.resolveBinding(routeRequest, CTX);

        expect(binding.model).toBe('c');
        expect(roleResource(rig, 'kimi-heavy', 'coder')).toMatchObject({ kind: 'unknown', reason: 'missing' });
        expect(rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === 'kimi-heavy')!
          .roleScores!.every((role) => role.original.availability === 'quota_unknown' && role.original.contributions.resetBonus === 0)).toBe(true);
      });

      it('rejects completed cached evidence when a later provider query crosses its reset before dispatch', async () => {
        const rig = await rigFor(
          { k: record('kimiP', { name: 'kimi-k3' }), c: record('codexP', { name: 'gpt-6-astra' }) },
          {
            kimiP: { type: 'openai', apiKey: accountA, baseUrl: 'https://example.test/kimi/v1' },
            codexP: { type: 'openai', apiKey: accountB, baseUrl: 'https://example.test/codex/v1' },
          },
          { 'kimi-heavy': allRoutes('k') },
        );
        const request = { ...routeRequest, caller: { modelAlias: 'c', thinkingLevel: 'high' } };
        const kimi = subscriptionQuota('kimiP', 88, 12 * HOUR);
        setQuota('kimiP', { ...kimi, limits: [kimi.limits[0]!, { ...kimi.limits[1]!, resetAt: new Date(clockNow + 1_000).toISOString() }] });
        expect((await rig.evaluator.resolveBinding(request, CTX)).model).toBe('k');
        expect(usageCalls.filter((provider) => provider === 'kimiP')).toHaveLength(1);
        await rig.config.set(SUBAGENT_SECTION, { presets: { 'codex-heavy': allRoutes('c') } });
        const entered = deferred<void>();
        const codexResponse = deferred<readonly ProviderUsageResult[]>();
        vi.mocked(ix.get(IProviderUsageService).queryUsage).mockImplementation(async (providerId?: string) => {
          if (providerId === undefined) return [];
          usageCalls.push(providerId);
          if (providerId === 'codexP') {
            entered.resolve();
            return codexResponse.promise;
          }
          return [{ ...kimi, provider: providerId }];
        });

        const pending = rig.evaluator.resolveBinding(request, CTX);
        await entered.promise;
        clockNow += 2_000;
        codexResponse.resolve([subscriptionQuota('codexP', 35, 5 * 24 * HOUR)]);
        const binding = await pending;

        expect(binding.model).toBe('c');
        expect(usageCalls.filter((provider) => provider === 'kimiP')).toHaveLength(1);
        expect(roleResource(rig, 'kimi-heavy', 'coder')).toMatchObject({ kind: 'unknown', reason: 'missing' });
      });

      it('revalidates expiry after activation storage waits before returning the actual binding', async () => {
        const rig = await subscriptionRig();
        const kimi = subscriptionQuota('kimiP', 88, 12 * HOUR);
        setQuota('kimiP', { ...kimi, limits: [kimi.limits[0]!, { ...kimi.limits[1]!, resetAt: new Date(clockNow + 1_000).toISOString() }] });
        setQuota('codexP', subscriptionQuota('codexP', 35, 5 * 24 * HOUR));
        const save = rig.store.setText.bind(rig.store);
        vi.spyOn(rig.store, 'setText').mockImplementation(async (scope, key, value) => {
          clockNow += 2_000;
          await save(scope, key, value);
        });

        const binding = await rig.evaluator.resolveBinding(routeRequest, CTX);

        expect(binding.model).toBe('c');
        expect(usageCalls.filter((provider) => provider === 'kimiP')).toHaveLength(1);
        expect(roleResource(rig, 'kimi-heavy', 'coder')).toMatchObject({ kind: 'unknown', reason: 'missing' });
      });

      it('never dispatches on a truly exhausted window even with a zero reserve floor', async () => {
        const rig = await subscriptionRig({ quotaFloorPercent: 0 });
        setQuota('kimiP', subscriptionQuota('kimiP', 88, HOUR, 100));
        setQuota('codexP', subscriptionQuota('codexP', 35, 5 * 24 * HOUR));

        const binding = await rig.evaluator.resolveBinding(routeRequest, CTX);

        expect(binding.model).toBe('c');
        const kimi = rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === 'kimi-heavy')!;
        const resource = roleResource(rig, 'kimi-heavy', 'coder');
        // The expiring weekly window still reports its bonus as evidence, but
        // the exhausted short window makes the route unavailable before any
        // floor policy applies — a zero floor is no reserve, not permission.
        // Any usable row for the role is a fallback to the healthy Codex
        // account, never the exhausted Kimi route itself.
        expect(resource).toMatchObject({
          kind: 'subscription',
          quotaRemainingPercent: 0,
          resetPriority: { floorRelaxed: false },
        });
        expect(kimi.roleScores!.every((role) => role.original.availability === 'quota_below_floor')).toBe(true);
        expect(kimi.roleScores!.every((role) => role.effective.model === 'c')).toBe(true);
      });

      it.each([
        { label: 'NaN used', badRow: { used: Number.NaN, limit: 100 } },
        { label: 'negative used', badRow: { used: -1, limit: 100 } },
        { label: 'zero limit', badRow: { used: 10, limit: 0 } },
        { label: 'invalid reset', badRow: { used: 0, limit: 100, resetAt: 'bad' } },
        { label: 'invalid window duration', badRow: { window: { duration: 0, unit: 'hour' as const }, used: 0, limit: 100 } },
      ])('refuses the whole account over a row with $label, above and below the floor', async ({ badRow }) => {
        for (const weeklyUsed of [70, 88]) {
          const rig = await subscriptionRig();
          setQuota('codexP', subscriptionQuota('codexP', 35, 5 * 24 * HOUR));
          setQuota('kimiP', {
            kind: 'ok',
            provider: 'kimiP',
            summary: null,
            limits: [
              { window: weekly, used: weeklyUsed, limit: 100, resetAt: new Date(clockNow + 12 * HOUR).toISOString() },
              badRow,
            ],
            extraUsage: null,
          });

          const binding = await rig.evaluator.resolveBinding(routeRequest, CTX);

          expect(binding.model).toBe('c');
          expect(roleResource(rig, 'kimi-heavy', 'coder')).toMatchObject({ kind: 'unknown', reason: 'missing' });
          expect(rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === 'kimi-heavy')!
            .roleScores!.every((role) => role.original.availability === 'quota_unknown' && role.original.contributions.resetBonus === 0)).toBe(true);
        }
      });

      it('keeps wallet availability free of the expiry bonus only when the raw subscription is exhausted', async () => {
        const wallet = (): BoosterWalletInfo => ({
          balanceCents: 50,
          totalCents: 100,
          monthlyChargeLimitEnabled: false,
          monthlyChargeLimitCents: 0,
          monthlyUsedCents: 0,
          currency: 'USD',
        });
        const rig = await subscriptionRig({ allowExtraUsage: true });
        setQuota('codexP', subscriptionQuota('codexP', 35, 5 * 24 * HOUR));
        setQuota('kimiP', { ...subscriptionQuota('kimiP', 88, 12 * HOUR, 100), extraUsage: wallet() });

        let binding = await rig.evaluator.resolveBinding(routeRequest, CTX);

        // The paid wallet alone keeps the account usable at 50%, and the
        // exhausted subscription lends no expiry bonus to it.
        expect(binding.model).toBe('c');
        const paidOnly = roleResource(rig, 'kimi-heavy', 'coder');
        expect(paidOnly).toMatchObject({ kind: 'subscription', quotaRemainingPercent: 50 });
        if (paidOnly.kind !== 'subscription') throw new Error('expected subscription evidence');
        expect(paidOnly.resetPriority).toBeUndefined();
        expect(rig.evaluator.status()!.candidates.find((candidate) => candidate.preset === 'kimi-heavy')!
          .roleScores!.every((role) => role.original.availability === 'healthy' && role.original.contributions.resetBonus === 0)).toBe(true);

        // Cross the cached short-window boundary, then make every raw window
        // positive again: the same wallet field now neither creates nor erases
        // the genuine subscription bonus.
        clockNow += 31 * 60 * 1000;
        setQuota('codexP', subscriptionQuota('codexP', 35, 5 * 24 * HOUR));
        setQuota('kimiP', { ...subscriptionQuota('kimiP', 88, 12 * HOUR), extraUsage: wallet() });
        binding = await rig.evaluator.resolveBinding(routeRequest, CTX);

        expect(binding.model).toBe('k');
        const kept = roleResource(rig, 'kimi-heavy', 'coder');
        if (kept.kind !== 'subscription') throw new Error('expected subscription evidence');
        expect(kept.quotaRemainingPercent).toBe(50);
        expect(kept.resetPriority).toMatchObject({ remainingPercent: 12, floorRelaxed: false });
        expect(kept.resetPriority!.bonus).toBeCloseTo(117.18, 2);
      });
    });
  });

  describe('automatic selection with real configuration storage', () => {
    it('merges gates with queued user flags and routing changes instead of replacing a stale snapshot', async () => {
      const { config: realConfig, evaluator, store, storage } = await realConfigRig();
      const entered = deferred<void>();
      const release = deferred<void>();
      const save = storage.write.bind(storage);
      vi.spyOn(storage, 'write').mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        await save(...args);
      });
      const first = realConfig.set('unrelated', 1);
      await entered.promise;
      const flagWrite = realConfig.set('experimental', { other_flag: true });
      const routingWrite = realConfig.set(SUBAGENT_SECTION, {
        autoPreset: { candidates: ['kimi-heavy'] },
        agents: { explore: { thinkingEffort: 'high' } },
      });
      const automatic = evaluator.selectAutomatically(REQUEST, CTX);
      await Promise.resolve();
      release.resolve();
      const [, , , result] = await Promise.all([first, flagWrite, routingWrite, automatic]);

      expect(result.status?.candidates.map((candidate) => candidate.preset)).toEqual(Object.keys(PRESETS));
      expect(result.status?.candidates.filter((candidate) => candidate.participating).map((candidate) => candidate.preset)).toEqual(['kimi-heavy']);
      expect(realConfig.get('experimental')).toEqual({ other_flag: true, auto_subagent_preset: true });
      expect(realConfig.get(SUBAGENT_SECTION)).toMatchObject({
        preset: 'balanced', agents: { explore: { thinkingEffort: 'high' } },
        autoPreset: { enabled: true, manualLock: false, candidates: ['kimi-heavy'] },
      });
      expect(await store.get('', 'config.toml')).toMatchObject({
        experimental: { other_flag: true, auto_subagent_preset: true },
        subagent: {
          agents: { explore: { thinking_effort: 'high' } },
          auto_preset: { enabled: true, manual_lock: false, candidates: ['kimi-heavy'] },
        },
      });
    });

    it('merges the latest Memory overlay after the user-layer write finishes', async () => {
      const { config: realConfig, evaluator, storage } = await realConfigRig();
      await realConfig.set('experimental', { other_flag: false }, ConfigTarget.Memory);
      await realConfig.set(SUBAGENT_SECTION, { autoPreset: { enabled: false, manualLock: true } }, ConfigTarget.Memory);
      const entered = deferred<void>();
      const release = deferred<void>();
      const save = storage.write.bind(storage);
      vi.spyOn(storage, 'write').mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        await save(...args);
      });
      const automatic = evaluator.selectAutomatically(REQUEST, CTX);
      await entered.promise;
      await realConfig.set('experimental', { other_flag: true }, ConfigTarget.Memory);
      await realConfig.set(SUBAGENT_SECTION, {
        autoPreset: { candidates: ['kimi-heavy'] },
        agents: { explore: { thinkingEffort: 'high' } },
      }, ConfigTarget.Memory);
      release.resolve();
      await automatic;

      expect(realConfig.inspect('experimental').memoryValue).toEqual({ other_flag: true, auto_subagent_preset: true });
      expect(realConfig.inspect(SUBAGENT_SECTION).memoryValue).toMatchObject({
        agents: { explore: { thinkingEffort: 'high' } },
        autoPreset: { enabled: true, manualLock: false, candidates: ['kimi-heavy'] },
      });
      expect(realConfig.inspect('experimental').userValue).toEqual({ other_flag: false, auto_subagent_preset: true });
    });

    it('does not revive failed automatic-mode writes on the next unrelated save', async () => {
      const { config: realConfig, evaluator, store, storage } = await realConfigRig();
      const before = await store.get('', 'config.toml');
      vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('storage unavailable'));
      expect((await evaluator.selectAutomatically(REQUEST, CTX)).reasonCode).toBe('evaluation_failed');
      expect(await store.get('', 'config.toml')).toEqual(before);
      expect(realConfig.inspect('experimental').userValue).toEqual({ other_flag: false, auto_subagent_preset: false });

      await realConfig.set('unrelated', 1);

      expect(realConfig.get('experimental')).toEqual({ other_flag: false, auto_subagent_preset: false });
      expect(realConfig.get(SUBAGENT_SECTION)).toMatchObject({ preset: 'balanced', autoPreset: { enabled: false, manualLock: true } });
      expect(await store.get('', 'config.toml')).toMatchObject({
        unrelated: 1,
        experimental: { other_flag: false, auto_subagent_preset: false },
        subagent: { preset: 'balanced', auto_preset: { enabled: false, manual_lock: true } },
      });
      expect(usageCalls).toEqual([]);
    });
  });

  describe('aggregate scoring and verified dispatch', () => {
    const multimodal: SubagentRouteRequest = { ...REQUEST, profileName: 'multimodal' };
    const capabilities = { image_in: true, video_in: false, audio_in: false, tool_use: true, thinking: true, max_context_tokens: 100_000 };
    let models: Record<string, Model>;

    beforeEach(() => {
      models = Object.fromEntries(['kimi', 'codex', 'deepseek', 'caller-model'].map((id) => [id, {
        id, name: id, aliases: [id], providerName: id, providerType: id,
        protocol: 'openai', headers: {}, authProvider: { getAuth: async () => undefined },
        capabilities: { ...capabilities }, maxContextSize: 100_000, alwaysThinking: false,
        supportEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium',
        baseUrl: id === 'deepseek' ? 'https://api.deepseek.com/v1' : `https://example.test/${id}/v1`,
      } as Model]));
      vi.spyOn(ix.get(IModelCatalog), 'get').mockImplementation((id) => {
        const model = models[id];
        if (model === undefined) throw new Error('unknown model');
        return model;
      });
      clockNow = Date.parse('2026-09-19T02:00:00Z');
    });

    function routes(model: string) {
      return Object.fromEntries(['coder', 'swarm', 'tower_worker', 'tower_reviewer', 'explore'].map((role) => [role, { model, thinkingEffort: 'high' }]));
    }

    async function configure(presets: NonNullable<SubagentConfig['presets']>, settings: Partial<SubagentAutoPresetConfig> = {}) {
      await config.replace(SUBAGENT_SECTION, { preset: Object.keys(presets)[0], presets,
        autoPreset: { enabled: true, priorityWeightPercent: 0, roleWeights: {}, switchCooldownMs: 0, refreshIntervalMs: 1, ...settings } });
    }

    function metered(total = '12.50', isAvailable = true): ProviderUsageResult {
      const period = { startAt: '2026-09-19T00:00:00Z', endAt: '2026-09-20T00:00:00Z', requestCount: 1,
        measuredRequestCount: 1, pendingRequestCount: 0, missingUsageRequestCount: 0, unpricedRequestCount: 1,
        inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, totalTokens: 30, estimatedCost: null, isPartial: true };
      return { kind: 'ok', provider: 'deepseek', summary: null, limits: [], extraUsage: null,
        meteredUsage: { source: 'local', costSource: 'estimated', currency: 'CNY', timezone: 'Asia/Shanghai',
          trackingStartedAt: null, degraded: false, today: period, month: period,
          balance: { kind: 'ok', isAvailable, balances: [{ currency: 'CNY', total, granted: '0', toppedUp: total }] } } };
    }

    it('scores the whole preset rather than the triggering coder and keeps equal routes equal', async () => {
      await configure({ first: routes('kimi'), second: { ...routes('codex'), coder: { model: 'kimi', thinkingEffort: 'high' } } });
      setQuota('kimi', okResult(50)); setQuota('codex', okResult(90));
      const result = await autoPreset.selectAutomatically({ ...REQUEST, profileName: 'coder' }, CTX);
      expect(result.activatedPreset).toBe('second');
      expect(result.status?.evaluationScope).toBe('preset');
      const [first, second] = result.status!.candidates;
      expect(first!.score).toBeLessThan(second!.score!);
      expect(first!.roleScores!.find((role) => role.key === 'coder')!.original.score).toBe(second!.roleScores!.find((role) => role.key === 'coder')!.original.score);
      expect(second!.roleScores!.every((role) => role.original.contributions.priorityBonus === 0)).toBe(true);
    });

    it('unifies custom and dedicated roles, excludes main, preserves zero weights and a fixed denominator', async () => {
      models['codex'] = { ...models['codex']!, capabilities: { ...capabilities, tool_use: false } };
      await configure({ first: { ...routes('codex'), multimodal: { model: 'missing' }, main: { model: 'missing' } },
        excluded: { ...routes('codex'), custom: { model: 'missing' } } }, { candidates: ['first'], roleWeights: { coder: 0, multimodal: 2 } });
      setQuota('codex', okResult(80));
      const result = await autoPreset.evaluate(REQUEST, CTX);
      const [first, excluded] = result.status!.candidates;
      expect(first!.roleScores!.map((role) => role.key).toSorted()).toEqual(['coder', 'custom', 'explore', 'multimodal', 'swarm', 'tower_reviewer', 'tower_worker']);
      expect(first!.totalRoleWeight).toBe(7);
      expect(first!.roleScores!.find((role) => role.key === 'coder')!.weight).toBe(0);
      expect(first!.score).toBeCloseTo(first!.roleScores!.reduce((sum, role) => sum + role.weight * role.effectiveScore, 0) / 7);
      expect(first!.availability).toBe('partial');
      expect(excluded!.participating).toBe(false); expect(excluded!.selectable).toBe(false);
      expect(first!.coverage?.totalProviderCount).toBe(2);
      expect(first!.coverage?.resourceProviderCount).toBe(1);
    });

    it('does not select a zero-denominator preset or fabricate a score', async () => {
      await configure({ first: routes('codex') }, { roleWeights: Object.fromEntries(Object.keys(routes('codex')).map((key) => [key, 0])) });
      setQuota('codex', okResult(90));
      const candidate = (await autoPreset.evaluate(REQUEST, CTX)).status!.candidates[0]!;
      expect(candidate.totalRoleWeight).toBe(0); expect(candidate.score).toBeUndefined(); expect(candidate.selectable).toBe(false);
    });

    it('relaxes the retention floor identically for a temporary fallback binding', async () => {
      const HOUR = 60 * 60 * 1000;
      const weekly = (used: number, resetInMs: number): ProviderUsageResult => ({
        kind: 'ok',
        provider: 'quota',
        summary: null,
        limits: [{ window: { duration: 1, unit: 'week' }, used, limit: 100, resetAt: new Date(clockNow + resetInMs).toISOString() }],
        extraUsage: null,
      });
      await configure({ first: routes('codex'), second: routes('kimi') });
      setQuota('codex', weekly(90, 5 * 24 * HOUR));
      setQuota('kimi', weekly(88, 12 * HOUR));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('second');
      const first = result.status!.candidates.find((candidate) => candidate.preset === 'first')!;
      const role = first.roleScores!.find((entry) => entry.key === 'explore')!;
      expect(role.original.availability).toBe('quota_below_floor');
      expect(role.original.resource).toMatchObject({ resetPriority: { bonus: 0, floorRelaxed: false } });
      expect(role.effective).toMatchObject({
        model: 'kimi',
        availability: 'healthy',
        resource: { kind: 'subscription', quotaRemainingPercent: 12, resetPriority: { floorRelaxed: true, remainingPercent: 12 } },
      });
      expect(role.effective.contributions.resetBonus).toBeCloseTo(117.18, 2);
      expect(role.fallback).toMatchObject({ sourcePreset: 'second', sourceRole: 'explore', reason: 'quota_below_floor' });
      expect(role.fallbackPenalty).toBe(10);
    });

    it('replaces depleted same-column multimodal routes from the compatible cross-role pool without mutation', async () => {
      await configure({ first: { ...routes('codex'), multimodal: { model: 'kimi', thinkingEffort: 'max' } },
        second: { ...routes('codex'), multimodal: { model: 'kimi', thinkingEffort: 'max' } } });
      setQuota('kimi', okResult(0)); setQuota('codex', okResult(90));
      const before = structuredClone(config.get(SUBAGENT_SECTION));
      const binding = await autoPreset.resolveBinding(multimodal, CTX);
      expect(binding).toMatchObject({ model: 'codex', thinking: 'high', source: 'auto-fallback', preset: 'first', manualRevision: 0,
        temporaryFallback: { sourceRole: 'coder', reason: 'quota_below_floor', original: { model: 'kimi', thinking: 'medium' } } });
      expect(config.get(SUBAGENT_SECTION)).toEqual(before);
      expect(config.inspect(SUBAGENT_SECTION).memoryValue).toBeUndefined();
      expect(usageCalls.toSorted()).toEqual(['codex', 'kimi']);
      const role = autoPreset.status()!.candidates[0]!.roleScores!.find((entry) => entry.key === 'multimodal')!;
      expect(role.effectiveScore).toBe(role.effective.score! - 10); expect(role.fallbackPenalty).toBe(10);
      clockNow += 2; setQuota('kimi', okResult(90));
      const restored = await autoPreset.resolveBinding(multimodal, CTX);
      expect(restored.model).toBe('kimi'); expect(restored.temporaryFallback).toBeUndefined();
      expect(binding.model).toBe('codex');
    });

    it('normalizes unsupported fallback thinking using the target model efforts', async () => {
      await configure({ first: { ...routes('codex'), multimodal: { model: 'kimi' }, coder: { model: 'codex', thinkingEffort: 'max' } } });
      setQuota('kimi', okResult(0)); setQuota('codex', okResult(90));
      const binding = await autoPreset.resolveBinding(multimodal, CTX);
      expect(binding.thinking).toBe('medium'); expect(models['codex']!.supportEfforts).toContain(binding.thinking);
    });

    it.each([
      { image_in: false }, { tool_use: false }, { image_in: false, tool_use: false, thinking: false, max_context_tokens: 0 },
    ])('rejects a multimodal fallback without known required capabilities: %j', async (patch) => {
      models['codex'] = { ...models['codex']!, capabilities: { ...capabilities, ...patch } };
      await configure({ first: { ...routes('codex'), multimodal: { model: 'kimi' } } });
      setQuota('kimi', okResult(0)); setQuota('codex', okResult(90));
      await expect(autoPreset.resolveBinding(multimodal, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
    });

    it.each([{ video_in: true }, { audio_in: true }, { minContextTokens: 200_000 }, { minInputTokens: 10 }])('enforces known request requirements %j', async (requirements) => {
      await configure({ first: { ...routes('codex'), multimodal: { model: 'kimi' } } });
      setQuota('kimi', okResult(0)); setQuota('codex', okResult(90));
      await expect(autoPreset.resolveBinding({ ...multimodal, requirements }, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
    });

    it('prefers compatible same-role replacements over a higher-scoring cross-role model', async () => {
      models['spare'] = { ...models['codex']!, id: 'spare', name: 'spare', providerName: 'spare' };
      await configure({ first: { ...routes('codex'), multimodal: { model: 'kimi' } },
        second: { ...routes('codex'), multimodal: { model: 'spare' } } });
      setQuota('kimi', okResult(0)); setQuota('codex', okResult(99)); setQuota('spare', okResult(50));
      const candidate = (await autoPreset.evaluate(multimodal, CTX)).status!.candidates[0]!;
      const role = candidate.roleScores!.find((entry) => entry.key === 'multimodal')!;
      expect(role.effective.model).toBe('spare'); expect(role.fallback?.sourceRole).toBe('multimodal');
    });

    it('uses base agents but never an excluded-preset-only provider as a fallback', async () => {
      models['matelab'] = { ...models['codex']!, id: 'matelab', name: 'matelab', providerName: 'matelab' };
      await configure({ first: routes('kimi'), excluded: routes('matelab') }, { candidates: ['first'] });
      setQuota('kimi', okResult(0)); setQuota('codex', okResult(60)); setQuota('matelab', okResult(100));
      await expect(autoPreset.resolveBinding(REQUEST, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      await config.set(SUBAGENT_SECTION, { agents: { spare: { model: 'codex', thinkingEffort: 'high' } } });
      const binding = await autoPreset.resolveBinding(REQUEST, CTX);
      expect(binding.model).toBe('codex'); expect(binding.temporaryFallback?.sourcePreset).toBeUndefined();
    });

    it.each([
      { name: 'gpt-5.6' }, { providerType: 'opencode-go' }, { baseUrl: 'https://opencode.ai/zen/go/v1' },
    ])('excludes prohibited models/accounts %j', async (patch) => {
      models['codex'] = { ...models['codex']!, ...patch };
      await configure({ first: { ...routes('kimi'), multimodal: { model: 'kimi' } } });
      await config.set(SUBAGENT_SECTION, { agents: { spare: { model: 'codex' } } });
      setQuota('kimi', okResult(0)); setQuota('codex', okResult(100));
      await expect(autoPreset.resolveBinding(multimodal, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      expect(usageCalls).not.toContain('codex');
    });

    it.each(['gpt-6-sol', 'gpt-6-luna'])(
      'selects %s from a healthy configured preset without changing the main model',
      async (name) => {
        models['codex'] = { ...models['codex']!, name };
        await configure({ first: routes('codex') });
        setQuota('codex', okResult(80));
        await config.set('defaultModel', 'caller-model');
        await config.set('thinking', { enabled: true, effort: 'low' });

        const binding = await autoPreset.resolveBinding(REQUEST, CTX);

        expect(binding).toMatchObject({ model: 'codex', preset: 'first' });
        expect(binding.temporaryFallback).toBeUndefined();
        expect(config.get('defaultModel')).toBe('caller-model');
        expect(config.get('thinking')).toEqual({ enabled: true, effort: 'low' });
      },
    );

    it('deduplicates alias resource queries and candidate run evidence', async () => {
      models['alias'] = { ...models['codex']!, id: 'alias', aliases: ['alias', 'codex'] };
      await configure({ first: { ...routes('codex'), explore: { model: 'alias' } }, second: routes('alias') });
      setQuota('codex', okResult(80)); usage.liveEntries = [runEntry('unique', 'alias', clockNow, 100)];
      const result = await autoPreset.selectAutomatically(REQUEST, CTX);
      expect(usageCalls).toEqual(['codex']);
      for (const candidate of result.status!.candidates) {
        expect(candidate.coverage).toMatchObject({ totalProviderCount: 1, resourceProviderCount: 1 });
        expect(candidate.localEvidence).toMatchObject({ sampleCount: 1, tokenCount: 100 });
      }
    });

    it('lets funded official DeepSeek compete normally against healthy subscription models', async () => {
      await configure({ first: routes('codex'), second: routes('deepseek') });
      setQuota('codex', okResult(80)); setQuota('deepseek', metered('0.01'));
      const result = await autoPreset.selectAutomatically(REQUEST, CTX);
      expect(result.activatedPreset).toBe('second');
      expect(result.status!.candidates[1]!.fallbackRoleCount).toBe(0);
      expect(result.status!.candidates[1]!.roleScores![0]!.original.resource).toMatchObject({ balanceCny: '0.01', resourceScore: 100 });
    });

    it.each([
      ['12.50', true, 'healthy', 100], ['0', true, 'balance_empty', 0], ['-1', true, 'balance_empty', 0],
      ['12', false, 'account_unavailable', 0], ['NaN', true, 'balance_invalid', undefined], ['1e3', true, 'balance_invalid', undefined],
    ] as const)('distinguishes official DeepSeek balance %s / %s', async (total, available, availability, resourceScore) => {
      await configure({ first: routes('deepseek') }); setQuota('deepseek', metered(total, available));
      const candidate = (await autoPreset.evaluate(REQUEST, CTX)).status!.candidates[0]!;
      const resource = candidate.roleScores![0]!.original.resource;
      expect(candidate.roleScores![0]!.original.availability).toBe(availability);
      expect(resource).toMatchObject({ kind: 'metered', resourceScore, resourceScoreBasis: 'funded_account' });
      expect(resource).not.toHaveProperty('quotaRemainingPercent');
      expect(resource).not.toHaveProperty('balance');
      if (resource.kind === 'metered') {
        expect(resource.balanceCny).toBe(availability === 'balance_invalid' ? undefined : total);
        expect(resource.meteredUsage?.today.estimatedCost).toBeNull();
        expect(resource.meteredUsage?.month.unpricedRequestCount).toBe(1);
      }
      expect(candidate.coverage?.resourceProviderCount).toBe(availability === 'balance_invalid' ? 0 : 1);
    });

    it('treats failed DeepSeek balance as unknown and never trusts a proxy metered payload', async () => {
      await configure({ first: routes('deepseek') }); setQuota('deepseek', { kind: 'error', provider: 'deepseek', message: 'safe failure' });
      let route = (await autoPreset.evaluate(REQUEST, CTX)).status!.candidates[0]!.roleScores![0]!.original;
      expect(route.availability).toBe('balance_unknown'); expect(route.resource).toMatchObject({ kind: 'metered', balanceStatus: 'query_failed', resourceScore: undefined });
      models['deepseek'] = { ...models['deepseek']!, baseUrl: 'https://example.test/v1' };
      clockNow += 2; setQuota('deepseek', metered());
      route = (await autoPreset.evaluate(REQUEST, CTX)).status!.candidates[0]!.roleScores![0]!.original;
      expect(route.availability).toBe('quota_unknown'); expect(route.resource.kind).toBe('unknown');
    });

    describe.each([
      { settings: {}, policy: 'block' },
      { settings: { deepseekAvoidPeakHours: false }, policy: 'off' },
      { settings: { deepseekPeakPolicy: 'block', deepseekAvoidPeakHours: false }, policy: 'block' },
      { settings: { deepseekPeakPolicy: 'penalize' }, policy: 'penalize' },
      { settings: { deepseekPeakPolicy: 'off' }, policy: 'off' },
    ] as const)('Shanghai peak policy $policy with $settings', ({ settings, policy }) => {
      it.each([
        ['2026-09-18T00:59:59Z', undefined], ['2026-09-18T01:00:00Z', '2026-09-18T04:00:00Z'],
        ['2026-09-18T03:59:59Z', '2026-09-18T04:00:00Z'], ['2026-09-18T04:00:00Z', undefined],
        ['2026-09-18T05:59:59Z', undefined], ['2026-09-18T06:00:00Z', '2026-09-18T10:00:00Z'],
        ['2026-09-18T09:59:59Z', '2026-09-18T10:00:00Z'], ['2026-09-18T10:00:00Z', undefined],
        ['2026-09-19T02:00:00Z', undefined], ['2026-09-20T07:00:00Z', undefined],
      ] as const)('assesses availability and score at %s', async (time, end) => {
        clockNow = Date.parse(time);
        await configure({ first: routes('deepseek') }, settings);
        setQuota('deepseek', metered());
        const result = await autoPreset.evaluate(REQUEST, CTX);
        const candidate = result.status!.candidates[0]!;
        const route = candidate.roleScores![0]!.original;
        const blocked = policy === 'block' && end !== undefined;
        const penalized = policy === 'penalize' && end !== undefined;
        expect(result.status!.policy).toMatchObject({ deepseekPeakPolicy: policy, deepseekPeakPenalty: 60 });
        expect(route.availability).toBe(blocked ? 'time_restricted' : 'healthy');
        expect(route.resource.blockedUntil).toBe(blocked ? Date.parse(end!) : undefined);
        expect(route.resource.kind === 'metered' && route.resource.peakPenalty).toEqual(penalized ? { points: 60, until: Date.parse(end!) } : undefined);
        expect(route.contributions.peakPenalty).toBe(penalized ? 60 : 0);
        expect(candidate.deepseekRoleShare).toBe(blocked ? 0 : 1);
        expect(route.contributions.resetBonus).toBe(0);
        expect(route.resource).not.toHaveProperty('resetPriority');
      });
    });

    it.each([
      [0, 0, 0, 103], [1, 0.25, 15, 88], [2, 0.5, 30, 73], [4, 1, 60, 43],
    ])('weights %s of four effective DeepSeek roles without double deduction', async (count, share, penalty, score) => {
      clockNow = Date.parse('2026-09-18T02:00:00Z');
      const mixed = routes('kimi');
      for (const key of ['coder', 'swarm', 'tower_worker', 'explore'].slice(0, count)) mixed[key] = { model: 'deepseek', thinkingEffort: 'high' };
      await configure({ mixed }, { deepseekPeakPolicy: 'penalize', roleWeights: { tower_reviewer: 0 } });
      setQuota('kimi', okResult(100)); setQuota('deepseek', metered());
      const candidate = (await autoPreset.evaluate(REQUEST, CTX)).status!.candidates[0]!;
      expect(candidate.deepseekRoleShare).toBe(share);
      expect(candidate.contributions.peakPenalty).toBe(penalty);
      expect(candidate.score).toBe(score);
      expect(candidate.fallbackRoleCount).toBe(0);
    });

    it.each([0, 24, 1000])('preserves raw custom penalty %s separately from clamped effective score', async (penalty) => {
      clockNow = Date.parse('2026-09-18T02:00:00Z');
      await configure({ first: routes('deepseek') }, { deepseekPeakPolicy: 'penalize', deepseekPeakPenalty: penalty });
      setQuota('deepseek', metered());
      const candidate = (await autoPreset.evaluate(REQUEST, CTX)).status!.candidates[0]!;
      expect(candidate.contributions.peakPenalty).toBe(penalty);
      expect(candidate.roleScores![0]!.original.score).toBe(103 - penalty);
      expect(candidate.score).toBe(penalty === 1000 ? 0 : 103 - penalty);
      expect(candidate.selectable).toBe(true);
    });

    it('weights custom roles rather than deduplicated DeepSeek accounts', async () => {
      clockNow = Date.parse('2026-09-18T02:00:00Z');
      models['alias'] = { ...models['deepseek']!, id: 'alias', aliases: ['alias', 'deepseek'] };
      await configure({ mixed: { ...routes('kimi'), coder: { model: 'alias' }, custom: { model: 'deepseek' } } },
        { deepseekPeakPolicy: 'penalize', roleWeights: { coder: 2, custom: 4, swarm: 0, tower_worker: 0, tower_reviewer: 0, explore: 2 } });
      setQuota('deepseek', metered()); setQuota('kimi', okResult(100));
      const candidate = (await autoPreset.evaluate(REQUEST, CTX)).status!.candidates[0]!;
      expect(candidate.totalRoleWeight).toBe(8);
      expect(candidate.deepseekRoleShare).toBe(0.75);
      expect(candidate.contributions.peakPenalty).toBe(45);
      expect(candidate.coverage?.resourceProviderCount).toBe(2);
      expect(usageCalls.toSorted()).toEqual(['deepseek', 'kimi']);
    });

    it('keeps all-zero DeepSeek role weights finite without selecting the preset', async () => {
      clockNow = Date.parse('2026-09-18T02:00:00Z');
      await configure({ first: routes('deepseek') }, { deepseekPeakPolicy: 'penalize', roleWeights: Object.fromEntries(Object.keys(routes('deepseek')).map((role) => [role, 0])) });
      setQuota('deepseek', metered());
      expect((await autoPreset.evaluate(REQUEST, CTX)).status!.candidates[0]).toMatchObject({ deepseekRoleShare: 0, contributions: { peakPenalty: 0 }, selectable: false, score: undefined });
    });

    it.each(['block', 'penalize'] as const)('does not charge an effective Kimi fallback under %s policy', async (policy) => {
      clockNow = Date.parse('2026-09-18T02:00:00Z');
      await configure({ first: routes('deepseek'), second: routes('kimi') }, { deepseekPeakPolicy: policy });
      setQuota('deepseek', metered(policy === 'block' ? '12' : '0')); setQuota('kimi', okResult(88));
      const candidate = (await autoPreset.evaluate(REQUEST, CTX)).status!.candidates[0]!;
      expect(candidate).toMatchObject({ deepseekRoleShare: 0, contributions: { peakPenalty: 0 }, fallbackRoleCount: 5, score: 81 });
      expect(candidate.roleScores![0]!.effective.model).toBe('kimi');
    });

    it('charges the actual DeepSeek fallback once, in addition to its fallback penalty', async () => {
      clockNow = Date.parse('2026-09-18T02:00:00Z');
      await configure({ first: routes('kimi'), second: routes('deepseek') }, { deepseekPeakPolicy: 'penalize' });
      setQuota('kimi', okResult(0)); setQuota('deepseek', metered());
      const candidate = (await autoPreset.evaluate(REQUEST, CTX)).status!.candidates[0]!;
      expect(candidate).toMatchObject({ deepseekRoleShare: 1, contributions: { peakPenalty: 60 }, fallbackRoleCount: 5, score: 33 });
      expect(candidate.roleScores![0]).toMatchObject({ effective: { model: 'deepseek', score: 43 }, fallbackPenalty: 10, effectiveScore: 33 });
    });

    it.each(['empty', 'unknown', 'capability', 'disabled', 'circuit'] as const)('does not let soft peak policy authorize %s evidence', async (kind) => {
      clockNow = Date.parse('2026-09-18T02:00:00Z');
      await configure({ first: routes('deepseek') }, { deepseekPeakPolicy: 'penalize', circuitBreakerFailureThreshold: 1, roleWeights: { coder: 0, swarm: 0, tower_worker: 0, tower_reviewer: 0 } });
      if (kind === 'capability') models['deepseek'] = { ...models['deepseek']!, capabilities: { ...capabilities, tool_use: false } };
      if (kind === 'disabled') models['deepseek'] = { ...models['deepseek']!, name: 'gpt-5.6' };
      if (kind === 'circuit') usage.liveEntries = [runEntry('recent-deepseek-failure', 'deepseek', clockNow, 0, { finished: { status: 'failed' } })];
      setQuota('deepseek', kind === 'unknown' ? undefined : metered(kind === 'empty' ? '0' : '12'));
      await expect(autoPreset.resolveBinding({ ...REQUEST, requirements: { tool_use: true } }, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      expect(autoPreset.status()!.candidates[0]).toMatchObject({ deepseekRoleShare: 0, contributions: { peakPenalty: 0 } });
    });

    it('does not identify a healthy proxy as official DeepSeek from model or preset names', async () => {
      clockNow = Date.parse('2026-09-18T02:00:00Z');
      models['deepseek'] = { ...models['deepseek']!, baseUrl: 'https://example.test/v1' };
      await configure({ 'deepseek-heavy': routes('deepseek') }, { deepseekPeakPolicy: 'penalize' });
      setQuota('deepseek', okResult(100));
      expect((await autoPreset.evaluate(REQUEST, CTX)).status!.candidates[0]).toMatchObject({ score: 103, deepseekRoleShare: 0, contributions: { peakPenalty: 0 } });
    });

    it.each([
      ['2026-09-18T00:59:59Z', '2026-09-18T01:00:00Z', 60],
      ['2026-09-18T03:59:59Z', '2026-09-18T04:00:00Z', 0],
    ] as const)('rescores soft penalties across a query boundary from %s', async (start, end, penalty) => {
      clockNow = Date.parse(start);
      await configure({ first: routes('deepseek') }, { deepseekPeakPolicy: 'penalize' });
      vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async () => {
        clockNow = Date.parse(end); return [metered()];
      });
      expect((await autoPreset.resolveBinding(REQUEST, CTX)).model).toBe('deepseek');
      expect(autoPreset.status()!.candidates[0]!.contributions.peakPenalty).toBe(penalty);
    });

    it('rescores soft penalties after asynchronous activation without falsely blocking dispatch', async () => {
      clockNow = Date.parse('2026-09-18T00:59:59Z');
      await configure({ first: routes('kimi'), second: routes('deepseek') }, { deepseekPeakPolicy: 'penalize' });
      setQuota('kimi', okResult(0)); setQuota('deepseek', metered());
      const set = config.set.bind(config);
      vi.spyOn(config, 'set').mockImplementation(async (...args) => { await set(...args); clockNow = Date.parse('2026-09-18T01:00:00Z'); });
      expect((await autoPreset.resolveBinding(REQUEST, CTX)).model).toBe('deepseek');
      expect(autoPreset.status()!.candidates[1]!.contributions.peakPenalty).toBe(60);
    });

    it('lets the one-twelfth DeepSeek mixture overtake the five-twelfths mixture at peak', async () => {
      clockNow = Date.parse('2026-09-18T02:00:00Z');
      const keys = [...Object.keys(routes('kimi')), 'agent', 'researcher', 'reviewer', 'librarian', 'plan', 'oracle', 'multimodal'];
      const mixed = (deepseekCount: number) => Object.fromEntries(keys.map((key, index) => [key, { model: index < deepseekCount ? 'deepseek' : index < 9 ? 'kimi' : 'codex', thinkingEffort: 'high' }]));
      await configure({ first: mixed(5), second: mixed(1) }, { deepseekPeakPolicy: 'off' });
      setQuota('deepseek', metered()); setQuota('kimi', okResult(88)); setQuota('codex', okResult(53));
      expect((await autoPreset.evaluate(REQUEST, CTX)).reasonCode).toBe('current_optimal');
      await config.set(SUBAGENT_SECTION, { autoPreset: { deepseekPeakPolicy: 'penalize' } });
      const result = await autoPreset.evaluate(REQUEST, CTX);
      expect(result.activatedPreset).toBe('second');
      expect(result.status!.candidates[0]).toMatchObject({ score: 62.25, contributions: { peakPenalty: 25 }, fallbackRoleCount: 0 });
      expect(result.status!.candidates[0]!.deepseekRoleShare).toBeCloseTo(5 / 12);
      expect(result.status!.candidates[1]).toMatchObject({ score: 78.25, contributions: { peakPenalty: 5 }, fallbackRoleCount: 0 });
      expect(result.status!.candidates[1]!.deepseekRoleShare).toBeCloseTo(1 / 12);
    });

    it('switches an unlocked excluded peak-safe preset to the eligible higher score at dispatch', async () => {
      await configure({ 'peak-safe': routes('codex'), 'kimi-heavy': routes('kimi') }, { candidates: ['kimi-heavy'], manualLock: false });
      setQuota('codex', okResult(55)); setQuota('kimi', okResult(95));
      expect(await autoPreset.resolveBinding(REQUEST, CTX)).toMatchObject({ model: 'kimi', preset: 'kimi-heavy' });
      expect(autoPreset.status()).toMatchObject({ selectedScore: 98, activatedPreset: 'kimi-heavy', reasonCode: 'current_unhealthy' });
      expect(autoPreset.status()!.currentScore).toBeCloseTo(58);
    });

    it.each([{ manualLock: true }, { enabled: false }])('preserves excluded explicit routing under %j', async (settings) => {
      await configure({ 'peak-safe': routes('codex'), 'kimi-heavy': routes('kimi') }, { candidates: ['kimi-heavy'], ...settings });
      expect((await autoPreset.resolveBinding(REQUEST, CTX)).model).toBe('codex');
      expect(currentPreset()).toBe('peak-safe');
      expect(usageCalls).toEqual([]);
    });

    it('does not silently add an excluded current preset to an empty candidate list', async () => {
      await configure({ 'peak-safe': routes('codex'), 'kimi-heavy': routes('kimi') }, { candidates: [] });
      setQuota('codex', okResult(55)); setQuota('kimi', okResult(95));
      expect((await autoPreset.evaluate(REQUEST, CTX)).reasonCode).toBe('no_candidates');
      expect(currentPreset()).toBe('peak-safe');
      expect(autoPreset.status()!.candidates.every((candidate) => !candidate.participating && !candidate.selectable)).toBe(true);
    });

    it('rechecks the clock after a query crosses into peak time and allows the explicit policy opt-out', async () => {
      clockNow = Date.parse('2026-09-18T00:59:59Z'); await configure({ first: routes('deepseek') });
      vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async () => {
        clockNow = Date.parse('2026-09-18T01:00:00Z'); return [metered()];
      });
      await expect(autoPreset.resolveBinding(REQUEST, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
      await config.set(SUBAGENT_SECTION, { autoPreset: { deepseekAvoidPeakHours: false } });
      expect((await autoPreset.resolveBinding(REQUEST, CTX)).model).toBe('deepseek');
    });

    it('checks time again after an asynchronous preset activation', async () => {
      clockNow = Date.parse('2026-09-18T00:59:59Z'); await configure({ first: routes('kimi'), second: routes('deepseek') });
      setQuota('kimi', okResult(0)); setQuota('deepseek', metered());
      const set = config.set.bind(config);
      vi.spyOn(config, 'set').mockImplementation(async (...args) => { await set(...args); clockNow = Date.parse('2026-09-18T01:00:00Z'); });
      await expect(autoPreset.resolveBinding(REQUEST, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
    });

    it.each([{ enabled: false }, { manualLock: true }])('passes through manual routing with no provider queries: %j', async (settings) => {
      await configure({ first: routes('kimi') }, settings);
      expect((await autoPreset.resolveBinding(REQUEST, CTX)).model).toBe('kimi'); expect(usageCalls).toEqual([]);
    });

    it('honors a late manual choice and never returns the stale automatic replacement', async () => {
      await configure({ first: routes('kimi'), second: routes('codex') });
      const started = deferred<void>(); const release = deferred<readonly ProviderUsageResult[]>();
      vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async () => { started.resolve(); return release.promise; });
      const pending = autoPreset.resolveBinding(REQUEST, CTX); await started.promise;
      await ix.get(ISubagentPresetActivationService).activate('first'); release.resolve([okResult(99)]);
      const binding = await pending; expect(binding.model).toBe('kimi'); expect(binding.source).toBe('preset'); expect(binding.temporaryFallback).toBeUndefined();
    });

    it('rejects stale model configuration evidence instead of silently dispatching a changed route', async () => {
      await configure({ first: routes('codex') });
      const started = deferred<void>(); const release = deferred<readonly ProviderUsageResult[]>();
      vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async () => { started.resolve(); return release.promise; });
      const pending = autoPreset.resolveBinding(REQUEST, CTX); await started.promise;
      await config.set('models', { codex: { model: 'changed' } }); release.resolve([okResult(99)]);
      await expect(pending).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
    });

    it('rejects model changes made during activation before returning a binding', async () => {
      await configure({ first: routes('kimi'), second: routes('codex') });
      setQuota('kimi', okResult(30)); setQuota('codex', okResult(99));
      const set = config.set.bind(config);
      vi.spyOn(config, 'set').mockImplementation(async (...args) => {
        await set(...args);
        if (args[0] === SUBAGENT_SECTION) await set('models', { codex: { model: 'changed' } });
      });
      await expect(autoPreset.resolveBinding(REQUEST, CTX)).rejects.toMatchObject({ code: 'auto_subagent_preset.binding_unavailable' });
    });

    it('keeps sufficient role/model evidence separate from another model on the same provider', async () => {
      models['alias'] = { ...models['codex']!, id: 'alias', name: 'other-model' };
      await configure({ first: routes('codex'), second: routes('alias') }, { circuitBreakerFailureThreshold: 100 });
      setQuota('codex', okResult(80));
      usage.liveEntries = [
        ...Array.from({ length: 3 }, (_, i) => runEntry(`good-${i}`, 'codex', clockNow - 10 + i, 100)),
        ...Array.from({ length: 3 }, (_, i) => runEntry(`bad-${i}`, 'alias', clockNow - 5 + i, 200, { finished: { status: 'failed' } })),
      ];
      const candidates = (await autoPreset.evaluate(REQUEST, CTX)).status!.candidates;
      expect(originalRoute(candidates[0]).localEvidence).toMatchObject({ scope: 'profile', sampleCount: 3, failureCount: 0, tokenCount: 300 });
      expect(originalRoute(candidates[1]).localEvidence).toMatchObject({ scope: 'profile', sampleCount: 3, failureCount: 3, tokenCount: 600 });
      expect(candidates[0]!.localEvidence).toMatchObject({ sampleCount: 6, tokenCount: 900 });
    });

    it('keeps per-request bindings separate under concurrent role dispatch', async () => {
      await configure({ first: { ...routes('codex'), multimodal: { model: 'kimi' } } });
      setQuota('kimi', okResult(0)); setQuota('codex', okResult(80));
      const [image, coder] = await Promise.all([autoPreset.resolveBinding(multimodal, CTX), autoPreset.resolveBinding({ ...REQUEST, profileName: 'coder' }, CTX)]);
      expect(image).toMatchObject({ model: 'codex', source: 'auto-fallback', temporaryFallback: { original: { model: 'kimi' } } });
      expect(coder).toMatchObject({ model: 'codex', source: 'preset' }); expect(coder.temporaryFallback).toBeUndefined();
      expect(image).not.toBe(coder);
    });

    it('propagates cancellation while quota evidence is pending without returning a binding', async () => {
      await configure({ first: routes('codex') });
      const entered = deferred<void>(); const release = deferred<readonly ProviderUsageResult[]>();
      vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async () => { entered.resolve(); return release.promise; });
      const controller = new AbortController();
      const pending = autoPreset.resolveBinding(REQUEST, { ...CTX, signal: controller.signal });
      await entered.promise; controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); release.resolve([okResult(99)]);
    });

    it('chooses an actually dispatchable current role while global selection remains aggregate', async () => {
      models['codex'] = { ...models['codex']!, capabilities: { ...capabilities, image_in: false } };
      models['kimi'] = { ...models['kimi']!, capabilities: { ...capabilities, tool_use: false } };
      await configure({ first: { ...routes('codex'), multimodal: { model: 'codex' } }, second: { ...routes('kimi'), multimodal: { model: 'deepseek' } } });
      setQuota('codex', okResult(99)); setQuota('kimi', okResult(30)); setQuota('deepseek', metered());
      const global = await autoPreset.selectAutomatically({ ...REQUEST, profileName: 'coder' }, CTX);
      expect(global.status!.candidates[0]!.score).toBeGreaterThan(global.status!.candidates[1]!.score!);
      const binding = await autoPreset.resolveBinding(multimodal, CTX);
      expect(binding.model).toBe('deepseek');
    });
  });

  describe('user-requested automatic selection', () => {
    it('shares in-flight quota refreshes between concurrent user requests', async () => {
      await config.set(SUBAGENT_SECTION, { autoPreset: { candidates: ['balanced'] } });
      setQuota('provider-balanced', okResult(90));
      await autoPreset.evaluate(REQUEST, CTX);
      const started = deferred<void>();
      const refreshed = deferred<readonly ProviderUsageResult[]>();
      const query = vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async () => {
        started.resolve();
        return refreshed.promise;
      });
      query.mockClear();
      const joined = deferred<void>();
      const controller = new AbortController();
      const listen = controller.signal.addEventListener.bind(controller.signal);
      vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => {
        listen(...args);
        joined.resolve();
      });
      const first = autoPreset.selectAutomatically(REQUEST, CTX);
      await started.promise;
      const second = autoPreset.selectAutomatically(REQUEST, { ...CTX, signal: controller.signal });
      await joined.promise;
      refreshed.resolve([okResult(75)]);
      const results = await Promise.all([first, second]);
      expect(query).toHaveBeenCalledTimes(3);
      expect(new Set(query.mock.calls.map(([provider]) => provider)).size).toBe(3);
      expect(results.map((result) => originalRoute(result.status?.candidates[0]).quotaRemainingPercent)).toEqual([75, 75]);
    });

    it('keeps circuit-open candidates unavailable on a user-requested refresh', async () => {
      await config.set(SUBAGENT_SECTION, { autoPreset: { candidates: ['kimi-heavy'], circuitBreakerFailureThreshold: 1 } });
      usage.liveEntries = [runEntry('recent-failure', 'route/kimi', clockNow, 0, { finished: { status: 'failed' } })];
      setQuota('provider-kimi', okResult(99));
      const result = await autoPreset.selectAutomatically(REQUEST, CTX);
      expect(result.reasonCode).toBe('no_healthy_candidate');
      expect(originalRoute(result.status?.candidates.find((candidate) => candidate.preset === 'kimi-heavy')).availability).toBe('circuit_open');
      expect(currentPreset()).toBe('balanced');
    });

    it('rejects an invalid route even with otherwise healthy provider evidence', async () => {
      await config.set(SUBAGENT_SECTION, {
        autoPreset: { candidates: ['invalid'] },
        presets: { invalid: { explore: { model: 'missing-model' } } },
      });
      const result = await autoPreset.selectAutomatically(REQUEST, CTX);
      expect(originalRoute(result.status?.candidates.find((candidate) => candidate.preset === 'invalid')).availability).toBe('route_unresolved');
      expect(currentPreset()).toBe('balanced');
      expect(usageCalls.toSorted()).toEqual(['provider-balanced', 'provider-deepseek', 'provider-kimi']);
    });

    it('does not activate after cancellation while provider evidence is pending', async () => {
      const started = deferred<void>();
      const evidence = deferred<readonly ProviderUsageResult[]>();
      vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async () => {
        started.resolve();
        return evidence.promise;
      });
      const controller = new AbortController();
      const pending = autoPreset.selectAutomatically(REQUEST, { ...CTX, signal: controller.signal });
      await started.promise;
      controller.abort();
      expect((await pending).reasonCode).toBe('cancelled');
      evidence.resolve([okResult(99)]);
      expect(currentPreset()).toBe('balanced');
    });
    it('unlocks both config layers and selects immediately without changing unrelated settings', async () => {
      await config.set('defaultModel', 'caller-model');
      await config.set('thinking', { effort: 'high' });
      await config.set('experimental', { other_flag: true, auto_subagent_preset: false });
      await config.set('experimental', { auto_subagent_preset: false }, ConfigTarget.Memory);
      await config.set(SUBAGENT_SECTION, { autoPreset: { enabled: false, manualLock: true } });
      await config.set(SUBAGENT_SECTION, { autoPreset: { enabled: false, manualLock: true } }, ConfigTarget.Memory);
      setQuota('provider-kimi', okResult(90));

      const result = await autoPreset.selectAutomatically(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      for (const layer of ['userValue', 'memoryValue'] as const) {
        expect(config.inspect<SubagentConfig>(SUBAGENT_SECTION)[layer]).toMatchObject({
          preset: 'kimi-heavy', autoPreset: { enabled: true, manualLock: false },
        });
        expect(config.inspect('experimental')[layer]).toMatchObject({ auto_subagent_preset: true });
      }
      expect(config.get('defaultModel')).toBe('caller-model');
      expect(config.get('thinking')).toEqual({ effort: 'high' });
      expect(config.inspect('experimental').userValue).toMatchObject({ other_flag: true });
      expect(config.inspect<SubagentConfig>(SUBAGENT_SECTION).userValue?.presets).toEqual(PRESETS);
      expect(REQUEST.caller).toEqual({ modelAlias: 'caller-model', thinkingLevel: 'low' });
    });

    it('refreshes evidence on every click while keeping an already optimal preset', async () => {
      setQuota('provider-balanced', okResult(90));
      const first = await autoPreset.selectAutomatically(REQUEST, CTX);
      setQuota('provider-balanced', okResult(80));
      const second = await autoPreset.selectAutomatically(REQUEST, CTX);

      expect(first.reasonCode).toBe('current_optimal');
      expect(second.reasonCode).toBe('current_optimal');
      expect(originalRoute(second.status?.candidates[0]).quotaRemainingPercent).toBe(80);
      expect(usageCalls.filter((provider) => provider === 'provider-balanced')).toHaveLength(2);
      expect(currentPreset()).toBe('balanced');
      expect(resolveSubagentAutoPresetConfig(config.get(SUBAGENT_SECTION)).manualLock).toBe(false);
    });

    it('selects a configured candidate when the current preset is outside the candidate list', async () => {
      await config.set(SUBAGENT_SECTION, { autoPreset: { candidates: ['kimi-heavy'] } });
      setQuota('provider-kimi', okResult(90));
      expect(await autoPreset.evaluate(REQUEST, CTX)).toMatchObject({ reasonCode: 'current_unhealthy', activatedPreset: 'kimi-heavy' });
      expect((await autoPreset.selectAutomatically(REQUEST, CTX)).reasonCode).toBe('current_optimal');
    });

    it('bypasses the score margin only for a user-requested selection', async () => {
      await config.set(SUBAGENT_SECTION, { autoPreset: { switchMarginPercent: 100 } });
      setQuota('provider-balanced', okResult(50));
      setQuota('provider-kimi', okResult(70));
      expect((await autoPreset.evaluate(REQUEST, CTX)).reasonCode).toBe('score_margin_not_met');
      expect((await autoPreset.selectAutomatically(REQUEST, CTX)).activatedPreset).toBe('kimi-heavy');
    });

    it('bypasses the switch cooldown only for a user-requested selection', async () => {
      await config.set(SUBAGENT_SECTION, { autoPreset: { refreshIntervalMs: 1, switchCooldownMs: 60_000 } });
      setQuota('provider-balanced', okResult(50));
      setQuota('provider-kimi', okResult(90));
      expect((await autoPreset.evaluate(REQUEST, CTX)).activatedPreset).toBe('kimi-heavy');
      clockNow += 2;
      setQuota('provider-balanced', okResult(99));
      setQuota('provider-kimi', okResult(50));
      expect((await autoPreset.evaluate(REQUEST, CTX)).reasonCode).toBe('switch_cooldown');
      expect((await autoPreset.selectAutomatically(REQUEST, CTX)).activatedPreset).toBe('balanced');
    });

    it('keeps the preset when fresh evidence falls below the quota floor', async () => {
      setQuota('provider-kimi', okResult(1));
      const result = await autoPreset.selectAutomatically(REQUEST, CTX);
      expect(result.reasonCode).toBe('no_healthy_candidate');
      expect(currentPreset()).toBe('balanced');
    });

    it('does not invent candidates when the configured list is empty', async () => {
      await config.set(SUBAGENT_SECTION, { autoPreset: { candidates: [] } });
      const result = await autoPreset.selectAutomatically(REQUEST, CTX);
      expect(result.reasonCode).toBe('no_candidates');
      expect(result.status?.candidates).toHaveLength(3);
      expect(result.status?.candidates.every((candidate) => !candidate.participating && !candidate.selectable)).toBe(true);
      expect(usageCalls.toSorted()).toEqual(['provider-balanced', 'provider-deepseek', 'provider-kimi']);
      expect(currentPreset()).toBe('balanced');
    });

    it('returns unknown evidence without changing the preset after provider failures', async () => {
      vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockRejectedValue(new Error('unavailable'));
      const result = await autoPreset.selectAutomatically(REQUEST, CTX);
      expect(result.reasonCode).toBe('no_quota_evidence');
      expect(currentPreset()).toBe('balanced');
    });

    it('updates global status without publishing session facts when there is no session', async () => {
      setQuota('provider-kimi', okResult(90));
      const result = await autoPreset.selectAutomatically(REQUEST, {});
      expect(result.activatedPreset).toBe('kimi-heavy');
      expect(autoPreset.status()).toBe(result.status);
      expect(publishedEvents).toEqual([]);
    });

    it('returns flag_disabled without writes when the environment prohibits automatic selection', async () => {
      vi.spyOn(ix.get(IFlagService), 'explain').mockReturnValue({
        id: AUTO_SUBAGENT_PRESET_FLAG_ID, enabled: false, source: 'env',
        title: '', description: '', surface: 'core', env: 'KIMI_CODE_EXPERIMENTAL_AUTO_SUBAGENT_PRESET', defaultEnabled: false,
      });
      const before = config.getAll();
      expect((await autoPreset.selectAutomatically(REQUEST, CTX)).reasonCode).toBe('flag_disabled');
      expect(config.getAll()).toEqual(before);
      expect(usageCalls).toEqual([]);
    });

    it('keeps the preset and reports failure when enabling configuration cannot be saved', async () => {
      config.failWrites = true;
      expect((await autoPreset.selectAutomatically(REQUEST, CTX)).reasonCode).toBe('evaluation_failed');
      expect(currentPreset()).toBe('balanced');
      expect(usageCalls).toEqual([]);
    });

    it('does not write configuration when the request was already cancelled', async () => {
      const before = config.getAll();
      const result = await autoPreset.selectAutomatically(REQUEST, { ...CTX, signal: AbortSignal.abort() });
      expect(result.reasonCode).toBe('cancelled');
      expect(config.getAll()).toEqual(before);
    });

    it('preserves a later manual selection while provider evidence is pending', async () => {
      const started = deferred<void>();
      const quota = deferred<readonly ProviderUsageResult[]>();
      vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async () => {
        started.resolve();
        return quota.promise;
      });
      const pending = autoPreset.selectAutomatically(REQUEST, CTX);
      await started.promise;
      await ix.get(ISubagentPresetActivationService).activate('deepseek-heavy');
      quota.resolve([okResult(90)]);
      const result = await pending;
      expect(result.reasonCode).toBe('manual_lock');
      expect(result.activatedPreset).toBeUndefined();
      expect(currentPreset()).toBe('deepseek-heavy');
      expect(resolveSubagentAutoPresetConfig(config.get(SUBAGENT_SECTION)).manualLock).toBe(true);
    });

    it('honors manual revision even if a same-value manual selection is subsequently unlocked', async () => {
      const started = deferred<void>();
      const quota = deferred<readonly ProviderUsageResult[]>();
      vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async () => {
        started.resolve();
        return quota.promise;
      });
      const pending = autoPreset.selectAutomatically(REQUEST, CTX);
      await started.promise;
      await ix.get(ISubagentPresetActivationService).activate('balanced');
      await config.set(SUBAGENT_SECTION, { autoPreset: { manualLock: false } });
      quota.resolve([okResult(90)]);
      expect((await pending).reasonCode).toBe('manual_override');
      expect(currentPreset()).toBe('balanced');
    });

    it('rechecks the routing snapshot before committing fresh evidence', async () => {
      const started = deferred<void>();
      const quota = deferred<readonly ProviderUsageResult[]>();
      vi.spyOn(ix.get(IProviderUsageService), 'queryUsage').mockImplementation(async () => {
        started.resolve();
        return quota.promise;
      });
      const pending = autoPreset.selectAutomatically(REQUEST, CTX);
      await started.promise;
      await config.set(SUBAGENT_SECTION, { autoPreset: { switchMarginPercent: 99 } });
      quota.resolve([okResult(90)]);
      expect((await pending).reasonCode).toBe('routing_config_changed');
      expect(currentPreset()).toBe('balanced');
    });
  });

  describe('flag and config gates', () => {
    it('does nothing when the flag is disabled', async () => {
      (ix.get(IFlagService).enabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = await autoPreset.evaluate(REQUEST, CTX);
      expect(result.activatedPreset).toBeUndefined();
      expect(currentPreset()).toBe('balanced');
      expect(usageCalls).toEqual([]);
    });

    it('does nothing when [subagent] auto_preset.enabled is off', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: false } }),
      );
      const result = await autoPreset.evaluate(REQUEST, CTX);
      expect(result.reason).toContain('disabled');
      expect(usageCalls).toEqual([]);
    });

    it('never touches main/default model or global thinking', async () => {
      await config.set('defaultModel', 'gpt-main-model');
      await config.set('thinking', { level: 'high' });
      setQuota('provider-balanced', okResult(90));
      setQuota('provider-kimi', okResult(99));

      await autoPreset.evaluate(REQUEST, CTX);
      expect(config.get('defaultModel')).toBe('gpt-main-model');
      expect(config.get('thinking')).toEqual({ level: 'high' });
    });
  });

  describe('manual lock', () => {
    it('defers to a manual selection and skips usage queries while locked', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, manualLock: true } }),
      );

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(result.reason).toBe('manual preset selection');
      expect(usageCalls).toEqual([]);
      expect(currentPreset()).toBe('balanced');
    });

    it('resumes automatic selection once the manual lock is cleared', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, manualLock: true } }),
      );
      await autoPreset.evaluate(REQUEST, CTX);
      expect(usageCalls).toEqual([]);

      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, manualLock: false } }),
      );
      setQuota('provider-balanced', okResult(20));
      setQuota('provider-kimi', okResult(95));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      expect(usageCalls).toContain('provider-kimi');
    });

    it.each(['balanced', 'deepseek-heavy'])('keeps automatic selection available after unlocking and a tool selects %s', async (preset) => {
      const activation = ix.get(ISubagentPresetActivationService);
      expect((await activation.activate('balanced')).kind).toBe('activated');
      expect((await autoPreset.evaluate(REQUEST, CTX)).reason).toBe('manual preset selection');
      expect(usageCalls).toEqual([]);
      await config.set(SUBAGENT_SECTION, { autoPreset: { manualLock: false } });
      const revision = activation.manualRevision;
      ix.set(ISetSubagentPresetTool, new SyncDescriptor(SetSubagentPresetTool));
      const execution = await ix.get(ISetSubagentPresetTool).resolveExecution({ preset });
      if (execution.isError === true) throw new Error('execution should not be an error');

      const result = await execution.execute({
        turnId: 0,
        toolCallId: 'call_preset',
        signal: new AbortController().signal,
      });

      expect(result.isError).toBeFalsy();
      expect(currentPreset()).toBe(preset);
      expect(activation.manualRevision).toBe(revision);
      expect(config.get<SubagentConfig>(SUBAGENT_SECTION).autoPreset?.manualLock).toBe(false);
      setQuota('provider-balanced', okResult(20));
      setQuota('provider-kimi', okResult(95));
      setQuota('provider-deepseek', okResult(5));

      const automatic = await autoPreset.evaluate(REQUEST, CTX);

      expect(automatic.activatedPreset).toBe('kimi-heavy');
      expect(usageCalls).toContain('provider-kimi');
      expect(config.get<SubagentConfig>(SUBAGENT_SECTION).autoPreset?.manualLock).toBe(false);
    });

    it('stamps preset + manual_lock atomically through the public manual boundary and never through the automatic transaction', async () => {
      const activation = ix.get(ISubagentPresetActivationService);

      const result = await activation.activate('kimi-heavy');

      expect(result.kind).toBe('activated');
      const userValue = config.inspect<SubagentConfig>(SUBAGENT_SECTION).userValue;
      expect(userValue?.preset).toBe('kimi-heavy');
      expect(userValue?.autoPreset).toMatchObject({ manualLock: true, enabled: true });

      // The automatic path only patches the preset: a committed automatic
      // switch leaves the lock off, so the next evaluation is not parked.
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, manualLock: false } }),
      );
      setQuota('provider-balanced', okResult(20));
      setQuota('provider-kimi', okResult(95));
      const automatic = await autoPreset.evaluate(REQUEST, CTX);
      expect(automatic.activatedPreset).toBe('kimi-heavy');
      expect(
        resolveSubagentAutoPresetConfig(
          config.get<SubagentConfig | undefined>(SUBAGENT_SECTION),
        ),
      ).toMatchObject({ enabled: true, manualLock: false });
    });

    it('stamps the lock even when a manual activation clears to base routing', async () => {
      const activation = ix.get(ISubagentPresetActivationService);

      const cleared = await activation.activate('');

      expect(cleared.kind).toBe('activated');
      const userValue = config.inspect<SubagentConfig>(SUBAGENT_SECTION).userValue;
      expect(userValue?.preset).toBe('');
      expect(userValue?.autoPreset).toMatchObject({ manualLock: true });
    });

    it('rejects a preset with a blank thinking effort without changing the selector or manual lock', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          presets: {
            ...PRESETS,
            invalid: { explore: { model: 'route/kimi', thinkingEffort: '   ' } },
          },
        }),
      );
      const activation = ix.get(ISubagentPresetActivationService);
      const revision = activation.manualRevision;

      const result = await activation.activate('invalid');

      expect(result).toMatchObject({ kind: 'failed', commitStarted: false });
      if (result.kind !== 'failed') throw new Error('expected activation failure');
      expect(result.message).toContain('thinking_effort');
      expect(currentPreset()).toBe('balanced');
      expect(
        resolveSubagentAutoPresetConfig(
          config.get<SubagentConfig | undefined>(SUBAGENT_SECTION),
        ).manualLock,
      ).toBe(false);
      expect(activation.manualRevision).toBe(revision);
    });
  });

  describe('selection rules', () => {
    it('keeps the current preset when it is healthy and no candidate beats it by margin', async () => {
      setQuota('provider-balanced', okResult(80));
      setQuota('provider-kimi', okResult(85));
      setQuota('provider-deepseek', okResult(89));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(currentPreset()).toBe('balanced');
    });

    it('keeps a healthy higher-priority current when the weighted lead stays below margin', async () => {
      setQuota('provider-balanced', okResult(80));
      setQuota('provider-kimi', okResult(95));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(result.reasonCode).toBe('score_margin_not_met');
      expect(currentPreset()).toBe('balanced');
    });

    it('switches below the floor even when the margin is not met', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, switchMarginPercent: 15 } }),
      );
      setQuota('provider-balanced', okResult(20));
      setQuota('provider-kimi', okResult(30));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
    });

    it('keeps the current below floor when no candidate scores above it', async () => {
      setQuota('provider-balanced', okResult(10));
      setQuota('provider-kimi', okResult(10));
      setQuota('provider-deepseek', okResult(9));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(currentPreset()).toBe('balanced');
    });

    it('does not switch to a below-floor candidate that only scores slightly higher', async () => {
      setQuota('provider-balanced', okResult(20));
      setQuota('provider-kimi', okResult(24));
      setQuota('provider-deepseek', okResult(23));

      // Balanced is below the floor (20 < 25), but the best candidate (24) is
      // also below the floor and only beats it by 4 (< margin 10) — the floor
      // escape requires the candidate to actually reach the floor.
      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(currentPreset()).toBe('balanced');
    });

    it.each([
      ['future', '2026-01-01T12:00:00.000Z', { availability: 'quota_below_floor', selectable: false, quotaRemainingPercent: 0, contributions: { quotaRemaining: 0, resetBonus: 0 } }],
      ['missing', undefined, { availability: 'quota_below_floor', selectable: false, quotaRemainingPercent: 0, contributions: { quotaRemaining: 0, resetBonus: 0 } }],
      // A response still citing a crossed reset is pre-reset evidence: after
      // the controlled refresh stays stale it is refused as unknown, never
      // authorized as either available or exhausted.
      ['past', '2025-12-31T23:59:59.999Z', { availability: 'quota_unknown', selectable: false, contributions: { resetBonus: 0 } }],
    ] as const)('rejects an exhausted candidate with a %s reset despite a healthy summary', async (_label, resetAt, expected) => {
      clockNow = Date.UTC(2026, 0, 1);
      setQuota('provider-balanced', okResult(30));
      setQuota('provider-kimi', {
        kind: 'ok',
        provider: 'provider-kimi',
        summary: { used: 5, limit: 100, resetAt: '2026-01-08T00:00:00.000Z' },
        limits: [{ used: 100, limit: 100, resetAt }],
        extraUsage: null,
      });

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(currentPreset()).toBe('balanced');
      expect(originalRoute(result.status!.candidates.find((candidate) => candidate.preset === 'kimi-heavy'))).toMatchObject(expected);
    });

    it('keeps an exhausted current unavailable after reset until refreshed usage confirms recovery', async () => {
      clockNow = Date.UTC(2026, 0, 1);
      const exhausted: ProviderUsageResult = {
        kind: 'ok',
        provider: 'provider-balanced',
        summary: { used: 5, limit: 100, resetAt: '2026-01-08T00:00:00.000Z' },
        limits: [{ used: 100, limit: 100, resetAt: '2026-01-01T00:01:00.000Z' }],
        extraUsage: null,
      };
      setQuota('provider-balanced', exhausted);
      setQuota('provider-kimi', okResult(30));

      const escaped = await autoPreset.evaluate(REQUEST, CTX);
      expect(escaped.activatedPreset).toBe('kimi-heavy');
      expect(escaped.reasonCode).toBe('current_unhealthy');

      clockNow += 61_000;
      const afterReset = await autoPreset.evaluate(REQUEST, CTX);
      // The crossed reset boundary invalidates the cache, and the provider
      // still cites that old reset: the pre-reset evidence is refused as
      // unknown rather than trusted as either exhausted or recovered.
      expect(originalRoute(afterReset.status!.candidates[0])).toMatchObject({
        availability: 'quota_unknown',
        selectable: false,
        contributions: { resetBonus: 0 },
      });
      expect(afterReset.activatedPreset).toBeUndefined();

      clockNow += 601_000;
      const stillExhausted = await autoPreset.evaluate(REQUEST, CTX);
      expect(originalRoute(stillExhausted.status!.candidates[0])).toMatchObject({
        availability: 'quota_unknown',
        selectable: false,
      });
      expect(stillExhausted.activatedPreset).toBeUndefined();

      setQuota('provider-balanced', {
        ...exhausted,
        limits: [{ used: 10, limit: 100, resetAt: '2026-01-01T01:00:00.000Z' }],
      });
      clockNow += 301_000;
      const recovered = await autoPreset.evaluate(REQUEST, CTX);
      expect(originalRoute(recovered.status!.candidates[0])).toMatchObject({
        availability: 'healthy',
        selectable: true,
        quotaRemainingPercent: 90,
      });
      expect(recovered.activatedPreset).toBe('balanced');
    });

    it('keeps no active preset when every candidate is below the floor', async () => {
      await config.replace(SUBAGENT_SECTION, subagentConfigWith({ preset: undefined }));
      setQuota('provider-balanced', okResult(20));
      setQuota('provider-kimi', okResult(15));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(result.reason).toContain('floor');
      expect(currentPreset()).toBeUndefined();
    });

    it('falls back when the current provider is unknown and another candidate is healthy', async () => {
      setQuota('provider-balanced', undefined);
      setQuota('provider-kimi', okResult(90));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      expect(currentPreset()).toBe('kimi-heavy');
    });

    it('prefers the current preset on an exact score tie', async () => {
      setQuota('provider-balanced', okResult(70));
      setQuota('provider-kimi', okResult(70));
      setQuota('provider-deepseek', okResult(70));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
    });

    it('lets quota outweigh priority and exposes the additive score breakdown', async () => {
      await config.replace(SUBAGENT_SECTION, subagentConfigWith({ preset: undefined }));
      setQuota('provider-balanced', okResult(30));
      setQuota('provider-kimi', okResult(90));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      expect(result.currentPreset).toBeUndefined();
      const status = autoPreset.status()!;
      const balanced = status.candidates.find((candidate) => candidate.preset === 'balanced')!;
      const kimi = status.candidates.find((candidate) => candidate.preset === 'kimi-heavy')!;
      expect(balanced.contributions).toMatchObject({
        priorityBonus: 20,
        routeFitBonus: 2,
      });
      expect(balanced.contributions.resourceScore).toBeCloseTo(30);
      expect(balanced.score).toBeCloseTo(52);
      expect(kimi.contributions).toMatchObject({
        priorityBonus: 10,
        routeFitBonus: 2,
      });
      expect(kimi.contributions.resourceScore).toBeCloseTo(90);
      expect(kimi.score).toBeCloseTo(102);
    });

    it('breaks exact ties between non-current candidates by candidate order', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          preset: undefined,
          autoPreset: { enabled: true, candidates: ['deepseek-heavy', 'kimi-heavy'] },
        }),
      );
      setQuota('provider-kimi', okResult(60));
      setQuota('provider-deepseek', okResult(60));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('deepseek-heavy');
    });

    it('escapes an unhealthy current to the highest weighted healthy candidate', async () => {
      setQuota('provider-balanced', okResult(10));
      setQuota('provider-kimi', okResult(90));
      setQuota('provider-deepseek', okResult(95));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      expect(result.reasonCode).toBe('current_unhealthy');
    });

    it('switches only when the weighted score lead reaches the configured margin', async () => {
      await config.replace(SUBAGENT_SECTION, subagentConfigWith({ preset: 'kimi-heavy' }));
      setQuota('provider-balanced', okResult(44));
      setQuota('provider-kimi', okResult(50));

      let result = await autoPreset.evaluate(REQUEST, CTX);
      expect(result.activatedPreset).toBeUndefined();
      expect(result.reasonCode).toBe('score_margin_not_met');
      expect(currentPreset()).toBe('kimi-heavy');

      clockNow += 301_000;
      setQuota('provider-balanced', okResult(51));
      setQuota('provider-kimi', okResult(50));

      result = await autoPreset.evaluate(REQUEST, CTX);
      expect(result.activatedPreset).toBe('balanced');
      expect(result.reasonCode).toBe('higher_score');
      expect(currentPreset()).toBe('balanced');
    });

    it('keeps the current preset when no candidate has any health evidence', async () => {
      setQuota('provider-balanced', undefined);
      setQuota('provider-kimi', undefined);
      setQuota('provider-deepseek', undefined);

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(result.reason).toContain('evidence');
      expect(currentPreset()).toBe('balanced');
    });

    it('replaces an unlocked current preset outside the candidates instead of implicitly locking it', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, candidates: ['kimi-heavy'] } }),
      );
      setQuota('provider-kimi', okResult(99));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      expect(result.reasonCode).toBe('current_unhealthy');
      expect(currentPreset()).toBe('kimi-heavy');
    });

    it('degrades missing candidates and unresolvable route models', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          autoPreset: { enabled: true, candidates: ['balanced', 'ghost', 'missing'] },
          presets: {
            ...PRESETS,
            ghost: { explore: { model: 'route/ghost' } },
          } as SubagentConfig['presets'],
        }),
      );
      // `route/ghost` is absent from the model catalog, so 'ghost' never scores.
      setQuota('provider-balanced', okResult(80));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(usageCalls.toSorted()).toEqual(['provider-balanced', 'provider-deepseek', 'provider-kimi']);
    });
  });

  describe('reset, local reliability, latency, and stability controls', () => {
    it('applies the exponential reset bonus only to declared subscription windows of at least a day', async () => {
      const now = Date.UTC(2026, 0, 1);
      clockNow = now;
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          preset: undefined,
          autoPreset: {
            enabled: true,
            candidates: ['balanced', 'kimi-heavy'],
            priorityWeightPercent: 0,
            localUsageWeightPercent: 0,
            reliabilityWeightPercent: 0,
            latencyWeightPercent: 0,
          },
        }),
      );
      setQuota('provider-balanced', {
        kind: 'ok',
        provider: 'provider-balanced',
        summary: null,
        limits: [{ window: { duration: 1, unit: 'week' }, used: 50, limit: 100, resetAt: new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString() }],
        extraUsage: null,
      });
      setQuota('provider-kimi', {
        kind: 'ok',
        provider: 'provider-kimi',
        summary: null,
        limits: [{ window: { duration: 1, unit: 'week' }, used: 50, limit: 100, resetAt: new Date(now + 60 * 60 * 1000).toISOString() }],
        extraUsage: null,
      });

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      const [balanced, kimi] = autoPreset.status()!.candidates;
      // Beyond the 72h horizon the declared weekly window earns nothing.
      expect(balanced?.contributions.resetBonus).toBe(0);
      expect(originalRoute(balanced).resource).toMatchObject({
        kind: 'subscription',
        resetPriority: { bonus: 0, floorRelaxed: false, window: { duration: 1, unit: 'week' } },
      });
      // One hour before the weekly reset the exponential bonus approaches the
      // configured maximum of 200.
      expect(kimi?.contributions.resetBonus).toBeCloseTo(191.41, 2);
      expect(originalRoute(kimi).resource).toMatchObject({
        kind: 'subscription',
        resetPriority: {
          window: { duration: 1, unit: 'week' },
          remainingPercent: 50,
          horizonMs: 72 * 60 * 60 * 1000,
          floorRelaxed: false,
        },
      });
    });

    it('uses profile samples once sufficient and lets reliability outweigh local priority', async () => {
      const now = Date.now();
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          preset: undefined,
          autoPreset: {
            enabled: true,
            candidates: ['balanced', 'kimi-heavy'],
            priorityWeightPercent: 20,
            localUsageWeightPercent: 0,
            reliabilityWeightPercent: 50,
            latencyWeightPercent: 0,
          },
        }),
      );
      usage.liveEntries = [
        ...Array.from({ length: 3 }, (_, index) =>
          runEntry(`balanced-explore-failed-${index}`, 'route/balanced', now - index, 0, {
            finished: { status: 'failed' },
          }),
        ),
        ...Array.from({ length: 3 }, (_, index) =>
          runEntry(`balanced-plan-ok-${index}`, 'route/balanced', now - 10 - index, 0, {
            profileName: 'plan',
          }),
        ),
        ...Array.from({ length: 3 }, (_, index) =>
          runEntry(`kimi-explore-ok-${index}`, 'route/kimi', now - 20 - index, 0),
        ),
      ];
      setQuota('provider-balanced', okResult(70));
      setQuota('provider-kimi', okResult(70));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      const balanced = result.status!.candidates.find((candidate) => candidate.preset === 'balanced')!;
      expect(originalRoute(balanced).localEvidence).toMatchObject({
        scope: 'profile',
        sampleCount: 3,
        failureCount: 3,
        adjustedFailureRate: 0.6,
      });
      expect(balanced.contributions.reliabilityPenalty).toBe(30);
    });

    it('falls back to provider-wide evidence below the profile sample threshold', async () => {
      const now = Date.now();
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          preset: undefined,
          autoPreset: {
            enabled: true,
            candidates: ['balanced'],
            localUsageWeightPercent: 0,
            reliabilityWeightPercent: 20,
            latencyWeightPercent: 0,
          },
        }),
      );
      usage.liveEntries = [
        runEntry('explore-failed-1', 'route/balanced', now, 0, { finished: { status: 'failed' } }),
        runEntry('explore-failed-2', 'route/balanced', now - 1, 0, { finished: { status: 'failed' } }),
        runEntry('plan-ok-1', 'route/balanced', now - 2, 0, { profileName: 'plan' }),
        runEntry('plan-ok-2', 'route/balanced', now - 3, 0, { profileName: 'plan' }),
        runEntry('plan-ok-3', 'route/balanced', now - 4, 0, { profileName: 'plan' }),
      ];
      setQuota('provider-balanced', okResult(80));

      await autoPreset.evaluate(REQUEST, CTX);

      const balanced = autoPreset.status()!.candidates[0]!;
      expect(originalRoute(balanced).localEvidence).toMatchObject({
        scope: 'provider',
        sampleCount: 5,
        failureCount: 2,
        adjustedFailureRate: 0.4,
      });
      expect(balanced.contributions.reliabilityPenalty).toBe(8);
    });

    it('shrinks a single failed run while retaining near-timeout reliability evidence', async () => {
      const now = Date.now();
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          preset: undefined,
          autoPreset: {
            enabled: true,
            candidates: ['balanced', 'kimi-heavy'],
            priorityWeightPercent: 0,
            localUsageWeightPercent: 0,
            reliabilityWeightPercent: 20,
            latencyWeightPercent: 0,
          },
        }),
      );
      usage.liveEntries = [
        runEntry('near-timeout-failed', 'route/balanced', now, 0, {
          finished: { status: 'failed', durationMs: 3_599_000 },
        }),
      ];
      setQuota('provider-balanced', okResult(70));
      setQuota('provider-kimi', okResult(70));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      const balanced = result.status!.candidates[0]!;
      expect(originalRoute(balanced).localEvidence).toMatchObject({
        sampleCount: 1,
        failureCount: 1,
        adjustedFailureRate: 0.2,
      });
      expect(balanced.contributions.reliabilityPenalty).toBe(4);
    });

    it('weights profile first-token latency by measured samples across partial and legacy runs', async () => {
      const now = Date.now();
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          preset: undefined,
          autoPreset: {
            enabled: true,
            candidates: ['balanced', 'kimi-heavy'],
            priorityWeightPercent: 0,
            localUsageWeightPercent: 0,
            reliabilityWeightPercent: 0,
            latencyWeightPercent: 20,
          },
        }),
      );
      usage.liveEntries = [
        runEntry('balanced-latency-single', 'route/balanced', now, 0, {
          finished: {
            averageFirstTokenLatencyMs: 1000,
            firstTokenLatencySampleCount: 1,
            llmRequestCount: 10,
          },
        }),
        runEntry('balanced-latency-partial', 'route/balanced', now - 1, 0, {
          finished: {
            averageFirstTokenLatencyMs: 100,
            firstTokenLatencySampleCount: 2,
            llmRequestCount: 4,
          },
        }),
        runEntry('balanced-latency-legacy', 'route/balanced', now - 2, 0, {
          finished: { averageFirstTokenLatencyMs: 700, llmRequestCount: 8 },
        }),
        ...Array.from({ length: 3 }, (_, index) =>
          runEntry(`kimi-latency-${index}`, 'route/kimi', now - 10 - index, 0, {
            finished: {
              averageFirstTokenLatencyMs: 100,
              firstTokenLatencySampleCount: 1,
              llmRequestCount: 1,
            },
          }),
        ),
      ];
      setQuota('provider-balanced', okResult(70));
      setQuota('provider-kimi', okResult(70));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      const balanced = result.status!.candidates[0]!;
      const kimi = result.status!.candidates[1]!;
      expect(originalRoute(balanced).localEvidence).toMatchObject({
        scope: 'profile',
        averageFirstTokenLatencyMs: 475,
        firstTokenLatencySampleCount: 4,
        llmRequestCount: 22,
      });
      expect(balanced.contributions.latencyPenalty).toBe(16);
      expect(originalRoute(kimi).localEvidence).toMatchObject({
        firstTokenLatencySampleCount: 3,
        llmRequestCount: 3,
      });
      expect(kimi.contributions.latencyPenalty).toBeCloseTo(20 * (100 / 475) * 0.6);
    });

    it('opens on consecutive failed runs and immediately escapes the unhealthy current', async () => {
      const now = Date.now();
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          autoPreset: {
            enabled: true,
            candidates: ['balanced', 'kimi-heavy'],
            priorityWeightPercent: 0,
            reliabilityWeightPercent: 0,
            circuitBreakerFailureThreshold: 3,
            circuitBreakerCooldownMs: 900_000,
          },
        }),
      );
      usage.liveEntries = Array.from({ length: 3 }, (_, index) =>
        runEntry(`failed-${index}`, 'route/balanced', now - (3 - index) * 1000, 0, {
          finished: {
            status: 'failed',
            errorCode: index === 0 ? 'provider.connection_error' : undefined,
          },
        }),
      );
      setQuota('provider-balanced', okResult(99));
      setQuota('provider-kimi', okResult(50));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      expect(result.reasonCode).toBe('circuit_breaker_escape');
      expect(originalRoute(result.status!.candidates[0])).toMatchObject({
        availability: 'circuit_open',
        selectable: false,
      });
      expect(originalRoute(result.status!.candidates[0]).circuitBreakerOpenUntil).toBeGreaterThan(now);
    });

    it('counts a live failed suffix across the cooldown cutoff and clears it after success', async () => {
      const now = Date.UTC(2026, 0, 1);
      clockNow = now;
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          autoPreset: {
            enabled: true,
            candidates: ['balanced', 'kimi-heavy'],
            priorityWeightPercent: 0,
            localUsageWeightPercent: 0,
            reliabilityWeightPercent: 0,
            latencyWeightPercent: 0,
            switchCooldownMs: 0,
            circuitBreakerFailureThreshold: 3,
            circuitBreakerCooldownMs: 60_000,
          },
        }),
      );
      setQuota('provider-balanced', okResult(99));
      setQuota('provider-kimi', okResult(50));
      await autoPreset.evaluate(REQUEST, CTX);

      usage.completeLiveRun(runEntry('spanning-failed-1', 'route/balanced', now, 0, {
        finished: { status: 'failed' },
      }));
      clockNow = now + 40_000;
      usage.completeLiveRun(runEntry('spanning-failed-2', 'route/balanced', now + 40_000, 0, {
        finished: { status: 'failed' },
      }));
      clockNow = now + 80_000;
      usage.completeLiveRun(runEntry('spanning-failed-3', 'route/balanced', now + 80_000, 0, {
        finished: { status: 'failed' },
      }));

      const opened = await autoPreset.evaluate(REQUEST, CTX);

      expect(opened.reasonCode).toBe('circuit_breaker_escape');
      expect(originalRoute(opened.status!.candidates[0])).toMatchObject({
        availability: 'circuit_open',
        circuitBreakerOpenUntil: now + 140_000,
      });

      clockNow = now + 80_001;
      usage.completeLiveRun(runEntry('spanning-recovered', 'route/balanced', now + 80_001, 0));
      const recovered = await autoPreset.evaluate(REQUEST, CTX);

      expect(recovered.activatedPreset).toBe('balanced');
      expect(originalRoute(recovered.status!.candidates[0])).toMatchObject({
        availability: 'healthy',
        circuitBreakerOpenUntil: undefined,
      });
    });

    it('hydrates an observed failed suffix spanning the cooldown cutoff without losing its live attribution', async () => {
      const now = Date.UTC(2026, 0, 1);
      clockNow = now;
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          autoPreset: {
            enabled: true,
            candidates: ['balanced', 'kimi-heavy'],
            priorityWeightPercent: 0,
            localUsageWindowMs: 30_000,
            localUsageWeightPercent: 0,
            reliabilityWeightPercent: 0,
            latencyWeightPercent: 0,
            circuitBreakerFailureThreshold: 3,
            circuitBreakerCooldownMs: 60_000,
          },
        }),
      );
      usage.liveEntries = [
        runEntry('hydrated-failed-1', 'route/balanced', now - 130_000, 0, {
          finished: { status: 'failed' },
        }),
        runEntry('hydrated-failed-2', 'route/balanced', now - 70_000, 0, {
          finished: { status: 'failed' },
        }),
        runEntry('hydrated-failed-3', 'route/balanced', now - 10_000, 0, {
          finished: { status: 'failed' },
        }),
      ];
      setQuota('provider-balanced', okResult(99));
      setQuota('provider-kimi', okResult(50));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(usage.readCalls).toBe(1);
      expect(result.reasonCode).toBe('circuit_breaker_escape');
      expect(originalRoute(result.status!.candidates[0])).toMatchObject({
        availability: 'circuit_open',
        circuitBreakerOpenUntil: now + 50_000,
      });
    });

    it('closes the circuit early after a later success and ignores cancellations', async () => {
      const now = Date.now();
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          autoPreset: {
            enabled: true,
            candidates: ['balanced', 'kimi-heavy'],
            reliabilityWeightPercent: 0,
            circuitBreakerFailureThreshold: 3,
            circuitBreakerCooldownMs: 900_000,
          },
        }),
      );
      usage.liveEntries = [
        ...Array.from({ length: 3 }, (_, index) =>
          runEntry(`failed-${index}`, 'route/balanced', now - 10_000 + index, 0, {
            finished: { status: 'failed' },
          }),
        ),
        runEntry('recovered', 'route/balanced', now - 1000, 0),
        ...Array.from({ length: 3 }, (_, index) =>
          runEntry(`cancelled-${index}`, 'route/kimi', now - 500 + index, 0, {
            finished: { status: 'cancelled' },
          }),
        ),
      ];
      setQuota('provider-balanced', okResult(90));
      setQuota('provider-kimi', okResult(80));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(originalRoute(result.status!.candidates[0])).toMatchObject({
        availability: 'healthy',
        circuitBreakerOpenUntil: undefined,
      });
      expect(originalRoute(result.status!.candidates[1]).localEvidence).toMatchObject({
        scope: 'none',
        sampleCount: 0,
        failureCount: 0,
      });
    });

    it('blocks ordinary cross-switching during cooldown but permits unhealthy escape', async () => {
      const now = Date.UTC(2026, 0, 1);
      clockNow = now;
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          autoPreset: {
            enabled: true,
            candidates: ['balanced', 'kimi-heavy'],
            priorityWeightPercent: 0,
            reliabilityWeightPercent: 0,
            latencyWeightPercent: 0,
            switchCooldownMs: 600_000,
          },
        }),
      );
      setQuota('provider-balanced', okResult(50));
      setQuota('provider-kimi', okResult(90));
      const first = await autoPreset.evaluate(REQUEST, CTX);
      expect(first.activatedPreset).toBe('kimi-heavy');
      expect(first.status!.switchCooldownUntil).toBe(now + 600_000);

      usage.completeLiveRun(runEntry('cache-reset-1', 'route/kimi', now + 1, 0));
      setQuota('provider-balanced', okResult(95));
      setQuota('provider-kimi', okResult(50));
      const cooled = await autoPreset.evaluate(REQUEST, CTX);
      expect(cooled.activatedPreset).toBeUndefined();
      expect(cooled.reasonCode).toBe('switch_cooldown');
      expect(currentPreset()).toBe('kimi-heavy');

      usage.completeLiveRun(runEntry('cache-reset-2', 'route/kimi', now + 2, 0));
      setQuota('provider-kimi', okResult(10));
      const escaped = await autoPreset.evaluate(REQUEST, CTX);
      expect(escaped.activatedPreset).toBe('balanced');
      expect(escaped.reasonCode).toBe('current_unhealthy');
    });
  });

  describe('local token usage', () => {
    it('applies the token weight to the score and flips the decision', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, localUsageWeightPercent: 10 } }),
      );
      const now = Date.now();
      usage.liveEntries = [
        runEntry('run-heavy', 'route/balanced', now - 30_000, 900_000),
        runEntry('run-light', 'route/kimi', now - 30_000, 0),
      ];
      setQuota('provider-balanced', okResult(30));
      setQuota('provider-kimi', okResult(48));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
    });

    it('prunes finished runs outside the local usage window', async () => {
      const now = Date.now();
      usage.liveEntries = [runEntry('run-old', 'route/balanced', now - 2 * 60 * 60 * 1000, 1_000_000)];
      setQuota('provider-balanced', okResult(30));
      setQuota('provider-kimi', okResult(40));

      // Without pruning, the stale token penalty would lower balanced from 52
      // to 42 and let kimi lead by the 10-point margin. Pruning leaves both at
      // 52, where the current preset wins the exact tie.
      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(currentPreset()).toBe('balanced');
    });

    it('hydrates the window from the ledger and updates from live completion events', async () => {
      const now = Date.now();
      usage.liveEntries = [runEntry('run-historic', 'route/kimi', now - 60_000, 1_000)];
      setQuota('provider-balanced', okResult(30));
      setQuota('provider-kimi', okResult(45));

      // Historic kimi tokens (1_000, normalized 1.0 → −10) leave kimi at 35;
      // balanced 30 is still healthy and first in priority → keep — the
      // hydration contributed to scoring.
      await autoPreset.evaluate(REQUEST, CTX);
      expect(currentPreset()).toBe('balanced');

      // A live completion adds 1M balanced tokens: balanced drops to 20 (below
      // the floor), so the decider falls back in order to kimi (~45). No re-read
      // is needed for the event.
      usage.completeLiveRun(runEntry('run-live', 'route/balanced', now + 60_000, 1_000_000));
      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
    });

    it('normalizes only against candidate-provider tokens, never a busy outsider', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, localUsageWeightPercent: 10 } }),
      );
      const now = Date.now();
      usage.liveEntries = [
        runEntry('run-candidate', 'route/balanced', now - 30_000, 1_000_000),
        runEntry('run-outsider', 'route/other', now - 30_000, 10_000_000),
      ];
      setQuota('provider-balanced', okResult(30));
      setQuota('provider-kimi', okResult(45));

      // The outsider provider is not among the candidates, so its 10M tokens
      // must not dilute the normalization: balanced drops to 20 (1M/1M → −10,
      // below the floor) and the decider falls back to kimi (45). A max
      // including the outsider would leave balanced at ~29 (healthy) and keep
      // the current preset.
      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
    });

    it('retains bounded live attribution while disabled and restores only observed evidence on hydration', async () => {
      const now = Date.now();
      usage.liveEntries = [runEntry('run-seed', 'route/balanced', now - 30_000, 1_000_000)];
      const flag = ix.get(IFlagService).enabled as ReturnType<typeof vi.fn>;
      flag.mockReturnValue(false);
      usage.completeLiveRun(runEntry('run-off', 'route/kimi', now + 1_000, 5_000_000));
      await autoPreset.evaluate(REQUEST, CTX);

      flag.mockReturnValue(true);
      setQuota('provider-balanced', okResult(30));
      setQuota('provider-kimi', okResult(45));
      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(currentPreset()).toBe('balanced');
      expect(originalRoute(result.status!.candidates[1]).localEvidence).toMatchObject({ sampleCount: 1, tokenCount: 5_000_000 });
    });

    it('does not use old entries as local evidence', async () => {
      const now = Date.now();
      const oldNoUsage: AgentRunUsageEntry = {
        started: startedRecord('run-old-no-usage', 'route/kimi', now - 2 * 3_600_000),
        finished: { ...finishedRecord('run-old-no-usage', now - 2 * 3_600_000, 0), usage: undefined },
      };
      usage.liveEntries = [oldNoUsage];
      setQuota('provider-balanced', okResult(80));
      setQuota('provider-kimi', okResult(95));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(originalRoute(result.status!.candidates[1]).localEvidence).toMatchObject({
        scope: 'none',
        sampleCount: 0,
      });
    });

    it('keeps an in-window usage-undefined entry without letting it affect tokens', async () => {
      const now = Date.now();
      const noUsage: AgentRunUsageEntry = {
        started: startedRecord('run-no-usage', 'route/kimi', now - 60_000),
        finished: { ...finishedRecord('run-no-usage', now - 60_000, 0), usage: undefined },
      };
      usage.liveEntries = [noUsage];
      setQuota('provider-balanced', okResult(90));
      setQuota('provider-kimi', okResult(95));

      await autoPreset.evaluate(REQUEST, CTX);

      // kimi has no token penalty from the entry, so the margin stays 5 → keep.
      expect(currentPreset()).toBe('balanced');
    });

    it('keeps bounded breaker history after entries age out of the local evidence window', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, localUsageWindowMs: 3_600_000 } }),
      );
      const now = Date.now();
      const aging: AgentRunUsageEntry = {
        started: startedRecord('run-aging', 'route/kimi', now - 2 * 60_000),
        finished: { ...finishedRecord('run-aging', now - 60_000, 0), usage: undefined },
      };
      usage.liveEntries = [aging];
      setQuota('provider-balanced', okResult(90));
      setQuota('provider-kimi', okResult(95));

      await autoPreset.evaluate(REQUEST, CTX);
      expect(autoPreset.status()!.candidates[1]!.localEvidence.sampleCount).toBe(1);

      clockNow = now + 4 * 3_600_000;
      await autoPreset.evaluate(REQUEST, CTX);
      expect(autoPreset.status()!.candidates[1]!.localEvidence).toMatchObject({
        scope: 'none',
        sampleCount: 0,
      });
    });

    it('re-hydrates from the ledger after being disabled mid-process', async () => {
      const now = Date.now();
      usage.liveEntries = [runEntry('run-a', 'route/kimi', now - 30_000, 1_000)];
      setQuota('provider-balanced', okResult(30));
      setQuota('provider-kimi', okResult(49));
      const flag = ix.get(IFlagService).enabled as ReturnType<typeof vi.fn>;

      // Enabled: hydration loads run-a (kimi 1_000 → 39), balanced is still
      // healthy at 30 — no switch.
      await autoPreset.evaluate(REQUEST, CTX);
      expect(currentPreset()).toBe('balanced');

      // Disabled mid-process: a completion while off must not be retained, and
      // the next evaluation drops the retained window. The record is still
      // persisted to the ledger (simulated below).
      flag.mockReturnValue(false);
      usage.completeLiveRun(runEntry('run-b', 'route/balanced', now + 1_000, 5_000_000));
      await autoPreset.evaluate(REQUEST, CTX);

      // The ledger now carries both the pre-disable and the off-period runs.
      usage.liveEntries = [
        runEntry('run-a', 'route/kimi', now - 30_000, 1_000),
        runEntry('run-b', 'route/balanced', now + 1_000, 5_000_000),
      ];

      // Re-enabled: the evaluation must re-hydrate from read() — with run-b's
      // 5M balanced tokens counted, balanced (30−10=20) drops below the floor
      // and the decider falls back to kimi (39). A skipped re-hydration would
      // see balanced at 30 (healthy) and keep it.
      flag.mockReturnValue(true);
      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
    });

    it('single-flights first hydration and does not expose a half-hydrated window', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      usage.liveEntries = [runEntry('run-seed', 'route/balanced', Date.now(), 1000)];
      usage.readImpl = async () => {
        await gate;
        return usage.entries;
      };
      setQuota('provider-balanced', okResult(90));
      setQuota('provider-kimi', okResult(95));
      let firstSettled = false;
      let secondSettled = false;

      const first = autoPreset.evaluate(REQUEST, CTX).finally(() => {
        firstSettled = true;
      });
      const second = autoPreset.evaluate(REQUEST, CTX).finally(() => {
        secondSettled = true;
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(usage.readCalls).toBe(1);
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);

      release();
      await Promise.all([first, second]);
      expect(usage.readCalls).toBe(1);
      expect(autoPreset.status()!.candidates[0]!.localEvidence.sampleCount).toBe(1);
    });

    it('retries ledger hydration after failed reads', async () => {
      const entry = runEntry('run-retry', 'route/balanced', Date.now(), 1000);
      usage.liveEntries = [entry];
      let failuresRemaining = 2;
      usage.readImpl = async () => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error('ledger unavailable');
        }
        return [entry];
      };
      setQuota('provider-balanced', okResult(90));
      setQuota('provider-kimi', okResult(95));

      await autoPreset.evaluate(REQUEST, CTX);
      expect(usage.readCalls).toBe(1);

      await autoPreset.evaluate(REQUEST, CTX);
      expect(usage.readCalls).toBe(2);

      await autoPreset.evaluate(REQUEST, CTX);
      expect(usage.readCalls).toBe(3);
      expect(autoPreset.status()!.candidates[0]!.localEvidence.sampleCount).toBe(1);
    });
  });

  describe('quota caching and concurrency', () => {
    it('serves quota from the TTL cache and refreshes after the interval', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, refreshIntervalMs: 60_000 } }),
      );
      setQuota('provider-balanced', okResult(80));
      setQuota('provider-kimi', okResult(95));

      await autoPreset.evaluate(REQUEST, CTX);
      await autoPreset.evaluate(REQUEST, CTX);
      expect(usageCalls.filter((p) => p === 'provider-kimi')).toHaveLength(1);

      clockNow += 61_000;
      await autoPreset.evaluate(REQUEST, CTX);
      expect(usageCalls.filter((p) => p === 'provider-kimi')).toHaveLength(2);
    });

    it('invalidates cached quota when a known reset boundary passes, even within the TTL', async () => {
      const now = Date.UTC(2026, 0, 1);
      clockNow = now;
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, refreshIntervalMs: 3_600_000 } }),
      );
      const weeklyAt = (resetInMs: number): ProviderUsageResult => ({
        kind: 'ok',
        provider: 'provider-kimi',
        summary: null,
        limits: [{ window: { duration: 1, unit: 'week' }, used: 10, limit: 100, resetAt: new Date(clockNow + resetInMs).toISOString() }],
        extraUsage: null,
      });
      setQuota('provider-balanced', okResult(80));
      setQuota('provider-kimi', weeklyAt(60_000));

      const first = await autoPreset.evaluate(REQUEST, CTX);
      const firstResetAt = now + 60_000;
      expect(usageCalls.filter((p) => p === 'provider-kimi')).toHaveLength(1);
      expect(originalRoute(first.status!.candidates.find((candidate) => candidate.preset === 'kimi-heavy')).resource)
        .toMatchObject({ kind: 'subscription', resetPriority: { resetAt: firstResetAt } });

      clockNow += 30_000;
      await autoPreset.evaluate(REQUEST, CTX);
      expect(usageCalls.filter((p) => p === 'provider-kimi')).toHaveLength(1);

      clockNow += 31_000;
      setQuota('provider-kimi', weeklyAt(60_000));
      const refreshed = await autoPreset.evaluate(REQUEST, CTX);
      expect(usageCalls.filter((p) => p === 'provider-kimi')).toHaveLength(2);
      expect(originalRoute(refreshed.status!.candidates.find((candidate) => candidate.preset === 'kimi-heavy')).resource)
        .toMatchObject({ kind: 'subscription', resetPriority: { resetAt: clockNow + 60_000 } });
    });

    it('refreshes a response that still cites a crossed reset once and refuses it when it stays stale', async () => {
      const now = Date.UTC(2026, 0, 1);
      clockNow = now;
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, refreshIntervalMs: 3_600_000 } }),
      );
      setQuota('provider-balanced', okResult(80));
      // The counterexample: the weekly window is genuinely positive and near
      // its reset, but the short window's data predates its own reset — the
      // whole response is pre-reset evidence and must not authorize the
      // expiring-quota bonus or the floor exception.
      setQuota('provider-kimi', {
        kind: 'ok',
        provider: 'provider-kimi',
        summary: null,
        limits: [
          { window: { duration: 1, unit: 'week' }, used: 88, limit: 100, resetAt: new Date(now + 12 * 60 * 60 * 1000).toISOString() },
          { window: { duration: 5, unit: 'hour' }, used: 0, limit: 100, resetAt: new Date(now - 60 * 60 * 1000).toISOString() },
        ],
        extraUsage: null,
      });

      const first = await autoPreset.evaluate(REQUEST, CTX);
      expect(usageCalls.filter((p) => p === 'provider-kimi')).toHaveLength(2);
      expect(originalRoute(first.status!.candidates.find((candidate) => candidate.preset === 'kimi-heavy'))).toMatchObject({
        availability: 'quota_unknown',
        selectable: false,
        contributions: { resetBonus: 0 },
      });

      clockNow += 60_000;
      await autoPreset.evaluate(REQUEST, CTX);
      expect(usageCalls.filter((p) => p === 'provider-kimi')).toHaveLength(4);
    });

    it('reports unknown after a crossed reset when the refresh fails instead of fabricating recovery', async () => {
      const now = Date.UTC(2026, 0, 1);
      clockNow = now;
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, refreshIntervalMs: 3_600_000 } }),
      );
      setQuota('provider-balanced', okResult(80));
      setQuota('provider-kimi', {
        kind: 'ok',
        provider: 'provider-kimi',
        summary: null,
        limits: [{ window: { duration: 1, unit: 'week' }, used: 0, limit: 100, resetAt: new Date(now + 60_000).toISOString() }],
        extraUsage: null,
      });

      const before = await autoPreset.evaluate(REQUEST, CTX);
      expect(originalRoute(before.status!.candidates.find((candidate) => candidate.preset === 'kimi-heavy')))
        .toMatchObject({ availability: 'healthy' });

      clockNow += 61_000;
      setQuota('provider-kimi', undefined);
      const after = await autoPreset.evaluate(REQUEST, CTX);
      expect(originalRoute(after.status!.candidates.find((candidate) => candidate.preset === 'kimi-heavy'))).toMatchObject({
        availability: 'quota_unknown',
        contributions: { resetBonus: 0 },
      });
    });

    it('shares an in-flight quota query between concurrent evaluations', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const query = vi.mocked(ix.get(IProviderUsageService).queryUsage);
      query.mockImplementation(async (providerId?: string) => {
        if (providerId !== undefined) usageCalls.push(providerId);
        await gate;
        return [okResult(95)];
      });

      const first = autoPreset.evaluate(REQUEST, CTX);
      const second = autoPreset.evaluate(REQUEST, CTX);
      release();
      await Promise.all([first, second]);

      // Every provider quota is single-flighted, so each provider is queried once.
      expect(usageCalls.filter((p) => p === 'provider-kimi')).toHaveLength(1);
      expect(usageCalls.filter((p) => p === 'provider-balanced')).toHaveLength(1);
    });

    it('invalidates the quota cache when a run finishes, so the next spawn refetches', async () => {
      setQuota('provider-balanced', okResult(80));
      setQuota('provider-kimi', okResult(95));

      await autoPreset.evaluate(REQUEST, CTX);
      expect(usageCalls.filter((p) => p === 'provider-kimi')).toHaveLength(1);

      usage.completeLiveRun(runEntry('run-1', 'route/kimi', Date.now(), 1000));

      await autoPreset.evaluate(REQUEST, CTX);
      expect(usageCalls.filter((p) => p === 'provider-kimi')).toHaveLength(2);
    });

    it('serializes concurrent activation writes without corrupting the section', async () => {
      setQuota('provider-balanced', okResult(5));
      setQuota('provider-kimi', okResult(90));
      setQuota('provider-deepseek', okResult(95));

      const [a, b] = await Promise.all([
        autoPreset.evaluate(REQUEST, CTX),
        autoPreset.evaluate(REQUEST, CTX),
      ]);
      const chosen = [a.activatedPreset, b.activatedPreset].filter(
        (preset): preset is string => preset !== undefined,
      );
      expect(chosen.length).toBeGreaterThan(0);
      const finalPreset = currentPreset();
      expect(chosen).toContain(finalPreset);
      // The presets/agents/timeout fields survive the writes.
      expect(config.get<SubagentConfig>(SUBAGENT_SECTION).presets).toEqual(PRESETS);
    });

    it('negative-caches unknown quota answers within the TTL', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, refreshIntervalMs: 60_000 } }),
      );
      setQuota('provider-balanced', okResult(80));
      setQuota('provider-kimi', undefined);

      await autoPreset.evaluate(REQUEST, CTX);
      await autoPreset.evaluate(REQUEST, CTX);
      expect(usageCalls.filter((p) => p === 'provider-kimi')).toHaveLength(1);

      usage.completeLiveRun(runEntry('run-1', 'route/kimi', Date.now(), 100));
      await autoPreset.evaluate(REQUEST, CTX);
      expect(usageCalls.filter((p) => p === 'provider-kimi')).toHaveLength(2);
    });

    it('returns immediately when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await autoPreset.evaluate(REQUEST, { sessionId: 'test-session', signal: controller.signal });

      expect(result.reason).toBe('cancelled');
      expect(usageCalls).toEqual([]);
      expect(currentPreset()).toBe('balanced');
    });

    it('races a provider that ignores abort and safely absorbs its late rejection', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, queryTimeoutMs: 5 } }),
      );
      const rejectors: Array<(error: Error) => void> = [];
      const query = vi.mocked(ix.get(IProviderUsageService).queryUsage);
      query.mockImplementation(
        (providerId?: string) =>
          new Promise<readonly ProviderUsageResult[]>((_resolve, reject) => {
            if (providerId !== undefined) usageCalls.push(providerId);
            rejectors.push(reject);
          }),
      );

      const startedAt = Date.now();
      const result = await autoPreset.evaluate(REQUEST, CTX);
      const elapsed = Date.now() - startedAt;

      expect(result.activatedPreset).toBeUndefined();
      expect(elapsed).toBeLessThan(1000);
      expect(rejectors).toHaveLength(3);

      for (const reject of rejectors) reject(new Error('late provider failure'));
      await Promise.resolve();
      await Promise.resolve();
      expect(currentPreset()).toBe('balanced');
    });

    it('does not persist once aborted mid-evaluation', async () => {
      const controller = new AbortController();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const query = vi.mocked(ix.get(IProviderUsageService).queryUsage);
      query.mockImplementation(
        (providerId?: string, options?: { signal?: AbortSignal }) =>
          new Promise<readonly ProviderUsageResult[]>((resolve) => {
            if (providerId !== undefined) usageCalls.push(providerId);
            void Promise.race([
              gate,
              new Promise<void>((settle) => {
                options?.signal?.addEventListener(
                  'abort',
                  () => {
                    settle();
                  },
                  { once: true },
                );
              }),
            ]).then(() => {
              resolve([{ kind: 'error', provider: providerId ?? 'x', message: 'aborted' }]);
            });
          }),
      );

      const pending = autoPreset.evaluate(REQUEST, { sessionId: 'test-session', signal: controller.signal });
      controller.abort();
      release();
      const result = await pending;

      expect(result.reason).toBe('cancelled');
      expect(currentPreset()).toBe('balanced');
    });

    it('does not negative-cache a quota answer cancelled by the caller signal', async () => {
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          autoPreset: { enabled: true, refreshIntervalMs: 60_000, queryTimeoutMs: 20 },
        }),
      );
      const controller = new AbortController();
      const query = vi.mocked(ix.get(IProviderUsageService).queryUsage);
      query.mockImplementation(
        (providerId?: string, options?: { signal?: AbortSignal }) =>
          new Promise<readonly ProviderUsageResult[]>((resolve) => {
            if (providerId !== undefined) usageCalls.push(providerId);
            options?.signal?.addEventListener(
              'abort',
              () => {
                resolve([{ kind: 'error', provider: providerId ?? 'x', message: 'aborted' }]);
              },
              { once: true },
            );
          }),
      );

      const pending = autoPreset.evaluate(REQUEST, { sessionId: 'test-session', signal: controller.signal });
      controller.abort();
      await pending;

      const cancelledCalls = usageCalls.length;

      // The next spawn has no aborting signal: the previous cancellation must
      // not have been cached as an unknown, so every provider is re-queried.
      await autoPreset.evaluate(REQUEST, CTX);
      expect(usageCalls.length).toBeGreaterThan(cancelledCalls);
    });

    it('re-decides against the live preset inside the write lock instead of overwriting on a stale current', async () => {
      const presets: SubagentConfig['presets'] = {
        balanced: {
          explore: { model: 'route/balanced' },
          plan: { model: 'route/balanced' },
        },
        'kimi-heavy': {
          explore: { model: 'route/kimi' },
          plan: { model: 'route/kimi' },
        },
        'deepseek-heavy': {
          explore: { model: 'route/deepseek' },
          plan: { model: 'route/deepseek-plan' },
        },
      };
      await config.replace(SUBAGENT_SECTION, subagentConfigWith({ presets }));
      quotaResults.set('provider-balanced', okResult(5));
      quotaResults.set('provider-kimi', okResult(90));
      quotaResults.set('provider-deepseek', okResult(95));
      quotaResults.set('provider-deepseek-plan', okResult(85));

      const exploreReq: SubagentRouteRequest = {
        route: 'agent',
        profileName: 'explore',
        caller: { modelAlias: 'caller-model', thinkingLevel: 'low' },
      };
      const planReq: SubagentRouteRequest = {
        route: 'agent',
        profileName: 'plan',
        caller: { modelAlias: 'caller-model', thinkingLevel: 'low' },
      };

      const [a, b] = await Promise.all([
        autoPreset.evaluate(exploreReq, CTX),
        autoPreset.evaluate(planReq, CTX),
      ]);

      // Exactly one evaluation commits: the explore route prefers deepseek
      // (95 over 90) and the plan route prefers kimi (90 over 85) — different
      // choices driven by the same stale balanced current. Whichever commits
      // first, the other must re-decide against the live preset inside the
      // write lock and keep it instead of overwriting it.
      const committed = [a, b].filter(
        (evaluation) => evaluation.activatedPreset !== undefined,
      );
      expect(committed).toHaveLength(1);
      const finalPreset = committed[0]!.activatedPreset!;
      expect(currentPreset()).toBe(finalPreset);
      const kept = [a, b].find((evaluation) => evaluation.activatedPreset === undefined)!;
      expect(kept.currentPreset).toBe(finalPreset);
      expect(kept.reason).not.toContain('failed');
    });

    it('rechecks the experimental flag inside the shared activation lock', async () => {
      const activation = ix.get(ISubagentPresetActivationService);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = activation.runExclusive(async () => gate);
      setQuota('provider-balanced', okResult(5));
      setQuota('provider-kimi', okResult(95));

      const pending = autoPreset.evaluate(REQUEST, CTX);
      await vi.waitFor(() => expect(usageCalls.length).toBeGreaterThan(0));
      (ix.get(IFlagService).enabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
      release();
      await blocker;
      const result = await pending;

      expect(result.reason).toBe('flag disabled');
      expect(currentPreset()).toBe('balanced');
    });

    it('rechecks auto_preset.enabled inside the shared activation lock', async () => {
      const activation = ix.get(ISubagentPresetActivationService);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = activation.runExclusive(async () => gate);
      setQuota('provider-balanced', okResult(5));
      setQuota('provider-kimi', okResult(95));

      const pending = autoPreset.evaluate(REQUEST, CTX);
      await vi.waitFor(() => expect(usageCalls.length).toBeGreaterThan(0));
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: false } }),
      );
      release();
      await blocker;
      const result = await pending;

      expect(result.reason).toBe('auto preset disabled');
      expect(currentPreset()).toBe('balanced');
    });

    it('rechecks candidate settings inside the shared activation lock', async () => {
      const activation = ix.get(ISubagentPresetActivationService);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = activation.runExclusive(async () => gate);
      setQuota('provider-balanced', okResult(5));
      setQuota('provider-kimi', okResult(95));

      const pending = autoPreset.evaluate(REQUEST, CTX);
      await vi.waitFor(() => expect(usageCalls.length).toBeGreaterThan(0));
      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({
          autoPreset: { enabled: true, candidates: ['balanced'] },
        }),
      );
      release();
      await blocker;
      const result = await pending;

      expect(result.activatedPreset).toBeUndefined();
      expect(currentPreset()).toBe('balanced');
      expect(result.reason).toMatch(/quota floor|already optimal|config changed/);
    });

    it('does not overwrite a same-value manual selection made during quota queries', async () => {
      setQuota('provider-balanced', okResult(5));
      setQuota('provider-kimi', okResult(95));
      setQuota('provider-deepseek', okResult(90));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const query = vi.mocked(ix.get(IProviderUsageService).queryUsage);
      query.mockImplementation(async (providerId?: string) => {
        if (providerId === undefined) return [];
        usageCalls.push(providerId);
        await gate;
        const result = quotaResults.get(providerId);
        return result === undefined
          ? [{ kind: 'error', provider: providerId, message: 'down' }]
          : [{ ...result, provider: providerId }];
      });

      const automatic = autoPreset.evaluate(REQUEST, CTX);
      await vi.waitFor(() => expect(usageCalls.length).toBeGreaterThan(0));
      const manual = await ix.get(ISubagentPresetActivationService).activate('kimi-heavy');
      expect(manual.kind).toBe('activated');
      release();
      const result = await automatic;

      // The manual selection stamped the manual lock, so the commit recheck
      // defers without overwriting the human choice.
      expect(result.reason).toBe('manual preset selection');
      expect(result.activatedPreset).toBeUndefined();
      expect(currentPreset()).toBe('kimi-heavy');
    });

    it('does not overwrite a different-value manual selection made during quota queries', async () => {
      setQuota('provider-balanced', okResult(5));
      setQuota('provider-kimi', okResult(95));
      setQuota('provider-deepseek', okResult(90));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const query = vi.mocked(ix.get(IProviderUsageService).queryUsage);
      query.mockImplementation(async (providerId?: string) => {
        if (providerId === undefined) return [];
        usageCalls.push(providerId);
        await gate;
        const result = quotaResults.get(providerId);
        return result === undefined
          ? [{ kind: 'error', provider: providerId, message: 'down' }]
          : [{ ...result, provider: providerId }];
      });

      const automatic = autoPreset.evaluate(REQUEST, CTX);
      await vi.waitFor(() => expect(usageCalls.length).toBeGreaterThan(0));
      const manual = await ix.get(ISubagentPresetActivationService).activate('kimi-heavy');
      expect(manual.kind).toBe('activated');
      release();
      const result = await automatic;

      // The manual choice itself is never replaced — even when it differs from
      // what the stale scoring would have activated.
      expect(result.reason).toBe('manual preset selection');
      expect(result.activatedPreset).toBeUndefined();
      expect(currentPreset()).toBe('kimi-heavy');
    });

    it('clears a manual preset to base routing through the shared activation boundary', async () => {
      const activation = ix.get(ISubagentPresetActivationService);
      const revision = activation.manualRevision;

      const result = await activation.activate('');

      expect(result.kind).toBe('activated');
      expect(currentPreset()).toBe('');
      expect(activation.manualRevision).toBe(revision + 1);
    });

    it('shares the write lock with manual activation so the later human choice wins', async () => {
      setQuota('provider-balanced', okResult(5));
      setQuota('provider-kimi', okResult(95));
      setQuota('provider-deepseek', okResult(90));
      const activation = ix.get(ISubagentPresetActivationService);
      const originalSet = config.set.bind(config);
      let autoCommitStarted!: () => void;
      const autoCommit = new Promise<void>((resolve) => {
        autoCommitStarted = resolve;
      });
      let releaseAutoCommit!: () => void;
      const autoCommitGate = new Promise<void>((resolve) => {
        releaseAutoCommit = resolve;
      });
      config.set = vi.fn(async (domain, patch, target = ConfigTarget.User) => {
        if (
          domain === SUBAGENT_SECTION &&
          target === ConfigTarget.User &&
          isObject(patch) &&
          patch['preset'] === 'kimi-heavy'
        ) {
          autoCommitStarted();
          await autoCommitGate;
        }
        await originalSet(domain, patch, target);
      });

      const automatic = autoPreset.evaluate(REQUEST, CTX);
      await autoCommit;
      let manualSettled = false;
      const manual = activation.activate('deepseek-heavy').finally(() => {
        manualSettled = true;
      });
      await Promise.resolve();
      expect(manualSettled).toBe(false);

      releaseAutoCommit();
      const [automaticResult, manualResult] = await Promise.all([automatic, manual]);

      expect(automaticResult.activatedPreset).toBe('kimi-heavy');
      expect(manualResult.kind).toBe('activated');
      expect(currentPreset()).toBe('deepseek-heavy');
    });
  });

  describe('persistence', () => {
    it('writes only [subagent].preset and syncs an existing memory overlay', async () => {
      await config.set(SUBAGENT_SECTION, { ...subagentConfigWith(), timeoutMs: 0 }, ConfigTarget.Memory);
      setQuota('provider-balanced', okResult(20));
      setQuota('provider-kimi', okResult(95));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      const userValue = config.inspect<SubagentConfig>(SUBAGENT_SECTION).userValue;
      const memoryValue = config.inspect<SubagentConfig>(SUBAGENT_SECTION).memoryValue;
      expect(userValue).toMatchObject({ preset: 'kimi-heavy', timeoutMs: 3_600_000 });
      expect(memoryValue).toMatchObject({ preset: 'kimi-heavy', timeoutMs: 0 });
      // The effective preset changed, so the next resolve already sees it.
      expect(currentPreset()).toBe('kimi-heavy');
    });

    it('does not report cancellation after the User-layer commit has started', async () => {
      const activation = ix.get(ISubagentPresetActivationService);
      const originalSet = config.set.bind(config);
      let committed!: () => void;
      const userCommitted = new Promise<void>((resolve) => {
        committed = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      config.set = vi.fn(async (domain, patch, target = ConfigTarget.User) => {
        await originalSet(domain, patch, target);
        if (target === ConfigTarget.User) {
          committed();
          await gate;
        }
      });
      const controller = new AbortController();

      const pending = activation.activate('kimi-heavy', controller.signal);
      await userCommitted;
      controller.abort();
      release();
      const result = await pending;

      expect(result.kind).toBe('activated');
      expect(currentPreset()).toBe('kimi-heavy');
    });

    it('reports a committed activation warning when Memory overlay alignment fails', async () => {
      await config.set(
        SUBAGENT_SECTION,
        { ...subagentConfigWith(), timeoutMs: 0 },
        ConfigTarget.Memory,
      );
      const activation = ix.get(ISubagentPresetActivationService);
      const originalSet = config.set.bind(config);
      config.set = vi.fn(async (domain, patch, target = ConfigTarget.User) => {
        if (target === ConfigTarget.Memory) throw new Error('memory write failed');
        await originalSet(domain, patch, target);
      });

      const result = await activation.activate('kimi-heavy');

      expect(result.kind).toBe('activated');
      if (result.kind !== 'activated') throw new Error('expected committed activation');
      expect(result.warning).toContain('Memory overlay');
      expect(config.inspect<SubagentConfig>(SUBAGENT_SECTION).userValue?.preset).toBe(
        'kimi-heavy',
      );
      expect(config.inspect<SubagentConfig>(SUBAGENT_SECTION).memoryValue?.preset).toBe(
        'balanced',
      );
    });

    it('keeps the current preset and logs a sanitized warn when the activation persist fails', async () => {
      config.failWrites = true;
      setQuota('provider-balanced', okResult(20));
      setQuota('provider-kimi', okResult(95));
      const warn = ix.get(ILogService).warn as ReturnType<typeof vi.fn>;

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(result.reason).toContain('failed');
      expect(currentPreset()).toBe('balanced');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(
        'auto subagent preset activation failed; refusing an unverified dispatch',
      );
    });

    it('end-to-end: a positive wallet takes over a depleted plan window only when opted in', async () => {
      quotaResults.set('provider-balanced', {
        kind: 'ok',
        provider: 'x',
        summary: null,
        limits: [{ used: 95, limit: 100 }],
        extraUsage: null,
      });
      quotaResults.set('provider-kimi', {
        kind: 'ok',
        provider: 'x',
        summary: null,
        limits: [],
        extraUsage: {
          balanceCents: 30,
          totalCents: 100,
          monthlyChargeLimitEnabled: false,
          monthlyChargeLimitCents: 0,
          monthlyUsedCents: 0,
          currency: 'USD',
        },
      });

      // Default (allowExtraUsage=false): the kimi wallet never counts → kimi is
      // unknown → balanced stays active even with only 5% left.
      await autoPreset.evaluate(REQUEST, CTX);
      expect(currentPreset()).toBe('balanced');
      const queriedBeforeToggle = usageCalls.length;

      await config.replace(
        SUBAGENT_SECTION,
        subagentConfigWith({ autoPreset: { enabled: true, allowExtraUsage: true } }),
      );

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBe('kimi-heavy');
      expect(usageCalls).toHaveLength(queriedBeforeToggle);
    });
  });

  describe('status and decision fact publishing', () => {
    it('publishes evaluated plus an explained preset_changed fact when a switch commits', async () => {
      setQuota('provider-balanced', okResult(20));
      setQuota('provider-kimi', okResult(95));

      const result = await autoPreset.evaluate(REQUEST, { sessionId: 'session-42' });

      expect(result.activatedPreset).toBe('kimi-heavy');
      expect(result.reasonCode).toBe('current_unhealthy');
      expect(autoPreset.status()).toBe(result.status);
      const changed = publishedEvents.find(
        (event) => event.type === SUBAGENT_PRESET_CHANGED_EVENT_TYPE,
      );
      expect(changed?.payload).toMatchObject({
        sessionId: 'session-42',
        previousPreset: 'balanced',
        currentPreset: 'kimi-heavy',
        reasonCode: 'current_unhealthy',
        profileName: 'explore',
        evaluatedAt: result.status!.evaluatedAt,
        previousScore: result.status!.currentScore,
        currentScore: result.status!.selectedScore,
      });
      const evaluated = publishedEvents.find(
        (event) => event.type === SUBAGENT_PRESET_EVALUATED_EVENT_TYPE,
      );
      expect(evaluated?.payload).toMatchObject({
        ...result.status,
        sessionId: 'session-42',
      });
      expect(publishedEvents).toHaveLength(2);
      // The automatic switch never stamps the manual lock.
      expect(
        resolveSubagentAutoPresetConfig(config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)),
      ).toMatchObject({ enabled: true, manualLock: false });
    });

    it('publishes an evaluated no-op with the candidate breakdown', async () => {
      setQuota('provider-balanced', okResult(90));
      setQuota('provider-kimi', okResult(95));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(result.reasonCode).toBe('current_optimal');
      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0]).toMatchObject({
        type: SUBAGENT_PRESET_EVALUATED_EVENT_TYPE,
        payload: {
          sessionId: 'test-session',
          reasonCode: 'current_optimal',
          currentPreset: 'balanced',
          candidates: result.status!.candidates,
        },
      });
    });

    it('publishes an evaluated early return when cancelled', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await autoPreset.evaluate(REQUEST, {
        sessionId: 'session-42',
        signal: controller.signal,
      });

      expect(result.reasonCode).toBe('cancelled');
      expect(result.status?.candidates).toEqual([]);
      expect(publishedEvents).toEqual([
        {
          type: SUBAGENT_PRESET_EVALUATED_EVENT_TYPE,
          payload: { ...result.status, sessionId: 'session-42' },
        },
      ]);
    });

    it('publishes only a sanitized evaluated fact when preset activation fails', async () => {
      config.failWrites = true;
      setQuota('provider-balanced', okResult(20));
      setQuota('provider-kimi', okResult(95));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(result.reasonCode).toBe('activation_failed');
      expect(currentPreset()).toBe('balanced');
      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0]).toMatchObject({
        type: SUBAGENT_PRESET_EVALUATED_EVENT_TYPE,
        payload: { reasonCode: 'activation_failed' },
      });
      expect(JSON.stringify(publishedEvents)).not.toContain('disk full');
    });

    it('publishes only an evaluated fact when a commit has no effective change', async () => {
      await config.set(SUBAGENT_SECTION, subagentConfigWith(), ConfigTarget.Memory);
      const originalSet = config.set.bind(config);
      config.set = vi.fn(async (domain, patch, target = ConfigTarget.User) => {
        if (target === ConfigTarget.Memory) throw new Error('memory write failed');
        await originalSet(domain, patch, target);
      });
      setQuota('provider-balanced', okResult(20));
      setQuota('provider-kimi', okResult(95));

      const result = await autoPreset.evaluate(REQUEST, CTX);

      expect(result.activatedPreset).toBeUndefined();
      expect(result.reasonCode).toBe('activation_no_effect');
      expect(currentPreset()).toBe('balanced');
      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0]).toMatchObject({
        type: SUBAGENT_PRESET_EVALUATED_EVENT_TYPE,
        payload: { reasonCode: 'activation_no_effect' },
      });
    });
  });
});

describe('AutoSubagentPresetService route model alignment', () => {
  // The candidate's provider comes from the route model resolved for that
  // preset (`resolveSubagentBindingForPreset`), not from the active preset.
  it('aligns providers through the candidate route model', async () => {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const config = new LayeredConfigStub({ subagent: subagentConfigWith() });
    const queries: string[] = [];
    ix.stub(IConfigService, config);
    ix.stub(IFlagService, {
      _serviceBrand: undefined,
      enabled: () => true,
      registry: {
        _serviceBrand: undefined,
        register: () => ({ dispose: () => {} }),
        get: () => undefined,
        list: () => [],
      },
      snapshot: () => ({}),
      enabledIds: () => [],
      explain: () => undefined,
      explainAll: () => [],
      setConfigOverrides: () => {},
    } as unknown as IFlagService);
    ix.stub(IModelCatalog, modelCatalogFor(ROUTES));
    stubScoringRegistries(ix);
    ix.stub(IAgentRunUsageService, new FakeRunUsageService() as unknown as IAgentRunUsageService);
    ix.stub(IProviderUsageService, {
      _serviceBrand: undefined,
      queryUsage: vi.fn(async (providerId?: string) => {
        if (providerId !== undefined) queries.push(providerId);
        return [{ kind: 'error', provider: providerId ?? 'x', message: 'no' }];
      }),
    } as unknown as IProviderUsageService);
    ix.stub(ILogService, {
      _serviceBrand: undefined,
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: () => ({} as ILogService),
      level: 'warn',
      setLevel: () => {},
      flush: async () => {},
    } as unknown as ILogService);
    ix.stub(IHostClock, {
      _serviceBrand: undefined,
      now: () => new Date(),
      timeZone: () => 'UTC',
    });
    ix.stub(IEventService, {
      _serviceBrand: undefined,
      publish: vi.fn(),
      subscribe: () => ({ dispose: () => {} }),
      onDidPublish: () => () => {},
      listenerCount: 0,
    } as unknown as IEventService);
    ix.set(
      ISubagentPresetActivationService,
      new SyncDescriptor(SubagentPresetActivationService),
    );
    ix.set(IAutoSubagentPresetService, new SyncDescriptor(AutoSubagentPresetService));
    const service = ix.get(IAutoSubagentPresetService);

    // Every candidate route resolves to its own provider; the balanced preset
    // (current) and the kimi preset both get queried even though only balanced
    // is active, because scoring reasons about every configured candidate.
    await service.evaluate(REQUEST, { sessionId: 'test-session' });
    expect(queries.toSorted()).toEqual(['provider-balanced', 'provider-deepseek', 'provider-kimi']);
    disposables.dispose();
  });
});
