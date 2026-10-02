/**
 * `sessionHandoff` domain — cross-project session-handoff contract.
 *
 * Public contract of the handoff coordinator: an App-scope, session-stateless
 * registration table for the *hosts* that participate in a handed-off session,
 * plus the start orchestration that creates the target session through the
 * normal `ISessionManager` path, records the source lineage in the target's
 * metadata, waits for every participating host's pre-prompt preparation, and
 * enqueues the initial prompt. There is no single owner: a host registers once
 * with a `matches` predicate over the source session id, and *every* host
 * matching that source session participates — the serving set is snapshotted
 * immediately before the target session is created and each snapshot host is
 * prepared in registration order, so a client bridge and a server bridge
 * registered in either order both adopt the session before its first prompt.
 * Handoff capability is per source session, never a process-wide switch, so
 * two sessions in one process never share it. A `SessionHandoffDenyGuard` is
 * the restricted-edge refusal: it is evaluated before host selection and
 * outranks any matching host, and it can only refuse (it never grants) so an
 * embedding cannot widen another session's surface. The target session is an
 * ordinary independent session: no fork, no child tagging, no inherited state,
 * and no automatic deletion or retry once it exists.
 *
 * Every authorization fact — the flag, the deny guards, and the serving set —
 * is evaluated again immediately before the target session is created and
 * again after the preparations return, so a permission revoked while a
 * pre-flight await or a preparation was in flight never creates a session and
 * never starts a prompt. The post-preparation check requires the current
 * matching set to be exactly the prepared one: a host added, withdrawn, or no
 * longer matching during preparation aborts the start instead of running the
 * session under a host that never prepared it. Nothing after session creation
 * throws; the result carries the real target id and status. Preparation runs
 * whenever the target session exists, including when the handoff will not
 * start (a metadata write failure, a revocation, a cancellation), so a host
 * should treat it as "register this session" rather than "a prompt is coming".
 *
 * `StartSessionStatus` reports what actually happened to the first prompt:
 * `running` / `pending` are accepted and not yet finished, `completed` means
 * the first turn already finished without failing, and `blocked` / `failed` /
 * `aborted` mean the turn never completed — a cancellation is never reported
 * as a started or completed session. `failure` is present exactly when the
 * start did not reach `running`, `pending`, or `completed`.
 *
 * Tool visibility follows the coordinator: the `StartSession` tool is hidden
 * while a source session has no matching host, and hosts that register after
 * the source agent's activation pass should refresh it through the existing
 * `IAgentToolActivationService.activate()` on that agent (or by publishing
 * `agent.status.updated` on its `IEventBus`) — no coordinator-specific refresh
 * channel exists, and `start()` re-checks authorization regardless. Bound at
 * App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ISessionScopeHandle } from '#/_base/di/scope';

export const SESSION_HANDOFF_CUSTOM_KEY = 'handoff';

/**
 * Outcome of the handoff's first prompt: `completed` is a real finished turn,
 * while `aborted` means the prompt never completed (cancelled before
 * submission, or its turn cancelled) and is never a success.
 */
export type StartSessionStatus = 'running' | 'pending' | 'completed' | 'blocked' | 'failed' | 'aborted';

/**
 * Identity of the session a handoff produced, as published to the host before
 * the first prompt is submitted.
 */
export interface SessionHandoffTarget {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workDir: string;
  readonly title?: string;
}

export interface SessionHandoffRequest {
  /** Session the handoff was initiated from. */
  readonly sourceSessionId: string;
  /** Agent the handoff was initiated from. */
  readonly sourceAgentId: string;
  /** Working directory of the source session, recorded as lineage only. */
  readonly sourceWorkDir: string;
  /** Absolute directory of the project the target session runs in. */
  readonly workDir: string;
  /** Self-contained task handed to the target session. */
  readonly prompt: string;
  readonly title?: string;
  /**
   * Cancellation of the initiating call. It governs the pre-submit phase
   * only: once the prompt is accepted the target session owns its turn and
   * this signal is no longer observed.
   */
  readonly signal: AbortSignal;
}

/**
 * Participation surface of a host's pre-prompt preparation. Runs after the
 * target session exists and before the first prompt is enqueued, so a host can
 * register the new session, install its interaction bridge, and only then let
 * the first turn start. Every participating host receives the same context;
 * the coordinator awaits them one after another in registration order, so a
 * host must not assume it runs alone or first. A rejection aborts the start
 * with the target session left in place — never deleted.
 */
export interface SessionHandoffPrepareContext {
  readonly sourceSessionId: string;
  readonly sourceAgentId: string;
  readonly sourceWorkDir: string;
  readonly workDir: string;
  readonly prompt: string;
  readonly title?: string;
  readonly target: SessionHandoffTarget;
  /** Live handle of the created target session. */
  readonly handle: ISessionScopeHandle;
}

export interface SessionHandoffHost {
  readonly id: string;
  /**
   * Whether this host takes part in handoffs initiated from the given source
   * session. Every matching host participates; there is no exclusive owner.
   */
  matches(sourceSessionId: string): boolean;
  /**
   * Called for every participating host once the target session exists and
   * before the first prompt is submitted — also when the handoff will not
   * start, so a host must register the session rather than assume a prompt
   * follows. Rejecting aborts the start and leaves the created session in
   * place.
   */
  prepare(context: SessionHandoffPrepareContext): void | Promise<void>;
}

export interface SessionHandoffDenyGuard {
  readonly id: string;
  /** Refusal message for the given source session, or `undefined` to abstain. */
  denyReason(sourceSessionId: string): string | undefined;
}

export interface SessionHandoffStartResult extends SessionHandoffTarget {
  /** Prompt id of the submitted initial prompt; absent when none was submitted. */
  readonly promptId?: string;
  readonly status: StartSessionStatus;
  /** Present exactly when the start did not reach `running`, `pending`, or `completed`. */
  readonly failure?: string;
}

export interface ISessionHandoffCoordinator {
  readonly _serviceBrand: undefined;

  /**
   * Registers a participating host; disposing the handle unregisters it. All
   * hosts matching a source session are prepared before that session's first
   * prompt — registration order only fixes the preparation order.
   */
  registerHost(host: SessionHandoffHost): IDisposable;

  /** Registers a refusal guard; disposing the handle unregisters it. */
  registerDenyGuard(guard: SessionHandoffDenyGuard): IDisposable;

  /** Whether at least one host serves this source session right now. */
  isAvailable(sourceSessionId: string): boolean;

  /**
   * Creates and starts the target session. Rejections raised before the
   * session exists throw; every failure after creation resolves to a result
   * carrying the real target id and status.
   */
  start(request: SessionHandoffRequest): Promise<SessionHandoffStartResult>;
}

export const ISessionHandoffCoordinator: ServiceIdentifier<ISessionHandoffCoordinator> =
  createDecorator<ISessionHandoffCoordinator>('sessionHandoffCoordinator');
