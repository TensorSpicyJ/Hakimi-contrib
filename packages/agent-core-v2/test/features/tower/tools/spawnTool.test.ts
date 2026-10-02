/**
 * TowerSpawnTool tests: guards (tower mode, rate limiter) and the happy-path
 * spawn composition (roster registration, tower-worker profile binding, the
 * auto permission-mode pin, detached task registration, rate-limit slot
 * release on settle). The store
 * side runs against a real on-disk git repo (mkdtemp fixture); the spawn
 * collaborators (lifecycle / subagents / tasks / rate limit) are stubbed.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { TowerStore } from '#/features/tower/protocol/index';
import { IAgentTowerService } from '#/features/tower/tower';
import { ITowerRateLimitService } from '#/features/tower/towerRateLimit';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { ITowerSpawnTool, type TowerSpawnToolInput } from '#/features/tower/tools/spawn/spawn';
import { TowerSpawnTool } from '#/features/tower/tools/spawn/spawnTool';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  SECONDARY_MODEL_SECTION,
  SUBAGENT_SECTION,
  resolveSubagentBinding,
} from '#/session/subagent/configSection';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';
import { IAutoSubagentPresetService } from '#/app/autoSubagentPreset/autoSubagentPreset';
import {
  ISessionSubagentService,
  type AgentRunHandle,
} from '#/session/subagent/subagent';
import type { ExecutableToolResult } from '#/tool/toolContract';

import { StubConfigService } from '../../../kosong/stubs';
import { executeTool } from '../../../tools/fixtures/execute-tool';
import { stubAutoSubagentPreset } from '../../../app/autoSubagentPreset/stubs';

const execFileAsync = promisify(execFile);
const signal = new AbortController().signal;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TowerSpawnTool', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let repo: string;
  let store: TowerStore;

  let towerActive: boolean;
  let gate: { readonly ok: true } | { readonly ok: false; readonly reason: string };
  let release: Mock<() => void>;
  let createAgent: Mock<IAgentLifecycleService['create']>;
  let runAgent: Mock<ISessionSubagentService['run']>;
  let registerTask: Mock<IAgentTaskService['registerTask']>;
  let completion: Deferred<{ readonly summary: string }>;
  let secondaryFlagOn: boolean;
  let secondaryModel: { readonly model: string } | undefined;
  let subagentConfig: Record<string, unknown> | undefined;
  let config: StubConfigService;
  let createdSetMode: Mock<(mode: PermissionMode) => void>;
  let effectiveThinking: string | undefined;
  let child: Awaited<ReturnType<IAgentLifecycleService['create']>>;

  async function git(cwd: string, ...args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd });
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'tower-spawn-test-'));
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.email', 'tower-test@example.com');
    await git(repo, 'config', 'user.name', 'Tower Test');
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await git(repo, 'add', 'README.md');
    await git(repo, 'commit', '-m', 'initial');
    store = new TowerStore(repo);
    await store.init();
    await store.plan([{ title: 'Build gemm', scope: ['src/**'] }]);

    towerActive = true;
    gate = { ok: true };
    release = vi.fn();
    completion = deferred();
    secondaryFlagOn = false;
    secondaryModel = undefined;
    subagentConfig = undefined;
    config = new StubConfigService();
    createdSetMode = vi.fn();
    effectiveThinking = undefined;
    createAgent = vi.fn(async (options) => {
      const childProfile = {
        data: () => ({
          modelAlias: options?.binding?.model,
          thinkingLevel: options?.binding?.thinking ?? 'off',
        }),
        getEffectiveThinkingLevel: () => effectiveThinking ?? options?.binding?.thinking ?? 'off',
        republishStatus: vi.fn(),
      };
      child = {
        id: 'agent-7',
        accessor: {
          get: (id: unknown) =>
            id === (IAgentPermissionModeService as unknown)
              ? { setMode: createdSetMode }
              : id === (IAgentProfileService as unknown) ? childProfile : undefined,
        },
      } as never;
      return child;
    });
    runAgent = vi.fn(
      async (agentId: string) =>
        ({
          agentId,
          turn: undefined,
          timingEvidence: () => ({ llmRequestCount: 0, firstTokenLatencySampleCount: 0 }),
          completion: completion.promise,
        }) as unknown as AgentRunHandle,
    );
    registerTask = vi.fn(() => 'task-1');

    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(IAgentTowerService, {
      get isActive() {
        return towerActive;
      },
      enter: () => {},
      exit: () => {},
    } as unknown as IAgentTowerService);
    ix.stub(ITowerRateLimitService, {
      acquire: () => gate,
      release,
    } as unknown as ITowerRateLimitService);
    ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-spawn-test' } as unknown as ISessionContext);
    ix.stub(IAgentScopeContext, { agentId: 'main', scope: (subKey?: string) => subKey ?? '' });
    ix.stub(IAgentLifecycleService, {
      get: (agentId: string) =>
        agentId === 'main'
          ? ({
              id: 'main',
              accessor: {
                get: (id: unknown) =>
                  id === (IEventBus as unknown)
                    ? ix.get(IEventBus)
                    : id === (IAgentLifecycleService as unknown)
                      ? { get: (targetId: string) => targetId === 'agent-7' ? child : undefined }
                      : undefined,
              },
            } as never)
          : undefined,
      create: createAgent,
    } as unknown as IAgentLifecycleService);
    ix.stub(ISessionSubagentService, { run: runAgent } as unknown as ISessionSubagentService);
    ix.stub(IAgentTaskService, { registerTask } as unknown as IAgentTaskService);
    ix.stub(IAgentProfileService, {
      data: () => ({ profileName: 'agent', modelAlias: 'kimi-code', thinkingLevel: 'off' }),
    } as unknown as IAgentProfileService);
    ix.stub(IConfigService, config);
    ix.stub(IFlagService, {
      enabled: (id: string) => id === SECONDARY_MODEL_FLAG_ID && secondaryFlagOn,
    } as unknown as IFlagService);
    ix.stub(IModelCatalog, { get: () => ({}) } as unknown as IModelCatalog);
    ix.stub(IAutoSubagentPresetService, {
      ...stubAutoSubagentPreset(),
      resolveBinding: async (request) => resolveSubagentBinding(
        config, ix.get(IFlagService), ix.get(IModelCatalog), request,
      ),
    });
    ix.set(ITowerSpawnTool, new SyncDescriptor(TowerSpawnTool));
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(repo, { recursive: true, force: true });
  });

  function execute(args: TowerSpawnToolInput): Promise<ExecutableToolResult> {
    config.setSilent(SECONDARY_MODEL_SECTION, secondaryModel);
    config.setSilent(SUBAGENT_SECTION, subagentConfig);
    return executeTool(ix.get(ITowerSpawnTool), {
      args,
      turnId: 0,
      toolCallId: 'call_spawn',
      signal,
    });
  }

  const WORKER_ARGS: TowerSpawnToolInput = {
    name: 'agent-build',
    kind: 'worker',
    mission_id: 'M1',
  };

  it('refuses when tower mode is not active', async () => {
    towerActive = false;

    const result = await execute(WORKER_ARGS);

    expect(result).toEqual({
      output: 'tower mode is not active — run TowerInit first',
      isError: true,
    });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('surfaces the rate-limit reason as an error result', async () => {
    gate = { ok: false, reason: 'tower spawn paused: provider is rate-limiting' };

    const result = await execute(WORKER_ARGS);

    expect(result).toEqual({ output: gate.ok === false ? gate.reason : '', isError: true });
    expect(createAgent).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    // The mission is untouched by the refused spawn — no phantom active owner.
    const mission = (await store.load()).missions.find((m) => m.id === 'M1');
    expect(mission?.status).toBe('planned');
    expect(mission?.owner).toBeUndefined();
  });

  it('leaves the mission untouched when the launch fails', async () => {
    createAgent.mockRejectedValue(new Error('provider unavailable'));

    const result = await execute(WORKER_ARGS);

    expect(result).toEqual({ output: 'tower spawn failed: provider unavailable', isError: true });
    const state = await store.load();
    const mission = state.missions.find((m) => m.id === 'M1');
    expect(mission?.status).toBe('planned');
    expect(mission?.owner).toBeUndefined();
    expect(state.roster.agents).toHaveLength(0);
  });

  it('creates workers and reviewers with their own temporary binding and reports the actual model', async () => {
    const resolveBinding = vi.fn<IAutoSubagentPresetService['resolveBinding']>(async (request) => ({
      model: request.route === 'tower_worker' ? 'fallback/worker' : 'fallback/reviewer',
      thinking: request.route === 'tower_worker' ? 'low' : 'high',
      source: 'auto-fallback', modelSource: 'auto-fallback', thinkingSource: 'auto-fallback',
    }));
    ix.stub(IAutoSubagentPresetService, { resolveBinding });
    const events: unknown[] = [];
    disposables.add(ix.get(IEventBus).subscribe((event) => events.push(event)));

    const worker = await execute(WORKER_ARGS);
    const reviewer = await execute({ name: 'reviewer-a', kind: 'reviewer', review_target: 'feat/build-gemm' });

    expect(worker.isError).toBeUndefined();
    expect(reviewer.isError).toBeUndefined();
    expect(createAgent).toHaveBeenNthCalledWith(1, {
      binding: { profile: 'tower-worker', model: 'fallback/worker', thinking: 'low' },
      labels: { parentAgentId: 'main' },
    });
    expect(createAgent).toHaveBeenNthCalledWith(2, {
      binding: { profile: 'tower-worker', model: 'fallback/reviewer', thinking: 'high' },
      labels: { parentAgentId: 'main' },
    });
    expect(worker.output).toContain('model: fallback/worker');
    expect(reviewer.output).toContain('model: fallback/reviewer');
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.spawned', model: 'fallback/worker' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.spawned', model: 'fallback/reviewer' }));
    const activityLog = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(activityLog).toMatch(/spawn .*model=fallback\/worker/);
    expect(activityLog).toMatch(/spawn .*model=fallback\/reviewer/);
    expect(registerTask.mock.calls[0]?.[0]).toMatchObject({ model: 'fallback/worker' });
    expect(resolveBinding).toHaveBeenCalledTimes(2);
  });

  it.each(['off', undefined])('records effective thinking instead of requested %s in task snapshots', async (requested) => {
    effectiveThinking = 'high';
    ix.stub(IAutoSubagentPresetService, {
      resolveBinding: async () => ({
        model: 'provider/worker', thinking: requested,
        source: 'caller', modelSource: 'caller', thinkingSource: 'caller',
      }),
    });
    const events: unknown[] = [];
    disposables.add(ix.get(IEventBus).subscribe((event) => events.push(event)));
    const result = await execute(WORKER_ARGS);
    expect(result.isError, String(result.output)).toBeFalsy();
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
      binding: { profile: 'tower-worker', model: 'provider/worker', thinking: requested },
    }));
    const task = registerTask.mock.calls[0]![0];
    expect(task).toMatchObject({ model: 'provider/worker', thinkingEffort: 'high' });
    expect(task.toInfo({
      taskId: 'task-1', description: 'Worker', status: 'running', startedAt: 0, endedAt: null,
    })).toMatchObject({ model: 'provider/worker', thinkingEffort: 'high' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'subagent.spawned', model: 'provider/worker', thinkingEffort: 'high',
    }));
  });

  it('refuses an unavailable route without allocation or a phantom roster entry', async () => {
    ix.stub(IAutoSubagentPresetService, {
      resolveBinding: vi.fn().mockRejectedValue(new Error('No compatible route')),
    });
    const result = await execute(WORKER_ARGS);
    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('No compatible route') });
    expect(createAgent).not.toHaveBeenCalled();
    expect(registerTask).not.toHaveBeenCalled();
    expect((await store.load()).roster.agents).toHaveLength(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it('spawns a detached tower-worker, registers the roster entry, and releases the slot on settle', async () => {
    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    const worktreeAbs = join(repo, '.tower/worktrees/wt-1');
    expect(result.output).toContain('agent_id: agent-7');
    expect(result.output).toContain('task_id: task-1');
    expect(result.output).toContain('status: running');
    expect(result.output).toContain(`worktree: ${worktreeAbs}`);

    expect(createAgent).toHaveBeenCalledWith({
      binding: { profile: 'tower-worker', model: 'kimi-code', thinking: 'off' },
      labels: { parentAgentId: 'main' },
    });
    expect(runAgent).toHaveBeenCalledWith(
      'agent-7',
      { kind: 'prompt', prompt: expect.stringContaining(worktreeAbs) },
      { signal: expect.any(AbortSignal) },
    );
    expect(registerTask).toHaveBeenCalledWith(expect.any(SubagentTask), {
      detached: true,
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
      signal: undefined,
    });

    const state = await store.load();
    const entry = state.roster.agents.find((agent) => agent.name === 'agent-build');
    expect(entry).toMatchObject({
      agentId: 'agent-7',
      sessionId: 'session-spawn-test',
      kind: 'worker',
      missionId: 'M1',
      worktree: 'wt-1',
      branch: 'feat/build-gemm',
    });
    const mission = state.missions.find((m) => m.id === 'M1');
    expect(mission?.status).toBe('active');
    expect(mission?.owner).toBe('agent-build');

    expect(release).not.toHaveBeenCalled();
    completion.resolve({ summary: 'worker done' });
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it('pins the spawned agent to the auto permission mode', async () => {
    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(createdSetMode).toHaveBeenCalledWith('auto');
  });

  it('uses the legacy fallback for workers and reports it in the output and activity log', async () => {
    secondaryFlagOn = true;
    secondaryModel = { model: 'cheap/fast' };

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('model: cheap/fast');
    expect(createAgent).toHaveBeenCalledWith({
      binding: { profile: 'tower-worker', model: 'cheap/fast', thinking: undefined },
      labels: { parentAgentId: 'main' },
    });
    const activityLog = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(activityLog).toMatch(/spawn .*model=cheap\/fast/);
  });

  it('inherits the caller model when the legacy fallback is disabled', async () => {
    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('model: kimi-code');
    const activityLog = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(activityLog).toMatch(/spawn .*model=kimi-code/);
  });

  it('keeps reviewers on the caller model when the legacy fallback is configured', async () => {
    secondaryFlagOn = true;
    secondaryModel = { model: 'cheap/fast' };

    const result = await execute({
      name: 'reviewer-a',
      kind: 'reviewer',
      review_target: 'feat/build-gemm',
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('model: kimi-code');
    expect(createAgent).toHaveBeenCalledWith({
      binding: { profile: 'tower-worker', model: 'kimi-code', thinking: 'off' },
      labels: { parentAgentId: 'main' },
    });
  });

  it('uses separate canonical preset routes for workers and reviewers', async () => {
    secondaryFlagOn = true;
    secondaryModel = { model: 'cheap/fast' };
    subagentConfig = {
      preset: 'research',
      presets: {
        research: {
          tower_worker: { model: 'preset/worker', thinkingEffort: 'low' },
          tower_reviewer: { model: 'preset/reviewer', thinkingEffort: 'high' },
        },
      },
    };

    const worker = await execute(WORKER_ARGS);
    const reviewer = await execute({
      name: 'reviewer-a',
      kind: 'reviewer',
      review_target: 'feat/build-gemm',
    });

    expect(worker.isError).toBeUndefined();
    expect(reviewer.isError).toBeUndefined();
    expect(createAgent).toHaveBeenNthCalledWith(1, {
      binding: { profile: 'tower-worker', model: 'preset/worker', thinking: 'low' },
      labels: { parentAgentId: 'main' },
    });
    expect(createAgent).toHaveBeenNthCalledWith(2, {
      binding: { profile: 'tower-worker', model: 'preset/reviewer', thinking: 'high' },
      labels: { parentAgentId: 'main' },
    });
  });

  it('falls back each tower route field independently to the base route', async () => {
    secondaryFlagOn = true;
    secondaryModel = { model: 'legacy/removed' };
    subagentConfig = {
      preset: 'research',
      agents: {
        tower_worker: { model: 'agents/worker', thinkingEffort: 'agents-worker' },
        tower_reviewer: { model: 'agents/reviewer', thinkingEffort: 'agents-reviewer' },
      },
      presets: {
        research: {
          tower_worker: { thinkingEffort: 'preset-worker' },
          tower_reviewer: { model: 'preset/reviewer' },
        },
      },
    };

    const worker = await execute(WORKER_ARGS);
    const reviewer = await execute({
      name: 'reviewer-a',
      kind: 'reviewer',
      review_target: 'feat/build-gemm',
    });

    expect(worker.isError).toBeUndefined();
    expect(reviewer.isError).toBeUndefined();
    expect(createAgent).toHaveBeenNthCalledWith(1, {
      binding: { profile: 'tower-worker', model: 'agents/worker', thinking: 'preset-worker' },
      labels: { parentAgentId: 'main' },
    });
    expect(createAgent).toHaveBeenNthCalledWith(2, {
      binding: { profile: 'tower-worker', model: 'preset/reviewer', thinking: 'agents-reviewer' },
      labels: { parentAgentId: 'main' },
    });
  });

  it('registers a reviewer without a worktree', async () => {
    const result = await execute({
      name: 'reviewer-a',
      kind: 'reviewer',
      review_target: 'feat/build-gemm',
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('review_target: feat/build-gemm');
    const state = await store.load();
    const entry = state.roster.agents.find((agent) => agent.name === 'reviewer-a');
    expect(entry).toMatchObject({
      agentId: 'agent-7',
      kind: 'reviewer',
      reviewTarget: 'feat/build-gemm',
    });
    expect(entry?.worktree).toBeUndefined();
  });

  it('refuses a duplicate name and points at resume', async () => {
    await store.registerAgent({
      name: 'agent-build',
      agentId: 'agent-old',
      kind: 'worker',
      missionId: 'M1',
      worktree: 'wt-1',
      branch: 'feat/build-gemm',
      spawnedAt: new Date().toISOString(),
    });

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('already registered');
    expect(result.output).toContain('Agent(resume="agent-old"');
    expect(createAgent).not.toHaveBeenCalled();
  });
});
