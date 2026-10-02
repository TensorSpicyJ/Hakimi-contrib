/**
 * `tower` domain — `IAgentTowerService` implementation.
 *
 * Tracks tower-mode enter/exit in the `wire` `TowerModel` (mutated only
 * through the `tower_mode.enter` / `tower_mode.exit` Ops, read through
 * `wire.getModel`), and derives the `towerMode` slice of
 * `agent.status.updated` from the Ops' `toEvent`. Also carries the
 * tower-mode harness constraints as `onBeforeExecuteTool` veto listeners and
 * coalesces Tower inbox traffic into main-agent wake requests. The first denies
 * `TodoList` while tower mode is active: mission state lives in the tower
 * protocol, and todo semantics ("keep exactly one task in_progress") would
 * serialize a fleet that exists to run in parallel — tower mode is per-agent,
 * so this only ever fires for the tower itself and workers keep their TodoList.
 * The second veto prevents foreground resumes of roster agents while task
 * controls are available; detached resumes keep the tower responsive. The
 * third is the tower-worker write guard (port of v1's
 * `tower-worker-write-guard-deny` policy): a `tower-worker`-profile agent's
 * Write/Edit is confined to the
 * worktree its roster entry records (`.tower/worktrees/<slot>` under the
 * repo root, resolved through the `tower` protocol store from
 * `sessionContext.cwd`); any declared write access outside it is vetoed with
 * the v1 message verbatim. v1 keyed the confinement on the worker's cwd
 * override, which was always set; v2 has no per-agent cwd, so a worker
 * without a roster entry (or with no readable `.tower` state) is simply
 * outside the protocol and the guard abstains. `AskUserQuestion` is
 * deliberately not vetoed here: the tower (the main agent) may ask the human
 * to clarify requirements, while workers and reviewers cannot ask at all —
 * their `tower-worker` profile does not list the tool. Bound at Agent scope.
 */

import { join } from 'node:path';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { LifecycleScope } from '#/app/scopes';
import { isWithinDirectory } from '#/tool/path-access';
import type { ToolFileAccess } from '#/tool/toolContract';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IWireService } from '#/wire/wire';
import {
  BROADCAST_NAME,
  TOWER_NAME,
  TowerStore,
  WORKTREES_DIR,
  resolveTowerRepoRoot,
} from './protocol/index';
import { IAgentTowerService, TOWER_WORKER_PROFILE } from './tower';
import { towerEnter, towerExit, TowerModel } from './towerOps';

class TowerInboxWakeRequest extends MessageStepRequest {
  constructor(message: ConstructorParameters<typeof MessageStepRequest>[0], private readonly settled: () => void) {
    super(message, { mergeable: true, turnScoped: false, admission: 'activeOrNewTurn' });
  }
  protected override onSettled(): void { this.settled(); }
}

