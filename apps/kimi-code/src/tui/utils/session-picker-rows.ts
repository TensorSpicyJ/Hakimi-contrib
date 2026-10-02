import type { SessionSummary } from '@bhjia-phys/hakimi-sdk';

import type { SessionRow } from '#/tui/components/dialogs/session-picker';

/** A live session this process adopted from a handoff, keyed by session id. */
export interface BackgroundSessionMarker {
  readonly workDir: string;
  readonly title: string | undefined;
  readonly status: string;
}

export function sessionRowsForPicker(
  sessions: readonly SessionSummary[],
  currentSessionId: string,
  currentSessionHasContent: boolean,
  background: ReadonlyMap<string, BackgroundSessionMarker> = new Map(),
): SessionRow[] {
  const rows = sessions
    .filter((session) => currentSessionHasContent || session.id !== currentSessionId)
    .map((session) => toRow(session, background));
  // A handed-off session runs in another project, so it is usually not on the
  // cwd-scoped page — fold the live ones in so the picker can always show and
  // open them without another process resume.
  const listed = new Set(rows.map((row) => row.id));
  const liveBackground = [...background.entries()]
    .filter(([sessionId]) => !listed.has(sessionId))
    .map(([sessionId, marker]) => ({
      id: sessionId,
      title: marker.title ?? null,
      last_prompt: null,
      work_dir: marker.workDir,
      updated_at: 0,
      background: { status: marker.status },
    }));
  return [...liveBackground, ...rows];
}

function toRow(
  session: SessionSummary,
  background: ReadonlyMap<string, BackgroundSessionMarker>,
): SessionRow {
  const marker = background.get(session.id);
  return {
    id: session.id,
    title: session.title ?? null,
    last_prompt: session.lastPrompt ?? null,
    work_dir: session.workDir,
    updated_at: session.updatedAt ?? session.createdAt ?? 0,
    metadata: session.metadata,
    background: marker === undefined ? undefined : { status: marker.status },
  };
}
