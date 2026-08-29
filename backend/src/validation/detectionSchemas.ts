import { z } from "zod";

import { componentTypeSchema } from "./common.js";

const detectionBoundingBoxSchema = z.object({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
});

const detectionCreateSchema = z.object({
  type: componentTypeSchema,
  label: z.string().nullish(),
  name: z.string().nullish(),
  confidence: z.number().min(0).max(1),
  bbox: detectionBoundingBoxSchema,
});

export const detectionBatchBodySchema = z.object({
  scan_id: z.string().min(1, "scan_id must not be empty"),
  detections: z.array(detectionCreateSchema).min(1, "detections must contain at least one entry"),
});

export type DetectionBatchBody = z.infer<typeof detectionBatchBodySchema>;
