/**
 * `sessionHandoff` domain — `SessionHandoffFeature`: cross-project session
 * handoff assembled as one App-scope Feature unit.
 *
 * Contributes the App-scope `ISessionHandoffCoordinator` (host registration
 * table plus the session-stateless start orchestration) and the main-agent
 * `StartSession` tool through the `features` base-class seams; retracting the
 * unit withdraws both. The exported `startSessionToolWhen` is the tool's
 * activation predicate — the main agent of a session the coordinator
 * currently supports (flag on, no deny guard, a matching host). The tool's
 * own execution re-checks the same conditions, so a stale activation can
 * never run the handoff while the host, the flag, or a deny guard says no,
 * and hiding the schema is never the only gate. Registered into the feature
 * table at import.
 */

import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { ISessionHandoffCoordinator } from './sessionHandoff';
import { SessionHandoffCoordinator } from './sessionHandoffCoordinator';
import { IStartSessionTool, START_SESSION_TOOL_NAME } from './tools/start-session/start-session';
import { StartSessionTool } from './tools/start-session/startSessionTool';

export function startSessionToolWhen(accessor: ServicesAccessor): boolean {
  if (accessor.get(IAgentScopeContext).agentId !== MAIN_AGENT_ID) return false;
  return accessor
    .get(ISessionHandoffCoordinator)
    .isAvailable(accessor.get(ISessionContext).sessionId);
}

export class SessionHandoffFeature extends Feature {
  static override readonly name = 'sessionHandoff';

  constructor() {
    super();
    this.contributeService(
      LifecycleScope.App,
      ISessionHandoffCoordinator,
      SessionHandoffCoordinator,
    );
    this.contributeTool(IStartSessionTool, StartSessionTool, {
      name: START_SESSION_TOOL_NAME,
      domain: 'sessionHandoff',
      when: startSessionToolWhen,
    });
  }
}

registerFeature(SessionHandoffFeature);
