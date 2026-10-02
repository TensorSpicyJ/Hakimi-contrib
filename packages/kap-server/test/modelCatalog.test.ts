import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IConfigService,
  IKosongConfigService,
  IModelCatalog,
  IOAuthService,
  IProviderDiscoveryService,
  type IModelCatalog as IModelCatalogType,
  type IOAuthService as IOAuthServiceType,
  type IProviderDiscoveryService as IProviderDiscoveryServiceType,
  type ModelCatalogConfig,
  type ModelsSection,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

interface WireModelItem {
  provider: string;
  model: string;
  display_name?: string;
  max_context_size: number;
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
}

interface WireRefreshResult {
  changed: Array<{ provider_id: string; provider_name: string; added: number; removed: number }>;
  unchanged: string[];
  failed: unknown[];
}

const CATALOG_TOML = [
  'default_model = "k2"',
  '',
  '[providers.kimi]',
  'type = "kimi"',
  'api_key = "sk-test"',
  'base_url = "https://api.example.test/v1"',
  '',
  '[providers.openai]',
  'type = "openai"',
  '',
  '[models.k2]',
  'provider = "kimi"',
  'model = "kimi-k2"',
  'max_context_size = 131072',
  'display_name = "Kimi K2"',
  'capabilities = ["thinking"]',
  '',
  '[models.turbo]',
  'provider = "kimi"',
  'model = "kimi-turbo"',
  'max_context_size = 32768',
  'display_name = "Kimi Turbo"',
  '',
  '[models.gpt4o]',
  'provider = "openai"',
  'model = "gpt-4o"',
  'max_context_size = 128000',
  '',
].join('\n');

const CODEX_PROVIDER_TOML = [
  '[providers."managed:openai-codex"]',
  'type = "openai_responses"',
  'base_url = "https://chatgpt.com/backend-api/codex"',
  '',
  '[providers."managed:openai-codex".oauth]',
  'storage = "file"',
  'key = "oauth/openai-codex"',
].join('\n');

// A pre-update install: the provider plus only the Astra alias (user-edited,
// so the backfill must leave the record alone) and one custom alias.
const CODEX_LEGACY_TOML = [
  'default_model = "openai-codex/gpt-6-astra"',
  'default_provider = "managed:openai-codex"',
  '',
  '[thinking]',
  'enabled = true',
  'effort = "high"',
  '',
  CODEX_PROVIDER_TOML,
  '',
  '[models."openai-codex/gpt-6-astra"]',
  'provider = "managed:openai-codex"',
  'model = "gpt-6-astra"',
  'max_context_size = 999999',
  'display_name = "My Astra"',
  'capabilities = ["thinking", "always_thinking"]',
  'support_efforts = ["high"]',
  'default_effort = "high"',
  '',
  '[models.codex-custom]',
  'provider = "managed:openai-codex"',
  'model = "gpt-5.5"',
  'max_context_size = 272000',
  'display_name = "My Codex"',
  '',
].join('\n');

const CODEX_STATIC_TOML = [
  'default_model = "openai-codex/gpt-6-astra"',
  '',
  '[providers."managed:openai-codex"]',
  'type = "openai_responses"',
  'model_source = "static"',
  'base_url = "https://chatgpt.com/backend-api/codex"',
  '',
  '[providers."managed:openai-codex".oauth]',
  'storage = "file"',
  'key = "oauth/openai-codex"',
  '',
  '[models."openai-codex/gpt-6-astra"]',
  'provider = "managed:openai-codex"',
  'model = "gpt-6-astra"',
  'max_context_size = 1050000',
  'max_input_size = 922000',
  'capabilities = ["thinking", "always_thinking", "tool_use", "image_in"]',
  'support_efforts = ["low", "medium", "high", "xhigh", "max", "ultra"]',
  'default_effort = "low"',
  'display_name = "GPT-6 Astra (ChatGPT)"',
  '',
].join('\n');

// The wire projection the offline backfill adds for the GPT-6 Sol/Luna
// entries, plus the canonical Astra entry the static config serves. Field
// values mirror the built-in table in packages/oauth/src/openai-codex.ts.
const CODEX_SOL_WIRE_ITEM: WireModelItem = {
  provider: 'managed:openai-codex',
  model: 'openai-codex/gpt-6-sol',
  display_name: 'GPT-6 Sol (ChatGPT)',
  max_context_size: 272000,
  capabilities: ['thinking', 'always_thinking', 'tool_use', 'image_in'],
  support_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  default_effort: 'medium',
};

