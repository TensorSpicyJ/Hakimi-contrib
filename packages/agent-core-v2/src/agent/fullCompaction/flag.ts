/**
 * `fullCompaction` domain — contributes the opt-in continuity policy to `flag`.
 */

import { registerFlagDefinition } from '#/app/flag/flagRegistry';

export const contextContinuityFlag = {
  id: 'context_continuity',
  title: 'Context continuity',
  description: 'Use evidence-focused handoffs, conservative compaction noise reduction, and constraint-preserving retries.',
  env: 'KIMI_CODE_EXPERIMENTAL_CONTEXT_CONTINUITY',
  default: false,
  surface: 'both',
} as const;

registerFlagDefinition(contextContinuityFlag);
