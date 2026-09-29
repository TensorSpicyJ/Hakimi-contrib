/** `research` domain — default-on research preference and rollback flag. */
import { z } from 'zod';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { registerFlagDefinition } from '#/app/flag/flagRegistry';

export const RESEARCH_SECTION = 'research';
export const ResearchConfigSchema = z.object({ enabled: z.boolean().default(true) });
export type ResearchConfig = z.infer<typeof ResearchConfigSchema>;
registerConfigSection(RESEARCH_SECTION, ResearchConfigSchema, { defaultValue: { enabled: true } });
registerFlagDefinition({
  id: 'research',
  title: 'AITP research mode',
  description: 'Use AITP topic files, research roles and topic navigation.',
  env: 'KIMI_CODE_EXPERIMENTAL_RESEARCH',
  default: true,
  surface: 'both',
});
