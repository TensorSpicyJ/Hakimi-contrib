import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { stubLoopWithHooks, type StubLoop } from '../../agent/loop/stubs';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { TowerStore } from '#/features/tower/protocol/index';
import { IAgentTowerService } from '#/features/tower/tower';
import { AgentTowerService } from '#/features/tower/towerService';
import { TowerModel } from '#/features/tower/towerOps';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { ToolCall } from '#/kosong/contract/message';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ToolAccesses } from '#/tool/toolContract';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';
import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

const execFileAsync = promisify(execFile);

const signal = new AbortController().signal;

function toolCall(name: string, id: string): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

function hookContext(toolCalls: ToolCall[], args: Record<string, unknown> = {}): ResolvedToolExecutionHookContext {
  return {
    turnId: 0,
    signal,
    toolCall: toolCalls[0]!,
    toolCalls,
    args,
    execution: { approvalRule: toolCalls[0]!.name, execute: async () => ({ output: '' }) },
  };
}

function writeHookContext(toolName: string, paths: readonly string[]): ResolvedToolExecutionHookContext {
  const call = toolCall(toolName, `call_${toolName.toLowerCase()}`);
  return {
    turnId: 0,
    signal,
    toolCall: call,
    toolCalls: [call],
    args: {},
    execution: {
      approvalRule: toolName,
      accesses: paths.flatMap((path) => ToolAccesses.writeFile(path)),
      execute: async () => ({ output: '' }),
    },
  };
}

