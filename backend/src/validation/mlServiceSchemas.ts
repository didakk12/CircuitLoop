/**
 * Zod schemas for validating responses *from* the Python ML service —
 * distinct from the rest of `validation/*.ts`, which validates requests
 * *into* this backend. Per ML_SERVICE_INTEGRATION_PLAN.md's explicit
 * instruction: "do not trust arbitrary Python responses without validating
 * them" — `mlServiceClient.ts` parses every response through these before
 * anything else touches it.
 */

import { z } from "zod";

const mlBoundingBoxSchema = z.object({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
});

const mlDetectionSchema = z.object({
  class_name: z.string(),
  confidence: z.number(),
  bbox: mlBoundingBoxSchema,
  text: z.string(),
});

export const mlDetectResponseSchema = z.object({
  detections: z.array(mlDetectionSchema),
});

const mlSearchResultSchema = z.object({
  part_name: z.string(),
  section: z.string(),
  source_file: z.string(),
  text: z.string(),
  // Neo4j cosine similarity. Range-checked rather than accepted as any
  // number: a value outside [0,1] would mean the index was built with a
  // different similarity function than the one this contract assumes, which
  // is a real misconfiguration worth failing on rather than passing through.
  score: z.number().min(0).max(1),
});

export const mlSearchResponseSchema = z.object({
  results: z.array(mlSearchResultSchema),
});

export const mlHealthResponseSchema = z.object({
  status: z.string(),
  model_loaded: z.boolean(),
  index_loaded: z.boolean(),
});

/** ml-service's own error envelope — parsed best-effort when a call fails, to surface a useful message. */
export const mlErrorResponseSchema = z.object({
  error: z.string(),
  detail: z.string().nullish(),
});
