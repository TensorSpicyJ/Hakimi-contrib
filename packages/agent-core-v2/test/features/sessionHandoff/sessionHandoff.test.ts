/**
 * Scenario: cross-project session handoff through the App-scope
 * `ISessionHandoffCoordinator` and its `StartSession` tool.
 * Responsibilities: verify flag / main-agent / deny-guard / host gating,
 * target path, default-model and trust pre-flight without creating a session or
 * submitting a prompt, the create → metadata → prepare → authorize → enqueue
 * ordering with the source lineage recorded (never fork/child), the explicit
 * title announced through the standard session-metadata event, prepare
 * rejection and enqueue failure reporting the real target id, authorization
 * drift and cancellation boundaries, and the tool's approval surface (not
 * default-approved, target directory as the rule subject).
 * Wiring: the real coordinator and tool resolved by interface from a flat
 * container, with the session manager, workspace instance manager, config,
 * model registry, host filesystem, and the created session handle stubbed.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/features/sessionHandoff/sessionHandoff.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
  ScopeActivation,
} from '#/_base/di/scope';
import { createScopedTestHost, createServices, type TestInstantiationService } from '#/_base/di/test';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import { _clearFeatureRecipesForTests, registerFeature } from '#/features/featureRegistry';
import { LifecycleScope } from '#/app/scopes';
import type { IAgentScopeHandle, ISessionScopeHandle } from '#/_base/di/scope';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IEventService, type DomainEvent } from '#/app/event/event';
import { ISessionManager, type CreateManagedSessionOptions } from '#/app/sessionManager/sessionManager';
import { SessionManager } from '#/app/sessionManager/sessionManagerService';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionMetadata,
  type SessionMeta,
  type SessionMetaPatch,
} from '#/session/sessionMetadata/sessionMetadata';
import { IAgentPromptService, type PromptHandle, type PromptState } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import { ToolAccesses, type ExecutableToolResult } from '#/tool/toolContract';

import { stubFlag } from '../../app/flag/stubs';
import { createFakeHostFs } from '../../tools/fixtures/fake-exec';
import {
  ISessionHandoffCoordinator,
  SESSION_HANDOFF_CUSTOM_KEY,
  type SessionHandoffHost,
  type SessionHandoffRequest,
  type SessionHandoffStartResult,
  type StartSessionStatus,
} from '#/features/sessionHandoff/sessionHandoff';
import { SessionHandoffCoordinator } from '#/features/sessionHandoff/sessionHandoffCoordinator';
import { SessionHandoffErrors } from '#/features/sessionHandoff/errors';
import { CROSS_PROJECT_SESSIONS_FLAG_ID } from '#/features/sessionHandoff/flag';
import {
  IStartSessionTool,
  START_SESSION_TOOL_NAME,
  StartSessionInputSchema,
} from '#/features/sessionHandoff/tools/start-session/start-session';
import { StartSessionTool } from '#/features/sessionHandoff/tools/start-session/startSessionTool';
import {
  SessionHandoffFeature,
  startSessionToolWhen,
} from '#/features/sessionHandoff/sessionHandoffFeature';

const SOURCE_SESSION_ID = 'session_source';
const SOURCE_WORK_DIR = '/work/source';
const TARGET_SESSION_ID = 'session_target';
const TARGET_WORKSPACE_ID = 'workspace_target';
const TARGET_DIR = '/work/target';
const DEFAULT_MODEL_ALIAS = 'primary-model';

type Call = string;

interface SetupOptions {
  readonly flagEnabled?: boolean;
  readonly agentId?: string;
  readonly hosts?: readonly SessionHandoffHost[];
  readonly denySessionIds?: readonly string[];
  readonly defaultModel?: string | undefined;
  readonly knownModels?: readonly string[];
  readonly directories?: readonly string[];
  readonly trusted?: boolean;
  readonly createError?: Error;
  readonly prepareError?: Error;
  readonly enqueueError?: Error;
  readonly metadataError?: Error;
  readonly promptState?: PromptState;
  /** Blocks the target-directory stat so a test can revoke mid-preflight. */
  readonly gate?: Promise<void>;
}

interface SessionHandleFixture {
  readonly handle: ISessionScopeHandle;
  readonly metadataUpdates: SessionMetaPatch[];
  readonly published: DomainEvent[];
  meta(): SessionMeta;
  /** Payloads of the standard `session.meta.updated` events, in order. */
  metaEvents(): unknown[];
  promptCalls(): readonly unknown[];
  promptAborts(): number;
}

function makeAccessor(
  entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>,
): ServicesAccessor {
  return {
    get<T>(id: ServiceIdentifier<T>): T {
      for (const [key, value] of entries) {
        if (key === id) return value as T;
      }
      throw new Error(`unexpected service request: ${String(id)}`);
    },
  };
}

