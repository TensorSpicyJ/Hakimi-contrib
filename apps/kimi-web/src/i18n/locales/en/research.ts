export default {
  title: 'Research',
  panelTitle: 'Research',
  hidePanel: 'Hide panel',
  modeOn: 'On',
  skillsAvailable: 'AITP Skills visible',
  skillsUnavailable: 'AITP Skills unavailable',
  pluginVersion: 'AITP version',
  versionUnknown: 'Unknown',
  pluginState: {
    unknown: 'Plugin metadata unknown',
    loading: 'Loading plugin metadata',
    unavailable: 'Plugin metadata unavailable',
    missing: 'Not installed',
    disabled: 'Plugin disabled',
    error: 'Plugin error',
    enabled: 'Plugin enabled',
  },
  availableSkills: 'Core Skills available in this session',
  noSessionSkills: 'No core AITP Skills in the current session list.',
  skillUsage: 'Type /skill:<name> followed by your request, or choose it from the / menu. Installed version does not imply Skill availability.',
  purpose:
    'Local project knowledge and long-term research memory. No host research loop runs — this mode only keeps the official AITP Skills visible.',
  guidanceKnowledge: 'Knowledge: read and write plain project files with the ordinary file tools.',
  guidanceMemory: 'Memory: the official AITP Skills (start with aitp-memory) record meaningful deltas.',
  historyNote:
    'Legacy Research records (lines, questions, checkpoints) are preserved read-only — they are not live state and never resume automatically.',
  commandIssueTitle: 'Research command',
  commandError: {
    disabled: 'Research Mode is not available on this backend.',
    snapshot_unavailable: 'Research state is unavailable for this session.',
    unknown_subcommand: 'Unknown /research subcommand. Use /research on, /research off, or /research status.',
    unexpected_arguments: 'Unexpected arguments. Use /research on, /research off, or /research status.',
    unsupported:
      'This /research subcommand is no longer supported: the host Research executor is retired. Historical records are read-only; use project knowledge files and the official AITP Skills for research memory.',
  },
} as const;
