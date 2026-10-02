/**
 * `autoSubagentPreset` domain — automatic dispatch rejection codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AutoSubagentPresetErrors = {
  codes: {
    AUTO_SUBAGENT_BINDING_UNAVAILABLE: 'auto_subagent_preset.binding_unavailable',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AutoSubagentPresetErrors);
