/**
 * `kosong/provider` composition probes — the runtime invariants of the L2
 * layer, exercised through the real registry path with every base contrib and
 * the Kimi + canonical-vendor endpoint definitions registered:
 *
 *  1. Composing Kimi without a config apiKey and without env vars must NOT
 *     silently pick up `OPENAI_API_KEY` (the `apiKey ?? ''` suppression in
 *     the openai contrib factory).
 *  2. Config `defaultHeaders` always win over trait-declared headers (the
 *     trailing synthetic trait).
 *  4. `supportedProtocols()` is derived from the registered bases and never
 *     contains `kimi` — a vendor is not a protocol. It does not contain
 *     `vertexai` either: Vertex AI is a `providerOptions` mode of the
 *     google-genai base, exercised below (flag forwarding, and the
 *     `VERTEXAI_API_KEY` → `GOOGLE_API_KEY` endpoint chain the google-genai
 *     definition declares).
 *
 * Plus the registry resolution contract: `resolveAdapterIdentity` branches,
 * `resolveProviderBaseId`, the `resolveCapability` fallback chain, and the
 * composed-provider shape (`name` is the base's, `uploadVideo` is bound only
 * when a trait declares it).
 *
 * DeepSeek probes cover official endpoint/auth isolation, per-turn thinking,
 * kwargs precedence, output budgets, and reasoning/tool-image replay through
 * the real base. A fixture trait seeds conflicting defaults via public hooks.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 test test/kosong/provider/composition.test.ts
 *
 * The final sections drive `generate` with mocked SDK clients and assert the
 * exact request params on the wire (the morph era asserted baked provider
 * state instead):
 *
 *  - the behavior probes for per-turn intent encoding (cacheKey / thinking /
 *     budget) on the Kimi, OpenAI, and Anthropic wires;
 *  - reasoning-only assistant history remains canonical while each wire
 *    projects it into a provider-valid representation;
 *  - the per-base `responseFormat` encodings (re-added from the deleted
 *     llmProtocol structured-output suite; morph-seeded kwargs cases that no
 *     longer have a channel are noted where they dropped);
 *  - the Anthropic thinking-keep context-management overlay and max-tokens
 *     profile, and the OpenAI `reasoning_effort` auto-enable with its
 *     load-bearing kill switch (a `withThinking` hook disables it);
 *  - the OpenAI Responses output-item identity contract end to end: item
 *     id/phase decoding (stream and non-stream), replay at item boundaries,
 *     encrypted-reasoning requests decoupled from an explicit effort, the
 *     Codex `session-id` cache header, and stream termination (early EOF,
 *     `incomplete`, `failed`, abort).
 *
 * Plus one construction invariant: every wire base builds its SDK client
 * with `maxRetries: 0` — retry is owned by the engine's step-retry layer,
 * never by the SDK (whose backoff sleep ignores the turn's AbortSignal). The
 * closing section proves it over a real HTTP 429: the first response reaches
 * the caller after exactly one request, carrying the server-directed delay.
 *
 * Note: base/definition registries are module-level state shared across this
 * file, so the contribs and test-vendor definitions are imported/registered
 * exactly once here.
 */

import { createServer } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import type OpenAI from 'openai';

import { isUnknownCapability } from '#/kosong/contract/capability';
import {
  APIConnectionError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIStatusError,
  ChatProviderError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import { generate } from '#/kosong/contract/generate';
import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import type {
  ChatProvider,
  GenerateOptions,
  ResponseFormat,
  StreamedMessage,
} from '#/kosong/contract/provider';
import '#/kosong/provider/bases/anthropic/index';
import {
  AnthropicChatProvider,
  resolveDefaultMaxTokens,
} from '#/kosong/provider/bases/anthropic/anthropic';
import '#/kosong/provider/bases/google-genai/index';
import { GoogleGenAIChatProvider } from '#/kosong/provider/bases/google-genai/google-genai';
import '#/kosong/provider/bases/openai/index';
import {
  OpenAIResponsesChatProvider,
  OpenAIResponsesStreamedMessage,
} from '#/kosong/provider/bases/openai/openai-responses';
import { OpenAILegacyChatProvider } from '#/kosong/provider/bases/openai/openai-legacy';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import {
  getProviderDefinition,
  getProviderDefinitions,
  hasProviderDefinition,
  registerProviderDefinition,
  resolveProviderEndpoint,
} from '#/kosong/provider/providerDefinition';
import { deepseekOpenAITrait } from '#/kosong/provider/providers/deepseek/deepseek.contrib';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';

registerProviderDefinition({
  id: 'header-vendor',
  baseProtocol: 'openai',
  traits: [
    {
      defaultHeaders: () => ({ 'x-shared': 'trait', 'x-trait-only': 'trait' }),
    },
  ],
});

registerProviderDefinition({
  id: 'cap-vendor',
  baseProtocol: 'openai',
  traits: [
    {
      capability: (modelName) =>
        modelName === 'special-model'
          ? {
              image_in: true,
              video_in: false,
              audio_in: false,
              thinking: false,
              tool_use: true,
              max_context_tokens: 0,
            }
          : undefined,
    },
  ],
});

registerProviderDefinition({
  id: 'deepseek-seeded',
  baseProtocol: 'openai',
  traits: [
    {
      provides: () => ({ thinkingEffort: 'high' }),
      cacheKey: () => ({
        thinking: { type: 'enabled', keep: 'all' },
        reasoning_effort: 'medium',
        temperature: 0.7,
        max_completion_tokens: 16,
        extra_body: {
          thinking: { type: 'enabled', keep: 'all' },
          reasoning_effort: 'medium',
          max_tokens: 32,
          vendor_option: 'preserved',
        },
      }),
    },
    deepseekOpenAITrait,
  ],
});

const ENV_KEYS = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'KIMI_API_KEY',
  'KIMI_BASE_URL',
  'GOOGLE_API_KEY',
  'VERTEXAI_API_KEY',
] as const;

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const registry = new ProtocolAdapterRegistry();

describe('supportedProtocols (probe 4)', () => {
  it('is derived from the registered bases and contains neither kimi nor vertexai', () => {
    const protocols = registry.supportedProtocols();
    expect(protocols).toHaveLength(4);
    expect([...protocols].toSorted()).toEqual(
      ['anthropic', 'google-genai', 'openai', 'openai_responses'].toSorted(),
    );
    expect(protocols).not.toContain('kimi');
    expect(protocols).not.toContain('vertexai');
  });
});

describe('apiKey env suppression (probe 1)', () => {
  it('does not pick up OPENAI_API_KEY when composing kimi without any key', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
    });
    await expect(provider.generate('sys', [], [])).rejects.toThrow(/apiKey is required/);

    process.env['OPENAI_API_KEY'] = 'sk-openai-must-not-leak';
    const withStrayEnv = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
    });
    await expect(withStrayEnv.generate('sys', [], [])).rejects.toThrow(/apiKey is required/);
  });

  it('uses the KIMI_API_KEY env fallback when composing kimi', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-from-env';
    process.env['OPENAI_API_KEY'] = 'sk-openai-must-not-win';
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
    });
    const apiKey = (provider as unknown as { _apiKey?: string })._apiKey;
    expect(apiKey).toBe('sk-kimi-from-env');
  });

  it('keeps the base env fallback for plain openai (no endpoint declared)', async () => {
    const noKey = registry.createChatProvider({ protocol: 'openai', modelName: 'gpt-4o' });
    await expect(noKey.generate('sys', [], [])).rejects.toThrow(/apiKey is required/);

    process.env['OPENAI_API_KEY'] = 'sk-openai-env';
    const withKey = registry.createChatProvider({
      protocol: 'openai',
      modelName: 'gpt-4o',
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    await expect(withKey.generate('sys', [], [])).rejects.toThrow(APIConnectionError);
  });

  it('prefers an explicit config apiKey over the env chain', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-from-env';
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
      apiKey: 'sk-explicit-config',
    });
    const apiKey = (provider as unknown as { _apiKey?: string })._apiKey;
    expect(apiKey).toBe('sk-explicit-config');
  });
});

describe('config defaultHeaders win (probe 2)', () => {
  it('merges trait headers under config headers via the trailing synthetic trait', () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'header-vendor',
      modelName: 'm',
      defaultHeaders: { 'x-shared': 'config', 'x-config-only': 'config' },
    });
    const headers = (provider as unknown as { _defaultHeaders?: Record<string, string> })
      ._defaultHeaders;
    expect(headers).toEqual({
      'x-shared': 'config',
      'x-trait-only': 'trait',
      'x-config-only': 'config',
    });
  });

  it('passes trait headers through when no config headers are set', () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'header-vendor',
      modelName: 'm',
    });
    const headers = (provider as unknown as { _defaultHeaders?: Record<string, string> })
      ._defaultHeaders;
    expect(headers).toEqual({ 'x-shared': 'trait', 'x-trait-only': 'trait' });
  });
});

describe('resolveAdapterIdentity', () => {
  it('resolves the (kimi, openai) pair registration: its traits plus the trailing synthetic trait', () => {
    const identity = registry.resolveAdapterIdentity('openai', 'kimi');
    expect(identity.baseId).toBe('openai');
    expect(identity.traits).toHaveLength(2);
  });

  it('resolves the (kimi, anthropic) pair registration: only its own traits', () => {
    const identity = registry.resolveAdapterIdentity('anthropic', 'kimi');
    expect(identity.baseId).toBe('anthropic');
    expect(identity.traits).toHaveLength(2);
  });

  it('resolves an unregistered (vendor, protocol) pair to no vendor traits', () => {
    const identity = registry.resolveAdapterIdentity('google-genai', 'kimi');
    expect(identity.baseId).toBe('google-genai');
    expect(identity.traits).toHaveLength(1);
  });

  it('resolves the unregistered-vendor branch: protocol itself as base, no vendor traits', () => {
    const identity = registry.resolveAdapterIdentity('openai', 'no-such-vendor');
    expect(identity.baseId).toBe('openai');
    expect(identity.traits).toHaveLength(1);
  });

  it('resolves the no-providerType branch identically', () => {
    const identity = registry.resolveAdapterIdentity('openai');
    expect(identity.baseId).toBe('openai');
    expect(identity.traits).toHaveLength(1);
  });
});

describe('resolveProviderBaseId', () => {
  it('returns the pair registration’s baseProtocol — the protocol itself by construction', () => {
    expect(registry.resolveProviderBaseId('openai', 'kimi')).toBe('openai');
    expect(registry.resolveProviderBaseId('anthropic', 'kimi')).toBe('anthropic');
  });

  it('returns the protocol itself otherwise', () => {
    expect(registry.resolveProviderBaseId('google-genai', 'kimi')).toBe('google-genai');
    expect(registry.resolveProviderBaseId('openai', 'no-such-vendor')).toBe('openai');
    expect(registry.resolveProviderBaseId('openai')).toBe('openai');
  });
});

