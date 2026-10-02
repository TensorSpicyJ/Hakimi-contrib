/**
 * `subagent` domain — resume-time model-binding reconciliation.
 *
 * Waits for the Session profile catalog and applies a validated dispatch binding
 * to an existing agent profile, falling back to canonical `[subagent]` resolution
 * only when none is supplied. Preserves profiles that own their binding policy.
 * This helper is stateless and shared by the Agent and AgentSwarm resume routes.
 */

import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { IAgentProfileService, ProfileData } from '#/agent/profile/profile';
import type { IModelCatalog } from '#/kosong/model/catalog';
import type { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';

import {
  resolveSubagentBinding,
  type SubagentBindingResolution,
  type SubagentRouteKind,
} from './configSection';

export async function refreshSubagentBindingOnResume(
  config: IConfigService,
  flags: IFlagService,
  catalog: ISessionAgentProfileCatalog,
  modelCatalog: IModelCatalog,
  profileService: IAgentProfileService,
  caller: ProfileData,
  route: SubagentRouteKind,
  validatedBinding?: SubagentBindingResolution,
  signal?: AbortSignal,
): Promise<ProfileData> {
  await catalog.ready;
  signal?.throwIfAborted();
  const current = profileService.data();
  const profileName = current.profileName;
  if (profileName === undefined) return current;

  const profile: AgentProfile | undefined = catalog.get(profileName);
  if (profile?.preserveBindingOnResume === true) return current;

  let resolution = validatedBinding;
  if (resolution === undefined) {
    if (caller.modelAlias === undefined || current.modelAlias === undefined) return current;
    resolution = resolveSubagentBinding(config, flags, modelCatalog, {
      route,
      profileName,
      modelPreference: profile?.modelPreference,
      caller: {
        modelAlias: caller.modelAlias,
        thinkingLevel: caller.thinkingLevel,
      },
    });
  }
  const modelChanged = resolution.model !== current.modelAlias;
  const thinkingChanged =
    resolution.thinking !== undefined && resolution.thinking !== current.thinkingLevel;
  const clearsThinking = resolution.thinking === undefined &&
    (resolution.modelSource === 'legacy-secondary' || resolution.modelSource === 'auto-fallback');
  if (modelChanged || thinkingChanged || clearsThinking) {
    profileService.rebind({
      modelAlias: resolution.model,
      thinkingLevel: resolution.thinking,
    });
  }
  return profileService.data();
}
