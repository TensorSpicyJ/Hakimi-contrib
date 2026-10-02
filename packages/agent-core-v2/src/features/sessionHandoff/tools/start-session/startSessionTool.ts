/**
 * `sessionHandoff` domain — `StartSessionTool` implementation (the
 * `StartSession` tool).
 *
 * Thin agent-side adapter over the handoff coordinator
 * (`sessionManager`-backed start, see `SessionHandoffCoordinator`): it reads
 * the caller identity from `sessionContext` / `scopeContext`, declares the
 * target directory as the approval subject (a non-enumerable side effect, so
 * the whole call is exclusive), and renders the coordinator's real
 * session/prompt/status result — a fast-completing first turn is reported as
 * completed, and every blocked, failed, or cancelled start is a tool error.
 * It never waits for the target turn. Pure tool — owns no scoped state. Bound
 * at Agent scope — contributed by `SessionHandoffFeature`.
 */

import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { resolve } from 'pathe';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { ISessionHandoffCoordinator, type SessionHandoffStartResult } from '#/features/sessionHandoff/sessionHandoff';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { toErrorMessage } from '#/_base/errors/errorMessage';

import DESCRIPTION from './start-session.md?raw';
import {
  IStartSessionTool,
  START_SESSION_TOOL_NAME,
  StartSessionInputSchema,
  isAbsoluteWorkDir,
  type StartSessionInput,
} from './start-session';

export class StartSessionTool implements IStartSessionTool {
  declare readonly _serviceBrand: undefined;
  readonly name = START_SESSION_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(StartSessionInputSchema);

  constructor(
    @ISessionHandoffCoordinator private readonly coordinator: ISessionHandoffCoordinator,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: StartSessionInput): ToolExecution {
    // Rejected in the resolve phase, before the approval round-trip: an
    // invalid target path must not ask the user to approve anything. The
    // parameters schema carries the same constraint, but the executor
    // validates against the derived JSON Schema, which cannot express it.
    if (!isAbsoluteWorkDir(args.work_dir)) {
      return {
        isError: true,
        output: `work_dir must be an absolute path to an existing directory, got "${args.work_dir}"`,
      };
    }
    const workDir = resolve(args.work_dir);
    return {
      accesses: ToolAccesses.all(),
      description: `Starting an independent session in ${workDir}`,
      display: {
        kind: 'generic',
        summary: `Create a session in ${workDir} and run the given task there`,
        detail: { work_dir: workDir, title: args.title, prompt: args.prompt },
      },
      approvalRule: literalRulePattern(this.name, workDir),
      matchesRule: (ruleArgs) => matchesPathRuleSubject(ruleArgs, workDir),
      execute: (ctx) => this.execution(args, workDir, ctx.signal),
    };
  }

  private async execution(
    args: StartSessionInput,
    workDir: string,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.coordinator.start({
        sourceSessionId: this.sessionContext.sessionId,
        sourceAgentId: this.scopeContext.agentId,
        sourceWorkDir: this.sessionContext.cwd,
        workDir,
        prompt: args.prompt,
        title: args.title,
        signal,
      });
      return result.failure === undefined
        ? { output: renderStarted(result) }
        : { isError: true, output: renderUnfinished(result, result.failure) };
    } catch (error) {
      return {
        isError: true,
        output: `Could not start a session in another project: ${toErrorMessage(error)}`,
      };
    }
  }
}

function renderStarted(result: SessionHandoffStartResult): string {
  const attributes = renderAttributes(result);
  if (result.status === 'completed') {
    return [
      `<session_handoff${attributes}>`,
      `The session in "${result.workDir}" already finished its first turn without reporting a failure. Open it to read what it produced.`,
      'Report the session id and that it finished; do not present its result as your own work without reading it there.',
      '</session_handoff>',
    ].join('\n');
  }
  return [
    `<session_handoff${attributes}>`,
    `Started an independent session in "${result.workDir}" and submitted the task. It runs on its own and is not affected by this session's turn ending.`,
    'Report the session id to the user and open the session list to follow its progress; answer its approvals or questions there. Do not wait for it in this turn.',
    '</session_handoff>',
  ].join('\n');
}

function renderUnfinished(result: SessionHandoffStartResult, failure: string): string {
  return [
    `<session_handoff${renderAttributes(result)} error="${escapeAttribute(failure)}">`,
    `The session exists but its first task did not run to completion: ${failure}`,
    'The session was left in place. Tell the user its id and this failure; do not delete or recreate it.',
    '</session_handoff>',
  ].join('\n');
}

function renderAttributes(result: SessionHandoffStartResult): string {
  const attributes = [
    `session_id="${escapeAttribute(result.sessionId)}"`,
    `workspace_id="${escapeAttribute(result.workspaceId)}"`,
    `work_dir="${escapeAttribute(result.workDir)}"`,
    `status="${result.status}"`,
  ];
  if (result.promptId !== undefined) attributes.push(`prompt_id="${escapeAttribute(result.promptId)}"`);
  return ` ${attributes.join(' ')}`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