function makeTargetHandle(
  promptState: PromptState,
  enqueueError?: Error,
  metadataError?: Error,
  onEnqueue?: () => void,
): SessionHandleFixture {
  const metadataUpdates: SessionMetaPatch[] = [];
  const published: DomainEvent[] = [];
  const prompts: unknown[] = [];
  let aborts = 0;
  let meta: SessionMeta = {
    id: TARGET_SESSION_ID,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  };

  const metadata: ISessionMetadata = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: () => ({ dispose: () => {} }),
    read: () => (metadataError === undefined ? Promise.resolve(meta) : Promise.reject(metadataError)),
    update: (patch: SessionMetaPatch) => {
      metadataUpdates.push(patch);
      meta = { ...meta, ...patch };
      return Promise.resolve();
    },
    setTitle: (title: string) => {
      meta = { ...meta, title, titleKind: 'custom' };
      return Promise.resolve();
    },
    setGeneratedTitleIfUncustomized: () => Promise.resolve(false),
    setArchived: (archived: boolean) => {
      meta = { ...meta, archived };
      return Promise.resolve();
    },
    registerAgent: () => Promise.resolve(),
  };

  const events: IEventService = {
    _serviceBrand: undefined,
    onDidPublish: () => ({ dispose: () => {} }),
    publish: (event) => {
      published.push(event);
    },
    subscribe: () => ({ dispose: () => {} }),
  };

  const promptService: IAgentPromptService = {
    _serviceBrand: undefined,
    enqueue: (input) => {
      prompts.push(input);
      onEnqueue?.();
      if (enqueueError !== undefined) return Promise.reject(enqueueError);
      const handle: PromptHandle = {
        id: 'prompt_target',
        userMessageId: 'prompt_target',
        createdAt: 'now',
        state: promptState,
        message: input.message,
        // Never settles: the handoff must not wait for the target turn.
        launched: new Promise(() => {}),
        completion: new Promise(() => {}),
      };
      return Promise.resolve(handle);
    },
    submit: () => Promise.resolve(undefined),
    submitSteer: () => Promise.resolve(undefined),
    list: () => ({ active: undefined, pending: [] }),
    abort: () => {
      aborts += 1;
      return true;
    },
    steer: () => Promise.resolve([]),
    inject: () => Promise.resolve(undefined),
    retry: () => Promise.resolve(undefined),
    clear: () => {},
    hooks: {
      onBeforeSubmitPrompt: {
        register: () => ({ dispose: () => {} }),
        run: () => Promise.resolve(),
      },
    } as unknown as IAgentPromptService['hooks'],
  };

  const agentHandle: IAgentScopeHandle = {
    id: MAIN_AGENT_ID,
    kind: LifecycleScope.Agent,
    accessor: makeAccessor([[IAgentPromptService, promptService]]),
    dispose: () => {},
  };

  const agents: IAgentLifecycleService = {
    _serviceBrand: undefined,
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
    create: () => Promise.resolve(agentHandle),
    fork: () => Promise.resolve(agentHandle),
    get: (id) => (id === MAIN_AGENT_ID ? agentHandle : undefined),
    list: () => [agentHandle],
    remove: () => Promise.resolve(),
    restore: () => Promise.resolve(agentHandle),
    broadcastPermissionMode: () => {},
  };

  const context = makeSessionContext({
    sessionId: TARGET_SESSION_ID,
    workspaceId: TARGET_WORKSPACE_ID,
    sessionDir: '/home/sessions/target',
    sessionScope: 'sessions/target',
    cwd: TARGET_DIR,
  });

  const handle: ISessionScopeHandle = {
    id: TARGET_SESSION_ID,
    kind: LifecycleScope.Session,
    accessor: makeAccessor([
      [ISessionContext, context],
      [ISessionMetadata, metadata],
      [IEventService, events],
      [IAgentLifecycleService, agents],
    ]),
    dispose: () => {},
  };

  return {
    handle,
    metadataUpdates,
    published,
    meta: () => meta,
    metaEvents: () =>
      published
        .filter((event) => event.type === 'session.meta.updated')
        .map((event) => event.payload),
    promptCalls: () => prompts,
    promptAborts: () => aborts,
  };
}

