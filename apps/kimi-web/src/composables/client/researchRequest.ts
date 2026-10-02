import type { ResearchModeSnapshot } from '../../api/types';

export interface ResearchRequestState {
  researchBySession: Record<string, ResearchModeSnapshot>;
  researchVersionBySession: Record<string, number>;
  researchRequestGenerationBySession: Record<string, number>;
}

export interface ResearchRequestToken {
  generation: number;
  liveVersion: number;
}

/** Start any Research GET or mutation. One shared per-session generation keeps
 * responses from overlapping reads and writes from committing out of order. */
export function beginResearchRequest(
  state: ResearchRequestState,
  sessionId: string,
): ResearchRequestToken {
  const generation = (state.researchRequestGenerationBySession[sessionId] ?? 0) + 1;
  state.researchRequestGenerationBySession = {
    ...state.researchRequestGenerationBySession,
    [sessionId]: generation,
  };
  return {
    generation,
    liveVersion: state.researchVersionBySession[sessionId] ?? 0,
  };
}

/** Commit only the latest Research request, and never replace a live WS update
 * that arrived after the request started. */
export function applyResearchResponseIfCurrent(
  state: ResearchRequestState,
  sessionId: string,
  token: ResearchRequestToken,
  snapshot: ResearchModeSnapshot,
): boolean {
  if (state.researchRequestGenerationBySession[sessionId] !== token.generation) {
    return false;
  }
  if ((state.researchVersionBySession[sessionId] ?? 0) !== token.liveVersion) {
    return false;
  }
  state.researchBySession = {
    ...state.researchBySession,
    [sessionId]: snapshot,
  };
  return true;
}

export const RESEARCH_REQUEST_INVALIDATED = new Error('Research backend changed');

export interface ResearchRequestCoordinator {
  read: (
    state: ResearchRequestState,
    sessionId: string,
    request: () => Promise<ResearchModeSnapshot>,
  ) => Promise<ResearchModeSnapshot>;
  mutate: (
    state: ResearchRequestState,
    sessionId: string,
    request: () => Promise<ResearchModeSnapshot>,
  ) => Promise<ResearchModeSnapshot>;
  reset: () => void;
}

/** Coordinate Research HTTP work per session. Mutations run serially, and reads
 * requested after a mutation starts wait for the full mutation queue to settle.
 * The generation token also invalidates a read that was already in flight when
 * a mutation began. Different sessions remain independent. */
export function createResearchRequestCoordinator(): ResearchRequestCoordinator {
  const mutationTailBySession = new Map<string, Promise<void>>();
  let epoch = 0;

  function assertCurrent(atRequest: number): void {
    if (epoch !== atRequest) throw RESEARCH_REQUEST_INVALIDATED;
  }

  async function currentAfterMutationTail(
    state: ResearchRequestState,
    sessionId: string,
    atRequest: number,
  ): Promise<ResearchModeSnapshot | undefined> {
    for (;;) {
      assertCurrent(atRequest);
      const mutationTail = mutationTailBySession.get(sessionId);
      if (mutationTail === undefined) return state.researchBySession[sessionId];
      await mutationTail;
    }
  }

  async function read(
    state: ResearchRequestState,
    sessionId: string,
    request: () => Promise<ResearchModeSnapshot>,
  ): Promise<ResearchModeSnapshot> {
    const atRequest = epoch;
    // Follow the full mutation queue before reading; a failed mutation may have
    // left no applied snapshot, so invalidated reads retry authoritatively.
    while (mutationTailBySession.has(sessionId)) {
      await mutationTailBySession.get(sessionId);
      assertCurrent(atRequest);
    }
    for (;;) {
      assertCurrent(atRequest);
      const token = beginResearchRequest(state, sessionId);
      const snapshot = await request();
      assertCurrent(atRequest);
      if (applyResearchResponseIfCurrent(state, sessionId, token, snapshot)) return snapshot;
      const current = await currentAfterMutationTail(state, sessionId, atRequest);
      assertCurrent(atRequest);
      if (current !== undefined) return current;
    }
  }

  function mutate(
    state: ResearchRequestState,
    sessionId: string,
    request: () => Promise<ResearchModeSnapshot>,
  ): Promise<ResearchModeSnapshot> {
    const atRequest = epoch;
    const previousMutation = mutationTailBySession.get(sessionId) ?? Promise.resolve();
    const response = previousMutation.then(async () => {
      assertCurrent(atRequest);
      const token = beginResearchRequest(state, sessionId);
      const snapshot = await request();
      assertCurrent(atRequest);
      return applyResearchResponseIfCurrent(state, sessionId, token, snapshot)
        ? snapshot
        : (state.researchBySession[sessionId] ?? snapshot);
    });
    const settled = response.then(
      () => undefined,
      () => undefined,
    );
    mutationTailBySession.set(sessionId, settled);
    void settled.then(() => {
      if (mutationTailBySession.get(sessionId) === settled) {
        mutationTailBySession.delete(sessionId);
      }
    });
    return response;
  }

  function reset(): void {
    epoch += 1;
    mutationTailBySession.clear();
  }

  return { read, mutate, reset };
}
