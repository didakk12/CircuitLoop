import { Router } from "express";

import * as detectionController from "../controllers/detectionController.js";
import { validateBody } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { detectionBatchBodySchema } from "../validation/detectionSchemas.js";

const router = Router();

router.post("/", validateBody(detectionBatchBodySchema), asyncHandler(detectionController.createDetections));

export default router;
