/**
 * `agentLifecycle` domain — `IAgentLifecycleService` implementation.
 *
 * Creates and tracks the session's agents as child scopes in a flat registry,
 * serializing same-id bootstrap and dropping incomplete handles after startup
 * failure. Seeds each agent's identity through `agent` scopeContext, wires
 * per-agent wire records and the wire state machine, the blob store, and MCP,
 * and registers the agent in the session registry. An id that already has a
 * persisted record keeps that record verbatim — reuse of an existing record,
 * not the create options, defines the agent's labels, parentage and fork
 * provenance. Binds the agent id into the
 * Agent-scoped telemetry view. New logs receive a metadata
 * envelope while non-empty unversioned logs are rejected.
 *
 * `restore` re-materializes an agent the session has on disk but that a cold
 * resume did not bring back (it materializes `main` only) by reusing the
 * persisted record and the same bootstrap path; an id with no record is never
 * materialized.
 *
 * Removal awaits the
 * agent task manager's graceful exit policy before draining turns and full
 * compaction, then disposing the child scope. An id under removal is registered
 * in the removing set from the moment it leaves the registry until its scope is
 * disposed, and `create` / `restore` refuse that id for the whole window: the
 * window spans awaits, so without the guard a caller could materialize a second
 * scope sharing the same wire journal — and resurrect an agent the session is
 * closing. The refusal is checked before the in-flight-creation join as well,
 * so a caller never receives a handle whose bootstrap the removal is about to
 * dispose. Refusal reuses the not-found code because from a caller's view the
 * agent is not available; a later create, after the removal settled, is
 * ordinary. Fans session-level
 * permission-mode switches out to every live agent — except
 * `tower-worker`-profile agents, which TowerSpawn pins to `auto` (they run
 * detached and unattended); the broadcast leaves them on `auto`. Bound at
 * Session scope.
 *
 * No agent id is special here: the main agent is simply the agent created
 * with the conventional `MAIN_AGENT_ID`, and `fork` requires its source to
 * exist. MCP readiness is not awaited here: the workspace's shared manager
 * connects in the background and the agent's LLM steps wait on it instead
 * (see `AgentMcpService`).
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { Error2, ErrorCodes } from '#/errors';
import { join } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import {
  createScopedChildHandle,
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/agent/permissionMode/configSection';
import { PermissionModeConfiguredModel } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { ProfileModel } from '#/agent/profile/profileOps';
import { TOWER_WORKER_PROFILE } from '#/features/tower/tower';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { abortError } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentRuntimeBindingSeed, IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import '#/agent/runtimeBinding/runtimeBindingService';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IWireService } from '#/wire/wire';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  type AgentListFilter,
  type CreateAgentOptions,
  type ForkAgentOptions,
  IAgentLifecycleService,
} from './agentLifecycle';

let nextAgentId = 0;

// NOTE: stays Disposable — its own 'get' and 'config' collide with the Fiber
export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly handles = new Map<string, IAgentScopeHandle>();
  private readonly onDidCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidDisposeEmitter = this._register(new Emitter<string>());
  private readonly onWillCloseEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly interactionBusDisposables = new Map<string, IDisposable>();
  private readonly creating = new Map<string, Promise<IAgentScopeHandle>>();
  private readonly removing = new Set<string>();

  get onDidCreate() {
    return this.onDidCreateEmitter.event;
  }
  get onDidDispose() {
    return this.onDidDisposeEmitter.event;
  }
  get onWillClose() {
    return this.onWillCloseEmitter.event;
  }

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this._register(this.onDidCreate((handle) => this.subscribeInteractionBus(handle)));
    this._register(
      this.onDidDispose((agentId) => {
        const d = this.interactionBusDisposables.get(agentId);
        if (d !== undefined) {
          d.dispose();
          this.interactionBusDisposables.delete(agentId);
        }
      }),
    );
    this._register({
      dispose: () => {
        for (const d of this.interactionBusDisposables.values()) d.dispose();
        this.interactionBusDisposables.clear();
      },
    });
  }

  private subscribeInteractionBus(handle: IAgentScopeHandle): void {
    if (this.interactionBusDisposables.has(handle.id)) return;
    const d = handle.accessor
      .get(IEventBus)
      .subscribe('turn.ended', (e) => this.interaction.cancelPendingForTurn(e.turnId));
    this.interactionBusDisposables.set(handle.id, d);
  }

  async create(opts: CreateAgentOptions = {}): Promise<IAgentScopeHandle> {
    if (opts.agentId !== undefined) {
      this.assertNotRemoving(opts.agentId);
      const inflight = this.creating.get(opts.agentId);
      if (inflight !== undefined) return inflight;
      const existing = this.handles.get(opts.agentId);
      if (existing !== undefined) return existing;
    }
    const agentId = opts.agentId ?? (await this.nextAvailableAgentId());
    const promise = this.doCreate(agentId, opts);
    this.creating.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(agentId);
    }
  }

  private async nextAvailableAgentId(): Promise<string> {
    let maxSuffix = -1;
    const consider = (id: string): void => {
      const match = /^agent-(\d+)$/.exec(id);
      if (match !== null) maxSuffix = Math.max(maxSuffix, Number(match[1]));
    };
    for (const id of this.handles.keys()) consider(id);
    const persisted = (await this.sessionMetadata.read()).agents ?? {};
    for (const id of Object.keys(persisted)) consider(id);
    const candidate = Math.max(maxSuffix + 1, nextAgentId);
    nextAgentId = candidate + 1;
    return `agent-${String(candidate)}`;
  }

  private async doCreate(agentId: string, opts: CreateAgentOptions): Promise<IAgentScopeHandle> {
    const agentScope = this.ctx.scope(`agents/${agentId}`);
    const agentHomedir = join(this.bootstrap.homeDir, agentScope);
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Agent,
      agentId,
      {
        seeds: [
          [IAgentScopeContext, makeAgentScopeContext({ agentId, agentScope })],
          [ITelemetryService, this.telemetry.withContext({ agent_id: agentId })],
          [IAgentRuntimeBindingSeed, {
            _serviceBrand: undefined,
            binding: { workspaceId: this.ctx.workspaceId, runtimeId: opts.runtimeId ?? 'local' },
          }],
        ],
      },
    ) as IAgentScopeHandle;
    this.handles.set(agentId, handle);
    try {
      const wire = handle.accessor.get(IWireService);
      await wire.seal();
      const persisted = (await this.sessionMetadata.read()).agents?.[agentId];
      await this.sessionMetadata.registerAgent(
        agentId,
        persisted ?? {
          homedir: agentHomedir,
          type: agentId === 'main' ? 'main' : 'sub',
          parentAgentId: agentId === 'main' ? undefined : 'main',
          forkedFrom: opts.forkedFrom,
          labels: opts.labels,
        },
      );
      this.onDidCreateEmitter.fire(handle);
      await wire.restore();
      await this.bindBootstrap(handle, opts);
      await handle.accessor.get(IAgentToolActivationService).activate();
      return handle;
    } catch (error) {
      if (this.handles.get(agentId) === handle) this.handles.delete(agentId);
      try {
        handle.dispose();
      } catch { }
      this.onDidDisposeEmitter.fire(agentId);
      throw error;
    }
  }

  private async bindBootstrap(
    handle: IAgentScopeHandle,
    opts: CreateAgentOptions,
  ): Promise<void> {
    if (opts.binding !== undefined) {
      await handle.accessor.get(IAgentProfileService).bind(opts.binding);
    }
    const wire = handle.accessor.get(IWireService);
    const permissionMode = this.config.get<PermissionMode>(DEFAULT_PERMISSION_MODE_SECTION);
    const hasRestoredPermissionMode = wire.getModel(PermissionModeConfiguredModel);
    if (permissionMode !== undefined && !hasRestoredPermissionMode) {
      handle.accessor.get(IAgentPermissionModeService).setMode(permissionMode);
    }
  }

  async fork(sourceAgentId: string, opts?: ForkAgentOptions): Promise<IAgentScopeHandle> {
    const source = this.handles.get(sourceAgentId);
    if (source === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Source agent "${sourceAgentId}" does not exist`, {
        details: { agentId: sourceAgentId },
      });
    }
    if (opts?.agentId !== undefined && this.handles.has(opts.agentId)) {
      throw new Error2(ErrorCodes.AGENT_ALREADY_EXISTS, `Agent "${opts.agentId}" already exists`, {
        details: { agentId: opts.agentId },
      });
    }
    const child = await this.create({
      agentId: opts?.agentId,
      runtimeId: source.accessor.get(IAgentRuntimeBindingService).current.runtimeId,
      forkedFrom: source.id,
    });

    const sourceData = source.accessor.get(IAgentProfileService).data();
    const childProfile = child.accessor.get(IAgentProfileService);
    const override = opts?.binding;
    if (override?.profile !== undefined) {
      await childProfile.bind({
        profile: override.profile,
        model: override.model ?? sourceData.modelAlias,
        thinking: override?.thinking ?? sourceData.thinkingLevel,
      });
    } else {
      childProfile.applyBindingSnapshot(sourceData);
      if (override?.model !== undefined) await childProfile.setModel(override.model);
      if (override?.thinking !== undefined) childProfile.setThinking(override.thinking);
    }

    const sourceMessages = source.accessor.get(IAgentContextMemoryService)?.get();
    if (sourceMessages !== undefined && sourceMessages.length > 0) {
      child.accessor.get(IAgentContextMemoryService)?.append(...sourceMessages);
    }
    return child;
  }

  get(agentId: string): IAgentScopeHandle | undefined {
    return this.handles.get(agentId);
  }

  async restore(agentId: string): Promise<IAgentScopeHandle | undefined> {
    this.assertNotRemoving(agentId);
    const inflight = this.creating.get(agentId);
    if (inflight !== undefined) return inflight;
    if (this.handles.has(agentId)) return this.create({ agentId });
    const meta = (await this.sessionMetadata.read()).agents?.[agentId];
    if (meta === undefined) return undefined;
    return this.create({ agentId });
  }

  private assertNotRemoving(agentId: string): void {
    if (!this.removing.has(agentId)) return;
    throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent instance "${agentId}" is being removed`, {
      details: { agentId },
    });
  }

  list(filter?: AgentListFilter): readonly IAgentScopeHandle[] {
    const all = [...this.handles.values()];
    const prefix = filter?.prefix;
    if (prefix === undefined) return all;
    return all.filter((handle) => handle.id.startsWith(prefix));
  }

  broadcastPermissionMode(mode: PermissionMode): void {
    for (const handle of this.handles.values()) {
      // Tower workers/reviewers stay pinned to auto (see the file header) —
      // the profile name is read off the wire model, not the profile service,
      // so the broadcast never has to materialize one.
      if (
        handle.accessor.get(IWireService).getModel(ProfileModel).profileName ===
        TOWER_WORKER_PROFILE
      ) {
        continue;
      }
      handle.accessor.get(IAgentPermissionModeService).setMode(mode);
    }
  }

  async remove(agentId: string): Promise<void> {
    const handle = this.handles.get(agentId);
    if (handle === undefined) return;
    this.handles.delete(agentId);
    this.removing.add(agentId);
    try {
      const tasks = handle.accessor.get(IAgentTaskService);
      await tasks.suppressAllTerminalNotifications();
      this.onWillCloseEmitter.fire(handle);
      const loop = handle.accessor.get(IAgentLoopService);
      const compaction = handle.accessor.get(IAgentFullCompactionService).compacting;
      const compactionSettled = compaction?.promise.catch(() => undefined) ?? Promise.resolve();
      const reason = abortError('Agent removed');
      for (const turnId of loop.status().pendingTurnIds) {
        loop.cancel(turnId, reason);
      }
      loop.cancel(undefined, reason);
      if (compaction !== null && !compaction.abortController.signal.aborted) {
        compaction.abortController.abort(reason);
      }
      await Promise.all([loop.settled(), compactionSettled]);
      await tasks.stopAllOnExit('Session closed');
      handle.dispose();
      this.onDidDisposeEmitter.fire(agentId);
    } finally {
      this.removing.delete(agentId);
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentLifecycleService,
  AgentLifecycleService,
  ScopeActivation.OnScopeCreated,
  'agentLifecycle',
);
