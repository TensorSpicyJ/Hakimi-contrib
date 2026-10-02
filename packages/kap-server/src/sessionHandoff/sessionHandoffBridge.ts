/**
 * `sessionHandoff` integration — the server's host half of cross-project
 * session handoff (the `StartSession` tool behind the
 * `cross_project_sessions` experimental flag).
 *
 * Three registrations, all revoked together by the returned disposable:
 *
 *   - **One `event.session.created` producer.** `ISessionManager`'s
 *     `onDidCreateSession` is the single surface every creation path crosses —
 *     the REST create/fork/child routes, the handoff coordinator, and any
 *     other internal creator — so the server projects creation onto the wire
 *     event from here instead of letting each route publish its own copy.
 *     `resume` (a stored session coming back) is deliberately not a creation;
 *     `startup` and `fork` are.
 *   - **The handoff host.** Every host whose `matches` accepts the source is
 *     prepared, in registration order, after the target session exists and
 *     before the first prompt is enqueued. This host's `prepare` activates the
 *     target in the broadcaster ({@link SessionEventBroadcaster.activate}): the
 *     activity-view and approval/question listeners are attached before the
 *     first turn can start, so a handoff whose first turn raises an approval
 *     before any client subscribed still journals it and still fans its global
 *     `event.session.work_changed` out to every connection.
 *   - **The restricted-embedding refusal.** `startServer({ remoteAccess })`
 *     narrows REST/WS to a shared session; letting that session start further
 *     sessions on the host would route around the embedding's own no-create
 *     boundary. The guard is keyed on the SOURCE session — never a process-wide
 *     switch — so sessions outside the shared scope (a co-resident ordinary
 *     server, or the product remote Web, which passes no `remoteAccess`) keep
 *     the capability on the same shared core.
 *
 * The host's `matches` is unconditionally true: the server can serve any
 * handoff, alongside whatever other host a shared core registered (e.g. an
 * in-process SDK) — the coordinator prepares every matching host, so this one
 * never displaces another.
 */

import {
  DisposableStore,
  IEventService,
  ISessionContext,
  ISessionManager,
  ISessionMetadata,
  ISessionHandoffCoordinator,
  toDisposable,
  type IDisposable,
  type ISessionScopeHandle,
  type Scope,
  type SessionHandoffDenyGuard,
} from '@moonshot-ai/agent-core-v2';

import type { RemoteAccessOptions } from '../middleware/remoteAccess';
import { resolveSessionFacts, toWireSession } from '../routes/sessions';
import type { SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';

export interface SessionHandoffBridgeOptions {
  readonly core: Scope;
  readonly broadcaster: SessionEventBroadcaster;
  /** Present only for a restricted embedding (`startServer({ remoteAccess })`). */
  readonly remoteAccess?: RemoteAccessOptions;
}

const HOST_ID = 'kap-server';
const DENY_GUARD_ID = 'kap-server.remote-access';

export function registerSessionHandoffBridge(
  options: SessionHandoffBridgeOptions,
): IDisposable {
  const coordinator = options.core.accessor.get(ISessionHandoffCoordinator);
  const disposables = new DisposableStore();
  disposables.add(publishCreatedSessions(options.core));
  disposables.add(
    coordinator.registerHost({
      id: HOST_ID,
      matches: () => true,
      // Prepared in registration order alongside every other matching host,
      // before the coordinating call submits the first prompt.
      prepare: (context) => options.broadcaster.activate(context.target.sessionId),
    }),
  );
  if (options.remoteAccess !== undefined) {
    disposables.add(coordinator.registerDenyGuard(remoteAccessDenyGuard(options.remoteAccess)));
  }
  return disposables;
}

/**
 * Project every real creation on `ISessionManager` onto `event.session.created`
 * — the single producer of that event. A resume is not a creation, and a
 * session is never published twice. The publish rides `waitUntil` so it
 * completes before the creating call returns: a route that patches the new
 * session afterwards (a caller-supplied title) publishes its follow-up fact in
 * order rather than racing this one.
 *
 * The frame therefore carries the session as it exists AT creation: the real
 * id, workspace, frozen cwd, and timestamps, but no write that happens later
 * (`agent_config` is the wire placeholder regardless). The REST route and
 * handoff coordinator publish later titles through `session.meta.updated`;
 * handoff lineage remains available through `GET /sessions/{id}` metadata.
 */
function publishCreatedSessions(core: Scope): IDisposable {
  const published = new Set<string>();
  const subscription = core.accessor.get(ISessionManager).onDidCreateSession?.((event) => {
    if (event.source === 'resume') return;
    if (published.has(event.sessionId)) return;
    published.add(event.sessionId);
    event.waitUntil(publishCreated(core, event.handle, event.sessionId));
  });
  return toDisposable(() => {
    subscription?.dispose();
    published.clear();
  });
}

async function publishCreated(
  core: Scope,
  handle: ISessionScopeHandle,
  sessionId: string,
): Promise<void> {
  const metadata = await handle.accessor.get(ISessionMetadata).read();
  const context = handle.accessor.get(ISessionContext);
  const session = toWireSession(
    { ...metadata, workspaceId: context.workspaceId },
    context.cwd,
    resolveSessionFacts(core, sessionId),
  );
  core.accessor.get(IEventService).publish({
    type: 'event.session.created',
    payload: { agentId: 'main', sessionId: session.id, session },
  });
}

/**
 * Refuse cross-project handoff from a session this restricted embedding serves.
 * The single-session share refuses that one source (a session outside the share
 * is another client's business, not this embedding's boundary); the
 * all-sessions share refuses every source, because its own REST/WS narrowing
 * still forbids creating sessions and a handoff would slip past that.
 */
function remoteAccessDenyGuard(remoteAccess: RemoteAccessOptions): SessionHandoffDenyGuard {
  return {
    id: DENY_GUARD_ID,
    denyReason: (sourceSessionId) => {
      if (remoteAccess.sessionId === null) {
        return 'This restricted embedding does not allow creating sessions, so cross-project session handoff is unavailable';
      }
      if (sourceSessionId !== remoteAccess.sessionId) return undefined;
      return 'A single-session remote share does not allow creating sessions, so cross-project session handoff is unavailable';
    },
  };
}
