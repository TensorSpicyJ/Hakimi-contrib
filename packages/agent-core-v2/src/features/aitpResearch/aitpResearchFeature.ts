/**
 * `aitpResearch` domain — local knowledge and research memory mode.
 *
 * Contributes the Agent-scoped toggle, brief context guidance, and official
 * AITP Skill visibility through the Feature seams. Legacy Research wire
 * vocabulary remains statically registered for history replay, not execution.
 */

import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { SkillVisibilityContribution } from '#/agent/skillVisibility/skillVisibility';
import { IAgentAitpModeService } from './mode/agentAitpMode';
import { AgentAitpModeService } from './mode/agentAitpModeService';
import { AitpResearchInjection } from './injection/aitpResearchInjection';
import { IAitpResearchInjection } from './injection/aitpResearchInjectionContract';
import { AitpSkillVisibilityInjection } from './injection/aitpSkillVisibilityInjection';
import { IAitpSkillVisibilityInjection } from './injection/aitpSkillVisibilityInjectionContract';
import { IEnterAITPModeTool, IExitAITPModeTool } from './tools/aitpModeTools';
import { EnterAITPModeTool, ExitAITPModeTool } from './tools/aitpModeToolsImpl';
import { AITP_PLUGIN_ID } from './aitpPlugin';

export class AitpResearchFeature extends Feature {
  static override readonly name = 'aitpResearch';

  constructor() {
    super();
    this.contributeAgentService(IAgentAitpModeService, AgentAitpModeService);
    this.contributeAgentService(IAitpResearchInjection, AitpResearchInjection);
    this.contributeAgentService(IAitpSkillVisibilityInjection, AitpSkillVisibilityInjection);
    this.contributeTool(IEnterAITPModeTool, EnterAITPModeTool, {
      name: 'EnterAITPMode',
      domain: 'aitpResearch',
    });
    this.contributeTool(IExitAITPModeTool, ExitAITPModeTool, {
      name: 'ExitAITPMode',
      domain: 'aitpResearch',
      when: (accessor) => accessor.get(IAgentAitpModeService).isActive,
    });
    this.contribute(SkillVisibilityContribution, {
      id: 'aitpResearch',
      isVisible: () => true,
      describeHidden: () => undefined,
      isVisibleInFrozenListing(skill) {
        return skill.plugin?.id !== AITP_PLUGIN_ID;
      },
    });
  }
}

registerFeature(AitpResearchFeature);
