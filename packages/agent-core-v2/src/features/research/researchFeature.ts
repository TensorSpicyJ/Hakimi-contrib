/**
 * `research` domain — AITP memory, navigation and scientific worker assembly.
 *
 * Contributes Session selection and Agent context through the Feature seams;
 * bundled Skills retain AITP's original text and on-demand resource links.
 */

import { ScopeActivation } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { IResearchService } from './research';
import { ResearchService } from './researchService';
import { IAgentResearchContext, AgentResearchContext } from './agentResearchContext';
import { RESEARCH_PROFILES } from './researchProfiles';
import './configSection';
import './aitp/bundle';

export class ResearchFeature extends Feature {
  static override readonly name = 'research';
  constructor() {
    super();
    this.contributeService(LifecycleScope.Session, IResearchService, ResearchService, { activation: ScopeActivation.OnDemand });
    this.contributeAgentService(IAgentResearchContext, AgentResearchContext, { activation: ScopeActivation.OnScopeCreated });
    this.contributeProfiles(RESEARCH_PROFILES);
  }
}
registerFeature(ResearchFeature);
