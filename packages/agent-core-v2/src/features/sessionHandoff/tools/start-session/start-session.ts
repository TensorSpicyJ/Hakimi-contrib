/**
 * `sessionHandoff` domain — `IStartSessionTool` contract (the `StartSession`
 * tool).
 *
 * Public contract of the `StartSession` tool: the model-facing input schema
 * (`work_dir`, `prompt`, optional `title`), the tool name the Plan-mode guard
 * and the activation predicate share, and the Agent-scope decorator resolving
 * the implementation through the container. Main-agent only and gated on a
 * matching handoff host; bound at Agent scope.
 */

import { z } from 'zod';
import { isAbsolute } from 'pathe';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const START_SESSION_TOOL_NAME = 'StartSession';

/** Absolute-path predicate shared by the input schema and the resolve-phase guard. */
export function isAbsoluteWorkDir(value: string): boolean {
  return isAbsolute(value);
}

export const StartSessionInputSchema = z
  .object({
    work_dir: z
      .string()
      .trim()
      .min(1)
      .refine(isAbsoluteWorkDir, {
        message:
          'work_dir must be an absolute path; relative paths are not resolved against the source session directory',
      })
      .describe(
        'Absolute path of the target project directory on this machine. The new session runs there and loads that project\'s own rules, Skills, and MCP configuration.',
      ),
    prompt: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Self-contained task for the new session: the goal, the necessary background, constraints, and acceptance criteria. The new session has none of this conversation, so restate everything it needs.',
      ),
    title: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Short title for the new session, shown in session lists.'),
  })
  .strict();

export type StartSessionInput = z.infer<typeof StartSessionInputSchema>;

export interface IStartSessionTool extends AgentTool<StartSessionInput> {
  readonly _serviceBrand: undefined;
}

export const IStartSessionTool = createDecorator<IStartSessionTool>('startSessionTool');
