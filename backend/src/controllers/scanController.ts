import type { Request, Response } from "express";

import { requireUser } from "../middleware/auth.js";
import * as detectionService from "../services/detectionService.js";
import * as imageStorageService from "../services/imageStorageService.js";
import * as scanService from "../services/scanService.js";
import { toComponentResponse, toScanDetailResponse, toScanSummaryResponse } from "../types/dto.js";
import type { ComponentResponse, CreateScanRequest, ScanResponse } from "../types/dto.js";
import { NotFoundError } from "../utils/errors.js";
import type { UploadDetectionFormBody } from "../validation/scanSchemas.js";

export async function createScan(
  req: Request<Record<string, never>, ScanResponse, CreateScanRequest>,
  res: Response<ScanResponse>,
): Promise<void> {
  const user = requireUser(req);
  // `image_path` is no longer accepted from the client: the image is whatever
  // gets uploaded to /:id/upload, and letting a caller set the stored filename
  // would point a scan at an arbitrary file in the upload directory.
  const scan = await scanService.createScan({ imagePath: null, ownerId: user.id });
  res.status(201).json(toScanDetailResponse(scan));
}

export async function listScans(_req: Request, res: Response<ScanResponse[]>): Promise<void> {
  const user = requireUser(_req);
  const scans = await scanService.listScans(user.id);
  res.status(200).json(scans.map(toScanSummaryResponse));
}

export async function getScan(
  req: Request<{ id: string }, ScanResponse>,
  res: Response<ScanResponse>,
): Promise<void> {
  const user = requireUser(req);
  const scan = await scanService.getScanById(req.params.id, user.id);
  res.status(200).json(toScanDetailResponse(scan));
}

/**
 * GET /api/scans/:id/image — serves the persisted upload.
 *
 * Ownership is resolved in the same query that finds the filename, so a scan
 * belonging to another user is a 404 and never reaches the filesystem. The
 * stored path is never exposed; the client only ever knows the scan id.
 */
export async function getScanImage(
  req: Request<{ id: string }>,
  res: Response,
): Promise<void> {
  const user = requireUser(req);
  const filename = await scanService.getOwnedImagePath(req.params.id, user.id);
  if (filename === null) {
    throw new NotFoundError("Scan image", req.params.id);
  }

  res.setHeader("Content-Type", imageStorageService.contentTypeForStoredImage(filename));
  // Private: the response is user-specific, so a shared cache must never reuse
  // it for a different session.
  res.setHeader("Cache-Control", "private, max-age=3600");

  const stream = imageStorageService.openStoredImage(filename);
  stream.on("error", () => {
    // The row survived but the file did not (manual deletion, lost volume).
    if (!res.headersSent) {
      res.status(404).json({ detail: `Scan image not found: ${req.params.id}` });
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}

/**
 * POST /api/scans/:id/upload — detection upload.
 *
 * `requireUploadedFile` guarantees `req.file`; `validateBody` has already
 * parsed `confidence`. Detection behaviour is unchanged — the image is now
 * additionally persisted so the scan remains viewable in history.
 */
export async function uploadAndDetect(
  req: Request<{ id: string }, ComponentResponse[], UploadDetectionFormBody>,
  res: Response<ComponentResponse[]>,
): Promise<void> {
  const user = requireUser(req);
  const file = req.file as Express.Multer.File;

  // Confirms the scan exists *and* belongs to the caller before writing an
  // image for it or running detection on someone else's scan.
  await scanService.getScanById(req.params.id, user.id);

  const components = await detectionService.detectAndPersist({
    scanId: req.params.id,
    ownerId: user.id,
    imageBuffer: file.buffer,
    filename: file.originalname,
    contentType: file.mimetype,
    confidence: req.body.confidence,
  });

  // Persisted after detection so a detection failure doesn't leave a stored
  // image for a scan that has no results.
  const storedFilename = await imageStorageService.saveScanImage(
    req.params.id,
    file.buffer,
    file.mimetype,
  );
  await scanService.setImagePath(req.params.id, storedFilename);

  res.status(201).json(components.map(toComponentResponse));
}