describe('SessionHandoffCoordinator', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let calls: Call[];
  let created: CreateManagedSessionOptions[];
  let materialized: string[];
  let flagEnabled: boolean;
  let defaultModel: string | undefined;
  let knownModels: readonly string[];
  let directories: Set<string>;
  let trusted: boolean;
  let trustCalls: number;
  let sessionFixture: SessionHandleFixture;
  let hosts: SessionHandoffHost[];
  let prepareContexts: Parameters<SessionHandoffHost['prepare']>[0][];
  let registeredHosts: IDisposable[];
  let preparedHostIds: string[];

  function setup(options: SetupOptions = {}): void {
    calls = [];
    created = [];
    materialized = [];
    prepareContexts = [];
    registeredHosts = [];
    flagEnabled = options.flagEnabled ?? true;
    defaultModel = 'defaultModel' in options ? options.defaultModel : DEFAULT_MODEL_ALIAS;
    knownModels = options.knownModels ?? [DEFAULT_MODEL_ALIAS];
    directories = new Set(options.directories ?? [TARGET_DIR, SOURCE_WORK_DIR]);
    trusted = options.trusted ?? true;
    trustCalls = 0;
    hosts = [...(options.hosts ?? [])];
    preparedHostIds = [];
    sessionFixture = makeTargetHandle(
      options.promptState ?? 'running',
      options.enqueueError,
      options.metadataError,
      () => calls.push('enqueue'),
    );

    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFlagService, stubFlag(() => flagEnabled));
        reg.definePartialInstance(IConfigService, {
          ready: Promise.resolve(),
          get: (() => defaultModel) as IConfigService['get'],
        });
        reg.definePartialInstance(IModelService, {
          ready: Promise.resolve(),
          get: (id: string) => {
            const record = { name: id, model: id } as unknown as ModelRecord;
            return knownModels.includes(id) ? record : undefined;
          },
        });
        reg.defineInstance(
          IHostFileSystem,
          createFakeHostFs({
            stat: async (path: string) => {
              if (options.gate !== undefined) await options.gate;
              return directories.has(path)
                ? { isFile: false, isDirectory: true, size: 0 }
                : { isFile: true, isDirectory: false, size: 0 };
            },
          }),
        );
        reg.definePartialInstance(IWorkspaceInstanceManager, {
          getOrCreate: (ref) => {
            const key = 'workspaceId' in ref ? ref.workspaceId : ref.root;
            // Production getOrCreate is instance-cached: a second call for the
            // same root returns the materialized instance untouched.
            if (!materialized.includes(key)) {
              materialized.push(key);
              calls.push('materialize');
            }
            return Promise.resolve({
              program: {
                trust: {
                  get: () => {
                    trustCalls += 1;
                    return Promise.resolve(trusted);
                  },
                },
              },
            } as unknown as WorkspaceInstance);
          },
        });
        reg.definePartialInstance(ISessionManager, {
          create: (opts: CreateManagedSessionOptions) => {
            calls.push('create');
            created.push(opts);
            if (options.createError !== undefined) return Promise.reject(options.createError);
            return Promise.resolve(sessionFixture.handle);
          },
          close: () => {
            calls.push('close');
            return Promise.resolve();
          },
          delete: () => {
            calls.push('delete');
            return Promise.resolve();
          },
        });
        reg.defineInstance(IAgentScopeContext, {
          _serviceBrand: undefined,
          agentId: options.agentId ?? MAIN_AGENT_ID,
          scope: (subKey?: string) => subKey ?? 'agents/main',
        });
        reg.define(ISessionHandoffCoordinator, SessionHandoffCoordinator);
        reg.define(IStartSessionTool, StartSessionTool);
      },
    });

    const coordinator = ix.get(ISessionHandoffCoordinator);
    const tracedHosts = hosts.map((host) => ({
      ...host,
      prepare: (context: Parameters<SessionHandoffHost['prepare']>[0]) => {
        prepareContexts.push(context);
        preparedHostIds.push(host.id);
        calls.push('prepare');
        if (options.prepareError !== undefined) return Promise.reject(options.prepareError);
        return host.prepare(context);
      },
    }));
    for (const host of tracedHosts) {
      const registration = coordinator.registerHost(host);
      registeredHosts.push(registration);
      disposables.add(registration);
    }
    for (const sessionId of options.denySessionIds ?? []) {
      disposables.add(coordinator.registerDenyGuard({
        id: `deny-${sessionId}`,
        denyReason: (source) =>
          source === sessionId ? 'This embedding serves a single session and refuses handoff' : undefined,
      }));
    }
  }

  function coordinator(): ISessionHandoffCoordinator {
    return ix.get(ISessionHandoffCoordinator);
  }

  function request(overrides: Partial<SessionHandoffRequest> = {}): SessionHandoffRequest {
    return {
      sourceSessionId: SOURCE_SESSION_ID,
      sourceAgentId: MAIN_AGENT_ID,
      sourceWorkDir: SOURCE_WORK_DIR,
      workDir: TARGET_DIR,
      prompt: 'Fix the flaky test in this project.',
      title: 'Fix flaky test',
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  function matchingHost(overrides: Partial<SessionHandoffHost> = {}): SessionHandoffHost {
    return {
      id: 'test-host',
      matches: (sourceSessionId) => sourceSessionId === SOURCE_SESSION_ID,
      prepare: () => {},
      ...overrides,
    };
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    setup();
  });

  afterEach(() => {
    disposables.dispose();
  });

  describe('gating', () => {
    it('reports unavailability and refuses the start when no host matches the source session', async () => {
      expect(coordinator().isAvailable(SOURCE_SESSION_ID)).toBe(false);
      await expect(coordinator().start(request())).rejects.toMatchObject({
        code: SessionHandoffErrors.codes.SESSION_HANDOFF_UNSUPPORTED,
      });
      expect(created).toEqual([]);
    });

    it('reports unavailability and refuses the start while the experimental flag is off', async () => {
      setup({ flagEnabled: false, hosts: [matchingHost()] });
      expect(coordinator().isAvailable(SOURCE_SESSION_ID)).toBe(false);
      await expect(coordinator().start(request())).rejects.toMatchObject({
        code: SessionHandoffErrors.codes.SESSION_HANDOFF_DISABLED,
      });
      expect(created).toEqual([]);
    });

    it('refuses a non-main caller', async () => {
      setup({ hosts: [matchingHost()] });
      await expect(coordinator().start(request({ sourceAgentId: 'coder' }))).rejects.toMatchObject({
        code: SessionHandoffErrors.codes.SESSION_HANDOFF_NOT_MAIN_AGENT,
      });
      expect(created).toEqual([]);
    });

    it('outranks a matching host with a deny guard and never grants from a guard', async () => {
      setup({ hosts: [matchingHost()], denySessionIds: [SOURCE_SESSION_ID] });
      expect(coordinator().isAvailable(SOURCE_SESSION_ID)).toBe(false);
      await expect(coordinator().start(request())).rejects.toMatchObject({
        code: SessionHandoffErrors.codes.SESSION_HANDOFF_DENIED,
      });
      expect(created).toEqual([]);
    });

    it('keeps a deny guard scoped to its own source session', async () => {
      setup({ hosts: [matchingHost()], denySessionIds: ['session_other'] });
      expect(coordinator().isAvailable(SOURCE_SESSION_ID)).toBe(true);
      await expect(coordinator().start(request())).resolves.toMatchObject({
        sessionId: TARGET_SESSION_ID,
      });
    });

    it('matches hosts by source session id', async () => {
      setup({
        hosts: [matchingHost({ id: 'other', matches: () => false }), matchingHost({ id: 'right' })],
      });
      await expect(coordinator().start(request())).resolves.toMatchObject({
        sessionId: TARGET_SESSION_ID,
      });
      expect(created).toHaveLength(1);
    });

    it('withdraws availability when a host registration is disposed', async () => {
      setup();
      const registration = coordinator().registerHost(matchingHost());
      expect(coordinator().isAvailable(SOURCE_SESSION_ID)).toBe(true);
      registration.dispose();
      expect(coordinator().isAvailable(SOURCE_SESSION_ID)).toBe(false);
      await expect(coordinator().start(request())).rejects.toMatchObject({
        code: SessionHandoffErrors.codes.SESSION_HANDOFF_UNSUPPORTED,
      });
      expect(created).toEqual([]);
    });

    it('withdraws availability when a deny guard registration is disposed', async () => {
      setup({ hosts: [matchingHost()] });
      const registration = coordinator().registerDenyGuard({
        id: 'deny',
        denyReason: () => 'refused',
      });
      expect(coordinator().isAvailable(SOURCE_SESSION_ID)).toBe(false);
      registration.dispose();
      expect(coordinator().isAvailable(SOURCE_SESSION_ID)).toBe(true);
    });

    it('gates the tool on the main agent and on availability', () => {
      function accessor(agentId: string, available: boolean): ServicesAccessor {
        return {
          get<T>(id: ServiceIdentifier<T>): T {
            if (id === IAgentScopeContext) return { agentId } as unknown as T;
            if (id === ISessionContext) return { sessionId: SOURCE_SESSION_ID } as unknown as T;
            if (id === ISessionHandoffCoordinator) {
              return { isAvailable: () => available } as unknown as T;
            }
            throw new Error(`unexpected service request: ${String(id)}`);
          },
        };
      }

      expect(startSessionToolWhen(accessor(MAIN_AGENT_ID, true))).toBe(true);
      expect(startSessionToolWhen(accessor(MAIN_AGENT_ID, false))).toBe(false);
      expect(startSessionToolWhen(accessor('coder', true))).toBe(false);
    });
  });

  describe('pre-flight', () => {
    it.each([
      ['relative', 'work/target'],
      ['missing', '/work/missing'],
    ])('refuses a %s work_dir without touching any session', async (_label, workDir) => {
      setup({ hosts: [matchingHost()] });
      await expect(coordinator().start(request({ workDir }))).rejects.toMatchObject({
        code: SessionHandoffErrors.codes.SESSION_HANDOFF_WORK_DIR_INVALID,
      });
      expect(created).toEqual([]);
      expect(materialized).toEqual([]);
    });

    it('fails before materializing a workspace when no default model is configured', async () => {
      setup({ hosts: [matchingHost()], defaultModel: undefined });
      await expect(coordinator().start(request())).rejects.toMatchObject({
        code: 'model.not_configured',
      });
      expect(created).toEqual([]);
      expect(materialized).toEqual([]);
    });

    it('fails before materializing a workspace when the default model alias is unknown', async () => {
      setup({ hosts: [matchingHost()], defaultModel: 'ghost', knownModels: [DEFAULT_MODEL_ALIAS] });
      await expect(coordinator().start(request())).rejects.toMatchObject({
        code: 'model.not_configured',
      });
      expect(created).toEqual([]);
      expect(materialized).toEqual([]);
    });

    it('refuses an untrusted target without trusting it', async () => {
      setup({ hosts: [matchingHost()], trusted: false });
      await expect(coordinator().start(request())).rejects.toMatchObject({
        code: SessionHandoffErrors.codes.SESSION_HANDOFF_TRUST_REQUIRED,
      });
      expect(created).toEqual([]);
      expect(trusted).toBe(false);
      expect(trustCalls).toBe(1);
    });

    it('refuses an already-aborted call before creating anything', async () => {
      setup({ hosts: [matchingHost()] });
      const controller = new AbortController();
      controller.abort();
      await expect(coordinator().start(request({ signal: controller.signal }))).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(created).toEqual([]);
      expect(materialized).toEqual([]);
    });
  });

  describe('start', () => {
    it('creates the target with the default main profile binding and returns the real session and prompt', async () => {
      setup({ hosts: [matchingHost()] });
      const result = await coordinator().start(request());

      expect(result).toEqual({
        sessionId: TARGET_SESSION_ID,
        workspaceId: TARGET_WORKSPACE_ID,
        workDir: TARGET_DIR,
        title: 'Fix flaky test',
        promptId: 'prompt_target',
        status: 'running',
      });
      expect(created).toEqual([
        {
          workDir: TARGET_DIR,
          mainAgentBinding: { profile: DEFAULT_AGENT_PROFILE_NAME, model: DEFAULT_MODEL_ALIAS },
        },
      ]);
    });

    it('orders creation, metadata, host preparation, and prompt submission', async () => {
      setup({ hosts: [matchingHost()] });
      await coordinator().start(request());
      expect(calls).toEqual(['materialize', 'create', 'prepare', 'enqueue']);
      expect(sessionFixture.promptCalls()).toHaveLength(1);
    });

    it('prepares every matching host in registration order before the first prompt', async () => {
      setup({
        hosts: [matchingHost({ id: 'client-bridge' }), matchingHost({ id: 'server-bridge' })],
      });
      const result = await coordinator().start(request());

      expect(preparedHostIds).toEqual(['client-bridge', 'server-bridge']);
      expect(calls).toEqual(['materialize', 'create', 'prepare', 'prepare', 'enqueue']);
      expect(result.status).toBe('running');
    });

    it('prepares every matching host when the broad server host registered first', async () => {
      setup({
        hosts: [
          matchingHost({ id: 'server-bridge', matches: () => true }),
          matchingHost({ id: 'client-bridge' }),
        ],
      });
      const result = await coordinator().start(request());

      expect(preparedHostIds).toEqual(['server-bridge', 'client-bridge']);
      expect(calls).toEqual(['materialize', 'create', 'prepare', 'prepare', 'enqueue']);
      expect(result).toMatchObject({ sessionId: TARGET_SESSION_ID, status: 'running' });
    });

    it('passes every participating host the same live target context', async () => {
      setup({ hosts: [matchingHost({ id: 'a' }), matchingHost({ id: 'b' })] });
      await coordinator().start(request());

      expect(prepareContexts).toHaveLength(2);
      expect(prepareContexts[0]).toBe(prepareContexts[1]);
      expect(prepareContexts[0]?.handle).toBe(sessionFixture.handle);
    });

    it('does not prepare a registered host that does not match the source session', async () => {
      setup({
        hosts: [matchingHost({ id: 'other', matches: () => false }), matchingHost({ id: 'mine' })],
      });
      await coordinator().start(request());

      expect(preparedHostIds).toEqual(['mine']);
    });

    it('hands the host the created handle, the source identity, and the target summary', async () => {
      setup({ hosts: [matchingHost()] });
      await coordinator().start(request());

      expect(prepareContexts).toHaveLength(1);
      const context = prepareContexts[0]!;
      expect(context.handle).toBe(sessionFixture.handle);
      expect(context.sourceSessionId).toBe(SOURCE_SESSION_ID);
      expect(context.sourceAgentId).toBe(MAIN_AGENT_ID);
      expect(context.sourceWorkDir).toBe(SOURCE_WORK_DIR);
      expect(context.prompt).toBe('Fix the flaky test in this project.');
      expect(context.target).toMatchObject({
        sessionId: TARGET_SESSION_ID,
        workspaceId: TARGET_WORKSPACE_ID,
        workDir: TARGET_DIR,
      });
    });

    it('records the source lineage as metadata and never as fork or child', async () => {
      setup({ hosts: [matchingHost()] });
      await coordinator().start(request());

      const meta = sessionFixture.meta();
      expect(meta.title).toBe('Fix flaky test');
      expect(meta.titleKind).toBe('custom');
      expect(meta.lastPrompt).toBe('Fix the flaky test in this project.');
      expect(meta.forkedFrom).toBeUndefined();
      expect(meta.custom?.[SESSION_HANDOFF_CUSTOM_KEY]).toEqual({
        source_session_id: SOURCE_SESSION_ID,
        source_work_dir: SOURCE_WORK_DIR,
        started_at: expect.any(Number),
      });
      expect(meta.custom?.['parent_session_id']).toBeUndefined();
      expect(meta.custom?.['child_session_kind']).toBeUndefined();
      expect(sessionFixture.published.some((event) => event.type === 'session.meta.updated')).toBe(true);
    });

    it('announces the explicit title with the standard session-metadata event before the prompt update', async () => {
      setup({ hosts: [matchingHost()] });
      await coordinator().start(request());

      const published = sessionFixture.metaEvents();
      expect(published).toEqual([
        {
          agentId: MAIN_AGENT_ID,
          sessionId: TARGET_SESSION_ID,
          title: 'Fix flaky test',
          patch: { title: 'Fix flaky test', isCustomTitle: true },
        },
        {
          agentId: MAIN_AGENT_ID,
          sessionId: TARGET_SESSION_ID,
          patch: {
            lastPrompt: 'Fix the flaky test in this project.',
          },
        },
      ]);
      expect(sessionFixture.meta().title).toBe('Fix flaky test');
      expect(sessionFixture.meta().titleKind).toBe('custom');
    });

    it('keeps the lineage out of the title event and publishes it only through metadata', async () => {
      setup({ hosts: [matchingHost()] });
      await coordinator().start(request());

      expect(JSON.stringify(sessionFixture.metaEvents())).not.toContain(SOURCE_SESSION_ID);
      expect(sessionFixture.meta().custom?.[SESSION_HANDOFF_CUSTOM_KEY]).toMatchObject({
        source_session_id: SOURCE_SESSION_ID,
      });
    });

    it('derives the title from the prompt and never announces a custom title when none was given', async () => {
      setup({ hosts: [matchingHost()] });
      await coordinator().start({ ...request(), title: undefined });

      const published = sessionFixture.metaEvents();
      expect(published).toHaveLength(1);
      expect(published[0]).toEqual({
        agentId: MAIN_AGENT_ID,
        sessionId: TARGET_SESSION_ID,
        title: 'Fix the flaky test in this project.',
        patch: {
          title: 'Fix the flaky test in this project.',
          isCustomTitle: false,
          lastPrompt: 'Fix the flaky test in this project.',
        },
      });
      expect(sessionFixture.meta().title).toBe('Fix the flaky test in this project.');
      expect(sessionFixture.meta().titleKind).toBe('replaceable');
    });

    it.each([
      ['running', 'running', false],
      ['pending', 'pending', false],
      ['steered', 'running', false],
      ['completed', 'completed', false],
      ['blocked', 'blocked', true],
      ['failed', 'failed', true],
      ['cancelled', 'aborted', true],
    ] as const)(
      'reports the real outcome of a %s prompt without waiting for the turn',
      async (promptState, expectedStatus, expectsFailure) => {
        setup({ hosts: [matchingHost()], promptState });
        const result = await coordinator().start(request());

        expect(result.sessionId).toBe(TARGET_SESSION_ID);
        expect(result.promptId).toBe('prompt_target');
        expect(result.status).toBe(expectedStatus);
        expect(result.failure === undefined).toBe(!expectsFailure);
      },
    );

    it('reports an already-finished first turn as completed rather than running', async () => {
      setup({ hosts: [matchingHost()], promptState: 'completed' });
      const result = await coordinator().start(request());

      expect(result.status).toBe('completed');
      expect(result.failure).toBeUndefined();
    });

    it('never reports a cancelled first prompt as started', async () => {
      setup({ hosts: [matchingHost()], promptState: 'cancelled' });
      const result = await coordinator().start(request());

      expect(result.status).toBe('aborted');
      expect(result.failure).toContain('cancelled');
    });

    it('does not adopt the caller signal for the target turn', async () => {
      setup({ hosts: [matchingHost()] });
      const controller = new AbortController();
      await coordinator().start(request({ signal: controller.signal }));
      controller.abort();

      expect(calls).toEqual(['materialize', 'create', 'prepare', 'enqueue']);
      expect(sessionFixture.promptAborts()).toBe(0);
    });
  });

  describe('partial failure after creation', () => {
    it('returns the target id and a real failure when host preparation rejects', async () => {
      setup({
        hosts: [matchingHost()],
        prepareError: new Error('host bridge unavailable'),
      });
      const result = await coordinator().start(request());

      expect(result.sessionId).toBe(TARGET_SESSION_ID);
      expect(result.status).toBe('failed');
      expect(result.failure).toBe('host bridge unavailable');
      expect(result.promptId).toBeUndefined();
      expect(sessionFixture.promptCalls()).toEqual([]);
      expect(calls).not.toContain('close');
      expect(calls).not.toContain('delete');
    });

    it('returns the target id and a real failure when prompt submission fails', async () => {
      setup({ hosts: [matchingHost()], enqueueError: new Error('queue is closed') });
      const result = await coordinator().start(request());

      expect(result.sessionId).toBe(TARGET_SESSION_ID);
      expect(result.status).toBe('failed');
      expect(result.failure).toBe('queue is closed');
      expect(calls).not.toContain('close');
      expect(calls).not.toContain('delete');
    });

    it('returns the target id and skips submission when cancelled during host preparation', async () => {
      const controller = new AbortController();
      setup({
        hosts: [
          matchingHost({
            prepare: () => {
              controller.abort();
            },
          }),
        ],
      });
      const result = await coordinator().start(request({ signal: controller.signal }));

      expect(result.sessionId).toBe(TARGET_SESSION_ID);
      expect(result.status).toBe('aborted');
      expect(result.promptId).toBeUndefined();
      expect(sessionFixture.promptCalls()).toEqual([]);
      expect(calls).not.toContain('close');
    });

    it('still lets the host register a session whose metadata could not be recorded, without starting it', async () => {
      setup({ hosts: [matchingHost()], metadataError: new Error('storage is read-only') });
      const result = await coordinator().start(request());

      expect(result.sessionId).toBe(TARGET_SESSION_ID);
      expect(result.status).toBe('failed');
      expect(result.failure).toContain('storage is read-only');
      expect(prepareContexts).toHaveLength(1);
      expect(prepareContexts[0]?.handle).toBe(sessionFixture.handle);
      expect(sessionFixture.promptCalls()).toEqual([]);
      expect(calls).not.toContain('close');
      expect(calls).not.toContain('delete');
    });

    it('does not retry or clean up when session creation itself fails', async () => {
      setup({ hosts: [matchingHost()], createError: new Error('bind failed') });
      await expect(coordinator().start(request())).rejects.toThrow('bind failed');
      expect(created).toHaveLength(1);
      expect(calls).not.toContain('close');
      expect(calls).not.toContain('delete');
    });
  });

  describe('authorization drift', () => {
    function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
      let open: () => void = () => {};
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { promise, open };
    }

    it('does not create a session when a deny guard lands during the pre-flight awaits', async () => {
      const parked = gate();
      setup({ hosts: [matchingHost()], gate: parked.promise });

      const starting = coordinator().start(request());
      disposables.add(
        coordinator().registerDenyGuard({ id: 'revoked', denyReason: () => 'revoked mid-flight' }),
      );
      parked.open();

      await expect(starting).rejects.toMatchObject({
        code: SessionHandoffErrors.codes.SESSION_HANDOFF_DENIED,
      });
      expect(created).toEqual([]);
      expect(sessionFixture.promptCalls()).toEqual([]);
    });

    it('does not create a session when the flag is disabled during the pre-flight awaits', async () => {
      const parked = gate();
      setup({ hosts: [matchingHost()], gate: parked.promise });

      const starting = coordinator().start(request());
      flagEnabled = false;
      parked.open();

      await expect(starting).rejects.toMatchObject({
        code: SessionHandoffErrors.codes.SESSION_HANDOFF_DISABLED,
      });
      expect(created).toEqual([]);
    });

    it('does not create a session when the matching host is withdrawn during the pre-flight awaits', async () => {
      const parked = gate();
      setup({ hosts: [matchingHost()], gate: parked.promise });

      const starting = coordinator().start(request());
      registeredHosts[0]!.dispose();
      parked.open();

      await expect(starting).rejects.toMatchObject({
        code: SessionHandoffErrors.codes.SESSION_HANDOFF_UNSUPPORTED,
      });
      expect(created).toEqual([]);
    });

    it('returns the real target and does not submit when a deny guard lands during preparation', async () => {
      setup({
        hosts: [
          matchingHost({
            prepare: () => {
              disposables.add(
                coordinator().registerDenyGuard({
                  id: 'revoked',
                  denyReason: () => 'revoked during preparation',
                }),
              );
            },
          }),
        ],
      });
      const result = await coordinator().start(request());

      expect(result.sessionId).toBe(TARGET_SESSION_ID);
      expect(result.status).toBe('failed');
      expect(result.failure).toBe('revoked during preparation');
      expect(sessionFixture.promptCalls()).toEqual([]);
      expect(calls).not.toContain('close');
      expect(calls).not.toContain('delete');
    });

    it('returns the real target and does not submit when the flag is disabled during preparation', async () => {
      setup({
        hosts: [
          matchingHost({
            prepare: () => {
              flagEnabled = false;
            },
          }),
        ],
      });
      const result = await coordinator().start(request());

      expect(result.sessionId).toBe(TARGET_SESSION_ID);
      expect(result.status).toBe('failed');
      expect(result.failure).toContain('disabled');
      expect(sessionFixture.promptCalls()).toEqual([]);
    });

    it('never starts under a replacement host that did not prepare the session', async () => {
      const replacementPrepare = vi.fn();
      setup({
        hosts: [
          matchingHost({
            prepare: () => {
              registeredHosts[0]!.dispose();
              disposables.add(
                coordinator().registerHost({
                  id: 'replacement',
                  matches: () => true,
                  prepare: replacementPrepare,
                }),
              );
            },
          }),
        ],
      });
      const result = await coordinator().start(request());

      expect(result.sessionId).toBe(TARGET_SESSION_ID);
      expect(result.status).toBe('failed');
      expect(result.failure).toContain('host');
      expect(replacementPrepare).not.toHaveBeenCalled();
      expect(sessionFixture.promptCalls()).toEqual([]);
      expect(sessionFixture.promptAborts()).toBe(0);
    });

    it('does not submit when the prepared host is withdrawn during preparation', async () => {
      setup({
        hosts: [
          matchingHost({
            prepare: () => {
              registeredHosts[0]!.dispose();
            },
          }),
        ],
      });
      const result = await coordinator().start(request());

      expect(result.status).toBe('failed');
      expect(sessionFixture.promptCalls()).toEqual([]);
    });

    it('fails closed when a new matching host registers during another host preparation', async () => {      const latePrepare = vi.fn();
      setup({
        hosts: [
          matchingHost({
            id: 'kap',
            matches: () => true,
            prepare: () => {
              disposables.add(
                coordinator().registerHost({
                  id: 'late-client-bridge',
                  matches: () => true,
                  prepare: latePrepare,
                }),
              );
            },
          }),
        ],
      });
      const result = await coordinator().start(request());

      expect(result.sessionId).toBe(TARGET_SESSION_ID);
      expect(result.status).toBe('failed');
      expect(result.failure).toContain('set of hosts');
      expect(preparedHostIds).toEqual(['kap']);
      expect(latePrepare).not.toHaveBeenCalled();
      expect(sessionFixture.promptCalls()).toEqual([]);
      expect(calls).not.toContain('enqueue');
    });

    it('fails closed when a matching host stops matching during another host preparation', async () => {
      let matchesSecond = true;
      setup({
        hosts: [
          matchingHost({
            id: 'first',
            prepare: () => {
              matchesSecond = false;
            },
          }),
          matchingHost({ id: 'second', matches: () => matchesSecond }),
        ],
      });
      const result = await coordinator().start(request());

      expect(result.status).toBe('failed');
      expect(result.failure).toContain('set of hosts');
      expect(preparedHostIds).toEqual(['first', 'second']);
      expect(sessionFixture.promptCalls()).toEqual([]);
    });

    it('does not submit when the second of two prepared hosts fails', async () => {
      setup({
        hosts: [
          matchingHost({ id: 'kap', matches: () => true }),
          matchingHost({
            id: 'client-bridge',
            prepare: () => Promise.reject(new Error('approval bridge unavailable')),
          }),
        ],
      });
      const result = await coordinator().start(request());

      expect(result.sessionId).toBe(TARGET_SESSION_ID);
      expect(result.status).toBe('failed');
      expect(result.failure).toBe('approval bridge unavailable');
      expect(preparedHostIds).toEqual(['kap', 'client-bridge']);
      expect(sessionFixture.promptCalls()).toEqual([]);
      expect(calls).not.toContain('close');
      expect(calls).not.toContain('delete');
    });

    it('returns the real target and does not submit when the target trust is revoked during preparation', async () => {
      setup({
        hosts: [
          matchingHost({
            prepare: () => {
              trusted = false;
            },
          }),
        ],
      });
      const result = await coordinator().start(request());

      expect(result.sessionId).toBe(TARGET_SESSION_ID);
      expect(result.status).toBe('failed');
      expect(result.failure).toContain('no longer trusted');
      expect(trustCalls).toBe(2);
      expect(sessionFixture.promptCalls()).toEqual([]);
      expect(calls).not.toContain('enqueue');
      expect(calls).not.toContain('close');
      expect(calls).not.toContain('delete');
    });

    it('reads the target trust after preparation and still refuses an untrusted target', async () => {
      setup({ hosts: [matchingHost()], trusted: false });
      await expect(coordinator().start(request())).rejects.toMatchObject({
        code: SessionHandoffErrors.codes.SESSION_HANDOFF_TRUST_REQUIRED,
      });
      expect(trustCalls).toBe(1);
      expect(created).toEqual([]);
    });

    it('prepares hosts and then authorizes once more before the first prompt without an await gap', async () => {
      setup({
        hosts: [
          matchingHost({
            prepare: () => {
              // Revoking the last matching host here must be caught by the
              // final check that runs immediately before submission.
              registeredHosts[0]!.dispose();
            },
          }),
        ],
      });
      const result = await coordinator().start(request());

      expect(preparedHostIds).toEqual(['test-host']);
      expect(calls).toEqual(['materialize', 'create', 'prepare']);
      expect(result.status).toBe('failed');
      expect(sessionFixture.promptCalls()).toEqual([]);
    });
  });
});

