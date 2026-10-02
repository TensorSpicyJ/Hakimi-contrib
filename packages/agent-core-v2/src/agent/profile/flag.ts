/**
 * `profile` domain — contributes the opt-in compact system-prompt policy.
 *
 * Registers through the App-scope `flag` catalog; profiles must explicitly
 * provide a compact renderer to participate.
 */

import { registerFlagDefinition } from '#/app/flag/flagRegistry';

export const PROFILE_COMPACT_PROMPT_FLAG_ID = 'profile_compact_prompt';

registerFlagDefinition({
  id: PROFILE_COMPACT_PROMPT_FLAG_ID,
  title: 'Compact profile prompts',
  description: 'Use a compact base prompt for profiles that explicitly provide one, preserving project instructions, skills, and mode reminders.',
  env: 'KIMI_CODE_EXPERIMENTAL_PROFILE_COMPACT_PROMPT',
  default: false,
  surface: 'core',
});
