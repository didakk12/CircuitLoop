import type { Request, Response } from "express";

import { requireUser } from "../middleware/auth.js";
import * as componentService from "../services/componentService.js";
import {
  fromDetectionCreateRequest,
  toComponentResponse,
  type ComponentResponse,
  type DetectionBatchCreateRequest,
} from "../types/dto.js";

export async function createDetections(
  req: Request<Record<string, never>, ComponentResponse[], DetectionBatchCreateRequest>,
  res: Response<ComponentResponse[]>,
): Promise<void> {
  const user = requireUser(req);
  const { scan_id: scanId, detections } = req.body;
  const inputs = detections.map((detection) => fromDetectionCreateRequest(detection, scanId));
  // Batch create is scoped to a scan the caller owns — createDetectionBatch
  // reports a scan owned by someone else as "Scan not found".
  const components = await componentService.createDetectionBatch(scanId, inputs, user.id);
  res.status(201).json(components.map(toComponentResponse));
}