describe('resolveCapability', () => {
  it('falls back to trait capability hooks before the base catalog', () => {
    const fromTrait = registry.resolveCapability('openai', 'special-model', 'cap-vendor');
    expect(fromTrait.image_in).toBe(true);
    const fromBase = registry.resolveCapability('openai', 'gpt-4o', 'cap-vendor');
    expect(fromBase.image_in).toBe(true);
  });

  it('falls back to the base catalog and then to UNKNOWN', () => {
    expect(registry.resolveCapability('openai', 'gpt-4o').image_in).toBe(true);
    const deepSeekVision = registry.resolveCapability(
      'openai',
      'deepseek-v4-flash-vision-exp',
    );
    expect(deepSeekVision.image_in).toBe(true);
    expect(deepSeekVision.thinking).toBe(true);
    expect(deepSeekVision.tool_use).toBe(true);
    const astra = registry.resolveCapability('openai', 'gpt-6-astra');
    expect(astra.image_in).toBe(true);
    expect(astra.thinking).toBe(true);
    expect(astra.tool_use).toBe(true);
    const astraSuffixed = registry.resolveCapability('openai', 'gpt-6-astra-2026-08-01');
    expect(astraSuffixed.image_in).toBe(true);
    expect(astraSuffixed.thinking).toBe(true);
    expect(astraSuffixed.tool_use).toBe(true);
    const astraResponses = registry.resolveCapability('openai_responses', 'gpt-6-astra');
    expect(astraResponses.image_in).toBe(true);
    expect(astraResponses.thinking).toBe(true);
    expect(astraResponses.tool_use).toBe(true);
    const astraResponsesSuffixed = registry.resolveCapability(
      'openai_responses',
      'gpt-6-astra-2026-08-01',
    );
    expect(astraResponsesSuffixed.tool_use).toBe(true);
    expect(isUnknownCapability(registry.resolveCapability('openai', 'gpt-6-astral'))).toBe(true);
    expect(isUnknownCapability(registry.resolveCapability('openai', 'gpt-6-astraX'))).toBe(true);
    expect(isUnknownCapability(registry.resolveCapability('openai', 'deepseek-not-real'))).toBe(true);
    expect(isUnknownCapability(registry.resolveCapability('openai', 'mystery-model'))).toBe(true);
    expect(registry.resolveCapability('anthropic', 'claude-opus-4-1').thinking).toBe(true);
  });

  describe.each(['openai', 'openai_responses'] as const)('%s GPT-6 catalog', (protocol) => {
    it.each([
      'gpt-6-sol', 'GPT-6-SOL', 'gpt-6-sol-2026-09-22', 'gpt-6-sol.preview',
      'gpt-6-luna', 'GPT-6-LUNA', 'gpt-6-luna-2026-09-22', 'gpt-6-luna.preview',
    ])('detects thinking, image input and tool use for %s', (modelName) => {
      expect(registry.resolveCapability(protocol, modelName)).toMatchObject({
        image_in: true,
        thinking: true,
        tool_use: true,
      });
    });

    it.each(['gpt-6-solar', 'gpt-6-solX', 'gpt-6-lunar', 'gpt-6-lunaX', 'gpt-6-unknown'])(
      'leaves the unrecognized model %s with unknown capabilities',
      (modelName) => {
        expect(isUnknownCapability(registry.resolveCapability(protocol, modelName))).toBe(true);
      },
    );
  });

  it('kimi declares no vendor-level capability — the base catalog answers instead', () => {
    expect(isUnknownCapability(registry.resolveCapability('openai', 'kimi-for-coding', 'kimi'))).toBe(
      true,
    );
    expect(registry.resolveCapability('openai', 'gpt-4o', 'kimi').image_in).toBe(true);
  });
});

describe('explainCapability', () => {
  it('reports the trait level when a trait hook answers', () => {
    const { capability, source } = registry.explainCapability('openai', 'special-model', 'cap-vendor');
    expect(capability.image_in).toBe(true);
    expect(source.kind).toBe('builtin');
    expect(source.detail).toContain('trait');
  });

  it('reports the base catalog level', () => {
    const { capability, source } = registry.explainCapability('openai', 'gpt-4o');
    expect(capability.image_in).toBe(true);
    expect(source.kind).toBe('builtin');
    expect(source.detail).toContain('base');
  });

  it('reports none when nothing knows the model', () => {
    const { capability, source } = registry.explainCapability('openai', 'mystery-model');
    expect(isUnknownCapability(capability)).toBe(true);
    expect(source.kind).toBe('none');
  });
});

describe('createChatProvider', () => {
  it('composes kimi as the openai base with the upload capability bound', () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
    });
    expect(provider.name).toBe('openai');
    expect(provider.modelName).toBe('kimi-k2');
    expect(typeof provider.uploadVideo).toBe('function');
  });

  it('composes plain openai without the upload capability', () => {
    const provider = registry.createChatProvider({ protocol: 'openai', modelName: 'gpt-4o' });
    expect(provider.name).toBe('openai');
    expect(provider.uploadVideo).toBeUndefined();
  });
});

describe('SDK-internal retry disabled (engine-owned step retry)', () => {
  it.each([
    { protocol: 'openai', modelName: 'gpt-4o' },
    { protocol: 'openai_responses', modelName: 'gpt-5' },
    { protocol: 'anthropic', modelName: 'claude-opus-4-6' },
  ] as const)('builds the $protocol SDK client with maxRetries 0', ({ protocol, modelName }) => {
    const provider = registry.createChatProvider({ protocol, modelName, apiKey: 'sk-probe' });
    expect((sdkClient(provider) as { maxRetries?: number }).maxRetries).toBe(0);
  });
});

describe('google-genai vertex mode (providerOptions)', () => {
  it('forwards vertexai + project + location from providerOptions to the base', () => {
    const provider = registry.createChatProvider({
      protocol: 'google-genai',
      modelName: 'gemini-2.5-flash',
      providerOptions: { vertexai: true, project: 'my-project', location: 'us-central1' },
    });
    expect(provider.name).toBe('google_genai');
    expect(Reflect.get(provider, '_vertexai')).toBe(true);
    expect(Reflect.get(provider, '_project')).toBe('my-project');
    expect(Reflect.get(provider, '_location')).toBe('us-central1');
  });

  it('stays in plain Gemini mode without the providerOptions flag', () => {
    const provider = registry.createChatProvider({
      protocol: 'google-genai',
      modelName: 'gemini-2.5-flash',
      apiKey: 'sk-probe',
    });
    expect(Reflect.get(provider, '_vertexai')).toBe(false);
    expect(Reflect.get(provider, '_project')).toBeUndefined();
    expect(Reflect.get(provider, '_location')).toBeUndefined();
  });

  it('prefers VERTEXAI_API_KEY over GOOGLE_API_KEY through the definition endpoint chain', () => {
    process.env['VERTEXAI_API_KEY'] = 'vertex-env-key';
    process.env['GOOGLE_API_KEY'] = 'google-env-key';
    const provider = registry.createChatProvider({
      protocol: 'google-genai',
      providerType: 'google-genai',
      modelName: 'gemini-2.5-flash',
    });
    expect(Reflect.get(provider, '_apiKey')).toBe('vertex-env-key');
  });

  it('falls back to GOOGLE_API_KEY when no vertex key is set', () => {
    process.env['GOOGLE_API_KEY'] = 'google-env-key';
    const provider = registry.createChatProvider({
      protocol: 'google-genai',
      providerType: 'google-genai',
      modelName: 'gemini-2.5-flash',
    });
    expect(Reflect.get(provider, '_apiKey')).toBe('google-env-key');
  });
});

describe('resolveProviderEndpoint', () => {
  it('resolves the kimi endpoint chain from process.env', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-env';
    expect(resolveProviderEndpoint('kimi')).toEqual({
      apiKey: 'sk-kimi-env',
      baseUrl: 'https://api.moonshot.ai/v1',
    });
  });

  it('reads a caller-supplied env bag instead of process.env', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-env';
    expect(resolveProviderEndpoint('kimi', { KIMI_BASE_URL: 'https://example.com/v1' })).toEqual({
      baseUrl: 'https://example.com/v1',
    });
  });

  it('aggregates the google-genai chain with the legacy vertex precedence', () => {
    expect(
      resolveProviderEndpoint('google-genai', {
        VERTEXAI_API_KEY: 'vertex-env-key',
        GOOGLE_API_KEY: 'google-env-key',
      }),
    ).toEqual({ apiKey: 'vertex-env-key' });
    expect(resolveProviderEndpoint('google-genai', { GOOGLE_API_KEY: 'google-env-key' })).toEqual({
      apiKey: 'google-env-key',
    });
    expect(
      resolveProviderEndpoint('google-genai', {
        GOOGLE_VERTEX_BASE_URL: 'https://vertex.example.test',
        GOOGLE_GEMINI_BASE_URL: 'https://gemini.example.test',
      }),
    ).toEqual({ baseUrl: 'https://vertex.example.test' });
    expect(
      resolveProviderEndpoint('google-genai', {
        GOOGLE_GEMINI_BASE_URL: 'https://gemini.example.test',
      }),
    ).toEqual({ baseUrl: 'https://gemini.example.test' });
  });

  it('returns {} for unregistered vendors', () => {
    expect(resolveProviderEndpoint('no-such-vendor')).toEqual({});
  });
});

describe('kimi provider definitions', () => {
  it('registers one definition per transport, with shared vendor-level facts', () => {
    const native = getProviderDefinition('kimi', 'openai');
    const anthropic = getProviderDefinition('kimi', 'anthropic');
    expect(native?.baseProtocol).toBe('openai');
    expect(native?.traits).toHaveLength(1);
    expect(anthropic?.baseProtocol).toBe('anthropic');
    expect(anthropic?.traits).toHaveLength(1);
    for (const definition of [native, anthropic]) {
      expect(definition?.endpoint).toEqual({
        apiKeyEnv: 'KIMI_API_KEY',
        baseUrlEnv: 'KIMI_BASE_URL',
        defaultBaseUrl: 'https://api.moonshot.ai/v1',
      });
      expect(definition?.hostHeaders).toBe('full');
      expect(definition?.modelSource).toBe('oauth-catalog');
    }
  });

  it('answers id-level queries and reports unregistered pairs', () => {
    expect(getProviderDefinition('kimi')?.baseProtocol).toBe('openai');
    expect(getProviderDefinitions('kimi')).toHaveLength(2);
    expect(hasProviderDefinition('kimi')).toBe(true);
    expect(hasProviderDefinition('no-such-vendor')).toBe(false);
    expect(getProviderDefinition('kimi', 'google-genai')).toBeUndefined();
  });

  it('allows the same id on several protocols but rejects a duplicate (id, baseProtocol) pair', () => {
    registerProviderDefinition({ id: 'pair-vendor', baseProtocol: 'openai', traits: [] });
    registerProviderDefinition({ id: 'pair-vendor', baseProtocol: 'anthropic', traits: [] });
    expect(getProviderDefinition('pair-vendor', 'openai')).toBeDefined();
    expect(getProviderDefinition('pair-vendor', 'anthropic')).toBeDefined();
    expect(() =>
      registerProviderDefinition({ id: 'pair-vendor', baseProtocol: 'openai', traits: [] }),
    ).toThrow(/already registered/);
    expect(() =>
      registerProviderDefinition({ id: 'kimi', baseProtocol: 'openai', traits: [] }),
    ).toThrow(/already registered/);
  });
});


const PROBE_HISTORY: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
];

const THINK_HISTORY: Message[] = [
  {
    role: 'assistant',
    content: [{ type: 'think', think: 'earlier reasoning' }],
    toolCalls: [],
  },
  { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
];

async function drain(stream: StreamedMessage): Promise<void> {
  for await (const part of stream) void part;
}

function sdkClient(provider: ChatProvider): unknown {
  return Reflect.get(provider, '_client');
}

function isStreaming(provider: ChatProvider): boolean {
  return (Reflect.get(provider, '_stream') as boolean | undefined) !== false;
}

async function* openAIChunkStream(): AsyncIterable<unknown> {
  yield {
    id: 'chatcmpl-probe',
    choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
}

function chatCompletionResponse(): Record<string, unknown> {
  return {
    id: 'chatcmpl-probe',
    object: 'chat.completion',
    created: 1,
    model: 'probe',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
}

async function* anthropicEventStream(): AsyncIterable<unknown> {
  yield {
    type: 'message_start',
    message: { id: 'msg_probe', usage: { input_tokens: 3, output_tokens: 1 } },
  };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } };
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } };
}

function anthropicMessageResponse(): Record<string, unknown> {
  return {
    id: 'msg_probe',
    type: 'message',
    role: 'assistant',
    model: 'probe',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 1 },
  };
}

async function* responsesEventStream(): AsyncIterable<unknown> {
  yield { type: 'response.created', response: { id: 'resp_probe' } };
  yield { type: 'response.output_text.delta', delta: 'Hello' };
  yield {
    type: 'response.completed',
    response: {
      id: 'resp_probe',
      status: 'completed',
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    },
  };
}

