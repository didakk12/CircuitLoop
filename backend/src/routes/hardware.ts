import { Router } from "express";

import * as hardwareController from "../controllers/hardwareController.js";
import { validateBody } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { hardwareActionBodySchema } from "../validation/hardwareSchemas.js";

const router = Router();

router.get("/status", hardwareController.getStatus);
// Not wrapped in `asyncHandler`: this handler returns synchronously and
// deliberately leaves the response open for the lifetime of the SSE stream.
router.get("/stream", hardwareController.streamStatus);
router.post("/action", validateBody(hardwareActionBodySchema), asyncHandler(hardwareController.sendAction));

export default router;