describe('AgentTowerService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  let permissionGateRan: boolean;
  let formatDenyMessage: Mock<(message: string) => string>;
  let loop: StubLoop;
  let inactivePolicyTool: string | undefined;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    // A stand-in listener registered after the tower listener proves whether
    // the tower veto ended adjudication or abstained.
    executorEvents = stubToolExecutorEvents();
    permissionGateRan = false;
    ix.stub(IAgentToolExecutorService, executorEvents.executor);
    formatDenyMessage = vi.fn((message: string) => message);
    ix.stub(IAgentToolApprovalService, { formatDenyMessage });
    loop = stubLoopWithHooks();
    ix.stub(IAgentLoopService, loop);
    inactivePolicyTool = undefined;
    ix.stub(IAgentToolPolicyService, {
      isToolActive: (name: string) => name !== inactivePolicyTool,
    } as unknown as IAgentToolPolicyService);
    // Write-guard dependencies — inert defaults; the guard tests re-stub them
    // with a worker profile / roster-backed repo before resolving the service.
    ix.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
    } as unknown as IAgentProfileService);
    ix.stub(IAgentScopeContext, {
      agentId: 'main',
      scope: (subKey?: string) => subKey ?? '',
    });
    ix.stub(ISessionContext, { cwd: '/nonexistent-tower-repo' } as unknown as ISessionContext);
    registerTestAgentWire(ix, testWireScope('wire', 'tower-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    ix.stub(IAgentScopeContext, {
      agentId: 'main',
      scope: (subKey?: string) => subKey ?? '',
    });
    ix.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
  });
  afterEach(() => disposables.dispose());

  async function fire(
    ctx: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    disposables.add(
      executorEvents.executor.onBeforeExecuteTool(() => {
        permissionGateRan = true;
      }),
    );
    return executorEvents.fireBeforeExecute(ctx);
  }

  it('enter / exit toggle isActive and emit agent.status.updated via wire', () => {
    const tower = ix.get(IAgentTowerService);
    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    expect(tower.isActive).toBe(false);
    tower.enter();
    expect(tower.isActive).toBe(true);
    tower.exit();
    expect(tower.isActive).toBe(false);

    expect(events).toEqual([
      { type: 'agent.status.updated', towerMode: true },
      { type: 'agent.status.updated', towerMode: false },
    ]);
  });

  it('enter / exit are idempotent while already in that state', () => {
    const tower = ix.get(IAgentTowerService);
    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    tower.exit();
    expect(tower.isActive).toBe(false);
    tower.enter();
    tower.enter();
    expect(tower.isActive).toBe(true);

    expect(events).toEqual([{ type: 'agent.status.updated', towerMode: true }]);
  });

  it('dispatch persists enter/exit records and replay rebuilds the flag (silent)', async () => {
    const tower = ix.get(IAgentTowerService);
    tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    expect(records).toEqual([{ type: 'tower_mode.enter', time: expect.any(Number) }]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const fresh = registerTestAgentWire(ix2, testWireScope('wire', 'tower-replay'), {
      log: ix2.get(IAppendLogStore),
    });
    await restoreTestAgentWire(
      fresh,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-replay'),
      records,
    );
    expect(fresh.getModel(TowerModel)).toBe(true);
  });

  it('replays legacy v1 tower_mode records written without a payload', async () => {
    const records: WireRecord[] = [
      { type: 'tower_mode.enter', time: 1 },
      { type: 'tower_mode.exit', time: 2 },
      { type: 'tower_mode.enter', time: 3 },
    ];

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const fresh = registerTestAgentWire(ix2, testWireScope('wire', 'tower-legacy'), {
      log: ix2.get(IAppendLogStore),
    });
    await restoreTestAgentWire(
      fresh,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-legacy'),
      records,
    );
    expect(fresh.getModel(TowerModel)).toBe(true);
  });

  it('leaves AskUserQuestion alone while tower mode is active (the tower may ask)', async () => {
    const tower = ix.get(IAgentTowerService);
    tower.enter();

    const decision = await fire(hookContext([toolCall('AskUserQuestion', 'call_ask')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('abstains on AskUserQuestion while tower mode is inactive', async () => {
    ix.get(IAgentTowerService);

    const decision = await fire(hookContext([toolCall('AskUserQuestion', 'call_ask')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('vetoes TodoList while tower mode is active', async () => {
    const tower = ix.get(IAgentTowerService);
    tower.enter();

    const decision = await fire(hookContext([toolCall('TodoList', 'call_todo')]));

    expect(decision).toEqual({
      veto: {
        output: expect.stringContaining('TodoList is not available while tower mode is active'),
        isError: true,
      },
    });
    expect(permissionGateRan).toBe(false);
    expect(formatDenyMessage).toHaveBeenCalledTimes(1);
  });

  it('abstains on TodoList while tower mode is inactive', async () => {
    ix.get(IAgentTowerService);

    const decision = await fire(hookContext([toolCall('TodoList', 'call_todo')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('abstains on other tools while tower mode is active', async () => {
    const tower = ix.get(IAgentTowerService);
    tower.enter();

    const decision = await fire(hookContext([toolCall('Bash', 'call_bash')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('vetoes foreground resume of a roster agent unless task controls are unavailable', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tower-resume-test-'));
    try {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 'tower-test@example.com'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.name', 'Tower Test'], { cwd: repo });
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      const store = new TowerStore(repo);
      await store.init();
      await store.registerAgent({
        name: 'worker-a',
        agentId: 'agent-worker-a',
        kind: 'worker',
        spawnedAt: new Date().toISOString(),
      });
      const stateFile = join(repo, '.tower/comms/state.json');
      const state = JSON.parse(await readFile(stateFile, 'utf8')) as {
        roster: { agents: Record<string, unknown>[] };
      };
      state.roster.agents.unshift({
        name: 'worker-stale',
        agentId: 'agent-worker-a',
        kind: 'worker',
        spawnedAt: '2026-09-13T08:00:00.000Z',
      });
      await writeFile(stateFile, `${JSON.stringify(state)}\n`);
      ix.stub(ISessionContext, { cwd: repo } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);
      tower.enter();

      const veto = await fire(
        hookContext([toolCall('Agent', 'call_resume')], { resume: ' agent-worker-a ' }),
      );
      expect(veto?.veto?.output).toContain('worker-a');
      expect(veto?.veto?.output).not.toContain('worker-stale');
      expect(veto?.veto?.output).toContain('run_in_background=true');

      const background = await fire(
        hookContext([toolCall('Agent', 'call_background')], {
          resume: 'agent-worker-a',
          run_in_background: true,
        }),
      );
      expect(background).toBeUndefined();

      for (const name of ['TaskList', 'TaskOutput', 'TaskStop']) {
        inactivePolicyTool = name;
        const decision = await fire(
          hookContext([toolCall('Agent', `call_${name}`)], { resume: 'agent-worker-a' }),
        );
        expect(decision).toBeUndefined();
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('coalesces inbox signals, truncates the latest subject, and drains a later batch after materialization', async () => {
    const tower = ix.get(IAgentTowerService);
    tower.enter();
    expect(tower.isActive).toBe(true);
    const enqueue = vi.spyOn(loop, 'enqueue');
    tower.notifyInbox({ from: 'worker-a', to: 'tower', subject: 'first' });
    tower.notifyInbox({ from: 'worker-b', to: 'all', subject: 'x'.repeat(121) });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(loop.queue.hasPendingRequests()).toBe(true);

    const messages: unknown[] = [];
    loop.drainNextBatch({ append: (...items) => messages.push(...items) });
    expect(JSON.stringify(messages)).toContain('2 new tower inbox messages');
    expect(JSON.stringify(messages)).toContain(`${'x'.repeat(120)}…`);

    tower.notifyInbox({ from: 'worker-c', to: 'tower', subject: 'later' });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(loop.queue.hasPendingRequests()).toBe(true);
    const later: unknown[] = [];
    loop.drainNextBatch({ append: (...items) => later.push(...items) });
    expect(JSON.stringify(later)).toContain('latest from worker-c:');
    expect(JSON.stringify(later)).toContain('later');
  });

  it('drops an inbox wake when disposed before its microtask runs', async () => {
    const tower = ix.get(IAgentTowerService) as AgentTowerService;
    tower.enter();
    tower.notifyInbox({ from: 'worker-a', to: 'tower', subject: 'disposed' });
    tower.dispose();
    await Promise.resolve();
    expect(loop.queue.hasPendingRequests()).toBe(false);
  });

  it('retries inbox wake after enqueue fails without an unhandled error', async () => {
    const tower = ix.get(IAgentTowerService);
    tower.enter();
    const enqueue = vi.spyOn(loop, 'enqueue').mockImplementationOnce(() => {
      throw new Error('loop unavailable');
    });
    tower.notifyInbox({ from: 'worker-a', to: 'tower', subject: 'retry' });
    await Promise.resolve();
    expect(enqueue).toHaveBeenCalledTimes(1);
    enqueue.mockRestore();
    tower.notifyInbox({ from: 'worker-b', to: 'tower', subject: 'retry again' });
    await Promise.resolve();
    expect(loop.queue.hasPendingRequests()).toBe(true);
  });

  it('drops a scheduled inbox wake on exit', async () => {
    const tower = ix.get(IAgentTowerService);
    tower.enter();
    tower.notifyInbox({ from: 'worker-a', to: 'tower', subject: 'stale' });
    tower.exit();
    await Promise.resolve();
    expect(loop.queue.hasPendingRequests()).toBe(false);
  });

  describe('tower-worker write guard', () => {
    const WORKER_AGENT_ID = 'agent-worker-1';
    let repo: string;
    let worktree: string;

    async function git(cwd: string, ...args: string[]): Promise<void> {
      await execFileAsync('git', args, { cwd });
    }

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), 'tower-guard-test-'));
      await git(repo, 'init', '-b', 'main');
      await git(repo, 'config', 'user.email', 'tower-test@example.com');
      await git(repo, 'config', 'user.name', 'Tower Test');
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await git(repo, 'add', 'README.md');
      await git(repo, 'commit', '-m', 'initial');
      const store = new TowerStore(repo);
      await store.init();
      await store.registerAgent({
        name: 'agent-build',
        agentId: WORKER_AGENT_ID,
        kind: 'worker',
        missionId: 'M1',
        worktree: 'wt-1',
        branch: 'feat/build',
        spawnedAt: new Date().toISOString(),
      });
      worktree = join(repo, '.tower/worktrees/wt-1');

      ix.stub(IAgentProfileService, {
        data: () => ({ profileName: 'tower-worker' }),
      } as unknown as IAgentProfileService);
      ix.stub(IAgentScopeContext, {
        agentId: WORKER_AGENT_ID,
        scope: (subKey?: string) => subKey ?? '',
      });
      ix.stub(ISessionContext, { cwd: repo } as unknown as ISessionContext);
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    it('allows a worker Write inside its own worktree', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(writeHookContext('Write', [`${worktree}/src/gemm.cpp`]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('denies a worker Write outside its worktree', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(
        writeHookContext('Edit', [`${repo}/src/gemm.cpp`, `${repo}/.tower/worktrees/wt-2/x.ts`]),
      );

      expect(decision?.veto?.isError).toBe(true);
      const output = decision?.veto?.output;
      expect(output).toContain(`tower workers may only write inside their own worktree (${worktree})`);
      expect(output).toContain(`${repo}/src/gemm.cpp`);
      expect(output).toContain(`${repo}/.tower/worktrees/wt-2/x.ts`);
      expect(output).toContain('TowerFinding');
      expect(output).toContain('TowerSend');
      expect(permissionGateRan).toBe(false);
      expect(formatDenyMessage).toHaveBeenCalledTimes(1);
    });

    it('abstains on non-Write/Edit tools for a worker', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(hookContext([toolCall('Bash', 'call_bash')]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('abstains when the agent is not a tower worker', async () => {
      ix.stub(IAgentProfileService, {
        data: () => ({ profileName: 'coder' }),
      } as unknown as IAgentProfileService);
      ix.get(IAgentTowerService);

      const decision = await fire(writeHookContext('Write', [`${repo}/src/gemm.cpp`]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('abstains when the worker has no roster entry', async () => {
      ix.stub(IAgentScopeContext, {
        agentId: 'agent-unregistered',
        scope: (subKey?: string) => subKey ?? '',
      });
      ix.get(IAgentTowerService);

      const decision = await fire(writeHookContext('Write', [`${repo}/src/gemm.cpp`]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });
  });
});