async function captureOpenAIBody(
  provider: ChatProvider,
  options?: GenerateOptions,
  history: Message[] = PROBE_HISTORY,
  tools: Tool[] = [],
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const client = sdkClient(provider) as { chat: { completions: { create: unknown } } };
  client.chat.completions.create = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return {
      withResponse: () =>
        Promise.resolve({
          data: isStreaming(provider) ? openAIChunkStream() : chatCompletionResponse(),
          response: { headers: new Headers() },
        }),
    };
  });
  await drain(await provider.generate('', tools, history, options));
  if (captured === undefined) throw new Error('expected chat.completions.create to be called');
  return captured;
}

async function captureAnthropicBody(
  provider: ChatProvider,
  options?: GenerateOptions,
  history: Message[] = PROBE_HISTORY,
): Promise<{
  readonly params: Record<string, unknown>;
  readonly requestOptions: Record<string, unknown> | undefined;
  readonly via: 'beta' | 'standard';
}> {
  let capturedParams: Record<string, unknown> | undefined;
  let capturedRequestOptions: Record<string, unknown> | undefined;
  let via: 'beta' | 'standard' | undefined;
  const client = sdkClient(provider) as {
    messages: { create: unknown };
    beta: { messages: { create: unknown } };
  };
  const create = (channel: 'beta' | 'standard') =>
    vi.fn().mockImplementation((params: unknown, requestOptions: unknown) => {
      via = channel;
      capturedParams = params as Record<string, unknown>;
      capturedRequestOptions = requestOptions as Record<string, unknown> | undefined;
      return Promise.resolve(
        isStreaming(provider) ? anthropicEventStream() : anthropicMessageResponse(),
      );
    });
  client.messages.create = create('standard');
  client.beta.messages.create = create('beta');
  await drain(await provider.generate('', [], history, options));
  if (capturedParams === undefined || via === undefined) {
    throw new Error('expected messages.create to be called');
  }
  return { params: capturedParams, requestOptions: capturedRequestOptions, via };
}

async function captureGoogleBody(
  provider: ChatProvider,
  options?: GenerateOptions,
  history: Message[] = PROBE_HISTORY,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const client = sdkClient(provider) as { models: { generateContent: unknown } };
  client.models.generateContent = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return Promise.resolve({
      candidates: [
        { content: { parts: [{ text: 'Hello' }], role: 'model' }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
      modelVersion: 'probe',
    });
  });
  await drain(await provider.generate('', [], history, options));
  if (captured === undefined) throw new Error('expected models.generateContent to be called');
  return captured;
}

async function captureResponsesBody(
  provider: ChatProvider,
  options?: GenerateOptions,
  history: Message[] = PROBE_HISTORY,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const client = sdkClient(provider) as { responses: { create: unknown } };
  client.responses.create = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return Promise.resolve(responsesEventStream());
  });
  await drain(await provider.generate('', [], history, options));
  if (captured === undefined) throw new Error('expected responses.create to be called');
  return captured;
}

interface ResponsesRequestRig {
  params(): Record<string, unknown> | undefined;
  requestOptions(): Record<string, unknown> | undefined;
}

function responsesProvider(
  overrides: Partial<ConstructorParameters<typeof OpenAIResponsesChatProvider>[0]> = {},
): OpenAIResponsesChatProvider {
  return new OpenAIResponsesChatProvider({ model: 'gpt-6-astra', apiKey: 'sk-probe', ...overrides });
}

async function* emit(events: readonly unknown[]): AsyncIterable<unknown> {
  yield* events;
}

function mockResponsesClient(
  provider: ChatProvider,
  events: readonly unknown[] | AsyncIterable<unknown>,
): ResponsesRequestRig {
  let capturedParams: Record<string, unknown> | undefined;
  let capturedRequestOptions: Record<string, unknown> | undefined;
  const client = sdkClient(provider) as { responses: { create: unknown } };
  client.responses.create = vi.fn().mockImplementation((params: unknown, requestOptions: unknown) => {
    capturedParams = params as Record<string, unknown>;
    capturedRequestOptions = requestOptions as Record<string, unknown> | undefined;
    return Promise.resolve(
      Array.isArray(events) ? emit(events) : (events as AsyncIterable<unknown>),
    );
  });
  return {
    params: () => capturedParams,
    requestOptions: () => capturedRequestOptions,
  };
}

async function collectParts(stream: StreamedMessage): Promise<unknown[]> {
  const parts: unknown[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

async function collectClonedParts(stream: StreamedMessage): Promise<unknown[]> {
  const parts: unknown[] = [];
  for await (const part of stream) parts.push(structuredClone(part));
  return parts;
}

const RESPONSES_COMPLETED = {
  type: 'response.completed',
  response: { id: 'resp_probe', status: 'completed' },
};

const RESPONSES_NON_EMPTY_REPLY = [
  { type: 'response.output_text.delta', item_id: 'msg_reply', delta: 'ack' },
  RESPONSES_COMPLETED,
];

function messageItem(id: string, phase?: string): Record<string, unknown> {
  const item: Record<string, unknown> = { type: 'message', id, role: 'assistant' };
  if (phase !== undefined) item['phase'] = phase;
  return item;
}

function textDelta(itemId: string, outputIndex: number, delta: string): Record<string, unknown> {
  return {
    type: 'response.output_text.delta',
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    delta,
  };
}

function reasoningDelta(itemId: string, outputIndex: number, delta: string): Record<string, unknown> {
  return {
    type: 'response.reasoning_summary_text.delta',
    item_id: itemId,
    output_index: outputIndex,
    summary_index: 0,
    delta,
  };
}

describe('DeepSeek Flash composition (official OpenAI wire)', () => {
  it('uses the official endpoint and DeepSeek credentials without inheriting OpenAI env', async () => {
    process.env['OPENAI_API_KEY'] = 'unrelated-key';
    process.env['OPENAI_BASE_URL'] = 'https://unrelated.example.test/v1';
    process.env['DEEPSEEK_API_KEY'] = 'deepseek-test-key';
    const provider = registry.createChatProvider({
      protocol: 'openai', providerType: 'deepseek', modelName: 'deepseek-flash',
    });
    expect(sdkClient(provider)).toMatchObject({
      apiKey: 'deepseek-test-key', baseURL: 'https://api.deepseek.com',
    });
    expect(provider.name).toBe('openai');
    expect(await captureOpenAIBody(provider)).toMatchObject({ model: 'deepseek-flash' });
  });

  it('prefers explicit endpoint credentials over DeepSeek env', () => {
    process.env['DEEPSEEK_API_KEY'] = 'env-key';
    process.env['DEEPSEEK_BASE_URL'] = 'https://env.example.test/v1';
    const config = { protocol: 'openai' as const, providerType: 'deepseek', modelName: 'deepseek-flash' };
    expect(sdkClient(registry.createChatProvider(config))).toMatchObject({
      apiKey: 'env-key', baseURL: 'https://env.example.test/v1',
    });
    expect(sdkClient(registry.createChatProvider({
      ...config, apiKey: 'explicit-key', baseUrl: 'https://explicit.example.test/v1',
    }))).toMatchObject({ apiKey: 'explicit-key', baseURL: 'https://explicit.example.test/v1' });
  });

  it('does not construct an OpenAI-authenticated client when DeepSeek credentials are absent', () => {
    process.env['OPENAI_API_KEY'] = 'unrelated-key';
    const provider = registry.createChatProvider({
      protocol: 'openai', providerType: 'deepseek', modelName: 'deepseek-flash',
    });
    expect(sdkClient(provider)).toBeUndefined();
  });

  it.each(['low', 'high', 'max'])('sends explicit %s unchanged even with reasoning history', async (effort) => {
    const provider = registry.createChatProvider({
      protocol: 'openai', providerType: 'deepseek', modelName: 'deepseek-flash', apiKey: 'sk-probe',
    });
    const body = await captureOpenAIBody(provider, { thinking: { effort, keep: 'all' } }, THINK_HISTORY);
    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect(body['reasoning_effort']).toBe(effort);
    expect(body).not.toHaveProperty('extra_body');
  });

  it.each([
    ['off', 'disabled'],
    ['on', 'enabled'],
  ])('encodes %s without injecting an effort from reasoning history', async (effort, type) => {
    const provider = registry.createChatProvider({
      protocol: 'openai', providerType: 'deepseek', modelName: 'deepseek-flash', apiKey: 'sk-probe',
    });
    const body = await captureOpenAIBody(provider, { thinking: { effort } }, THINK_HISTORY);
    expect(body['thinking']).toEqual({ type });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('leaves thinking unspecified when no intent is supplied, even with reasoning history', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai', providerType: 'deepseek', modelName: 'deepseek-flash', apiKey: 'sk-probe',
    });
    const body = await captureOpenAIBody(provider, undefined, THINK_HISTORY);
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it.each([
    ['low', 'enabled', 'low'],
    ['high', 'enabled', 'high'],
    ['max', 'enabled', 'max'],
    ['on', 'enabled', undefined],
    ['off', 'disabled', undefined],
  ] as const)('lets per-request %s override provider defaults and conflicting seeded kwargs', async (effort, type, reasoningEffort) => {
    const provider = registry.createChatProvider({
      protocol: 'openai', providerType: 'deepseek-seeded', modelName: 'deepseek-flash', apiKey: 'sk-probe',
    });
    const body = await captureOpenAIBody(provider, {
      cacheKey: 'seed-kwargs', thinking: { effort, keep: 'all' }, maxCompletionTokens: 200000,
    }, THINK_HISTORY);
    expect(body['thinking']).toEqual({ type });
    expect(body['reasoning_effort']).toBe(reasoningEffort);
    if (reasoningEffort === undefined) expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).toMatchObject({ temperature: 0.7, vendor_option: 'preserved', max_tokens: 200000 });
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('extra_body');
  });

  it.each(['medium', 'xhigh', 'invalid'])('rejects unsupported effort %s with config.invalid', async (effort) => {
    const provider = registry.createChatProvider({
      protocol: 'openai', providerType: 'deepseek', modelName: 'deepseek-flash', apiKey: 'sk-probe',
    });
    await expect(captureOpenAIBody(provider, { thinking: { effort } })).rejects.toMatchObject({
      code: 'config.invalid', details: { provider: 'deepseek', effort },
      message: expect.stringContaining('off, on, low, high, or max'),
    });
  });

  it.each([
    [undefined, undefined, 200000],
    [950000, 1048576, 98576],
    [1048576, 1048576, 1],
  ])('keeps the explicit output budget subject only to remaining context (%s used)', async (usedContextTokens, maxContextTokens, expected) => {
    const provider = registry.createChatProvider({
      protocol: 'openai', providerType: 'deepseek', modelName: 'deepseek-flash', apiKey: 'sk-probe',
    });
    const body = await captureOpenAIBody(provider, {
      maxCompletionTokens: 200000, usedContextTokens, maxContextTokens,
    });
    expect(body['max_tokens']).toBe(expected);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('replays reasoning and all tool results before attached tool images on the shared wire', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai', providerType: 'deepseek', modelName: 'deepseek-flash', apiKey: 'sk-probe',
    });
    const history: Message[] = [
      { role: 'user', content: [
        { type: 'text', text: 'Compare these images.' },
        { type: 'image_url', imageUrl: { url: 'https://example.test/input.png' } },
      ], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'think', think: 'Inspect both sources.' }], toolCalls: [
        { type: 'function', id: 'call_a', name: 'read_image', arguments: '{"name":"a"}' },
        { type: 'function', id: 'call_b', name: 'read_image', arguments: '{"name":"b"}' },
      ] },
      { role: 'tool', toolCallId: 'call_a', toolCalls: [], content: [
        { type: 'text', text: 'Image A' },
        { type: 'image_url', imageUrl: { url: 'https://example.test/a.png' } },
      ] },
      { role: 'tool', toolCallId: 'call_b', toolCalls: [], content: [
        { type: 'image_url', imageUrl: { url: 'https://example.test/b.png' } },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'Compared.' }], toolCalls: [] },
    ];
    const body = await captureOpenAIBody(provider, { thinking: { effort: 'high' } }, history);
    expect(body['messages']).toEqual([
      { role: 'user', content: [
        { type: 'text', text: 'Compare these images.' },
        { type: 'image_url', image_url: { url: 'https://example.test/input.png' } },
      ] },
      { role: 'assistant', reasoning_content: 'Inspect both sources.', tool_calls: [
        { type: 'function', id: 'call_a', function: { name: 'read_image', arguments: '{"name":"a"}' } },
        { type: 'function', id: 'call_b', function: { name: 'read_image', arguments: '{"name":"b"}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_a', content: 'Image A' },
      { role: 'tool', tool_call_id: 'call_b', content: '(see attached media)' },
      { role: 'user', content: [
        { type: 'text', text: 'Attached media from tool result:' },
        { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
        { type: 'image_url', image_url: { url: 'https://example.test/b.png' } },
      ] },
      { role: 'assistant', content: 'Compared.' },
    ]);
  });

  it('does not apply DeepSeek thinking or budget rules to generic OpenAI with a Flash model name', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai', providerType: 'openai', modelName: 'deepseek-flash', apiKey: 'sk-probe',
    });
    const body = await captureOpenAIBody(provider, { maxCompletionTokens: 200000 }, THINK_HISTORY);
    expect(body['reasoning_effort']).toBe('medium');
    expect(body).not.toHaveProperty('thinking');
    expect(body['max_tokens']).toBe(131072);
  });
});