describe('SessionHandoffCoordinator with the real ISessionManager', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let createdOptions: CreateManagedSessionOptions[];
  let sessionFixture: SessionHandleFixture;

  beforeEach(() => {
    disposables = new DisposableStore();
    createdOptions = [];
    sessionFixture = makeTargetHandle('running');
    const didCreate = new Emitter<{
      readonly sessionId: string;
      readonly handle: ISessionScopeHandle;
      readonly source: 'startup';
    }>();
    const controller = {
      onWillCreateSession: Event.None,
      onDidCreateSession: didCreate.event,
      onWillCloseSession: Event.None,
      onDidCloseSession: Event.None,
      onDidArchiveSession: Event.None,
      onDidForkSession: Event.None,
      create: (opts: CreateManagedSessionOptions) => {
        createdOptions.push(opts);
        didCreate.fire({ sessionId: TARGET_SESSION_ID, handle: sessionFixture.handle, source: 'startup' });
        return Promise.resolve(sessionFixture.handle);
      },
      dispose: () => {},
    };
    const workspace = {
      id: TARGET_WORKSPACE_ID,
      root: TARGET_DIR,
      program: {
        sessionControllerGeneration: 'generation-1',
        createSessionController: () => controller,
        trust: { get: () => Promise.resolve(true) },
      },
    };

    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFlagService, stubFlag(() => true));
        reg.definePartialInstance(IConfigService, {
          ready: Promise.resolve(),
          get: (() => DEFAULT_MODEL_ALIAS) as IConfigService['get'],
        });
        reg.definePartialInstance(IModelService, {
          ready: Promise.resolve(),
          get: (id: string) =>
            id === DEFAULT_MODEL_ALIAS ? ({ name: id, model: id } as unknown as ModelRecord) : undefined,
        });
        reg.defineInstance(
          IHostFileSystem,
          createFakeHostFs({
            stat: () => Promise.resolve({ isFile: false, isDirectory: true, size: 0 }),
          }),
        );
        reg.definePartialInstance(IWorkspaceInstanceManager, {
          getOrCreate: () => Promise.resolve(workspace as unknown as WorkspaceInstance),
          get: (workspaceId: string) =>
            workspaceId === TARGET_WORKSPACE_ID ? (workspace as unknown as WorkspaceInstance) : undefined,
        });
        reg.definePartialInstance(ISessionIndex, { get: () => Promise.resolve(undefined) });
        reg.define(ISessionManager, SessionManager);
        reg.define(ISessionHandoffCoordinator, SessionHandoffCoordinator);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('creates the target through the real session manager and enqueues on the created handle', async () => {
    const coordinator = ix.get(ISessionHandoffCoordinator);
    disposables.add(
      coordinator.registerHost({
        id: 'host',
        matches: () => true,
        prepare: () => {},
      }),
    );

    const result = await coordinator.start({
      sourceSessionId: SOURCE_SESSION_ID,
      sourceAgentId: MAIN_AGENT_ID,
      sourceWorkDir: SOURCE_WORK_DIR,
      workDir: TARGET_DIR,
      prompt: 'Do the thing.',
      signal: new AbortController().signal,
    });

    expect(createdOptions).toEqual([
      {
        workDir: TARGET_DIR,
        mainAgentBinding: { profile: DEFAULT_AGENT_PROFILE_NAME, model: DEFAULT_MODEL_ALIAS },
      },
    ]);
    expect(result).toMatchObject({
      sessionId: TARGET_SESSION_ID,
      workspaceId: TARGET_WORKSPACE_ID,
      status: 'running',
      promptId: 'prompt_target',
    });
    expect(sessionFixture.promptCalls()).toHaveLength(1);
    expect(ix.get(ISessionManager).get(TARGET_SESSION_ID)).toBe(sessionFixture.handle);
  });
});

