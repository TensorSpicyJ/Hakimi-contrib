/**
 * `applyPatch` domain — contributes the opt-in patch editing flag.
 */

import { registerFlagDefinition } from '#/app/flag/flagRegistry';

export const APPLY_PATCH_FLAG_ID = 'apply_patch';

registerFlagDefinition({
  id: APPLY_PATCH_FLAG_ID,
  title: 'Apply patch tool',
  description: 'Enable context-based Add, Update and Delete patches for file editing.',
  env: 'KIMI_CODE_EXPERIMENTAL_APPLY_PATCH',
  default: false,
  surface: 'core',
});