describe('per-turn intent wire encoding (behavior probes)', () => {
  it('encodes cacheKey + thinking + budget on the Kimi wire as prompt_cache_key + expanded thinking, never reasoning_effort', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
      apiKey: 'sk-probe',
    });

    const body = await captureOpenAIBody(provider, {
      cacheKey: 'session-probe',
      thinking: { effort: 'high', keep: 'all' },
      maxCompletionTokens: 5000,
    });

    expect(body['prompt_cache_key']).toBe('session-probe');
    expect(body['thinking']).toEqual({ type: 'enabled', effort: 'high', keep: 'all' });
    expect(body).not.toHaveProperty('extra_body');
    expect(body['max_completion_tokens']).toBe(5000);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it.each([
    'gpt-6-astra', 'gpt-6-astra-2026-08-01',
    'gpt-6-sol', 'GPT-6-SOL', 'gpt-6-sol-2026-09-22', 'gpt-6-sol.preview',
    'gpt-6-luna', 'GPT-6-LUNA', 'gpt-6-luna-2026-09-22', 'gpt-6-luna.preview',
  ])(
    'encodes the generate budget for %s on the OpenAI wire as max_completion_tokens',
    async (modelName) => {
      const provider = registry.createChatProvider({
        protocol: 'openai',
        modelName,
        apiKey: 'sk-probe',
      });

      const body = await captureOpenAIBody(provider, { maxCompletionTokens: 5000 });

      expect(body['max_completion_tokens']).toBe(5000);
      expect(body).not.toHaveProperty('max_tokens');
    },
  );

  it('encodes cacheKey on plain OpenAI as the native prompt_cache_key', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      modelName: 'gpt-4o',
      apiKey: 'sk-probe',
    });

    const body = await captureOpenAIBody(provider, { cacheKey: 'session-probe' });

    expect(body['prompt_cache_key']).toBe('session-probe');
  });

  it('encodes cacheKey on Anthropic as metadata.user_id', async () => {
    const provider = registry.createChatProvider({
      protocol: 'anthropic',
      modelName: 'claude-opus-4-6',
      apiKey: 'sk-probe',
    });

    const { params, via } = await captureAnthropicBody(provider, { cacheKey: 'session-probe' });

    expect(via).toBe('standard');
    expect(params['metadata']).toEqual({ user_id: 'session-probe' });
  });

  it('encodes thinking for Kimi over the Anthropic transport through the pair trait only', async () => {
    const provider = registry.createChatProvider({
      protocol: 'anthropic',
      providerType: 'kimi',
      modelName: 'kimi-for-coding',
      apiKey: 'sk-probe',
    });

    const { params, requestOptions, via } = await captureAnthropicBody(provider, {
      thinking: { effort: 'high' },
    });

    expect(via).toBe('standard');
    expect(params['thinking']).toEqual({ type: 'enabled' });
    expect(params['output_config']).toEqual({ effort: 'high' });
    expect(requestOptions).toBeUndefined();
  });
});

describe('reasoning-only assistant history projection', () => {
  it('adds empty content on the OpenAI Chat Completions wire without dropping reasoning', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'deepseek-v4-flash',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureOpenAIBody(provider, undefined, THINK_HISTORY);
    const messages = body['messages'] as Array<Record<string, unknown>>;

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: '',
      reasoning_content: 'earlier reasoning',
    });
  });

  it('keeps unsigned thinking on the Kimi Anthropic wire', async () => {
    const provider = registry.createChatProvider({
      protocol: 'anthropic',
      providerType: 'kimi',
      modelName: 'kimi-for-coding',
      apiKey: 'sk-probe',
    });

    const { params } = await captureAnthropicBody(provider, undefined, THINK_HISTORY);
    const messages = params['messages'] as Array<Record<string, unknown>>;

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'earlier reasoning' }],
    });
  });

  it('keeps unsigned thinking on the Google GenAI wire', async () => {
    const provider = new GoogleGenAIChatProvider({
      model: 'gemini-2.5-flash',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureGoogleBody(provider, undefined, THINK_HISTORY);
    const contents = body['contents'] as Array<Record<string, unknown>>;

    expect(contents[0]).toEqual({
      role: 'model',
      parts: [{ text: 'earlier reasoning', thought: true }],
    });
  });
});

describe('OpenAI Responses developer-role projection', () => {
  it.each(['gpt-6-solar', 'gpt-6-lunar', 'gpt-6-unknown'])(
    'preserves the system role for the unrecognized model %s',
    async (modelName) => {
      const provider = registry.createChatProvider({
        protocol: 'openai_responses', modelName, apiKey: 'sk-probe',
      });
      const body = await captureResponsesBody(provider, undefined, [
        { role: 'system', content: [{ type: 'text', text: 'Remember this.' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      ]);
      expect(body['input']).toMatchObject([{ role: 'system' }, { role: 'user' }]);
    },
  );

  it.each([
    'gpt-6-astra', 'gpt-6-astra-2026-08-01',
    'gpt-6-sol', 'GPT-6-SOL', 'gpt-6-sol-2026-09-22', 'gpt-6-sol.preview',
    'gpt-6-luna', 'GPT-6-LUNA', 'gpt-6-luna-2026-09-22', 'gpt-6-luna.preview',
  ])(
    'maps a history system message to developer for %s',
    async (modelName) => {
      const provider = registry.createChatProvider({
        protocol: 'openai_responses',
        modelName,
        apiKey: 'sk-probe',
      });
      const history: Message[] = [
        { role: 'system', content: [{ type: 'text', text: 'Remember this.' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      ];
      const body = await captureResponsesBody(provider, undefined, history);
      const input = body['input'] as Array<Record<string, unknown>>;

      expect(input[0]).toEqual({
        content: [{ type: 'input_text', text: 'Remember this.' }],
        role: 'developer',
        type: 'message',
      });
      expect(input[1]).toEqual({
        content: [{ type: 'input_text', text: 'hi' }],
        role: 'user',
        type: 'message',
      });
    },
  );
});

describe('quota-exhausted classification through the real composition (behavior probes)', () => {
  const MOONSHOT_QUOTA_BODY = {
    type: 'error',
    error: {
      type: 'exceeded_current_quota_error',
      message:
        'Your account is suspended due to insufficient balance, please recharge your account',
    },
  };

  function mockQuota429Client(provider: ChatProvider): void {
    const client = sdkClient(provider) as {
      messages: { create: unknown };
      beta: { messages: { create: unknown } };
    };
    const reject = vi.fn().mockImplementation(() => {
      throw AnthropicAPIError.generate(
        429,
        MOONSHOT_QUOTA_BODY,
        'Too many requests',
        new Headers(),
      );
    });
    client.messages.create = reject;
    client.beta.messages.create = reject;
  }

  it('fails fast on a Moonshot quota 429 over the (kimi, anthropic) composition', async () => {
    const provider = registry.createChatProvider({
      protocol: 'anthropic',
      providerType: 'kimi',
      modelName: 'kimi-for-coding',
      apiKey: 'sk-probe',
    });
    mockQuota429Client(provider);

    const caught = await provider.generate('', [], PROBE_HISTORY).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(caught)).toBe(false);
  });

  it('keeps the same 429 a retryable rate limit on a plain anthropic composition', async () => {
    const provider = registry.createChatProvider({
      protocol: 'anthropic',
      modelName: 'claude-opus-4-6',
      apiKey: 'sk-probe',
    });
    mockQuota429Client(provider);

    const caught = await provider.generate('', [], PROBE_HISTORY).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(APIProviderRateLimitError);
    expect(caught).not.toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(caught)).toBe(true);
  });
});

describe('reasoning dialect (behavior probes)', () => {
  it('yields think parts from the `reasoning` wire field', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
      apiKey: 'sk-probe',
    });

    const client = sdkClient(provider) as { chat: { completions: { create: unknown } } };
    client.chat.completions.create = vi.fn().mockImplementation(() => {
      async function* chunks(): AsyncIterable<unknown> {
        yield { id: 'chatcmpl-probe', choices: [{ index: 0, delta: { reasoning: 'hmm' } }] };
        yield {
          id: 'chatcmpl-probe',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        };
      }
      return {
        withResponse: () =>
          Promise.resolve({ data: chunks(), response: { headers: new Headers() } }),
      };
    });

    const parts: unknown[] = [];
    for await (const part of await provider.generate('', [], PROBE_HISTORY)) {
      parts.push(part);
    }
    expect(parts).toEqual([
      { type: 'think', think: 'hmm' },
      { type: 'text', text: 'ok' },
    ]);
  });

  it('echoes thinking under `reasoning` after the endpoint spoke it', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
      apiKey: 'sk-probe',
    });

    const captured: Array<Record<string, unknown>> = [];
    const client = sdkClient(provider) as { chat: { completions: { create: unknown } } };
    client.chat.completions.create = vi.fn().mockImplementation((params: unknown) => {
      captured.push(params as Record<string, unknown>);
      async function* chunks(): AsyncIterable<unknown> {
        yield { id: 'chatcmpl-probe', choices: [{ index: 0, delta: { reasoning: 'hmm' } }] };
        yield {
          id: 'chatcmpl-probe',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        };
      }
      return {
        withResponse: () =>
          Promise.resolve({ data: chunks(), response: { headers: new Headers() } }),
      };
    });

    await drain(await provider.generate('', [], PROBE_HISTORY));

    await drain(await provider.generate('', [], THINK_HISTORY));

    const messages = captured[1]?.['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({ reasoning: 'earlier reasoning' });
    expect(messages[0]).not.toHaveProperty('reasoning_content');
  });

  it('kimi composition defaults to reasoning_content before any detection', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
      apiKey: 'sk-probe',
    });

    const body = await captureOpenAIBody(provider, undefined, THINK_HISTORY);

    const messages = body['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({ reasoning_content: 'earlier reasoning' });
  });

  it('an explicit reasoningKey pins the dialect against detection', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'sk-probe',
      stream: false,
      reasoningKey: 'custom_key',
    });

    const captured: Array<Record<string, unknown>> = [];
    const client = sdkClient(provider) as { chat: { completions: { create: unknown } } };
    client.chat.completions.create = vi.fn().mockImplementation((params: unknown) => {
      captured.push(params as Record<string, unknown>);
      return {
        withResponse: () =>
          Promise.resolve({
            data: {
              id: 'chatcmpl-probe',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'ok', reasoning: 'hmm' },
                  finish_reason: 'stop',
                },
              ],
            },
            response: { headers: new Headers() },
          }),
      };
    });

    const firstParts: unknown[] = [];
    for await (const part of await provider.generate('', [], PROBE_HISTORY)) {
      firstParts.push(part);
    }
    expect(firstParts).toEqual([{ type: 'text', text: 'ok' }]);

    await drain(await provider.generate('', [], THINK_HISTORY));

    const messages = captured[1]?.['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({ custom_key: 'earlier reasoning' });
  });
});

