/**
 * `tools` domain — `TowerSendTool` implementation (the `TowerSend` tool).
 *
 * Delivers the message through the protocol `TowerStore` rooted at the
 * session cwd (`sessionContext`), resolving the caller's roster identity
 * from the agent scope (`scopeContext`). Registered for every agent —
 * visibility is controlled by profile tool lists. Bound at Agent scope.
 */

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentTowerService } from '#/features/tower/tower';
import { BROADCAST_NAME, TOWER_NAME } from '#/features/tower/protocol/index';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { callerName, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './send.md?raw';
import { ITowerSendTool, TowerSendToolInputSchema, type TowerSendToolInput } from './send';

export class TowerSendTool implements ITowerSendTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerSend' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerSendToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
  ) {}

  resolveExecution(args: TowerSendToolInput): ToolExecution {
    return {
      description: `Sending tower message to ${args.to}: ${args.subject}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const state = await store.load();
          const caller = callerName(this.scopeContext.agentId, store, state);
          const to = args.to.trim();
          const rel = await store.send(caller, {
            to,
            subject: args.subject,
            body: args.body,
            scope: args.scope,
            action: args.action,
            consentRef: args.consent_ref,
          });
          if (this.lifecycle !== undefined && caller !== TOWER_NAME && (to === TOWER_NAME || to === BROADCAST_NAME)) {
            this.lifecycle.get('main')?.accessor.get(IAgentTowerService).notifyInbox({
              from: caller,
              to,
              subject: args.subject,
            });
          }
          const entry = caller === TOWER_NAME ? state.roster.agents.find((agent) => agent.name === to) : undefined;
          const idle =
            entry !== undefined &&
            this.tasks !== undefined &&
            !this.tasks.list(true).some((task) => task.kind === 'agent' && task.agentId === entry.agentId);
          const note = idle
            ? `\nnote: ${to} has no running task in this session — the message remains in its inbox until Agent(resume="${entry.agentId}", run_in_background=true, prompt="...") delivers it`
            : '';
          return { output: `message sent to ${to}\nfile: ${rel}${note}` };
        }),
    };
  }
}

