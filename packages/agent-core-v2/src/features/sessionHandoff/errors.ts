/**
 * `sessionHandoff` domain error codes — the rejection vocabulary of starting
 * an independent session in another project directory.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const SessionHandoffErrors = {
  codes: {
    SESSION_HANDOFF_DISABLED: 'session.handoff_disabled',
    SESSION_HANDOFF_NOT_MAIN_AGENT: 'session.handoff_not_main_agent',
    SESSION_HANDOFF_DENIED: 'session.handoff_denied',
    SESSION_HANDOFF_UNSUPPORTED: 'session.handoff_unsupported',
    SESSION_HANDOFF_WORK_DIR_INVALID: 'session.handoff_work_dir_invalid',
    SESSION_HANDOFF_TRUST_REQUIRED: 'session.handoff_trust_required',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(SessionHandoffErrors);