const CONTACT_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
  additionalProperties: false,
};

const JSON_SCHEMA_FORMAT: ResponseFormat = {
  type: 'json_schema',
  jsonSchema: { name: 'contact', schema: CONTACT_SCHEMA, strict: true },
};

describe('responseFormat wire encoding (per base)', () => {
  it('maps json_schema to the OpenAI Chat Completions response_format', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureOpenAIBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });

    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'contact',
        schema: CONTACT_SCHEMA,
        strict: true,
        description: undefined,
      },
    });
  });

  it('keeps response_format intact through the Kimi buildParams pipeline', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
      apiKey: 'sk-probe',
    });

    const body = await captureOpenAIBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });

    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'contact',
        schema: CONTACT_SCHEMA,
        strict: true,
        description: undefined,
      },
    });
  });

  it('maps json_schema to Anthropic output_config.format, merged over the per-turn effort', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-6',
      apiKey: 'sk-probe',
      stream: false,
    });

    const { params } = await captureAnthropicBody(provider, {
      thinking: { effort: 'medium' },
      responseFormat: JSON_SCHEMA_FORMAT,
    });

    expect(params['output_config']).toEqual({
      effort: 'medium',
      format: { type: 'json_schema', schema: CONTACT_SCHEMA },
    });
  });

  it('rejects json_object for Anthropic because the provider requires a schema', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-6',
      apiKey: 'sk-probe',
      stream: false,
    });

    await expect(
      provider.generate('', [], PROBE_HISTORY, { responseFormat: { type: 'json_object' } }),
    ).rejects.toThrow('Anthropic provider requires a JSON schema for structured response output.');
  });

  it('maps json_schema to the Google GenAI response config', async () => {
    const provider = new GoogleGenAIChatProvider({
      model: 'gemini-2.5-flash',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureGoogleBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });
    const config = body['config'] as Record<string, unknown>;

    expect(config['responseMimeType']).toBe('application/json');
    expect(config['responseJsonSchema']).toEqual(CONTACT_SCHEMA);
  });

  it('maps json_schema to the OpenAI Responses text.format', async () => {
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-4.1', apiKey: 'sk-probe' });

    const body = await captureResponsesBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });

    expect(body['text']).toEqual({
      format: {
        type: 'json_schema',
        name: 'contact',
        schema: CONTACT_SCHEMA,
        strict: true,
        description: undefined,
      },
    });
  });
});

describe('Anthropic thinking keep (context-management overlay)', () => {
  it('overlays the clear-thinking edit and forces the beta endpoint when keep is set', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-6',
      apiKey: 'sk-probe',
      stream: false,
    });

    const { params, via } = await captureAnthropicBody(provider, {
      thinking: { effort: 'high', keep: 'all' },
    });

    expect(via).toBe('beta');
    expect(params['context_management']).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    });
    expect(params['betas']).toContain('context-management-2025-06-27');
  });

  it('never duplicates the edit or the beta across turns on the same provider', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-6',
      apiKey: 'sk-probe',
      stream: false,
    });
    const keepAll: GenerateOptions = { thinking: { effort: 'high', keep: 'all' } };

    const first = await captureAnthropicBody(provider, keepAll);
    const second = await captureAnthropicBody(provider, keepAll);

    for (const { params } of [first, second]) {
      const edits = (params['context_management'] as { edits: unknown[] }).edits;
      expect(edits).toEqual([{ type: 'clear_thinking_20251015', keep: 'all' }]);
      const betas = params['betas'] as string[];
      expect(betas.filter((beta) => beta === 'context-management-2025-06-27')).toHaveLength(1);
    }
  });

  it('sends no context-management and stays on the standard endpoint without keep', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-6',
      apiKey: 'sk-probe',
      stream: false,
    });

    const { params, via } = await captureAnthropicBody(provider, {
      thinking: { effort: 'high' },
    });

    expect(via).toBe('standard');
    expect(params).not.toHaveProperty('context_management');
    expect(params).not.toHaveProperty('betas');
  });
});

describe('Anthropic max-tokens profile', () => {
  it('returns per-version Messages-API caps for known Claude models', () => {
    expect(resolveDefaultMaxTokens('claude-fable-5')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-8')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-7')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-6')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-5-20251101')).toBe(64000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-6')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-haiku-4-5')).toBe(64000);
  });

  it('matches dotted version separators', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4.8')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4.7')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4.6')).toBe(128000);
  });

  it('falls back to the nearest lower catalogued minor for unknown minors', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4-9')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-10')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-9')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-haiku-4-9')).toBe(64000);
    expect(resolveDefaultMaxTokens('claude-opus-4-3')).toBe(32000);
  });

  it('honors a lower override, clamps an override above the ceiling, and defaults unknown models to 128000', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4-7', 200)).toBe(200);
    expect(resolveDefaultMaxTokens('claude-opus-4-7', 999999)).toBe(128000);
    expect(resolveDefaultMaxTokens('unknown-model', 12345)).toBe(12345);
    expect(resolveDefaultMaxTokens('totally-unknown-model')).toBe(128000);
  });

  it('sends the profile default as max_tokens when no explicit defaultMaxTokens is set', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'sk-probe',
      stream: false,
    });

    const { params } = await captureAnthropicBody(provider);

    expect(params['max_tokens']).toBe(128000);
  });

  it('sends an explicit defaultMaxTokens unclamped, even above the model ceiling', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'sk-probe',
      stream: false,
      defaultMaxTokens: 999999,
    });

    const { params } = await captureAnthropicBody(provider);

    expect(params['max_tokens']).toBe(999999);
  });

  it('clamps the per-turn budget against the model ceiling', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'sk-probe',
      stream: false,
    });

    const within = await captureAnthropicBody(provider, { maxCompletionTokens: 5000 });
    expect(within.params['max_tokens']).toBe(5000);
    const above = await captureAnthropicBody(provider, { maxCompletionTokens: 999999 });
    expect(above.params['max_tokens']).toBe(128000);
  });

  it('lets an explicit constructor defaultMaxTokens win over the per-turn budget', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'sk-probe',
      stream: false,
      defaultMaxTokens: 999999,
    });

    const { params } = await captureAnthropicBody(provider, { maxCompletionTokens: 5000 });

    expect(params['max_tokens']).toBe(999999);
  });
});

describe('OpenAI reasoning_effort path (issue #1616)', () => {
  it('auto-enables reasoning_effort=medium from think-part history when no withThinking hook exists', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureOpenAIBody(provider, undefined, THINK_HISTORY);

    expect(body['reasoning_effort']).toBe('medium');
  });

  it('maps an explicit concrete effort to reasoning_effort', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureOpenAIBody(provider, { thinking: { effort: 'high' } });

    expect(body['reasoning_effort']).toBe('high');
  });

  it('suppresses the auto-enable on an explicit off, even with think-part history', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureOpenAIBody(provider, { thinking: { effort: 'off' } }, THINK_HISTORY);

    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('encodes an explicit off as the configured offEffort for models that reason by default', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'grok-4',
      apiKey: 'sk-probe',
      stream: false,
      offEffort: 'none',
    });

    const body = await captureOpenAIBody(provider, { thinking: { effort: 'off' } }, THINK_HISTORY);

    expect(body['reasoning_effort']).toBe('none');
  });

  it('encodes an explicit off as the configured offEffort on the Responses wire', async () => {
    const provider = new OpenAIResponsesChatProvider({
      model: 'grok-4',
      apiKey: 'sk-probe',
      offEffort: 'none',
    });

    const body = await captureResponsesBody(provider, { thinking: { effort: 'off' } });

    expect(body['reasoning']).toEqual({ effort: 'none', summary: 'auto' });
  });

  it('disables the auto-enable entirely once a withThinking hook exists (load-bearing)', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'sk-probe',
      stream: false,
      hooks: { withThinking: () => undefined },
    });

    const scanned = await captureOpenAIBody(provider, undefined, THINK_HISTORY);
    expect(scanned).not.toHaveProperty('reasoning_effort');

    const explicit = await captureOpenAIBody(provider, { thinking: { effort: 'low' } });
    expect(explicit['reasoning_effort']).toBe('low');
  });
});

describe('429 wire behavior over real HTTP (no hidden SDK retry)', () => {
  async function with429Server(
    body: Record<string, unknown>,
    run: (port: number, requestCount: () => number) => Promise<void>,
  ): Promise<void> {
    let count = 0;
    const server = createServer((_req, res) => {
      count += 1;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('server has no address');
      }
      await run(address.port, () => count);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }

  it.each([
    {
      protocol: 'openai',
      modelName: 'gpt-4o',
      baseUrlPath: '/v1',
      body: { error: { message: 'slow down', type: 'rate_limit_error' } },
    },
    {
      protocol: 'openai_responses',
      modelName: 'gpt-5',
      baseUrlPath: '/v1',
      body: { error: { message: 'slow down', type: 'rate_limit_error' } },
    },
    {
      protocol: 'anthropic',
      modelName: 'claude-opus-4-6',
      baseUrlPath: '',
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
    },
    {
      protocol: 'google-genai',
      modelName: 'gemini-2.5-flash',
      baseUrlPath: '',
      body: {
        error: {
          code: 429,
          message: 'Resource exhausted',
          status: 'RESOURCE_EXHAUSTED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5s' }],
        },
      },
    },
  ] as const)(
    'the first 429 reaches the caller after exactly one request with the 5s server delay ($protocol)',
    async ({ protocol, modelName, baseUrlPath, body }) => {
      await with429Server(body, async (port, requestCount) => {
        const provider = registry.createChatProvider({
          protocol,
          modelName,
          apiKey: 'sk-probe',
          baseUrl: `http://127.0.0.1:${String(port)}${baseUrlPath}`,
        });
        const rejected: unknown = await provider.generate('sys', [], PROBE_HISTORY).then(
          () => {
            throw new Error('expected generate to reject');
          },
          (error: unknown) => error,
        );
        expect(rejected).toBeInstanceOf(APIProviderRateLimitError);
        expect((rejected as APIStatusError).retryAfterMs).toBe(5000);
        expect(requestCount()).toBe(1);
      });
    },
  );
});

