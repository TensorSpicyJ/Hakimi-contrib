/** Research navigation mirrors the session research service without copying note content. */
import { z } from 'zod';
import type { ServiceContract } from '../types.js';

export const researchTopicSchema = z.object({
  path: z.string(), directory: z.string(), title: z.string(), summary: z.string(),
  mainQuestion: z.string().optional(),
});
export const researchSnapshotSchema = z.object({
  enabled: z.boolean(), rootDirectory: z.string(),
  current: researchTopicSchema.nullable(), parent: researchTopicSchema.nullable(),
  children: z.array(researchTopicSchema), linkedTopics: z.array(researchTopicSchema),
  warning: z.string().optional(),
});
export const researchContract = {
  snapshot: { input: z.tuple([]), output: researchSnapshotSchema },
  select: { input: z.tuple([z.string().trim().min(1)]), output: researchSnapshotSchema },
  setEnabled: { input: z.tuple([z.boolean()]), output: researchSnapshotSchema },
} satisfies ServiceContract;
