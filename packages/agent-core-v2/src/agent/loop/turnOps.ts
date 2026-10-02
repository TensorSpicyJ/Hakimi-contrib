/**
 * `loop` domain — persists and restores monotonically increasing turn
 * identity.
 *
 * Owns the next available turn id, including cancelled queued reservations and
 * legacy loop-event observations. Also persists the terminal `turn.ended`
 * record (reason / error / durationMs) and the `turn.step.interrupted` record
 * (step / reason / message) so downstream history rebuilds and cold-resumed
 * read models (e.g. the activity view and the transcript cold fold) can
 * recover how the last turn and its steps ended. Consumed by the Agent-scope
 * `loopService`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';
import type { KimiErrorPayload } from '#/_base/errors/serialize';
import type { ContentPart } from '#/kosong/contract/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';

export interface TurnModelState {
  readonly nextTurnId: number;
  readonly cancelledTurnIds: readonly number[];
  readonly lastEnded?: {
    readonly turnId: number;
    readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
    readonly durationMs?: number;
  };
}

export const TurnModel = defineModel<TurnModelState>(
  'turn',
  () => ({ nextTurnId: 0, cancelledTurnIds: [] }),
  {
    reducers: {
      'context.append_loop_event': (state, { event }) => {
        if (event.type === 'tool.result' || event.turnId === undefined) {
          return state;
        }

        const turnId = Number.parseInt(event.turnId, 10);
        if (!Number.isInteger(turnId)) return state;
        let next = state;
        if (turnId >= state.nextTurnId) next = advanceTurnClock(state, turnId + 1);
        if (next.lastEnded !== undefined && turnId > next.lastEnded.turnId) {
          next = { ...next, lastEnded: undefined };
        }
        return next;
      },
    },
  },
);

const turnInputShape = {
  input: z.custom<readonly ContentPart[]>(),
  origin: z.custom<PromptOrigin>(),
};

declare module '#/wire/types' {
  interface PersistedOpMap {
    'turn.prompt': typeof promptTurn;
    'turn.steer': typeof steerTurn;
    'turn.cancel': typeof cancelTurn;
    'turn.ended': typeof endTurn;
    'turn.step.interrupted': typeof interruptStep;
  }
}

export const promptTurn = TurnModel.defineOp('turn.prompt', {
  schema: z.object(turnInputShape),
  apply: (s) => advanceTurnClock(s, s.nextTurnId + 1),
});

export const steerTurn = TurnModel.defineOp('turn.steer', {
  schema: z.object(turnInputShape),
  apply: (s) => s,
});

export const cancelTurn = TurnModel.defineOp('turn.cancel', {
  schema: z.object({
    turnId: z.number().optional(),
    target: z.enum(['active', 'queued']).optional(),
    reason: z.enum(['user_cancelled', 'aborted']).optional(),
  }),
  apply: (s, { turnId, target }) => {
    if (target === undefined || turnId === undefined) return s;
    if (turnId < s.nextTurnId) return s;
    return advanceTurnClock(s, s.nextTurnId, [...s.cancelledTurnIds, turnId]);
  },
});

export const endTurn = TurnModel.defineOp('turn.ended', {
  schema: z.object({
    turnId: z.number(),
    reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
    error: z.custom<KimiErrorPayload>().optional(),
    durationMs: z.number().optional(),
  }),
  apply: (s, { turnId, reason, durationMs }) => ({
    ...s,
    lastEnded: { turnId, reason, durationMs },
  }),
});

export const interruptStep = TurnModel.defineOp('turn.step.interrupted', {
  schema: z.object({
    turnId: z.number(),
    step: z.number(),
    stepId: z.string().optional(),
    reason: z.string(),
    message: z.string().optional(),
  }),
  apply: (s) => s,
  toEvent: (p) => ({
    type: 'turn.step.interrupted' as const,
    turnId: p.turnId,
    step: p.step,
    stepId: p.stepId,
    reason: p.reason,
    message: p.message,
  }),
});

function advanceTurnClock(
  state: TurnModelState,
  nextTurnId: number,
  cancelledTurnIds: readonly number[] = state.cancelledTurnIds,
): TurnModelState {
  const pendingCancellations = new Set(
    cancelledTurnIds.filter((turnId) => turnId >= nextTurnId),
  );
  while (pendingCancellations.delete(nextTurnId)) nextTurnId += 1;
  return {
    ...state,
    nextTurnId,
    cancelledTurnIds: [...pendingCancellations].toSorted((a, b) => a - b),
  };
}
