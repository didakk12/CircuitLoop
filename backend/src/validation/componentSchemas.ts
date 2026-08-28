import { z } from "zod";

import { componentConditionSchema, componentStatusSchema, componentTypeSchema, salvagePrioritySchema } from "./common.js";

export const createComponentBodySchema = z.object({
  scan_id: z.string().min(1).nullish(),
  type: componentTypeSchema,
  name: z.string().nullish(),
  confidence: z.number().min(0, "confidence must be >= 0").max(1, "confidence must be <= 1"),
  condition: componentConditionSchema.optional(),
  salvage_priority: salvagePrioritySchema.nullish(),
  x1: z.number().nullish(),
  y1: z.number().nullish(),
  x2: z.number().nullish(),
  y2: z.number().nullish(),
});

export type CreateComponentBody = z.infer<typeof createComponentBodySchema>;

/** PUT /api/components/:id — same full-replace shape as create, matching the original contract. */
export const updateComponentBodySchema = createComponentBodySchema;

export type UpdateComponentBody = z.infer<typeof updateComponentBodySchema>;

export const listComponentsQuerySchema = z.object({
  type: componentTypeSchema.optional(),
  status: componentStatusSchema.optional(),
});

export type ListComponentsQuery = z.infer<typeof listComponentsQuerySchema>;
