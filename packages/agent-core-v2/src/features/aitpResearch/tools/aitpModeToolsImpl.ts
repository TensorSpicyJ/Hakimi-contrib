/**
 * `aitpResearch` domain — Research memory-mode compatibility toggle tools.
 *
 * Delegate only to the Agent-scoped mode service under normal tool permission
 * policy. They perform no AITP operation or research-state mutation.
 */

import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentAitpModeService } from '../mode/agentAitpMode';
import {
  IEnterAITPModeTool,
  IExitAITPModeTool,
  EnterAITPModeInputSchema,
  ExitAITPModeInputSchema,
  type EnterAITPModeInput,
  type ExitAITPModeInput,
} from './aitpModeTools';

export class EnterAITPModeTool implements IEnterAITPModeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'EnterAITPMode' as const;
  readonly description = 'Enable Research Mode: use ordinary file tools for local knowledge and the official AITP Skills for long-term research memory. This toggle performs no AITP I/O and is not required for ordinary research or file tools. General Goal and Plan remain available.';
  readonly parameters = toInputJsonSchema(EnterAITPModeInputSchema);

  constructor(@IAgentAitpModeService private readonly mode: IAgentAitpModeService) {}

  resolveExecution(_args: EnterAITPModeInput): ToolExecution {
    return {
      description: 'Enabling Research Mode',
      approvalRule: this.name,
      execute: async () => {
        await this.mode.enter({ actor: 'model' });
        return {
          output: (await this.mode.getSnapshot()).skillsAvailable
            ? 'Research Mode enabled. Read project knowledge and use the official AITP Skills for relevant memory. Save only genuinely new progress; no durable change means no write.'
            : 'Research Mode enabled for local knowledge. Official AITP Skills are unavailable; install or enable the official `aitp` plugin to use research memory.',
        };
      },
    };
  }
}

export class ExitAITPModeTool implements IExitAITPModeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ExitAITPMode' as const;
  readonly description = 'Disable Research Mode guidance and official AITP Skill visibility. Preserves all historical records and knowledge files.';
  readonly parameters = toInputJsonSchema(ExitAITPModeInputSchema);

  constructor(@IAgentAitpModeService private readonly mode: IAgentAitpModeService) {}

  resolveExecution(_args: ExitAITPModeInput): ToolExecution {
    return {
      description: 'Disabling Research Mode',
      approvalRule: this.name,
      execute: async () => {
        await this.mode.exit();
        return { output: 'Research Mode disabled. Historical records and knowledge files are unchanged.' };
      },
    };
  }
}
