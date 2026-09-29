import { z } from 'zod';

export const researchTopicSchema = z.object({
  path: z.string(),
  directory: z.string(),
  title: z.string(),
  summary: z.string(),
  mainQuestion: z.string().optional(),
});

export const researchSnapshotSchema = z.object({
  enabled: z.boolean(),
  rootDirectory: z.string(),
  current: researchTopicSchema.nullable(),
  parent: researchTopicSchema.nullable(),
  children: z.array(researchTopicSchema),
  linkedTopics: z.array(researchTopicSchema),
  warning: z.string().optional(),
});

export const updateResearchRequestSchema = z.union([
  z.object({ path: z.string().trim().min(1) }).strict(),
  z.object({ enabled: z.boolean() }).strict(),
]);

export const researchNoteSchema = z.object({
  topic: researchTopicSchema,
  content: z.string(),
  truncated: z.boolean(),
}).nullable();
