/**
 * `sessionHandoff` domain — experimental flag for cross-project session
 * handoff.
 *
 * Gates the `StartSession` tool and its host coordination contract. On by
 * default; the per-feature environment variable and `[experimental]` config
 * section remain available as opt-outs. The tool description requires user
 * confirmation of an agent-proposed handoff before creating a session.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const CROSS_PROJECT_SESSIONS_FLAG_ID = 'cross_project_sessions';
export const CROSS_PROJECT_SESSIONS_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_CROSS_PROJECT_SESSIONS';

export const crossProjectSessionsFlag: FlagDefinitionInput = {
  id: CROSS_PROJECT_SESSIONS_FLAG_ID,
  title: 'Cross-project sessions',
  description:
    'Let the main agent start an independent session in another project directory through the StartSession tool. The target session loads the target project rules and runs with its own default model, profile, permission and Plan settings; the source session keeps running independently.',
  env: CROSS_PROJECT_SESSIONS_FLAG_ENV,
  default: true,
  surface: 'both',
};

registerFlagDefinition(crossProjectSessionsFlag);
