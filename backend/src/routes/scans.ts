import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import multer, { MulterError } from "multer";

import * as scanController from "../controllers/scanController.js";
import { settings } from "../config/env.js";
import { requireUploadedFile, validateBody } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { createScanBodySchema, uploadDetectionFormSchema } from "../validation/scanSchemas.js";

const router = Router();

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: settings.maxUploadBytes },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
      callback(new ValidationError(`Unsupported content type '${file.mimetype}' — expected PNG or JPEG`));
      return;
    }
    callback(null, true);
  },
});

/**
 * Multer surfaces its own errors (e.g. LIMIT_FILE_SIZE) outside the normal
 * validation flow — this wraps its middleware so every failure still ends
 * up as an `AppError` through the same `next(error)` -> `errorHandler`
 * path as everything else, instead of a separate error shape.
 */
function handleUpload(field: string): RequestHandler {
  const middleware = upload.single(field);
  return (req: Request, res: Response, next: NextFunction): void => {
    middleware(req, res, (error: unknown) => {
      if (error instanceof MulterError && error.code === "LIMIT_FILE_SIZE") {
        next(new ValidationError(`Image exceeds the ${settings.maxUploadBytes}-byte limit`));
        return;
      }
      next(error); // our own fileFilter ValidationError, or anything unexpected
    });
  };
}

router.post("/", validateBody(createScanBodySchema), asyncHandler(scanController.createScan));
router.get("/", asyncHandler(scanController.listScans));
router.get("/:id", asyncHandler(scanController.getScan));
router.get("/:id/image", asyncHandler(scanController.getScanImage));
router.post(
  "/:id/upload",
  handleUpload("image"),
  requireUploadedFile("image"),
  validateBody(uploadDetectionFormSchema),
  asyncHandler(scanController.uploadAndDetect),
);

export default router;