describe('StartSessionTool', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    const coordinator: ISessionHandoffCoordinator = {
      _serviceBrand: undefined,
      registerHost: () => ({ dispose: () => {} }),
      registerDenyGuard: () => ({ dispose: () => {} }),
      isAvailable: () => true,
      start: () =>
        Promise.resolve({
          sessionId: TARGET_SESSION_ID,
          workspaceId: TARGET_WORKSPACE_ID,
          workDir: TARGET_DIR,
          promptId: 'prompt_target',
          status: 'running' as const,
        }),
    };
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(ISessionHandoffCoordinator, coordinator);
        reg.definePartialInstance(ISessionContext, {
          sessionId: SOURCE_SESSION_ID,
          cwd: SOURCE_WORK_DIR,
        });
        reg.defineInstance(IAgentScopeContext, {
          _serviceBrand: undefined,
          agentId: MAIN_AGENT_ID,
          scope: () => 'agents/main',
        });
        reg.define(IStartSessionTool, StartSessionTool);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  function tool(): IStartSessionTool {
    return ix.get(IStartSessionTool);
  }

  function coordinatorStub(result: Partial<SessionHandoffStartResult> & { status: StartSessionStatus }): ISessionHandoffCoordinator {
    return {
      _serviceBrand: undefined,
      registerHost: () => ({ dispose: () => {} }),
      registerDenyGuard: () => ({ dispose: () => {} }),
      isAvailable: () => true,
      start: () =>
        Promise.resolve({
          sessionId: TARGET_SESSION_ID,
          workspaceId: TARGET_WORKSPACE_ID,
          workDir: TARGET_DIR,
          promptId: 'prompt_target',
          ...result,
        }),
    };
  }

  async function executeTool(): Promise<ExecutableToolResult> {
    const execution = ix.get(IStartSessionTool).resolveExecution({
      work_dir: TARGET_DIR,
      prompt: 'Do the thing.',
    });
    if (!('execute' in execution)) throw new Error('expected a runnable execution');
    return execution.execute({
      turnId: 1,
      toolCallId: 'call',
      signal: new AbortController().signal,
    });
  }

  it('allows proposing a handoff but requires confirmation before creating it', () => {
    const description = tool().description;
    expect(description).toContain('proactively propose the target project');
    expect(description).toContain('ask the user to confirm using AskUserQuestion');
    expect(description).toContain('wait for their answer');
    expect(description).toContain('do not ask twice');
    expect(description).toContain('YOLO mode does not replace this confirmation');
    expect(description).toContain('If the user declines or has not confirmed');
  });

  it('declares the target directory as the approval subject and an exclusive call', async () => {
    const input = {
      work_dir: `${TARGET_DIR}/`,
      prompt: 'Do the thing.',
      title: 'Thing',
    };
    const execution = tool().resolveExecution(input);

    expect('execute' in execution).toBe(true);
    if (!('execute' in execution)) throw new Error('expected a runnable execution');
    expect(execution.accesses).toEqual(ToolAccesses.all());
    expect(execution.approvalRule).toContain(`${START_SESSION_TOOL_NAME}(`);
    expect(execution.approvalRule).toContain(TARGET_DIR);
    expect(execution.matchesRule?.(TARGET_DIR)).toBe(true);
    expect(execution.matchesRule?.('/work/elsewhere')).toBe(false);
    expect(execution.display).toMatchObject({
      kind: 'generic',
      summary: expect.stringContaining(TARGET_DIR),
    });
  });

  it('rejects a relative work_dir in the input schema while keeping a plain string for the model', () => {
    expect(
      StartSessionInputSchema.safeParse({ work_dir: 'work/target', prompt: 'Do the thing.' }).success,
    ).toBe(false);
    expect(
      StartSessionInputSchema.safeParse({ work_dir: TARGET_DIR, prompt: 'Do the thing.' }).success,
    ).toBe(true);

    const parameters = tool().parameters as {
      readonly properties: Record<string, { readonly type?: string }>;
    };
    expect(parameters.properties['work_dir']?.type).toBe('string');
  });

  it('rejects a relative work_dir before the approval round-trip', async () => {
    const execution = await tool().resolveExecution({
      work_dir: 'work/target',
      prompt: 'Do the thing.',
    });

    if ('execute' in execution) throw new Error('expected a resolve-phase rejection');
    expect(execution.isError).toBe(true);
    expect(execution.output).toContain('absolute path');
  });

  it('renders the real session, prompt, and status', async () => {
    const execution = tool().resolveExecution({
      work_dir: TARGET_DIR,
      prompt: 'Do the thing.',
    });
    if (!('execute' in execution)) throw new Error('expected a runnable execution');
    const result = await execution.execute({
      turnId: 1,
      toolCallId: 'call',
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain(`session_id="${TARGET_SESSION_ID}"`);
    expect(result.output).toContain('prompt_id="prompt_target"');
    expect(result.output).toContain('status="running"');
  });

  it('reports an already-completed first turn as a success without claiming it is still running', async () => {
    ix.stub(ISessionHandoffCoordinator, coordinatorStub({ status: 'completed' }));
    const result = await executeTool();

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('status="completed"');
    expect(result.output).toContain('already finished its first turn');
  });

  it.each(['failed', 'blocked', 'aborted'] as const)(
    'reports a %s first prompt as a tool error carrying the session id',
    async (status) => {
      ix.stub(
        ISessionHandoffCoordinator,
        coordinatorStub({ status, failure: `first prompt ${status}` }),
      );
      const result = await executeTool();

      expect(result.isError).toBe(true);
      expect(result.output).toContain(`session_id="${TARGET_SESSION_ID}"`);
      expect(result.output).toContain(`status="${status}"`);
      expect(result.output).toContain(`first prompt ${status}`);
    },
  );

  it('reports a start rejection as a tool error', async () => {
    ix.stub(ISessionHandoffCoordinator, {
      _serviceBrand: undefined,
      registerHost: () => ({ dispose: () => {} }),
      registerDenyGuard: () => ({ dispose: () => {} }),
      isAvailable: () => true,
      start: () => Promise.reject(new Error('cross-project handoff is disabled')),
    });
    const result = await executeTool();

    expect(result.isError).toBe(true);
    expect(result.output).toContain('cross-project handoff is disabled');
  });
});

describe('SessionHandoffFeature wiring (real App/Agent scopes)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    _clearFeatureRecipesForTests();
    registerScopedService(
      LifecycleScope.App,
      IFeatureManager,
      FeatureManagerService,
      ScopeActivation.OnScopeCreated,
      'feature',
    );
    registerScopedService(
      LifecycleScope.App,
      IFeatureAssemblyService,
      FeatureAssemblyService,
      ScopeActivation.OnScopeCreated,
      'features',
    );
  });

  it('assembles the feature and resolves the tool across scopes for the main agent only', async () => {
    registerFeature(SessionHandoffFeature);
    const host = createScopedTestHost([
      [IFlagService, stubFlag(() => true)],
      [IConfigService, { _serviceBrand: undefined, ready: Promise.resolve(), get: () => DEFAULT_MODEL_ALIAS }],
      [IModelService, { _serviceBrand: undefined, ready: Promise.resolve() }],
      [IHostFileSystem, createFakeHostFs()],
      [IWorkspaceInstanceManager, { _serviceBrand: undefined }],
      [ISessionManager, { _serviceBrand: undefined }],
    ]);

    expect(host.app.accessor.get(IFeatureManager).units().map((unit) => unit.name)).toEqual([
      'sessionHandoff',
    ]);

    const session = host.child(LifecycleScope.Session, 'session-1', [
      [ISessionContext, makeSessionContext({
        sessionId: SOURCE_SESSION_ID,
        workspaceId: 'workspace-1',
        sessionDir: '/home/sessions/source',
        sessionScope: 'sessions/source',
        cwd: SOURCE_WORK_DIR,
      })],
    ]);
    const main = host.childOf(session, LifecycleScope.Agent, MAIN_AGENT_ID, [
      [IAgentScopeContext, { _serviceBrand: undefined, agentId: MAIN_AGENT_ID, scope: () => 'agents/main' }],
    ]);

    expect(main.accessor.get(IStartSessionTool).name).toBe(START_SESSION_TOOL_NAME);
    expect(startSessionToolWhen(main.accessor)).toBe(false);

    const registration = host.app.accessor
      .get(ISessionHandoffCoordinator)
      .registerHost({ id: 'host', matches: () => true, prepare: () => {} });
    expect(startSessionToolWhen(main.accessor)).toBe(true);
    registration.dispose();
    expect(startSessionToolWhen(main.accessor)).toBe(false);

    host.dispose();
  });
});
