import type { AppPlugin, AppSkill } from '../api/types';

const CORE_AITP_SKILLS = ['aitp-memory', 'aitp-research', 'aitp-writing', 'aitp-distill'];

/** Display only core skills actually returned by the session visibility API. */
export function availableAitpSkills(skills: readonly AppSkill[]): AppSkill[] {
  return CORE_AITP_SKILLS.flatMap((name) => {
    // The REST descriptor does not expose plugin identity (plugin roots may
    // appear as `extra`). Match actual visible names, not an invented source.
    const skill = skills.find((candidate) => candidate.name === name);
    return skill ? [skill] : [];
  });
}

export function aitpPluginStatus(
  plugin: AppPlugin | null | undefined,
  metadataStatus: 'unknown' | 'loading' | 'ready' | 'error' = 'unknown',
): 'unknown' | 'loading' | 'unavailable' | 'missing' | 'disabled' | 'error' | 'enabled' {
  if (metadataStatus === 'error') return 'unavailable';
  if (metadataStatus !== 'ready') return metadataStatus;
  if (!plugin) return 'missing';
  if (plugin.state === 'error') return 'error';
  return plugin.enabled ? 'enabled' : 'disabled';
}
