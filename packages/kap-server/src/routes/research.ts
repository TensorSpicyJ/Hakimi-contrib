/** Session research navigation; content stays in the workspace's AITP notes. */
import {
  Error2,
  ErrorCodes,
  IResearchService,
  resumeSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { mapError } from '../transport/errors';
import { ErrorCode } from '../protocol/error-codes';
import { researchNoteSchema, researchSnapshotSchema, updateResearchRequestSchema } from '../protocol/rest-research';

interface ResearchRouteHost {
  get(path: string, options: { schema?: Record<string, unknown> }, handler: (
    req: { id: string; params: unknown }, reply: { send(payload: unknown): void },
  ) => Promise<void> | void): unknown;
  post(path: string, options: { schema?: Record<string, unknown> }, handler: (
    req: { id: string; params: unknown; body: unknown }, reply: { send(payload: unknown): void },
  ) => Promise<void> | void): unknown;
}

async function resolveResearch(core: Scope, sessionId: string): Promise<IResearchService> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (!session) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  return session.accessor.get(IResearchService);
}

export function registerResearchRoutes(app: ResearchRouteHost, core: Scope): void {
  const params = z.object({ session_id: z.string().min(1) });
  const getRoute = defineRoute({
    method: 'GET', path: '/sessions/{session_id}/research', params,
    success: { data: researchSnapshotSchema },
    errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
    description: 'Read the current AITP topic and nearby research notes', tags: ['sessions'],
  }, async (req, reply) => {
    try {
      const service = await resolveResearch(core, req.params.session_id);
      reply.send(okEnvelope(await service.snapshot(), req.id));
    } catch (error) {
      reply.send(mapError(error, req.id));
    }
  });
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<ResearchRouteHost['get']>[2]);

  const noteRoute = defineRoute({
    method: 'GET', path: '/sessions/{session_id}/research/note', params,
    success: { data: researchNoteSchema },
    errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
    description: 'Read the selected AITP main note', tags: ['sessions'],
  }, async (req, reply) => {
    try {
      const service = await resolveResearch(core, req.params.session_id);
      reply.send(okEnvelope(await service.readCurrentNote(), req.id));
    } catch (error) {
      reply.send(mapError(error, req.id));
    }
  });
  app.get(noteRoute.path, noteRoute.options, noteRoute.handler as Parameters<ResearchRouteHost['get']>[2]);

  const updateRoute = defineRoute({
    method: 'POST', path: '/sessions/{session_id}/research', params,
    body: updateResearchRequestSchema,
    success: { data: researchSnapshotSchema },
    errors: { [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Select an existing AITP note or change research mode', tags: ['sessions'],
  }, async (req, reply) => {
    try {
      const service = await resolveResearch(core, req.params.session_id);
      const snapshot = 'path' in req.body
        ? await service.select(req.body.path)
        : await service.setEnabled(req.body.enabled);
      reply.send(okEnvelope(snapshot, req.id));
    } catch (error) {
      if (error instanceof Error2 && error.code === 'research.note_invalid') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
        return;
      }
      reply.send(mapError(error, req.id));
    }
  });
  app.post(updateRoute.path, updateRoute.options, updateRoute.handler as Parameters<ResearchRouteHost['post']>[2]);
}
