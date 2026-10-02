/**
 * `providerUsageLedger` tests — the App-scope metered-usage ledger:
 *
 *  - records independent attempt documents and aggregates today/month tokens +
 *    estimated CNY cost via the pure `aggregateMeteredUsage`;
 *  - distinguishes measured / missing-usage / unpriced / pending requests;
 *  - aggregates caller-verified alias groups without losing noncanonical history,
 *    duplicating attempts, or hiding member tracking gaps and degraded reads;
 *  - serializes a finish write after its start write and recovers records
 *    across instances sharing one store (restart);
 *  - only accepts formal UUID keys (skipping atomic-write tmp leftovers) and
 *    runtime-validates every document, degrading instead of throwing;
 *  - persists a real tracking start in per-writer metadata and resets it on a
 *    detected flag-off gap;
 *  - degrades (rather than failing) on a persistence or pricing error;
 *  - no-ops when the feature flag is off or the base URL is not an official
 *    DeepSeek endpoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import type { LocalMeteredUsage } from '#/app/providerUsage/meteredUsage';
import {
  IProviderUsageLedgerService,
  type MeteredAttemptStart,
} from '#/app/providerUsageLedger/providerUsageLedger';
import {
  aggregateMeteredUsage,
  type AttemptRecord,
  ProviderUsageLedgerService,
} from '#/app/providerUsageLedger/providerUsageLedgerService';
import type { TokenUsage } from '#/kosong/contract/usage';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import {
  IAtomicDocumentStore,
} from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubFlag } from '../flag/stubs';

const DEEPSEEK_BASE = 'https://api.deepseek.com';

function usageOf(inputOther: number, output: number, inputCacheRead: number): TokenUsage {
  return { inputOther, output, inputCacheRead, inputCacheCreation: 0 };
}

function start(overrides: Partial<MeteredAttemptStart> = {}): MeteredAttemptStart {
  return {
    providerName: 'deepseek',
    providerType: 'deepseek',
    modelName: 'deepseek-v4-pro',
    modelAlias: 'deepseek/deepseek-v4-pro',
    baseUrl: DEEPSEEK_BASE,
    startedAtEpochMs: Date.now(),
    ...overrides,
  };
}

function mutableFlag(initial: boolean): { flags: IFlagService; set: (value: boolean) => void } {
  let value = initial;
  return {
    flags: stubFlag(() => value),
    set: (next: boolean) => {
      value = next;
    },
  };
}

class MapAtomicDocs implements IAtomicDocumentStore {
  declare readonly _serviceBrand: undefined;

  readonly data = new Map<string, Map<string, unknown>>();
  readonly setCalls: Array<{ scope: string; key: string; value: unknown }> = [];
  deferSet = false;
  deferFirstTrackingSet = false;
  private firstTrackingDeferred = false;
  private firstTrackingResolve: (() => void) | undefined;
  private readonly pendingResolvers: Array<() => void> = [];

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    this.setCalls.push({ scope, key, value });
    if (this.deferSet) {
      return new Promise<void>((resolve) => {
        this.pendingResolvers.push(resolve);
      });
    }
    if (this.deferFirstTrackingSet && scope.includes('/_tracking/') && !this.firstTrackingDeferred) {
      this.firstTrackingDeferred = true;
      return new Promise<void>((resolve) => {
        this.firstTrackingResolve = resolve;
      });
    }
    this.store(scope, key, value);
  }

  releaseFirstTrackingSet(): void {
    this.firstTrackingResolve?.();
    this.firstTrackingResolve = undefined;
    const first = this.setCalls.find((call) => call.scope.includes('/_tracking/'));
    if (first !== undefined) this.store(first.scope, first.key, first.value);
  }

  resolveAll(): void {
    for (const resolve of this.pendingResolvers.splice(0)) resolve();
    for (const call of this.setCalls) this.store(call.scope, call.key, call.value);
  }

  private store(scope: string, key: string, value: unknown): void {
    let bucket = this.data.get(scope);
    if (bucket === undefined) {
      bucket = new Map();
      this.data.set(scope, bucket);
    }
    bucket.set(key, value);
  }

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    return this.data.get(scope)?.get(key) as T | undefined;
  }

  async list(scope: string): Promise<readonly string[]> {
    return [...(this.data.get(scope)?.keys() ?? [])];
  }

  async delete(scope: string, key: string): Promise<void> {
    this.data.get(scope)?.delete(key);
  }

  watch(): () => { dispose: () => void } {
    return () => ({ dispose: () => {} });
  }

  acquire(): { dispose: () => void } {
    return { dispose: () => {} };
  }
}

function createLedger(
  opts: {
    flags?: IFlagService;
    store?: InMemoryStorageService;
    atomicDocs?: IAtomicDocumentStore;
  } = {},
): { ledger: IProviderUsageLedgerService; atomicDocs: IAtomicDocumentStore; dispose: () => void } {
  const disposables = new DisposableStore();
  const ix = disposables.add(new TestInstantiationService());
  const store = opts.store ?? new InMemoryStorageService();
  ix.set(IFileSystemStorageService, store);
  if (opts.atomicDocs !== undefined) {
    ix.set(IAtomicDocumentStore, opts.atomicDocs);
  } else {
    ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
  }
  ix.set(IBootstrapService, stubBootstrap());
  ix.stub(IFlagService, opts.flags ?? stubFlag(true));
  ix.set(IProviderUsageLedgerService, new SyncDescriptor(ProviderUsageLedgerService));
  return {
    ledger: ix.get(IProviderUsageLedgerService),
    atomicDocs: ix.get(IAtomicDocumentStore),
    dispose: () => disposables.dispose(),
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const MONTH_SCOPE = 'store/providerUsageLedger/2026-09';
const TRACKING_SCOPE = 'store/providerUsageLedger/_tracking/deepseek';
const TRACKING_KEY = 'start';
const T1 = Date.UTC(2026, 8, 1, 12, 0, 0);
const T2 = Date.UTC(2026, 8, 7, 12, 0, 0);

function withClock(initial = T2): { set: (epochMs: number) => void } {
  let now = initial;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    set: (epochMs: number) => {
      now = epochMs;
    },
  };
}

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

function shanghaiEpoch(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS;
}

// 2026-09-09 and 2026-09-10 are a Wednesday and a Thursday; 10:00 is peak.
const SEP9_PEAK = shanghaiEpoch(2026, 9, 9, 10, 0);
const SEP10_PEAK = shanghaiEpoch(2026, 9, 10, 10, 0);
const SEP10_OFF_PEAK = shanghaiEpoch(2026, 9, 10, 20, 0);
const SEP10_DAY_START = shanghaiEpoch(2026, 9, 10, 0, 0);
const SEP1_DAY_START = shanghaiEpoch(2026, 9, 1, 0, 0);

function seedAttempt(
  store: MapAtomicDocs,
  startedAtEpochMs: number,
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord {
  const record: AttemptRecord = {
    attemptId: crypto.randomUUID(),
    providerName: 'deepseek',
    modelName: 'deepseek-v4-pro',
    modelAlias: 'deepseek/deepseek-v4-pro',
    startedAtEpochMs,
    outcome: 'success',
    usage: usageOf(0, 1_000_000, 0),
    pricingVersion: null,
    costNanos: null,
    ...overrides,
  };
  const bucket = store.data.get(MONTH_SCOPE) ?? new Map<string, unknown>();
  bucket.set(record.attemptId, record);
  store.data.set(MONTH_SCOPE, bucket);
  return record;
}

function seedTracking(
  store: MapAtomicDocs,
  trackingStartedAtEpochMs: number,
  gapTimes: readonly number[] = [],
): void {
  const bucket = new Map<string, unknown>([
    [TRACKING_KEY, { providerName: 'deepseek', trackingStartedAtEpochMs }],
  ]);
  for (const time of gapTimes) {
    bucket.set(crypto.randomUUID(), {
      providerName: 'deepseek',
      trackingStartedAtEpochMs: time,
      gap: true,
    });
  }
  store.data.set(TRACKING_SCOPE, bucket);
}

describe('ProviderUsageLedgerService', () => {
  let disposables: DisposableStore;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => {
    disposables.dispose();
    vi.restoreAllMocks();
  });

  it('keeps usage and missing-price evidence from an alias other than the canonical query provider', async () => {
    withClock(T2);
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    const id = host.ledger.startAttempt(start({ providerName: 'z-used', modelName: 'unknown-model' }));
    host.ledger.finishAttempt(id!, { usage: usageOf(10, 20, 0), outcome: 'success' });

    const report = await host.ledger.getMeteredUsage(['a-unused', 'z-used']);
    expect(report.trackingStartedAt).toBe(new Date(T2).toISOString());
    expect(report.degraded).toBe(false);
    for (const period of [report.today, report.month]) {
      expect(period).toMatchObject({
        requestCount: 1, measuredRequestCount: 1, totalTokens: 30,
        unpricedRequestCount: 1, estimatedCost: null, isPartial: true,
      });
    }
    expect((await host.ledger.getMeteredUsage('a-unused')).month.requestCount).toBe(0);
  });

  it('counts each real attempt once across aliases, repeated names and duplicate storage listing keys', async () => {
    withClock(T2);
    const store = new InMemoryStorageService();
    const writer = createLedger({ store });
    disposables.add({ dispose: writer.dispose });
    const first = writer.ledger.startAttempt(start({ providerName: 'a-used', modelName: 'unknown-model' }));
    const second = writer.ledger.startAttempt(start({ providerName: 'z-used', modelName: 'unknown-model' }));
    const outside = writer.ledger.startAttempt(start({ providerName: 'outside', modelName: 'unknown-model' }));
    writer.ledger.finishAttempt(first!, { usage: usageOf(10, 20, 0), outcome: 'success' });
    writer.ledger.finishAttempt(first!, { usage: usageOf(100, 200, 0), outcome: 'success' });
    writer.ledger.finishAttempt(second!, { usage: usageOf(3, 4, 5), outcome: 'success' });
    writer.ledger.finishAttempt(outside!, { usage: usageOf(100, 200, 0), outcome: 'success' });
    await writer.ledger.getMeteredUsage(['a-used', 'z-used']);
    const restored = createLedger({ store });
    disposables.add({ dispose: restored.dispose });
    const list = restored.atomicDocs.list.bind(restored.atomicDocs);
    vi.spyOn(restored.atomicDocs, 'list').mockImplementation(async (scope) => {
      const keys = await list(scope);
      return scope === MONTH_SCOPE ? [...keys, ...keys] : keys;
    });

    const report = await restored.ledger.getMeteredUsage(['z-used', 'a-used', 'z-used']);
    expect(report.month).toMatchObject({
      requestCount: 2, measuredRequestCount: 2, inputTokens: 18, outputTokens: 24,
      cacheReadTokens: 5, totalTokens: 42, unpricedRequestCount: 2, estimatedCost: null,
    });
    expect(report.degraded).toBe(false);
    expect(await restored.ledger.getMeteredUsage(['a-used', 'z-used'])).toEqual(report);
    expect(await restored.ledger.getMeteredUsage(['a-used'])).toEqual(await restored.ledger.getMeteredUsage('a-used'));
  });

  it('propagates pending and missing-usage attempts across all requested aliases', async () => {
    withClock(T2);
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    host.ledger.startAttempt(start({ providerName: 'pending' }));
    const missing = host.ledger.startAttempt(start({ providerName: 'missing' }));
    host.ledger.finishAttempt(missing!, { usage: null, outcome: 'error' });
    const measured = host.ledger.startAttempt(start({ providerName: 'measured', modelName: 'unknown-model' }));
    host.ledger.finishAttempt(measured!, { usage: usageOf(10, 20, 0), outcome: 'success' });

    const report = await host.ledger.getMeteredUsage(['pending', 'missing', 'measured']);
    expect(report.month).toMatchObject({
      requestCount: 3, measuredRequestCount: 1, pendingRequestCount: 1,
      missingUsageRequestCount: 1, unpricedRequestCount: 1, totalTokens: 30,
      estimatedCost: null, isPartial: true,
    });
  });

  it('retains known tracking history but marks a group partial when an unused alias has no coverage', async () => {
    withClock(T2);
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    const lastMonth = Date.UTC(2026, 7, 20);
    const id = host.ledger.startAttempt(start({ providerName: 'z-used', startedAtEpochMs: lastMonth }));
    host.ledger.finishAttempt(id!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    expect((await host.ledger.getMeteredUsage('z-used')).month.isPartial).toBe(false);

    const report = await host.ledger.getMeteredUsage(['a-unused', 'z-used']);
    expect(report.trackingStartedAt).toBe(new Date(lastMonth).toISOString());
    expect(report.today.isPartial).toBe(true);
    expect(report.month.isPartial).toBe(true);
    expect(report.degraded).toBe(false);
  });

  it('uses the latest known member tracking start without discarding older member records', async () => {
    const clock = withClock(T1);
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    const first = host.ledger.startAttempt(start({ providerName: 'a-used' }));
    host.ledger.finishAttempt(first!, { usage: usageOf(10, 20, 0), outcome: 'success' });
    clock.set(T2);
    const second = host.ledger.startAttempt(start({ providerName: 'z-used' }));
    host.ledger.finishAttempt(second!, { usage: usageOf(1, 2, 0), outcome: 'success' });
    const report = await host.ledger.getMeteredUsage(['a-used', 'z-used']);
    expect(report.trackingStartedAt).toBe(new Date(T2).toISOString());
    expect(report.month.totalTokens).toBe(33);
    expect(report.today.totalTokens).toBe(3);
    expect(report.today.isPartial).toBe(true);
  });

  it('preserves a noncanonical member\'s tracking gap after restoring the ledger', async () => {
    const clock = withClock(T1);
    const store = new InMemoryStorageService();
    const flag = mutableFlag(true);
    const host = createLedger({ store, flags: flag.flags });
    disposables.add({ dispose: host.dispose });
    for (const providerName of ['a-used', 'z-used']) {
      const id = host.ledger.startAttempt(start({ providerName }));
      host.ledger.finishAttempt(id!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    }
    await host.ledger.getMeteredUsage(['a-used', 'z-used']);
    clock.set(T2);
    expect((await host.ledger.getMeteredUsage(['a-used', 'z-used'])).today.isPartial).toBe(false);
    flag.set(false);
    expect(host.ledger.startAttempt(start({ providerName: 'z-used' }))).toBeUndefined();
    await host.ledger.getMeteredUsage('z-used');
    const restored = createLedger({ store });
    disposables.add({ dispose: restored.dispose });
    expect((await restored.ledger.getMeteredUsage('a-used')).today.isPartial).toBe(false);
    const report = await restored.ledger.getMeteredUsage(['a-used', 'z-used']);
    expect(report.today.isPartial).toBe(true);
    expect(report.degraded).toBe(false);
  });

  it('preserves another alias\'s records when one member\'s tracking metadata cannot be read', async () => {
    withClock(T2);
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    const id = host.ledger.startAttempt(start({ providerName: 'z-used', modelName: 'unknown-model' }));
    host.ledger.finishAttempt(id!, { usage: usageOf(10, 20, 0), outcome: 'success' });
    const list = host.atomicDocs.list.bind(host.atomicDocs);
    vi.spyOn(host.atomicDocs, 'list').mockImplementation(async (scope) => {
      if (scope.endsWith('/_tracking/a-unused')) throw new Error('tracking unavailable');
      return list(scope);
    });
    const report = await host.ledger.getMeteredUsage(['a-unused', 'z-used']);
    expect(report.degraded).toBe(true);
    expect(report.trackingStartedAt).toBe(new Date(T2).toISOString());
    expect(report.month).toMatchObject({ requestCount: 1, totalTokens: 30, estimatedCost: null, isPartial: true });
  });

  it('records a measured attempt and aggregates today/month cost', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 12, 0, 0));
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    const id = host.ledger.startAttempt(start());
    expect(id).toBeTypeOf('string');
    host.ledger.finishAttempt(id!, { usage: usageOf(1000, 500, 200), outcome: 'success' });
    await flush();

    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.source).toBe('local');
    expect(metered.currency).toBe('CNY');
    expect(metered.today.requestCount).toBe(1);
    expect(metered.today.measuredRequestCount).toBe(1);
    expect(metered.today.inputTokens).toBe(1200);
    expect(metered.today.outputTokens).toBe(500);
    expect(metered.today.cacheReadTokens).toBe(200);
    expect(metered.today.totalTokens).toBe(1700);
    expect(metered.today.estimatedCost).toBeTypeOf('string');
  });

  it('snapshots only token counters and does not persist caller-owned extra fields', async () => {
    withClock(T2);
    const store = new MapAtomicDocs();
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });
    const id = host.ledger.startAttempt(start());
    const usage = { ...usageOf(1, 2, 3), apiKey: 'test-credential-marker' };
    host.ledger.finishAttempt(id!, { usage, outcome: 'success' });
    usage.output = 999;
    expect((await host.ledger.getMeteredUsage('deepseek')).today.totalTokens).toBe(6);
    const record = await store.get<AttemptRecord>(MONTH_SCOPE, id!);
    expect(record?.usage).toEqual(usageOf(1, 2, 3));
    expect(JSON.stringify(record)).not.toContain('test-credential-marker');
  });

  it('does not treat invalid caller counters as a measured zero-cost request', async () => {
    withClock(T2);
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    const id = host.ledger.startAttempt(start());
    host.ledger.finishAttempt(id!, { usage: usageOf(Number.NaN, 2, 3), outcome: 'success' });
    const report = await host.ledger.getMeteredUsage('deepseek');
    expect(report.degraded).toBe(true);
    expect(report.today.measuredRequestCount).toBe(0);
    expect(report.today.missingUsageRequestCount).toBe(1);
    expect(report.today.estimatedCost).toBeNull();
  });

  it('distinguishes missing usage from zero usage', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 12, 0, 0));
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    const id = host.ledger.startAttempt(start());
    host.ledger.finishAttempt(id!, { usage: null, outcome: 'error' });
    await flush();

    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.today.requestCount).toBe(1);
    expect(metered.today.measuredRequestCount).toBe(0);
    expect(metered.today.missingUsageRequestCount).toBe(1);
    expect(metered.today.isPartial).toBe(true);
  });

  it('marks an unknown model unpriced without inventing a cost', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 12, 0, 0));
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    const id = host.ledger.startAttempt(start({ modelName: 'deepseek-chat' }));
    host.ledger.finishAttempt(id!, { usage: usageOf(100, 50, 0), outcome: 'success' });
    await flush();

    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.today.measuredRequestCount).toBe(1);
    expect(metered.today.unpricedRequestCount).toBe(1);
    expect(metered.today.estimatedCost).toBeNull();
    expect(metered.today.isPartial).toBe(true);
  });

  it('keeps a started-but-unfinished attempt pending', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 12, 0, 0));
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    host.ledger.startAttempt(start());
    await flush();

    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.today.requestCount).toBe(1);
    expect(metered.today.pendingRequestCount).toBe(1);
    expect(metered.today.isPartial).toBe(true);
  });

  it('does not double-count a repeated finish', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 12, 0, 0));
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    const id = host.ledger.startAttempt(start());
    host.ledger.finishAttempt(id!, { usage: usageOf(100, 50, 0), outcome: 'success' });
    host.ledger.finishAttempt(id!, { usage: usageOf(100, 50, 0), outcome: 'success' });
    await flush();

    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.today.requestCount).toBe(1);
  });

  it('serializes the finish write after the start write resolves', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 12, 0, 0));
    const store = new MapAtomicDocs();
    store.deferSet = true;
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });

    const attemptWrites = (): Array<{ scope: string; key: string }> =>
      store.setCalls.filter((call) => call.scope === MONTH_SCOPE);

    const id = host.ledger.startAttempt(start());
    host.ledger.finishAttempt(id!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    await flush();
    expect(attemptWrites()).toHaveLength(1);

    store.deferSet = false;
    store.resolveAll();
    await flush();
    expect(attemptWrites()).toHaveLength(2);
    expect(attemptWrites()[1]).toMatchObject({ key: id, value: { outcome: 'success' } });
    const rebuilt = createLedger({ atomicDocs: store });
    disposables.add({ dispose: rebuilt.dispose });
    expect((await rebuilt.ledger.getMeteredUsage('deepseek')).today.measuredRequestCount).toBe(1);
  });

  it('waits for already queued writes before returning a usage snapshot', async () => {
    withClock(T2);
    const store = new MapAtomicDocs();
    store.deferSet = true;
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });
    const id = host.ledger.startAttempt(start());
    host.ledger.finishAttempt(id!, { usage: usageOf(10, 3, 20), outcome: 'success' });
    let snapshot: LocalMeteredUsage | undefined;
    const reading = host.ledger.getMeteredUsage('deepseek').then((value) => { snapshot = value; });
    try {
      await flush();
      expect(snapshot).toBeUndefined();
    } finally {
      store.deferSet = false;
      store.resolveAll();
      await reading;
    }
    expect(snapshot?.today).toMatchObject({
      measuredRequestCount: 1, inputTokens: 30, outputTokens: 3, cacheReadTokens: 20, totalTokens: 33,
    });
  });

  it('drains queued writes on disposal without delaying finishAttempt', async () => {
    withClock(T2);
    const store = new MapAtomicDocs();
    store.deferSet = true;
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });
    const id = host.ledger.startAttempt(start());
    host.ledger.finishAttempt(id!, { usage: usageOf(2, 3, 1), outcome: 'success' });
    let closed = false;
    const closing = (host.ledger as ProviderUsageLedgerService).dispose().then(() => { closed = true; });
    try {
      await flush();
      expect(closed).toBe(false);
      expect(host.ledger.startAttempt(start())).toBeUndefined();
    } finally {
      store.deferSet = false;
      store.resolveAll();
      await closing;
    }
    const rebuilt = createLedger({ atomicDocs: store });
    disposables.add({ dispose: rebuilt.dispose });
    expect((await rebuilt.ledger.getMeteredUsage('deepseek')).today.totalTokens).toBe(6);
  });

  it('keeps a newer coverage reset when another writer finishes an older metadata write', async () => {
    const clock = withClock(T1);
    const store = new MapAtomicDocs();
    store.deferFirstTrackingSet = true;
    const first = createLedger({ atomicDocs: store });
    disposables.add({ dispose: first.dispose });
    const firstId = first.ledger.startAttempt(start());
    first.ledger.finishAttempt(firstId!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    await flush();

    const flag = mutableFlag(true);
    const second = createLedger({ atomicDocs: store, flags: flag.flags });
    disposables.add({ dispose: second.dispose });
    const secondId = second.ledger.startAttempt(start());
    second.ledger.finishAttempt(secondId!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    flag.set(false);
    second.ledger.startAttempt(start());
    clock.set(T2);
    flag.set(true);
    const resumedId = second.ledger.startAttempt(start());
    second.ledger.finishAttempt(resumedId!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    expect((await second.ledger.getMeteredUsage('deepseek')).trackingStartedAt).toBe(new Date(T2).toISOString());

    store.releaseFirstTrackingSet();
    await first.ledger.getMeteredUsage('deepseek');
    const rebuilt = createLedger({ atomicDocs: store });
    disposables.add({ dispose: rebuilt.dispose });
    const report = await rebuilt.ledger.getMeteredUsage('deepseek');
    expect(report.trackingStartedAt).toBe(new Date(T2).toISOString());
    expect(report.today.isPartial).toBe(true);
  });

  it('recovers records across instances sharing one store', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 12, 0, 0));
    const store = new InMemoryStorageService();
    const first = createLedger({ store });
    const id = first.ledger.startAttempt(start());
    first.ledger.finishAttempt(id!, { usage: usageOf(10, 20, 0), outcome: 'success' });
    await flush();
    first.dispose();

    const second = createLedger({ store });
    disposables.add({ dispose: second.dispose });
    const metered = await second.ledger.getMeteredUsage('deepseek');
    expect(metered.today.requestCount).toBe(1);
    expect(metered.today.outputTokens).toBe(20);
  });

  it('skips tmp files and only counts formal UUID keys with a matching attemptId', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 12, 0, 0));
    const store = new MapAtomicDocs();
    const uuid = crypto.randomUUID();
    const good: AttemptRecord = {
      attemptId: uuid,
      providerName: 'deepseek',
      modelName: 'deepseek-v4-pro',
      modelAlias: 'deepseek/deepseek-v4-pro',
      startedAtEpochMs: Date.now(),
      outcome: 'success',
      usage: usageOf(5, 6, 0),
      pricingVersion: '2026-09-07',
      costNanos: '0',
    };
    store.data.set(MONTH_SCOPE, new Map());
    store.data.get(MONTH_SCOPE)!.set(uuid, good);
    store.data.get(MONTH_SCOPE)!.set(`${uuid}.tmp.123.abc`, { ...good, attemptId: uuid });
    store.data
      .get(MONTH_SCOPE)!
      .set(crypto.randomUUID(), { ...good, attemptId: 'mismatched-attempt-id' });

    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });
    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.today.requestCount).toBe(1);
    expect(metered.today.outputTokens).toBe(6);
    expect(metered.degraded).toBe(true);
  });

  it('skips a JSON-null document and still returns a metered result', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 12, 0, 0));
    const store = new MapAtomicDocs();
    store.data.set(MONTH_SCOPE, new Map([[crypto.randomUUID(), null]]));
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });
    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.today.requestCount).toBe(0);
    expect(metered.degraded).toBe(true);
  });

  it('skips a record with an invalid costNanos and marks degraded', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 12, 0, 0));
    const store = new MapAtomicDocs();
    const uuid = crypto.randomUUID();
    store.data.set(MONTH_SCOPE, new Map([[uuid, {
      attemptId: uuid,
      providerName: 'deepseek',
      modelName: 'deepseek-v4-pro',
      modelAlias: 'deepseek/deepseek-v4-pro',
      startedAtEpochMs: Date.now(),
      outcome: 'success',
      usage: usageOf(1, 1, 0),
      pricingVersion: '2026-09-07',
      costNanos: 'not-a-number',
    }]]));
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });
    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.today.requestCount).toBe(0);
    expect(metered.degraded).toBe(true);
  });

  it('persists a tracking start across a month boundary', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(T2);
    const store = new MapAtomicDocs();
    const lastMonth = Date.UTC(2026, 7, 20, 0, 0, 0);
    store.data.set(TRACKING_SCOPE, new Map([[TRACKING_KEY, {
      providerName: 'deepseek',
      trackingStartedAtEpochMs: lastMonth,
    }]]));
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });
    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.trackingStartedAt).toBe(new Date(lastMonth).toISOString());
    expect(metered.month.isPartial).toBe(false);
  });

  it('resets the tracking start when the flag is toggled off and back on', async () => {
    const clock = withClock(T1);
    const flag = mutableFlag(true);
    const host = createLedger({ flags: flag.flags });
    disposables.add({ dispose: host.dispose });

    const first = host.ledger.startAttempt(start({ startedAtEpochMs: T1 }));
    host.ledger.finishAttempt(first!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    await flush();

    flag.set(false);
    expect(host.ledger.startAttempt(start({ startedAtEpochMs: T1 }))).toBeUndefined();
    flag.set(true);
    clock.set(T2);
    const second = host.ledger.startAttempt(start({ startedAtEpochMs: T2 }));
    host.ledger.finishAttempt(second!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    await flush();

    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.trackingStartedAt).toBe(new Date(T2).toISOString());
    expect(metered.today.isPartial).toBe(true);
  });

  it('does not let a non-target request consume a provider pending gap', async () => {
    const clock = withClock(T1);
    const flag = mutableFlag(true);
    const host = createLedger({ flags: flag.flags });
    disposables.add({ dispose: host.dispose });

    const first = host.ledger.startAttempt(start({ startedAtEpochMs: T1 }));
    host.ledger.finishAttempt(first!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    await flush();

    flag.set(false);
    expect(host.ledger.startAttempt(start({ startedAtEpochMs: T1 }))).toBeUndefined();
    flag.set(true);

    expect(
      host.ledger.startAttempt(start({ baseUrl: 'https://example.com/v1', startedAtEpochMs: T2 })),
    ).toBeUndefined();

    clock.set(T2);
    const second = host.ledger.startAttempt(start({ startedAtEpochMs: T2 }));
    host.ledger.finishAttempt(second!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    await flush();

    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.trackingStartedAt).toBe(new Date(T2).toISOString());
  });

  it('initializes and restores two official providers independently', async () => {
    const clock = withClock(T1);
    const flag = mutableFlag(true);
    const host = createLedger({ flags: flag.flags });
    disposables.add({ dispose: host.dispose });

    host.ledger.startAttempt(start({ providerName: 'ds-a', startedAtEpochMs: T1 }));
    host.ledger.startAttempt(start({ providerName: 'ds-b', startedAtEpochMs: T1 }));
    await flush();

    flag.set(false);
    host.ledger.startAttempt(start({ providerName: 'ds-a', startedAtEpochMs: T1 }));
    flag.set(true);
    host.ledger.startAttempt(start({ providerName: 'ds-b', startedAtEpochMs: T1 }));
    clock.set(T2);
    host.ledger.startAttempt(start({ providerName: 'ds-a', startedAtEpochMs: T2 }));
    await flush();

    const meteredA = await host.ledger.getMeteredUsage('ds-a');
    const meteredB = await host.ledger.getMeteredUsage('ds-b');
    expect(meteredA.trackingStartedAt).toBe(new Date(T2).toISOString());
    expect(meteredB.trackingStartedAt).toBe(new Date(T1).toISOString());
  });

  it('serializes tracking writes so a late initial write cannot regress the restore', async () => {
    const clock = withClock(T1);
    const flag = mutableFlag(true);
    const store = new MapAtomicDocs();
    store.deferFirstTrackingSet = true;
    const host = createLedger({ flags: flag.flags, atomicDocs: store });
    disposables.add({ dispose: host.dispose });

    const first = host.ledger.startAttempt(start({ startedAtEpochMs: T1 }));
    host.ledger.finishAttempt(first!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    flag.set(false);
    host.ledger.startAttempt(start({ startedAtEpochMs: T1 }));
    flag.set(true);
    clock.set(T2);
    const second = host.ledger.startAttempt(start({ startedAtEpochMs: T2 }));
    host.ledger.finishAttempt(second!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    await flush();

    const trackingSets = store.setCalls.filter((call) => call.scope === TRACKING_SCOPE);
    expect(trackingSets).toHaveLength(1);

    store.releaseFirstTrackingSet();
    await flush();

    const rebuilt = createLedger({ atomicDocs: store });
    disposables.add({ dispose: rebuilt.dispose });
    const metered = await rebuilt.ledger.getMeteredUsage('deepseek');
    expect(metered.trackingStartedAt).toBe(new Date(T2).toISOString());
  });

  it('inherits the persisted tracking start across a restart', async () => {
    const clock = withClock(T1);
    const store = new InMemoryStorageService();
    const first = createLedger({ store });
    const id = first.ledger.startAttempt(start({ startedAtEpochMs: T1 }));
    first.ledger.finishAttempt(id!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    await flush();
    first.dispose();

    clock.set(T2);
    const second = createLedger({ store });
    disposables.add({ dispose: second.dispose });

    const before = await second.ledger.getMeteredUsage('deepseek');
    expect(before.trackingStartedAt).toBe(new Date(T1).toISOString());

    const id2 = second.ledger.startAttempt(start({ startedAtEpochMs: T2 }));
    second.ledger.finishAttempt(id2!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    await flush();

    const after = await second.ledger.getMeteredUsage('deepseek');
    expect(after.trackingStartedAt).toBe(new Date(T1).toISOString());
  });

  it('preserves an observed disabled gap across normal disposal and restart', async () => {
    const clock = withClock(T1);
    const store = new InMemoryStorageService();
    const flag = mutableFlag(true);
    const first = createLedger({ store, flags: flag.flags });
    disposables.add({ dispose: first.dispose });
    const id = first.ledger.startAttempt(start());
    first.ledger.finishAttempt(id!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    clock.set(T2);
    flag.set(false);
    expect(first.ledger.startAttempt(start())).toBeUndefined();
    await (first.ledger as ProviderUsageLedgerService).dispose();

    clock.set(T2 + 60_000);
    const restored = createLedger({ store });
    disposables.add({ dispose: restored.dispose });
    expect((await restored.ledger.getMeteredUsage('deepseek')).today.isPartial).toBe(true);
    const resumedId = restored.ledger.startAttempt(start());
    restored.ledger.finishAttempt(resumedId!, { usage: usageOf(2, 3, 0), outcome: 'success' });
    const report = await restored.ledger.getMeteredUsage('deepseek');
    expect(report.degraded).toBe(false);
    expect(report.today.isPartial).toBe(true);
    expect(report.month.isPartial).toBe(true);
    expect(report.today.measuredRequestCount).toBe(1);
    expect(report.today.totalTokens).toBe(5);
  });

  it('records gaps on later days when another writer remains disabled', async () => {
    const clock = withClock(T1);
    const store = new InMemoryStorageService();
    const active = createLedger({ store });
    disposables.add({ dispose: active.dispose });
    const first = active.ledger.startAttempt(start());
    active.ledger.finishAttempt(first!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    await active.ledger.getMeteredUsage('deepseek');
    const disabled = createLedger({ store, flags: stubFlag(false) });
    disposables.add({ dispose: disabled.dispose });
    for (const time of [T2, T2 + 86_400_000]) {
      clock.set(time);
      expect(disabled.ledger.startAttempt(start())).toBeUndefined();
      await disabled.ledger.getMeteredUsage('deepseek');
      const id = active.ledger.startAttempt(start());
      active.ledger.finishAttempt(id!, { usage: usageOf(1, 1, 0), outcome: 'success' });
      expect((await active.ledger.getMeteredUsage('deepseek')).today.isPartial).toBe(true);
    }
  });

  it('reports a null tracking start with no prior request', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(T2);
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.trackingStartedAt).toBeNull();
    expect(metered.month.isPartial).toBe(true);
  });

  it('does not backdate the current price snapshot onto earlier requests', async () => {
    withClock(T1);
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    const id = host.ledger.startAttempt(start());
    host.ledger.finishAttempt(id!, { usage: usageOf(1, 2, 3), outcome: 'success' });
    const report = await host.ledger.getMeteredUsage('deepseek');
    expect(report.today.totalTokens).toBe(6);
    expect(report.today.unpricedRequestCount).toBe(1);
    expect(report.today.estimatedCost).toBeNull();
    expect(report.today.isPartial).toBe(true);
  });

  it('treats a prototype-key model name as unpriced without throwing', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 12, 0, 0));
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    for (const name of ['constructor', 'toString', '__proto__']) {
      const id = host.ledger.startAttempt(start({ modelName: name }));
      expect(id).toBeTypeOf('string');
      expect(() => host.ledger.finishAttempt(id!, { usage: usageOf(1, 1, 0), outcome: 'success' })).not.toThrow();
    }
    await flush();
    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.today.requestCount).toBe(3);
    expect(metered.today.unpricedRequestCount).toBe(3);
  });

  it('degrades rather than failing when persistence throws', async () => {
    const failingDocs: IAtomicDocumentStore = {
      _serviceBrand: undefined,
      get: async () => undefined,
      set: async () => {
        throw new Error('write failed');
      },
      delete: async () => {},
      list: async () => [],
      watch: () => () => ({ dispose: () => {} }),
      acquire: () => ({ dispose: () => {} }),
    };
    const host = createLedger({ atomicDocs: failingDocs });
    disposables.add({ dispose: host.dispose });
    const id = host.ledger.startAttempt(start());
    host.ledger.finishAttempt(id!, { usage: usageOf(1, 1, 0), outcome: 'success' });
    await flush();
    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.degraded).toBe(true);
  });

  it('does not record when the feature flag is off', async () => {
    const host = createLedger({ flags: stubFlag(false) });
    disposables.add({ dispose: host.dispose });
    expect(host.ledger.startAttempt(start())).toBeUndefined();
    await flush();
    const metered = await host.ledger.getMeteredUsage('deepseek');
    expect(metered.today.requestCount).toBe(0);
  });

  it('does not record a non-official DeepSeek base URL', async () => {
    const host = createLedger();
    disposables.add({ dispose: host.dispose });
    expect(host.ledger.startAttempt(start({ baseUrl: 'https://example.com/v1' }))).toBeUndefined();
  });

  it('prices the new deepseek-flash wire model on the write path', async () => {
    withClock(SEP10_PEAK);
    const store = new MapAtomicDocs();
    seedTracking(store, SEP10_DAY_START);
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });

    const id = host.ledger.startAttempt(start({
      modelName: 'deepseek-flash',
      modelAlias: 'deepseek/deepseek-flash',
      startedAtEpochMs: SEP10_PEAK,
    }));
    host.ledger.finishAttempt(id!, { usage: usageOf(0, 1_000_000, 0), outcome: 'success' });

    const report = await host.ledger.getMeteredUsage('deepseek');
    expect(report.today.measuredRequestCount).toBe(1);
    expect(report.today.unpricedRequestCount).toBe(0);
    expect(report.today.estimatedCost).toBe('8');
    expect(report.today.isPartial).toBe(false);
    const record = await store.get<AttemptRecord>(MONTH_SCOPE, id!);
    expect(record?.pricingVersion).toBe('2026-09-10');
    expect(record?.costNanos).toBe('8000000000');
  });

  it('prices deepseek-flash at the exact peak and off-peak V4.1 rates', async () => {
    withClock(SEP10_OFF_PEAK);
    const store = new MapAtomicDocs();
    seedTracking(store, SEP10_DAY_START);
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });

    for (const startedAtEpochMs of [SEP10_PEAK, SEP10_OFF_PEAK]) {
      const id = host.ledger.startAttempt(start({ modelName: 'deepseek-flash', startedAtEpochMs }));
      host.ledger.finishAttempt(id!, { usage: usageOf(0, 1_000_000, 0), outcome: 'success' });
    }

    const report = await host.ledger.getMeteredUsage('deepseek');
    expect(report.today.measuredRequestCount).toBe(2);
    expect(report.today.unpricedRequestCount).toBe(0);
    expect(report.today.estimatedCost).toBe('12');
  });

  it('prices legacy flash names by request date and leaves deepseek-flash unpriced before its release', async () => {
    withClock(SEP10_PEAK);
    const store = new MapAtomicDocs();
    seedTracking(store, SEP1_DAY_START);
    seedAttempt(store, SEP9_PEAK, {
      modelName: 'deepseek-v4-flash',
      pricingVersion: '2026-09-07',
      costNanos: '9000000000',
    });
    seedAttempt(store, SEP9_PEAK, { modelName: 'deepseek-flash' });
    seedAttempt(store, SEP10_PEAK, { modelName: 'deepseek-flash' });

    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });
    const report = await host.ledger.getMeteredUsage('deepseek');

    expect(report.today.estimatedCost).toBe('8');
    expect(report.today.unpricedRequestCount).toBe(0);
    expect(report.today.isPartial).toBe(false);
    expect(report.month.measuredRequestCount).toBe(3);
    expect(report.month.unpricedRequestCount).toBe(1);
    expect(report.month.estimatedCost).toBe('17');
    expect(report.month.isPartial).toBe(true);
  });

  it('derives a cost for a stored unpriced record without rewriting the ledger', async () => {
    withClock(SEP10_PEAK);
    const store = new MapAtomicDocs();
    seedTracking(store, SEP10_DAY_START);
    const stored = seedAttempt(store, SEP10_PEAK, {
      modelName: 'deepseek-flash',
      usage: usageOf(1000, 500, 200),
    });
    const writesBefore = store.setCalls.length;
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });

    const report = await host.ledger.getMeteredUsage('deepseek');
    expect(report.today).toMatchObject({
      requestCount: 1,
      measuredRequestCount: 1,
      unpricedRequestCount: 0,
      inputTokens: 1200,
      outputTokens: 500,
      cacheReadTokens: 200,
      totalTokens: 1700,
      estimatedCost: '0.006008',
    });
    expect(store.setCalls).toHaveLength(writesBefore);
    expect(await store.get<AttemptRecord>(MONTH_SCOPE, stored.attemptId)).toEqual(stored);
    expect(await host.ledger.getMeteredUsage('deepseek')).toEqual(report);
  });

  it('corrects a superseded legacy flash price but never touches pro or unknown versions', async () => {
    withClock(SEP10_PEAK);
    const store = new MapAtomicDocs();
    seedTracking(store, SEP10_DAY_START);
    const staleFlash = seedAttempt(store, SEP10_PEAK, {
      modelName: 'deepseek-v4-flash',
      pricingVersion: '2026-09-07',
      costNanos: '9000000000',
    });
    seedAttempt(store, SEP10_PEAK, {
      modelName: 'deepseek-v4-pro',
      pricingVersion: '2026-09-07',
      costNanos: '27000000000',
    });
    seedAttempt(store, SEP10_PEAK, { modelName: 'deepseek-flash', pricingVersion: '2026-09-10' });
    seedAttempt(store, SEP10_PEAK, {
      modelName: 'deepseek-flash',
      pricingVersion: '2099-01-01',
      costNanos: '123',
    });
    seedAttempt(store, SEP9_PEAK, {
      modelName: 'deepseek-v4-flash',
      pricingVersion: '2026-09-07',
      costNanos: '9000000000',
    });
    const writesBefore = store.setCalls.length;
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });

    const report = await host.ledger.getMeteredUsage('deepseek');
    expect(report.today.measuredRequestCount).toBe(4);
    expect(report.today.unpricedRequestCount).toBe(1);
    expect(report.today.estimatedCost).toBe('35.000000123');
    expect(report.month.estimatedCost).toBe('44.000000123');
    expect(store.setCalls).toHaveLength(writesBefore);
    expect(await store.get<AttemptRecord>(MONTH_SCOPE, staleFlash.attemptId)).toEqual(staleFlash);
  });

  it('reports the same derived cost from the cache and from a restarted service', async () => {
    withClock(SEP10_PEAK);
    const store = new MapAtomicDocs();
    seedTracking(store, SEP10_DAY_START);
    seedAttempt(store, SEP10_PEAK, { modelName: 'deepseek-flash' });

    const first = createLedger({ atomicDocs: store });
    disposables.add({ dispose: first.dispose });
    const cached = await first.ledger.getMeteredUsage('deepseek');
    expect(cached.today.estimatedCost).toBe('8');

    const restarted = createLedger({ atomicDocs: store });
    disposables.add({ dispose: restarted.dispose });
    const reloaded = await restarted.ledger.getMeteredUsage('deepseek');
    expect(reloaded).toEqual(cached);
    expect(await first.ledger.getMeteredUsage('deepseek')).toEqual(cached);
  });

  it('keeps the incomplete-coverage flag after deriving a cost', async () => {
    withClock(SEP10_PEAK);
    const store = new MapAtomicDocs();
    seedTracking(store, SEP1_DAY_START, [shanghaiEpoch(2026, 9, 10, 8, 0)]);
    seedAttempt(store, SEP10_PEAK, { modelName: 'deepseek-flash' });
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });

    const report = await host.ledger.getMeteredUsage('deepseek');
    expect(report.today.estimatedCost).toBe('8');
    expect(report.today.unpricedRequestCount).toBe(0);
    expect(report.today.isPartial).toBe(true);
    expect(report.month.isPartial).toBe(true);
  });

  it('leaves a stored record for an unknown model unpriced', async () => {
    withClock(SEP10_PEAK);
    const store = new MapAtomicDocs();
    seedTracking(store, SEP10_DAY_START);
    seedAttempt(store, SEP10_PEAK, { modelName: 'deepseek-chat' });
    const host = createLedger({ atomicDocs: store });
    disposables.add({ dispose: host.dispose });

    const report = await host.ledger.getMeteredUsage('deepseek');
    expect(report.today.measuredRequestCount).toBe(1);
    expect(report.today.unpricedRequestCount).toBe(1);
    expect(report.today.estimatedCost).toBeNull();
    expect(report.today.isPartial).toBe(true);
  });
});

describe('aggregateMeteredUsage', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0); // 2026-09-07T12:00:00Z

  function record(startedAtEpochMs: number, outcome: AttemptRecord['outcome'], usage: TokenUsage | null): AttemptRecord {
    return {
      attemptId: `id-${startedAtEpochMs}`,
      providerName: 'deepseek',
      modelName: 'deepseek-v4-flash',
      modelAlias: 'deepseek/deepseek-v4-flash',
      startedAtEpochMs,
      outcome,
      usage,
      pricingVersion: usage === null ? null : '2026-09-07',
      costNanos: usage === null ? null : '0',
    };
  }

  it('splits records across the Shanghai day boundary', () => {
    const today = now;
    const yesterday = today - 24 * 3_600_000;
    const metered: LocalMeteredUsage = aggregateMeteredUsage(
      [record(yesterday, 'success', usageOf(1, 2, 0)), record(today, 'success', usageOf(10, 20, 0))],
      now,
      false,
      yesterday,
    );
    expect(metered.today.requestCount).toBe(1);
    expect(metered.month.requestCount).toBe(2);
    expect(metered.today.outputTokens).toBe(20);
    expect(metered.month.outputTokens).toBe(22);
  });

  it('marks a period partial when tracking starts mid-period', () => {
    const monthStart = Date.UTC(2026, 8, 1, 0, 0, 0) - 8 * 3_600_000;
    const midMonth = monthStart + 10 * 24 * 3_600_000;
    const metered = aggregateMeteredUsage([record(midMonth, 'success', usageOf(1, 1, 0))], now, false, midMonth);
    expect(metered.trackingStartedAt).toBe(new Date(midMonth).toISOString());
    expect(metered.month.isPartial).toBe(true);
  });

  it('reports null tracking start and partial when there is no metadata', () => {
    const metered = aggregateMeteredUsage([], now, false, null);
    expect(metered.trackingStartedAt).toBeNull();
    expect(metered.today.isPartial).toBe(true);
    expect(metered.month.isPartial).toBe(true);
    expect(metered.today.requestCount).toBe(0);
  });

  it('treats an invalid costNanos as unpriced rather than free', () => {
    const bad = record(now, 'success', usageOf(1, 1, 0));
    const metered = aggregateMeteredUsage([{ ...bad, costNanos: 'oops' }], now, false, now);
    expect(metered.today.unpricedRequestCount).toBe(1);
    expect(metered.today.estimatedCost).toBeNull();
    expect(metered.today.isPartial).toBe(true);
  });
});
