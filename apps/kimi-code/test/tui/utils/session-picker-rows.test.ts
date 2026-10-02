import type { SessionSummary } from '@bhjia-phys/hakimi-sdk';
import { describe, expect, it } from 'vitest';

import { sessionRowsForPicker } from '#/tui/utils/session-picker-rows';

function summary(input: {
  readonly id: string;
  readonly title?: string;
  readonly lastPrompt?: string;
}): SessionSummary {
  return {
    id: input.id,
    title: input.title,
    lastPrompt: input.lastPrompt,
    workDir: '/tmp/project',
    sessionDir: `/tmp/home/sessions/${input.id}`,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('sessionRowsForPicker', () => {
  it('omits the current session when the TUI session has no content', () => {
    const rows = sessionRowsForPicker(
      [
        summary({ id: 'ses_current', title: 'New Session' }),
        summary({ id: 'ses_previous', title: 'New Session' }),
      ],
      'ses_current',
      false,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_previous']);
  });

  it('keeps the current session when the TUI session has content', () => {
    const rows = sessionRowsForPicker(
      [
        summary({
          id: 'ses_current',
          title: 'Implement feature',
          lastPrompt: 'Implement feature',
        }),
      ],
      'ses_current',
      true,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_current']);
  });

  it('does not filter empty historical sessions', () => {
    const rows = sessionRowsForPicker(
      [
        summary({ id: 'ses_current', title: 'New Session' }),
        summary({ id: 'ses_previous_empty', title: 'New Session' }),
      ],
      'ses_current',
      false,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_previous_empty']);
  });

  it('marks a session this process adopted from a handoff', () => {
    const rows = sessionRowsForPicker(
      [summary({ id: 'ses_a' }), summary({ id: 'ses_b' })],
      'ses_a',
      true,
      new Map([
        [
          'ses_b',
          { workDir: '/tmp/project-b', title: 'Port the parser', status: 'running' },
        ],
      ]),
    );

    expect(rows).toEqual([
      expect.objectContaining({ id: 'ses_a', background: undefined }),
      expect.objectContaining({ id: 'ses_b', background: { status: 'running' } }),
    ]);
  });

  it('folds live background sessions from another project into the page', () => {
    // A handed-off session runs in another cwd, so the cwd-scoped page never
    // lists it; the picker must still be able to show and open it.
    const rows = sessionRowsForPicker(
      [summary({ id: 'ses_a' })],
      'ses_a',
      true,
      new Map([
        [
          'ses_b',
          { workDir: '/tmp/project-b', title: 'Port the parser', status: 'waiting' },
        ],
      ]),
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_b', 'ses_a']);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        work_dir: '/tmp/project-b',
        title: 'Port the parser',
        background: { status: 'waiting' },
      }),
    );
  });
});