describe('OpenAI Responses custom tool input', () => {
  const textTool: Tool = {
    name: 'apply_patch',
    description: 'Apply a patch.',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    },
    inputFormat: { type: 'text', grammar: { syntax: 'lark', definition: 'start: /.+/' } },
  };

  it('declares only text-input tools as custom while retaining ordinary functions', async () => {
    const provider = responsesProvider();
    const rig = mockResponsesClient(provider, [RESPONSES_COMPLETED]);
    await drain(await provider.generate('', [
      textTool,
      { ...textTool, name: 'free_text', inputFormat: { type: 'text' } },
      { name: 'lookup', description: 'Find a value.', parameters: { type: 'object' } },
    ], PROBE_HISTORY));
    expect(rig.params()?.['tools']).toEqual([
      {
        type: 'custom', name: 'apply_patch', description: 'Apply a patch.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' },
      },
      { type: 'custom', name: 'free_text', description: 'Apply a patch.', format: { type: 'text' } },
      { type: 'function', name: 'lookup', description: 'Find a value.', parameters: { type: 'object' }, strict: false },
    ]);
  });

  it('keeps the JSON function schema on the Chat Completions wire', async () => {
    const provider = new OpenAILegacyChatProvider({ model: 'gpt-4.1', apiKey: 'sk-probe' });
    const body = await captureOpenAIBody(provider, undefined, PROBE_HISTORY, [textTool]);
    expect(body['tools']).toEqual([{
      type: 'function',
      function: { name: 'apply_patch', description: 'Apply a patch.', parameters: textTool.parameters },
    }]);
  });

  it('assembles interleaved custom and function calls with escaped input and final suffixes', async () => {
    const provider = responsesProvider();
    const raw = 'line "one"\nC:\\example\\x\n中文 😀';
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', id: 'ctc_a', call_id: 'call_a', name: 'apply_patch', input: '' } },
      { type: 'response.custom_tool_call_input.delta', output_index: 0, delta: 'line "one"\n' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'lookup', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{"key":' },
      { type: 'response.custom_tool_call_input.delta', item_id: 'ctc_a', delta: 'C:\\example\\x\n' },
      { type: 'response.custom_tool_call_input.done', item_id: 'ctc_a', input: raw },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'custom_tool_call', id: 'ctc_a', call_id: 'call_a', name: 'apply_patch', input: raw } },
      { type: 'response.function_call_arguments.done', item_id: 'fc_b', arguments: '{"key":"value"}' },
      RESPONSES_COMPLETED,
    ]);
    const result = await generate(provider, '', [textTool], PROBE_HISTORY);
    expect(result.message.toolCalls).toEqual([
      { type: 'function', id: 'call_a', name: 'apply_patch', arguments: JSON.stringify({ input: raw }), extras: { openaiResponses: { type: 'custom_tool_call' } } },
      { type: 'function', id: 'call_b', name: 'lookup', arguments: '{"key":"value"}', extras: undefined },
    ]);
  });

  it('uses the item completion input when no custom input deltas arrive', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', id: 'ctc_a', call_id: 'call_a', name: 'apply_patch', input: '' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'custom_tool_call', id: 'ctc_a', call_id: 'call_a', name: 'apply_patch', input: 'complete patch' } },
      RESPONSES_COMPLETED,
    ]);
    const result = await generate(provider, '', [textTool], PROBE_HISTORY);
    expect(result.message.toolCalls[0]?.arguments).toBe('{"input":"complete patch"}');
  });

  it('closes custom input on terminal completion when optional input done events are absent', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', id: 'ctc_a', call_id: 'call_a', name: 'apply_patch', input: 'patch' } },
      RESPONSES_COMPLETED,
    ]);
    const result = await generate(provider, '', [textTool], PROBE_HISTORY);
    expect(result.message.toolCalls[0]?.arguments).toBe('{"input":"patch"}');
    expect(result.finishReason).toBe('completed');
    expect(result.rawFinishReason).toBe('completed');
  });

  it('rejects a custom completion that disagrees with its streamed input', async () => {
    const stream = new OpenAIResponsesStreamedMessage(emit([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', id: 'ctc_a', call_id: 'call_a', name: 'apply_patch', input: 'first' } },
      { type: 'response.custom_tool_call_input.done', item_id: 'ctc_a', input: 'different' },
      RESPONSES_COMPLETED,
    ]), true);
    await expect(collectParts(stream)).rejects.toThrow('does not match the streamed input deltas');
  });

  it('rejects custom input deltas without a corresponding output item', async () => {
    const stream = new OpenAIResponsesStreamedMessage(emit([
      { type: 'response.custom_tool_call_input.delta', item_id: 'ctc_missing', delta: 'patch' },
      RESPONSES_COMPLETED,
    ]), true);
    await expect(collectParts(stream)).rejects.toThrow('unknown output item');
  });

  it('decodes non-stream custom calls into executable JSON arguments', async () => {
    const stream = new OpenAIResponsesStreamedMessage({
      id: 'resp_a', status: 'completed',
      output: [{ type: 'custom_tool_call', id: 'ctc_a', call_id: 'call_a', name: 'apply_patch', input: 'a\n"b"' }],
    }, false);
    expect(await collectParts(stream)).toEqual([{
      type: 'function', id: 'call_a', name: 'apply_patch', arguments: '{"input":"a\\n\\\"b\\\""}',
      extras: { openaiResponses: { type: 'custom_tool_call' } },
    }]);
    expect(stream.finishReason).toBe('completed');
    expect(stream.rawFinishReason).toBe('completed');
  });

  it('replays persisted custom call and result types without changing ordinary function results', async () => {
    const history: Message[] = JSON.parse(JSON.stringify([
      { role: 'assistant', content: [], toolCalls: [
        { type: 'function', id: 'call_a', name: 'apply_patch', arguments: '{"input":"line 1\\nline 2"}', extras: { openaiResponses: { type: 'custom_tool_call' } } },
        { type: 'function', id: 'call_b', name: 'lookup', arguments: '{}' },
      ] },
      { role: 'tool', content: [{ type: 'text', text: 'Applied.' }], toolCalls: [], toolCallId: 'call_a' },
      { role: 'tool', content: [{ type: 'text', text: 'Found.' }], toolCalls: [], toolCallId: 'call_b' },
    ]));
    const body = await captureResponsesBody(responsesProvider(), undefined, history);
    expect(body['input']).toEqual([
      { type: 'custom_tool_call', call_id: 'call_a', name: 'apply_patch', input: 'line 1\nline 2' },
      { type: 'function_call', call_id: 'call_b', name: 'lookup', arguments: '{}' },
      { type: 'custom_tool_call_output', call_id: 'call_a', output: [{ type: 'input_text', text: 'Applied.' }] },
      { type: 'function_call_output', call_id: 'call_b', output: [{ type: 'input_text', text: 'Found.' }] },
    ]);
  });

  it('replays interrupted custom input without requiring a completed JSON envelope', async () => {
    const body = await captureResponsesBody(responsesProvider(), undefined, [{
      role: 'assistant', partial: true, content: [], toolCalls: [{
        type: 'function', id: 'call_a', name: 'apply_patch', arguments: '{"input":"partial\\npatch',
        extras: { openaiResponses: { type: 'custom_tool_call' } },
      }],
    }]);
    expect(body['input']).toEqual([
      { type: 'custom_tool_call', call_id: 'call_a', name: 'apply_patch', input: 'partial\npatch' },
    ]);
  });
});

