import type { Request, Response } from "express";

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
  const { scan_id: scanId, detections } = req.body;
  const inputs = detections.map((detection) => fromDetectionCreateRequest(detection, scanId));
  const components = await componentService.createDetectionBatch(scanId, inputs);
  res.status(201).json(components.map(toComponentResponse));
}