const CODEX_LUNA_WIRE_ITEM: WireModelItem = {
  provider: 'managed:openai-codex',
  model: 'openai-codex/gpt-6-luna',
  display_name: 'GPT-6 Luna (ChatGPT)',
  max_context_size: 272000,
  capabilities: ['thinking', 'always_thinking', 'tool_use', 'image_in'],
  support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  default_effort: 'medium',
};

const CODEX_ASTRA_WIRE_ITEM: WireModelItem = {
  provider: 'managed:openai-codex',
  model: 'openai-codex/gpt-6-astra',
  display_name: 'GPT-6 Astra (ChatGPT)',
  max_context_size: 1050000,
  capabilities: ['thinking', 'always_thinking', 'tool_use', 'image_in'],
  support_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  default_effort: 'low',
};

describe('server-v2 /api/v1 model/provider catalog', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-model-catalog-'));
    // Disable the background refresh scheduler so its startup refresh never
    // races the route-level assertions below (it shares the IProviderDiscoveryService
    // binding that the stub tests override).
    process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START'] = '0';
    process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS'] = '0';
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
    delete process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START'];
    delete process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS'];
  });

  async function boot(toml?: string, seeds?: ScopeSeed): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        body === undefined ? {} : { 'content-type': 'application/json' },
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('lists configured models as selectable aliases', async () => {
    await boot(CATALOG_TOML);
    const { status, body } = await getJson<{ items: unknown[] }>('/api/v1/models');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([
      {
        provider: 'kimi',
        model: 'k2',
        display_name: 'Kimi K2',
        max_context_size: 131072,
        capabilities: ['thinking'],
      },
      {
        provider: 'kimi',
        model: 'turbo',
        display_name: 'Kimi Turbo',
        max_context_size: 32768,
      },
      {
        provider: 'openai',
        model: 'gpt4o',
        display_name: 'gpt-4o',
        max_context_size: 128000,
      },
    ]);
  });

  it('lists models without refreshing providers', async () => {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: [],
      failed: [],
    }));
    const seeds = [
      [IModelCatalog, catalogStub()],
      [IProviderDiscoveryService, discoveryStub(refreshProviderModels)],
    ] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { status, body } = await getJson<{ items: unknown[] }>('/api/v1/models');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('lists providers and returns a single provider by id', async () => {
    await boot(CATALOG_TOML);
    const list = await getJson<{ items: unknown[] }>('/api/v1/providers');
    expect(list.body.code).toBe(0);
    expect(list.body.data.items).toEqual([
      {
        id: 'kimi',
        type: 'kimi',
        base_url: 'https://api.example.test/v1',
        default_model: 'k2',
        has_api_key: true,
        status: 'connected',
        models: ['k2', 'turbo'],
      },
      {
        id: 'openai',
        type: 'openai',
        has_api_key: false,
        status: 'unconfigured',
        models: ['gpt4o'],
      },
    ]);

    const single = await getJson<unknown>('/api/v1/providers/kimi');
    expect(single.body.code).toBe(0);
    expect(single.body.data).toEqual({
      id: 'kimi',
      type: 'kimi',
      base_url: 'https://api.example.test/v1',
      default_model: 'k2',
      has_api_key: true,
      status: 'connected',
      models: ['k2', 'turbo'],
      // The single GET reveals the stored key; the list above never does.
      api_key: 'sk-test',
    });

    const noKey = await getJson<Record<string, unknown>>('/api/v1/providers/openai');
    expect(noKey.body.code).toBe(0);
    expect(noKey.body.data).not.toHaveProperty('api_key');
  });

  it('sets the global default model and reflects it in /auth', async () => {
    await boot(CATALOG_TOML);
    const { body } = await postJson<unknown>('/api/v1/models/turbo:set_default', {});
    expect(body.code).toBe(0);
    expect(body.data).toEqual({
      default_model: 'turbo',
      model: {
        provider: 'kimi',
        model: 'turbo',
        display_name: 'Kimi Turbo',
        max_context_size: 32768,
      },
    });

    const auth = await getJson<{ default_model: string | null }>('/api/v1/auth');
    expect(auth.body.code).toBe(0);
    expect(auth.body.data.default_model).toBe('turbo');
  });

  it('maps unknown provider and model ids to catalog not-found codes', async () => {
    await boot(CATALOG_TOML);
    const provider = await getJson<unknown>('/api/v1/providers/missing');
    expect(provider.body.code).toBe(40412);

    const model = await postJson<unknown>('/api/v1/models/missing:set_default', {});
    expect(model.body.code).toBe(40413);
  });

  it('returns an empty refresh result through the catalog route', async () => {
    await boot(CATALOG_TOML);
    const { status, body } = await postJson<{
      changed: unknown[];
      unchanged: unknown[];
      failed: unknown[];
    }>('/api/v1/providers:refresh_oauth', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ changed: [], unchanged: [], failed: [] });
  });

  it('returns an empty refresh result through the providers:refresh route', async () => {
    await boot(CATALOG_TOML);
    const { status, body } = await postJson<{
      changed: unknown[];
      unchanged: unknown[];
      failed: unknown[];
    }>('/api/v1/providers:refresh', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ changed: [], unchanged: [], failed: [] });
  });

  function catalogStub(): IModelCatalogType {
    return {
      _serviceBrand: undefined,
      get: () => {
        throw new Error('unused');
      },
      getRequester: () => {
        throw new Error('unused');
      },
      inspect: () => {
        throw new Error('unused');
      },
      ping: async () => {
        throw new Error('unused');
      },
      findByName: () => [],
      listModels: async () => [],
      listProviders: async () => [],
      getProvider: async () => {
        throw new Error('unused');
      },
      setDefaultModel: async () => {
        throw new Error('unused');
      },
    };
  }

  function discoveryStub(
    refreshProviderModels: IProviderDiscoveryServiceType['refreshProviderModels'],
  ): IProviderDiscoveryServiceType {
    return { _serviceBrand: undefined, refreshProviderModels };
  }

  function oauthStub(
    refreshOAuthProviderModels: IOAuthServiceType['refreshOAuthProviderModels'],
  ): IOAuthServiceType {
    return {
      _serviceBrand: undefined,
      startLogin: async () => {
        throw new Error('unused');
      },
      getFlow: () => undefined,
      cancelLogin: async () => {
        throw new Error('unused');
      },
      logout: async () => {
        throw new Error('unused');
      },
      status: async () => ({ loggedIn: false }),
      refreshOAuthProviderModels,
      getManagedUsage: async () => ({ kind: 'error' as const, message: 'unused' }),
      getManagedUserInfo: async () => ({ kind: 'error' as const, message: 'unused' }),
      resolveTokenProvider: () => undefined,
      getCachedAccessToken: async () => undefined,
    };
  }

  it('refreshes OAuth provider models through POST /providers:refresh_oauth', async () => {
    const refreshOAuthProviderModels = vi.fn(async () => ({
      changed: [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 1, removed: 0 },
      ],
      unchanged: [],
      failed: [],
    }));
    const seeds = [[IOAuthService, oauthStub(refreshOAuthProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { status, body } = await postJson<{
      changed: unknown[];
      unchanged: unknown[];
      failed: unknown[];
    }>('/api/v1/providers:refresh_oauth', {});

    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({
      changed: [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 1, removed: 0 },
      ],
      unchanged: [],
      failed: [],
    });
    expect(refreshOAuthProviderModels).toHaveBeenCalledTimes(1);
  });

  it('refreshes all provider models through POST /providers:refresh', async () => {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 2, removed: 1 },
      ],
      unchanged: ['moonshot-cn'],
      failed: [],
    }));
    const seeds = [[IProviderDiscoveryService, discoveryStub(refreshProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { status, body } = await postJson('/api/v1/providers:refresh', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(refreshProviderModels).toHaveBeenCalledWith({ scope: 'all' });
  });

  it('refreshes a single provider through POST /providers/{id}:refresh', async () => {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: [],
      failed: [],
    }));
    const seeds = [[IProviderDiscoveryService, discoveryStub(refreshProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { status, body } = await postJson('/api/v1/providers/managed%3Akimi-code:refresh', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(refreshProviderModels).toHaveBeenCalledWith({ providerId: 'managed:kimi-code' });
  });

  it('rejects unsupported provider actions with 40001', async () => {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: [],
      failed: [],
    }));
    const seeds = [[IProviderDiscoveryService, discoveryStub(refreshProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { body } = await postJson('/api/v1/providers/foo:bogus', {});
    expect(body.code).toBe(40001);
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('loads the [model_catalog] config section from TOML', async () => {
    await boot(
      ['[model_catalog]', 'refresh_interval_ms = 1000', 'refresh_on_start = false', ''].join('\n'),
    );
    const cfg = server!.core.accessor.get(IConfigService);
    await cfg.ready;
    const value = cfg.get<ModelCatalogConfig | undefined>('modelCatalog');
    expect(value).toEqual({ refreshIntervalMs: 1000, refreshOnStart: false });
  });

  it('backfills missing built-in Codex models on boot without touching tokens or user config', async () => {
    // A throwing token provider proves the offline backfill never resolves
    // OAuth credentials; the temp home carries no token and no login runs.
    const resolveTokenProvider = vi.fn(() => {
      throw new Error('boot backfill must not resolve OAuth token providers');
    });
    const seeds = [
      [
        IOAuthService,
        {
          ...oauthStub(async () => ({ changed: [], unchanged: [], failed: [] })),
          resolveTokenProvider,
        },
      ],
    ] as unknown as ScopeSeed;
    await boot(CODEX_LEGACY_TOML, seeds);

    // The very first catalog read after boot already serves the full set.
    const { status, body } = await getJson<{ items: WireModelItem[] }>('/api/v1/models');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    const items = new Map<string, WireModelItem>(
      body.data.items.map((item) => [item.model, item]),
    );
    expect([...items.keys()].toSorted()).toEqual([
      'codex-custom',
      'openai-codex/gpt-5.6-luna',
      'openai-codex/gpt-5.6-sol',
      'openai-codex/gpt-5.6-terra',
      'openai-codex/gpt-6-astra',
      'openai-codex/gpt-6-luna',
      'openai-codex/gpt-6-sol',
    ]);
    expect(items.get('openai-codex/gpt-6-sol')).toEqual(CODEX_SOL_WIRE_ITEM);
    expect(items.get('openai-codex/gpt-6-luna')).toEqual(CODEX_LUNA_WIRE_ITEM);
    // Existing records win over the built-in table, and custom aliases survive.
    expect(items.get('openai-codex/gpt-6-astra')).toEqual({
      provider: 'managed:openai-codex',
      model: 'openai-codex/gpt-6-astra',
      display_name: 'My Astra',
      max_context_size: 999999,
      capabilities: ['thinking', 'always_thinking'],
      support_efforts: ['high'],
      default_effort: 'high',
    });
    expect(items.get('codex-custom')).toEqual({
      provider: 'managed:openai-codex',
      model: 'codex-custom',
      display_name: 'My Codex',
      max_context_size: 272000,
    });
    expect(resolveTokenProvider).not.toHaveBeenCalled();

    // The default pointer, thinking preference, and provider record are
    // exactly what the user configured.
    const config = server!.core.accessor.get(IConfigService);
    await config.ready;
    expect(config.get<string>('defaultModel')).toBe('openai-codex/gpt-6-astra');
    expect(config.get<string>('defaultProvider')).toBe('managed:openai-codex');
    expect(config.get('thinking')).toEqual({ enabled: true, effort: 'high' });
    expect(config.get<Record<string, unknown>>('providers')).toEqual({
      'managed:openai-codex': {
        type: 'openai_responses',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        oauth: { storage: 'file', key: 'oauth/openai-codex' },
      },
    });
  });

  it('does not backfill Codex models when the provider pins model_source = "static"', async () => {
    await boot(CODEX_STATIC_TOML);
    const { status, body } = await getJson<{ items: WireModelItem[] }>('/api/v1/models');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([CODEX_ASTRA_WIRE_ITEM]);

    const config = server!.core.accessor.get(IConfigService);
    await config.ready;
    expect(
      config.get<Record<string, Record<string, unknown>>>('providers')?.['managed:openai-codex'],
    ).toMatchObject({ modelSource: 'static' });
  });

  it.each([
    ['targeted', '/api/v1/providers/managed%3Aopenai-codex:refresh'],
    ['all', '/api/v1/providers:refresh'],
  ])(
    're-adds locally removed Codex models through the %s refresh without network',
    async (_label, path) => {
      // Boot the legacy config: the startup backfill fills the catalog first,
      // then the test removes the GPT-6 Sol/Luna aliases through the real
      // config service before refreshing.
      await boot(CODEX_LEGACY_TOML);
      const config = server!.core.accessor.get(IConfigService);
      await config.ready;
      await server!.core.accessor.get(IKosongConfigService).ready;

      const removed = [CODEX_SOL_WIRE_ITEM.model, CODEX_LUNA_WIRE_ITEM.model];
      const models = config.get<ModelsSection>('models') ?? {};
      await config.replace(
        'models',
        Object.fromEntries(Object.entries(models).filter(([id]) => !removed.includes(id))),
      );

      const before = await getJson<{ items: WireModelItem[] }>('/api/v1/models');
      expect(before.body.code).toBe(0);
      const beforeIds = before.body.data.items.map((item) => item.model);
      expect(beforeIds).toHaveLength(5);
      for (const id of removed) expect(beforeIds).not.toContain(id);

      const refreshed = await postJson<WireRefreshResult>(path, {});
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.code).toBe(0);
      expect(refreshed.body.data).toEqual({
        changed: [
          { provider_id: 'managed:openai-codex', provider_name: 'OpenAI Codex', added: 2, removed: 0 },
        ],
        unchanged: [],
        failed: [],
      });

      const after = await getJson<{ items: WireModelItem[] }>('/api/v1/models');
      expect(after.body.code).toBe(0);
      const items = new Map<string, WireModelItem>(
        after.body.data.items.map((item) => [item.model, item]),
      );
      expect(items.size).toBe(7);
      expect(items.get(CODEX_SOL_WIRE_ITEM.model)).toEqual(CODEX_SOL_WIRE_ITEM);
      expect(items.get(CODEX_LUNA_WIRE_ITEM.model)).toEqual(CODEX_LUNA_WIRE_ITEM);

      // The additive refresh writes only the missing aliases: the default
      // pointer and the provider record stay untouched.
      expect(config.get<string>('defaultModel')).toBe('openai-codex/gpt-6-astra');
      expect(config.get<Record<string, unknown>>('providers')).toEqual({
        'managed:openai-codex': {
          type: 'openai_responses',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          oauth: { storage: 'file', key: 'oauth/openai-codex' },
        },
      });
    },
  );

  it('holds the catalog read until the kosong bridge finishes hydration', async () => {
    // Controlled bridge readiness: the handler must reach the bridge barrier
    // before touching the catalog and serve the response only after release.
    // No timers — if the barrier await is dropped from the route, the race
    // below resolves to 'catalog' and the test fails immediately.
    let reachBarrier!: () => void;
    const barrierReached = new Promise<void>((resolve) => {
      reachBarrier = resolve;
    });
    let releaseBridge!: () => void;
    const bridgeReady = new Promise<void>((resolve) => {
      releaseBridge = resolve;
    });
    let catalogRead!: () => void;
    const catalogReadStarted = new Promise<void>((resolve) => {
      catalogRead = resolve;
    });
    const listModels = vi.fn(async () => {
      catalogRead();
      return [];
    });
    const bridge = {
      _serviceBrand: undefined,
      get ready(): Promise<void> {
        reachBarrier();
        return bridgeReady;
      },
    };
    const seeds = [
      [IKosongConfigService, bridge],
      [IModelCatalog, { ...catalogStub(), listModels }],
    ] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const pending = getJson<{ items: unknown[] }>('/api/v1/models');
    const first = await Promise.race([
      barrierReached.then(() => 'barrier' as const),
      catalogReadStarted.then(() => 'catalog' as const),
    ]);
    expect(first).toBe('barrier');
    expect(listModels).not.toHaveBeenCalled();

    releaseBridge();
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
    expect(listModels).toHaveBeenCalledTimes(1);
  });
});