export class AgentTowerService extends Disposable implements IAgentTowerService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @ISessionContext private readonly sessionCtx: ISessionContext,
  ) {
    super();
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.isActive) return;
        if (event.toolCall.name !== 'TodoList') return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              'TodoList is not available while tower mode is active — mission state lives in the tower protocol (TowerPlan/TowerMission/TowerStatus, MISSIONS.md), and todo semantics would serialize the fleet. Spawn every dependency-unblocked mission now, then end your turn: worker completions wake you.',
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool(async (event) => {
        if (!this.isActive || event.toolCall.name !== 'Agent') return;
        const args = event.args;
        if (typeof args !== 'object' || args === null) return;
        const resume = (args as { readonly resume?: unknown }).resume;
        if (typeof resume !== 'string' || resume.trim().length === 0) return;
        if ((args as { readonly run_in_background?: unknown }).run_in_background === true) return;
        if (
          !this.toolPolicy.isToolActive('TaskList') ||
          !this.toolPolicy.isToolActive('TaskOutput') ||
          !this.toolPolicy.isToolActive('TaskStop')
        ) return;
        const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
        const entry = await store
          .load()
          .then((state) => store.resolveAgent(state, resume.trim()), () => undefined);
        if (entry === undefined) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              `Resuming tower agent "${entry.name}" in the foreground would freeze the tower — pass run_in_background=true instead.`,
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool(async (event) => {
        if (this.profile.data().profileName !== TOWER_WORKER_PROFILE) return;
        const toolName = event.toolCall.name;
        if (toolName !== 'Write' && toolName !== 'Edit') return;

        const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
        const entry = await store
          .load()
          .then((state) => store.resolveAgent(state, this.agentCtx.agentId), () => undefined);
        const slot = entry?.worktree;
        if (slot === undefined) return;
        const worktree = store.abs(join(WORKTREES_DIR, slot));

        const escapes = (event.execution.accesses ?? [])
          .filter(
            (access): access is ToolFileAccess =>
              access.kind === 'file' &&
              (access.operation === 'write' || access.operation === 'readwrite'),
          )
          .filter((access) => !isWithinDirectory(access.path, worktree));
        if (escapes.length === 0) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              `tower workers may only write inside their own worktree (${worktree}) — denied: ` +
                `${escapes.map((access) => access.path).join(', ')}. ` +
                'Out-of-scope changes are not yours to make: file them with TowerFinding or ask the tower via TowerSend.',
            ),
          ),
        );
      }),
    );
  }

  private wakeReceipt: ReturnType<IAgentLoopService['enqueue']> | undefined;
  private wakeRequest: TowerInboxWakeRequest | undefined;
  private wakeSignals: Array<{ readonly from: string; readonly to: string; readonly subject: string }> = [];
  private wakeEpoch = 0;
  private wakeScheduled = false;

  enter(): void {
    if (this.isActive) return;
    this.wire.dispatch(towerEnter({}));
  }

  exit(): void {
    this.wakeEpoch += 1;
    this.wakeSignals = [];
    this.wakeScheduled = false;
    this.wakeReceipt?.abort();
    this.wakeReceipt = undefined;
    this.wakeRequest = undefined;
    if (!this.isActive) return;
    this.wire.dispatch(towerExit({}));
  }

  notifyInbox(input: { readonly from: string; readonly to: string; readonly subject: string }): void {
    if (!this.isActive || this.agentCtx.agentId !== 'main' || this.loop === undefined) return;
    if (input.to !== TOWER_NAME && input.to !== BROADCAST_NAME) return;
    this.wakeSignals.push(input);
    if (this.wakeRequest !== undefined || this.wakeScheduled) return;
    this.wakeScheduled = true;
    const epoch = this.wakeEpoch;
    queueMicrotask(() => {
      this.wakeScheduled = false;
      if (epoch !== this.wakeEpoch || this.wakeRequest !== undefined || !this.isActive) return;
      const latest = this.wakeSignals.at(-1);
      if (latest === undefined) return;
      const count = this.wakeSignals.length;
      this.wakeSignals = [];
      const subject = latest.subject.length > 120 ? `${latest.subject.slice(0, 120)}…` : latest.subject;
      const request = new TowerInboxWakeRequest(
        {
          role: 'user',
          content: [{ type: 'text', text: `${count} new tower inbox message${count === 1 ? '' : 's'} — latest from ${latest.from}: "${subject}". Read and route it with TowerInbox.` }],
          toolCalls: [],
          origin: { kind: 'injection', variant: 'tower_inbox' },
        },
        () => {
          if (this.wakeRequest !== request) return;
          this.wakeRequest = undefined;
          this.wakeReceipt = undefined;
          const pending = this.wakeSignals;
          this.wakeSignals = [];
          for (const signal of pending) this.notifyInbox(signal);
        },
      );
      this.wakeRequest = request;
      try {
        this.wakeReceipt = this.loop.enqueue(request);
      } catch {
        if (this.wakeRequest === request) {
          this.wakeRequest = undefined;
          this.wakeReceipt = undefined;
          this.wakeSignals = [];
        }
      }
    });
  }

  override dispose(): void {
    this.wakeEpoch += 1;
    this.wakeSignals = [];
    this.wakeRequest?.abort();
    this.wakeRequest = undefined;
    this.wakeReceipt?.abort();
    this.wakeReceipt = undefined;
    super.dispose();
  }

  get isActive(): boolean {
    return this.wire.getModel(TowerModel);
  }
}

// The tower-mode write guard must be live from agent-scope creation, so this
// service stays on the static import=register channel instead of the Feature
// seam: a feature-contributed OnScopeCreated agent service materializes
// through the ScopeUnits cascade, which can run before the scope's static
// registrations (IEventBus) are visible.
registerScopedService(
  LifecycleScope.Agent,
  IAgentTowerService,
  AgentTowerService,
  ScopeActivation.OnScopeCreated,
  'tower',
);
