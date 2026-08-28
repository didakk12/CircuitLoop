import { z } from "zod";

export const createScanBodySchema = z.object({
  image_path: z.string().min(1).nullish(),
});

export type CreateScanBody = z.infer<typeof createScanBodySchema>;

/**
 * POST /api/scans/:id/upload's non-file form field. Multer populates form
 * fields onto req.body as strings, hence z.coerce — the same `validateBody`
 * middleware every other endpoint uses works here unchanged.
 */
export const uploadDetectionFormSchema = z.object({
  confidence: z.coerce.number().min(0, "confidence must be >= 0").max(1, "confidence must be <= 1").optional(),
});

export type UploadDetectionFormBody = z.infer<typeof uploadDetectionFormSchema>;