describe('OpenAI Responses output-item identity (stream decoding)', () => {
  it('normalizes a streamed refusal as filtered while preserving visible text and replay type', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: messageItem('msg_refusal') },
      { type: 'response.refusal.delta', item_id: 'msg_refusal', output_index: 0, delta: 'I cannot ' },
      { type: 'response.refusal.delta', item_id: 'msg_refusal', output_index: 0, delta: 'help with that.' },
      {
        type: 'response.refusal.done',
        item_id: 'msg_refusal',
        output_index: 0,
        refusal: 'I cannot help with that.',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          ...messageItem('msg_refusal', 'final_answer'),
          content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
        },
      },
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.finishReason).toBe('filtered');
    expect(result.rawFinishReason).toBe('refusal');
    expect(result.message.content).toEqual([
      {
        type: 'text',
        text: 'I cannot help with that.',
        openaiResponses: { itemId: 'msg_refusal', phase: 'final_answer', contentType: 'refusal' },
      },
    ]);
    const body = await captureResponsesBody(provider, undefined, [result.message]);
    expect(body['input']).toEqual([
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_refusal',
        phase: 'final_answer',
        content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
      },
    ]);
  });

  it('preserves refusal content when decoding a non-streaming assistant message', async () => {
    const stream = new OpenAIResponsesStreamedMessage(
      {
        id: 'resp_refusal',
        status: 'completed',
        output: [{
          type: 'message',
          id: 'msg_refusal',
          phase: 'final_answer',
          content: [
            { type: 'output_text', text: 'About your request: ' },
            { type: 'refusal', refusal: 'I cannot help with that.' },
          ],
        }],
      },
      false,
    );

    expect(await collectParts(stream)).toEqual([
      { type: 'text', text: 'About your request: ', openaiResponses: { itemId: 'msg_refusal', phase: 'final_answer' } },
      {
        type: 'text',
        text: 'I cannot help with that.',
        openaiResponses: { itemId: 'msg_refusal', phase: 'final_answer', contentType: 'refusal' },
      },
    ]);
    expect(stream.finishReason).toBe('filtered');
    expect(stream.rawFinishReason).toBe('refusal');
  });

  it('normalizes refusal recorded only in the terminal output without inventing streamed content', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_text.delta', delta: 'Visible response.' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_refusal', status: 'completed', output: [{
            ...messageItem('msg_refusal'),
            content: [{ type: 'refusal', refusal: 'Refused.' }],
          }],
        },
      },
    ]);
    const result = await generate(provider, '', [], PROBE_HISTORY);
    expect(result.message.content).toEqual([{ type: 'text', text: 'Visible response.' }]);
    expect(result.finishReason).toBe('filtered');
    expect(result.rawFinishReason).toBe('refusal');
  });

  it.each(['completed', 'incomplete'] as const)('keeps refusal filtered under the %s terminal status', async (status) => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.refusal.delta', delta: 'Refused.' },
      {
        type: `response.${status}`,
        response: { id: 'resp_refusal', status, incomplete_details: { reason: 'max_output_tokens' } },
      },
    ]);
    const result = await generate(provider, '', [], PROBE_HISTORY);
    expect(result.finishReason).toBe('filtered');
    expect(result.rawFinishReason).toBe('refusal');
    expect(result.message.content).toEqual([{ type: 'text', text: 'Refused.', openaiResponses: { contentType: 'refusal' } }]);
  });

  it('keeps a message item as one part and folds the phase its done event reports', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.created', response: { id: 'resp_probe' } },
      { type: 'response.output_item.added', output_index: 0, item: messageItem('msg_1') },
      textDelta('msg_1', 0, 'Hello '),
      textDelta('msg_1', 0, 'world'),
      { type: 'response.output_item.done', output_index: 0, item: messageItem('msg_1', 'final_answer') },
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([
      {
        type: 'text',
        text: 'Hello world',
        openaiResponses: { itemId: 'msg_1', phase: 'final_answer' },
      },
    ]);
  });

  it('does not merge streamed text across two message items', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: messageItem('msg_a') },
      textDelta('msg_a', 0, 'first'),
      { type: 'response.output_item.done', output_index: 0, item: messageItem('msg_a') },
      { type: 'response.output_item.added', output_index: 1, item: messageItem('msg_b') },
      textDelta('msg_b', 1, 'second'),
      { type: 'response.output_item.done', output_index: 1, item: messageItem('msg_b') },
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([
      { type: 'text', text: 'first', openaiResponses: { itemId: 'msg_a' } },
      { type: 'text', text: 'second', openaiResponses: { itemId: 'msg_b' } },
    ]);
  });

  it('recovers the item id by output index when the done event omits it', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 3, item: messageItem('legacy-item-7') },
      textDelta('legacy-item-7', 3, 'kept'),
      {
        type: 'response.output_item.done',
        output_index: 3,
        item: { type: 'message', role: 'assistant', phase: 'commentary' },
      },
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([
      {
        type: 'text',
        text: 'kept',
        openaiResponses: { itemId: 'legacy-item-7', phase: 'commentary' },
      },
    ]);
  });

  it('emits no empty text part when a message item streamed no text', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: messageItem('msg_1') },
      { type: 'response.output_item.done', output_index: 0, item: messageItem('msg_1', 'commentary') },
      RESPONSES_COMPLETED,
    ]);

    expect(await collectParts(await provider.generate('', [], PROBE_HISTORY))).toEqual([]);
  });

  it('keeps adjacent reasoning items separate, each with its own id and encrypted content', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
      reasoningDelta('rs_1', 0, 'first thought'),
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-1' },
      },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: 'rs_2' } },
      reasoningDelta('rs_2', 1, 'second thought'),
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'reasoning', id: 'rs_2', encrypted_content: 'enc-2' },
      },
      { type: 'response.output_item.added', output_index: 2, item: messageItem('msg_1') },
      textDelta('msg_1', 2, 'answer'),
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([
      {
        type: 'think',
        think: 'first thought',
        encrypted: 'enc-1',
        openaiResponses: { itemId: 'rs_1' },
      },
      {
        type: 'think',
        think: 'second thought',
        encrypted: 'enc-2',
        openaiResponses: { itemId: 'rs_2' },
      },
      { type: 'text', text: 'answer', openaiResponses: { itemId: 'msg_1' } },
    ]);
  });

  it('keeps an encrypted reasoning item that streamed no summary text', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-1' },
      },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'answer' },
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([
      { type: 'think', think: '', encrypted: 'enc-1', openaiResponses: { itemId: 'rs_1' } },
      { type: 'text', text: 'answer', openaiResponses: { itemId: 'msg_1' } },
    ]);
  });

  it('keeps interleaved message and reasoning items in stream order', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: messageItem('msg_1') },
      textDelta('msg_1', 0, 'before '),
      { type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: 'rs_1' } },
      reasoningDelta('rs_1', 1, 'why'),
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-1' },
      },
      { type: 'response.output_item.added', output_index: 2, item: messageItem('msg_2') },
      textDelta('msg_2', 2, 'after'),
      { type: 'response.output_item.done', output_index: 2, item: messageItem('msg_2') },
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([
      { type: 'text', text: 'before ', openaiResponses: { itemId: 'msg_1' } },
      { type: 'think', think: 'why', encrypted: 'enc-1', openaiResponses: { itemId: 'rs_1' } },
      { type: 'text', text: 'after', openaiResponses: { itemId: 'msg_2' } },
    ]);
  });

  it('decodes item identity from a non-streaming response body', async () => {
    const stream = new OpenAIResponsesStreamedMessage(
      {
        id: 'resp_probe',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_1',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'answer' }],
          },
          {
            type: 'reasoning',
            id: 'rs_1',
            encrypted_content: 'enc-1',
            summary: [{ type: 'summary_text', text: 'why' }],
          },
        ],
      },
      false,
    );

    expect(await collectParts(stream)).toEqual([
      {
        type: 'text',
        text: 'answer',
        openaiResponses: { itemId: 'msg_1', phase: 'final_answer' },
      },
      { type: 'think', think: 'why', encrypted: 'enc-1', openaiResponses: { itemId: 'rs_1' } },
    ]);
  });

  it('folds a reasoning item with several summary parts into one think part', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      {
        type: 'response.reasoning_summary_part.added',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
      },
      reasoningDelta('rs_1', 0, 'first summary'),
      {
        type: 'response.reasoning_summary_part.added',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 1,
      },
      reasoningDelta('rs_1', 0, 'second summary'),
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-1' },
      },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'answer' },
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([
      {
        type: 'think',
        think: 'first summarysecond summary',
        encrypted: 'enc-1',
        openaiResponses: { itemId: 'rs_1' },
      },
      { type: 'text', text: 'answer', openaiResponses: { itemId: 'msg_1' } },
    ]);
  });

  it('leaves a backend that sends no item identity with the legacy part shape', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_text.delta', delta: 'Hello' },
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('keeps legacy untagged reasoning encrypted content on the streamed part', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.reasoning_summary_text.delta', delta: 'because' },
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', encrypted_content: 'enc-1' },
      },
      { type: 'response.output_text.delta', delta: 'answer' },
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([
      { type: 'think', think: 'because', encrypted: 'enc-1' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('delivers the done-event phase and encrypted content as late update parts', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
      reasoningDelta('rs_1', 0, 'because'),
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-1' },
      },
      { type: 'response.output_item.added', output_index: 1, item: messageItem('msg_1') },
      textDelta('msg_1', 1, 'answer'),
      { type: 'response.output_item.done', output_index: 1, item: messageItem('msg_1', 'final_answer') },
      RESPONSES_COMPLETED,
    ]);

    expect(await collectClonedParts(await provider.generate('', [], PROBE_HISTORY))).toEqual([
      { type: 'think', think: 'because', openaiResponses: { itemId: 'rs_1' } },
      { type: 'think', think: '', encrypted: 'enc-1', openaiResponses: { itemId: 'rs_1' } },
      { type: 'text', text: 'answer', openaiResponses: { itemId: 'msg_1' } },
      { type: 'text', text: '', openaiResponses: { itemId: 'msg_1', phase: 'final_answer' } },
    ]);
  });

  it('replays interleaved reasoning items once each with their encrypted content', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_a' } },
      reasoningDelta('rs_a', 0, 'A1'),
      { type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: 'rs_b' } },
      reasoningDelta('rs_b', 1, 'B1'),
      reasoningDelta('rs_a', 0, 'A2'),
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_a', encrypted_content: 'enc-a' },
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'reasoning', id: 'rs_b', encrypted_content: 'enc-b' },
      },
      { type: 'response.output_item.added', output_index: 2, item: messageItem('msg_1') },
      textDelta('msg_1', 2, 'answer'),
      RESPONSES_COMPLETED,
    ]);

    const first = await generate(provider, '', [], PROBE_HISTORY);

    expect(first.message.content).toEqual([
      { type: 'think', think: 'A1', openaiResponses: { itemId: 'rs_a' } },
      { type: 'think', think: 'B1', encrypted: 'enc-b', openaiResponses: { itemId: 'rs_b' } },
      { type: 'think', think: 'A2', encrypted: 'enc-a', openaiResponses: { itemId: 'rs_a' } },
      { type: 'text', text: 'answer', openaiResponses: { itemId: 'msg_1' } },
    ]);

    const replay = mockResponsesClient(provider, RESPONSES_NON_EMPTY_REPLY);
    await generate(provider, '', [], [...PROBE_HISTORY, first.message]);

    expect(replay.params()?.['input']).toEqual([
      { content: [{ type: 'input_text', text: 'Hi' }], role: 'user', type: 'message' },
      {
        summary: [
          { type: 'summary_text', text: 'A1' },
          { type: 'summary_text', text: 'A2' },
        ],
        type: 'reasoning',
        encrypted_content: 'enc-a',
        id: 'rs_a',
      },
      {
        summary: [{ type: 'summary_text', text: 'B1' }],
        type: 'reasoning',
        encrypted_content: 'enc-b',
        id: 'rs_b',
      },
      {
        content: [{ type: 'output_text', text: 'answer', annotations: [] }],
        role: 'assistant',
        type: 'message',
        id: 'msg_1',
      },
    ]);
  });

  it('takes the phase from the added event when the done event omits it', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: messageItem('msg_1', 'commentary') },
      textDelta('msg_1', 0, 'answer'),
      { type: 'response.output_item.done', output_index: 0, item: messageItem('msg_1') },
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([
      { type: 'text', text: 'answer', openaiResponses: { itemId: 'msg_1', phase: 'commentary' } },
    ]);
  });

  it('matches a delta that carries only an item id to its later done event', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'answer' },
      { type: 'response.output_item.done', output_index: 0, item: messageItem('msg_1', 'final_answer') },
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([
      { type: 'text', text: 'answer', openaiResponses: { itemId: 'msg_1', phase: 'final_answer' } },
    ]);
  });

  it('keeps a phase that arrives after a tool call already flushed the item text', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: messageItem('msg_1') },
      textDelta('msg_1', 0, 'answer'),
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Bash' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 1,
        delta: '{"command":"ls"}',
      },
      { type: 'response.output_item.done', output_index: 0, item: messageItem('msg_1', 'final_answer') },
      RESPONSES_COMPLETED,
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([
      { type: 'text', text: 'answer', openaiResponses: { itemId: 'msg_1', phase: 'final_answer' } },
    ]);
    expect(result.message.toolCalls).toHaveLength(1);
    expect(result.message.toolCalls[0]?.id).toBe('call_1');
  });

  it('groups interleaved message items by their real item on the next request', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: messageItem('msg_a') },
      { type: 'response.output_item.added', output_index: 1, item: messageItem('msg_b') },
      textDelta('msg_a', 0, 'alpha '),
      textDelta('msg_b', 1, 'bravo '),
      textDelta('msg_a', 0, 'one'),
      textDelta('msg_b', 1, 'two'),
      { type: 'response.output_item.done', output_index: 0, item: messageItem('msg_a', 'final_answer') },
      { type: 'response.output_item.done', output_index: 1, item: messageItem('msg_b', 'commentary') },
      RESPONSES_COMPLETED,
    ]);

    const first = await generate(provider, '', [], PROBE_HISTORY);

    expect(first.message.content).toEqual([
      { type: 'text', text: 'alpha ', openaiResponses: { itemId: 'msg_a', phase: 'final_answer' } },
      { type: 'text', text: 'bravo ', openaiResponses: { itemId: 'msg_b', phase: 'commentary' } },
      { type: 'text', text: 'one', openaiResponses: { itemId: 'msg_a', phase: 'final_answer' } },
      { type: 'text', text: 'two', openaiResponses: { itemId: 'msg_b', phase: 'commentary' } },
    ]);

    const replay = mockResponsesClient(provider, RESPONSES_NON_EMPTY_REPLY);
    await generate(provider, '', [], [...PROBE_HISTORY, first.message]);

    expect(replay.params()?.['input']).toEqual([
      { content: [{ type: 'input_text', text: 'Hi' }], role: 'user', type: 'message' },
      {
        content: [
          { type: 'output_text', text: 'alpha ', annotations: [] },
          { type: 'output_text', text: 'one', annotations: [] },
        ],
        role: 'assistant',
        type: 'message',
        id: 'msg_a',
        phase: 'final_answer',
      },
      {
        content: [
          { type: 'output_text', text: 'bravo ', annotations: [] },
          { type: 'output_text', text: 'two', annotations: [] },
        ],
        role: 'assistant',
        type: 'message',
        id: 'msg_b',
        phase: 'commentary',
      },
    ]);
  });
});

