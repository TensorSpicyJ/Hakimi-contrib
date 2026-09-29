/** `research` domain — user-visible topic-selection failures. */
import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ResearchErrors = {
  codes: { RESEARCH_NOTE_INVALID: 'research.note_invalid' },
  info: {
    'research.note_invalid': {
      title: 'Research note cannot be selected',
      retryable: false,
      public: true,
      action: 'Select an existing research note in the workspace, an added directory, or the displayed parent topic.',
    },
  },
} as const satisfies ErrorDomain;
registerErrorDomain(ResearchErrors);