describe('OpenAI Responses replay (item id, phase, encrypted reasoning)', () => {
  it('preserves phase boundaries when replayed assistant parts have no item ids', async () => {
    const provider = responsesProvider();
    const body = await captureResponsesBody(provider, undefined, [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking ', openaiResponses: { phase: 'commentary' } },
          { type: 'text', text: 'logs.', openaiResponses: { phase: 'commentary' } },
          { type: 'text', text: 'Legacy text.' },
          { type: 'text', text: 'Fixed.', openaiResponses: { phase: 'final_answer' } },
        ],
        toolCalls: [],
      },
    ]);

    expect(body['input']).toEqual([
      {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [
          { type: 'output_text', text: 'Checking ', annotations: [] },
          { type: 'output_text', text: 'logs.', annotations: [] },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Legacy text.', annotations: [] }],
      },
      {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Fixed.', annotations: [] }],
      },
    ]);
  });

  const RECORDED_TURN: Message = {
    role: 'assistant',
    content: [
      { type: 'think', think: 'because', encrypted: 'enc-1', openaiResponses: { itemId: 'rs_1' } },
      {
        type: 'text',
        text: 'answer',
        openaiResponses: { itemId: 'msg_1', phase: 'final_answer' },
      },
    ],
    toolCalls: [],
  };

  it('plays back the recorded item ids, phase and encrypted reasoning', async () => {
    const provider = responsesProvider();

    const body = await captureResponsesBody(provider, undefined, [...PROBE_HISTORY, RECORDED_TURN]);

    expect(body['input']).toEqual([
      { content: [{ type: 'input_text', text: 'Hi' }], role: 'user', type: 'message' },
      {
        summary: [{ type: 'summary_text', text: 'because' }],
        type: 'reasoning',
        encrypted_content: 'enc-1',
        id: 'rs_1',
      },
      {
        content: [{ type: 'output_text', text: 'answer', annotations: [] }],
        role: 'assistant',
        type: 'message',
        id: 'msg_1',
        phase: 'final_answer',
      },
    ]);
  });

  it('splits replayed assistant text at item boundaries into separate input messages', async () => {
    const provider = responsesProvider();
    const history: Message[] = [
      ...PROBE_HISTORY,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first', openaiResponses: { itemId: 'msg_a' } },
          { type: 'text', text: 'second', openaiResponses: { itemId: 'msg_b', phase: 'commentary' } },
        ],
        toolCalls: [],
      },
    ];

    const body = await captureResponsesBody(provider, undefined, history);

    expect(body['input']).toEqual([
      { content: [{ type: 'input_text', text: 'Hi' }], role: 'user', type: 'message' },
      {
        content: [{ type: 'output_text', text: 'first', annotations: [] }],
        role: 'assistant',
        type: 'message',
        id: 'msg_a',
      },
      {
        content: [{ type: 'output_text', text: 'second', annotations: [] }],
        role: 'assistant',
        type: 'message',
        id: 'msg_b',
        phase: 'commentary',
      },
    ]);
  });

  it('does not invent an id or phase for legacy history', async () => {
    const provider = responsesProvider();
    const history: Message[] = [
      ...PROBE_HISTORY,
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'plain thought' },
          { type: 'text', text: 'plain answer' },
        ],
        toolCalls: [],
      },
    ];

    const body = await captureResponsesBody(provider, undefined, history);

    expect(body['input']).toEqual([
      { content: [{ type: 'input_text', text: 'Hi' }], role: 'user', type: 'message' },
      { summary: [{ type: 'summary_text', text: 'plain thought' }], type: 'reasoning' },
      {
        content: [{ type: 'output_text', text: 'plain answer', annotations: [] }],
        role: 'assistant',
        type: 'message',
      },
    ]);
  });

  it('replays a decoded reasoning item with its id and encrypted content', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
      reasoningDelta('rs_1', 0, 'because'),
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-1' },
      },
      { type: 'response.output_item.added', output_index: 1, item: messageItem('msg_1') },
      textDelta('msg_1', 1, 'answer'),
      { type: 'response.output_item.done', output_index: 1, item: messageItem('msg_1', 'final_answer') },
      RESPONSES_COMPLETED,
    ]);

    const first = await generate(provider, '', [], PROBE_HISTORY);

    expect(first.message.content).toEqual([
      { type: 'think', think: 'because', encrypted: 'enc-1', openaiResponses: { itemId: 'rs_1' } },
      { type: 'text', text: 'answer', openaiResponses: { itemId: 'msg_1', phase: 'final_answer' } },
    ]);

    const replay = mockResponsesClient(provider, RESPONSES_NON_EMPTY_REPLY);
    await generate(provider, '', [], [...PROBE_HISTORY, first.message]);

    expect(replay.params()?.['input']).toEqual([
      { content: [{ type: 'input_text', text: 'Hi' }], role: 'user', type: 'message' },
      {
        summary: [{ type: 'summary_text', text: 'because' }],
        type: 'reasoning',
        encrypted_content: 'enc-1',
        id: 'rs_1',
      },
      {
        content: [{ type: 'output_text', text: 'answer', annotations: [] }],
        role: 'assistant',
        type: 'message',
        id: 'msg_1',
        phase: 'final_answer',
      },
    ]);
  });

  it('stores but does not replay a prefix-less legacy item id', async () => {
    const provider = responsesProvider();
    const history: Message[] = [
      ...PROBE_HISTORY,
      {
        role: 'assistant',
        content: [
          {
            type: 'think',
            think: 'why',
            encrypted: 'enc-1',
            openaiResponses: { itemId: 'legacy-rs' },
          },
          {
            type: 'text',
            text: 'answer',
            openaiResponses: { itemId: 'legacy-item-7', phase: 'final_answer' },
          },
        ],
        toolCalls: [],
      },
    ];

    const body = await captureResponsesBody(provider, undefined, history);

    expect(body['input']).toEqual([
      { content: [{ type: 'input_text', text: 'Hi' }], role: 'user', type: 'message' },
      { summary: [{ type: 'summary_text', text: 'why' }], type: 'reasoning', encrypted_content: 'enc-1' },
      {
        content: [{ type: 'output_text', text: 'answer', annotations: [] }],
        role: 'assistant',
        type: 'message',
        phase: 'final_answer',
      },
    ]);
  });

  it('does not leak Responses metadata onto another provider wire', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureOpenAIBody(provider, undefined, [...PROBE_HISTORY, RECORDED_TURN]);

    expect(JSON.stringify(body)).not.toContain('openaiResponses');
    expect(JSON.stringify(body)).not.toContain('msg_1');
    expect(JSON.stringify(body)).not.toContain('final_answer');
  });
});

describe('OpenAI Responses encrypted-reasoning request and Codex session cache', () => {
  it('requests encrypted reasoning when the turn passes no options at all', async () => {
    const provider = responsesProvider();

    const body = await captureResponsesBody(provider);

    expect(body['include']).toEqual(['reasoning.encrypted_content']);
    expect(body).not.toHaveProperty('reasoning');
    expect(body['store']).toBe(false);
  });

  it('requests encrypted reasoning when options carry no thinking field', async () => {
    const provider = responsesProvider();

    const body = await captureResponsesBody(provider, { cacheKey: 'session-42' });

    expect(body['include']).toEqual(['reasoning.encrypted_content']);
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('requests encrypted reasoning for thinking:on without sending an effort', async () => {
    const provider = responsesProvider();

    const body = await captureResponsesBody(provider, { thinking: { effort: 'on' } });

    expect(body['include']).toEqual(['reasoning.encrypted_content']);
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('requests encrypted reasoning alongside a concrete effort', async () => {
    const provider = responsesProvider();

    const body = await captureResponsesBody(provider, { thinking: { effort: 'high' } });

    expect(body['include']).toEqual(['reasoning.encrypted_content']);
    expect(body['reasoning']).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('sends the turn cache key as the session-id header on the official Codex backend', async () => {
    const provider = responsesProvider({ baseUrl: 'https://chatgpt.com/backend-api/codex' });
    const rig = mockResponsesClient(provider, [RESPONSES_COMPLETED]);

    await provider.generate('', [], PROBE_HISTORY, { cacheKey: 'session-42' });

    expect(rig.requestOptions()).toEqual({ headers: { 'session-id': 'session-42' } });
  });

  it('does not send the Codex session header to a plain OpenAI endpoint', async () => {
    const provider = responsesProvider({ baseUrl: 'https://api.openai.com/v1' });
    const rig = mockResponsesClient(provider, [RESPONSES_COMPLETED]);

    await provider.generate('', [], PROBE_HISTORY, { cacheKey: 'session-42' });

    expect(rig.requestOptions()).toBeUndefined();
  });

  it('sends no session header for a Codex turn without a cache key', async () => {
    const provider = responsesProvider({ baseUrl: 'https://chatgpt.com/backend-api/codex' });
    const rig = mockResponsesClient(provider, [RESPONSES_COMPLETED]);

    await provider.generate('', [], PROBE_HISTORY);

    expect(rig.requestOptions()).toBeUndefined();
  });

  it('keeps a configured session-id header over the cache key regardless of case', async () => {
    const provider = responsesProvider({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      defaultHeaders: { 'Session-Id': 'configured-session' },
    });
    const rig = mockResponsesClient(provider, [RESPONSES_COMPLETED]);

    await provider.generate('', [], PROBE_HISTORY, { cacheKey: 'session-42' });

    expect(rig.requestOptions()).toBeUndefined();
  });

  it('keeps an auth-provided session-id header over the cache key regardless of case', async () => {
    let capturedRequestOptions: Record<string, unknown> | undefined;
    const stub = {
      responses: {
        create: vi.fn().mockImplementation((_params: unknown, requestOptions: unknown) => {
          capturedRequestOptions = requestOptions as Record<string, unknown> | undefined;
          return Promise.resolve(emit([RESPONSES_COMPLETED]));
        }),
      },
    } as unknown as OpenAI;
    const provider = responsesProvider({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      clientFactory: () => stub,
    });

    await provider.generate('', [], PROBE_HISTORY, {
      cacheKey: 'session-42',
      auth: { apiKey: 'sk-auth', headers: { 'SESSION-ID': 'from-auth' } },
    });

    expect(capturedRequestOptions).toBeUndefined();
  });

  it('sends each turn its own cache key without mutating the shared client', async () => {
    const provider = responsesProvider({ baseUrl: 'https://chatgpt.com/backend-api/codex' });
    const rig = mockResponsesClient(provider, [RESPONSES_COMPLETED]);

    await provider.generate('', [], PROBE_HISTORY, { cacheKey: 'session-a' });
    const firstHeaders = rig.requestOptions()?.['headers'];
    await provider.generate('', [], PROBE_HISTORY, { cacheKey: 'session-b' });

    expect(firstHeaders).toEqual({ 'session-id': 'session-a' });
    expect(rig.requestOptions()?.['headers']).toEqual({ 'session-id': 'session-b' });
  });

  it('keeps the abort signal on the request options alongside the session header', async () => {
    const provider = responsesProvider({ baseUrl: 'https://chatgpt.com/backend-api/codex' });
    const rig = mockResponsesClient(provider, [RESPONSES_COMPLETED]);
    const controller = new AbortController();

    await provider.generate('', [], PROBE_HISTORY, {
      cacheKey: 'session-42',
      signal: controller.signal,
    });

    expect(rig.requestOptions()).toEqual({
      signal: controller.signal,
      headers: { 'session-id': 'session-42' },
    });
  });
});

describe('OpenAI Responses stream termination', () => {
  it.each([
    { status: 'completed', finishReason: 'completed' },
    { status: 'incomplete', finishReason: 'truncated' },
  ])('finishes on $status without reading beyond the terminal event', async ({ status, finishReason }) => {
    const provider = responsesProvider();
    let released = false;
    async function* stream(): AsyncIterable<unknown> {
      try {
        yield { type: 'response.output_text.delta', delta: 'answer' };
        yield {
          type: `response.${status}`,
          response: {
            id: 'resp_terminal',
            status,
            incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
            usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } },
          },
        };
        throw new Error('connection failed after terminal event');
      } finally {
        released = true;
      }
    }
    mockResponsesClient(provider, stream());

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([{ type: 'text', text: 'answer' }]);
    expect(result.finishReason).toBe(finishReason);
    expect(result.usage).toEqual({ inputOther: 8, inputCacheRead: 4, inputCacheCreation: 0, output: 3 });
    expect(released).toBe(true);
  });

  it('fails with APIConnectionError when the stream ends without a terminal event', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_text.delta', delta: 'partial answer' },
    ]);

    const caught: unknown = await provider
      .generate('', [], PROBE_HISTORY)
      .then((stream) => drain(stream))
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(caught).toBeInstanceOf(APIConnectionError);
  });

  it('does not run tool calls recorded before a stream ended without its terminal event', async () => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Bash' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 0,
        delta: '{"command":"ls"}',
      },
    ]);
    const onToolCall = vi.fn();

    const caught: unknown = await generate(provider, '', [], PROBE_HISTORY, { onToolCall }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(APIConnectionError);
    expect(onToolCall).not.toHaveBeenCalled();
  });

  it.each([
    ['max_output_tokens', 'truncated'], ['content_filter', 'filtered'],
  ] as const)('preserves the ordinary incomplete %s finish as %s', async (reason, finishReason) => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      { type: 'response.output_text.delta', delta: 'truncated answer' },
      {
        type: 'response.incomplete',
        response: {
          id: 'resp_probe',
          status: 'incomplete',
          incomplete_details: { reason },
        },
      },
    ]);

    const result = await generate(provider, '', [], PROBE_HISTORY);

    expect(result.message.content).toEqual([{ type: 'text', text: 'truncated answer' }]);
    expect(result.finishReason).toBe(finishReason);
    expect(result.rawFinishReason).toBe(reason);
  });

  it.each([false, true])('keeps response.failed as its own error with preceding refusal=%s', async (refused) => {
    const provider = responsesProvider();
    mockResponsesClient(provider, [
      ...(refused ? [{ type: 'response.refusal.delta', delta: 'Refused.' }] : []),
      {
        type: 'response.failed',
        response: { id: 'resp_probe', status: 'failed', error: { code: 'server_error', message: 'boom' } },
      },
    ]);

    const caught: unknown = await provider
      .generate('', [], PROBE_HISTORY)
      .then((stream) => drain(stream))
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(caught).toBeInstanceOf(ChatProviderError);
    expect(caught).not.toBeInstanceOf(APIConnectionError);
  });

  it('surfaces a mid-stream abort as an AbortError rather than a connection error', async () => {
    const provider = responsesProvider();
    async function* abortingStream(): AsyncIterable<unknown> {
      yield { type: 'response.output_text.delta', delta: 'partial' };
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    mockResponsesClient(provider, abortingStream());

    const caught: unknown = await provider
      .generate('', [], PROBE_HISTORY)
      .then((stream) => drain(stream))
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect(caught).not.toBeInstanceOf(APIConnectionError);
  });
});
