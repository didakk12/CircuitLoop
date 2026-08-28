import { Router } from "express";

import * as testResultController from "../controllers/testResultController.js";
import { validateBody } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { createTestResultBodySchema } from "../validation/testResultSchemas.js";

/** Mounted at the same `/components` base as routes/components.ts, mirroring the original two-router-one-prefix split. */
const router = Router();

router.post("/:id/test", validateBody(createTestResultBodySchema), asyncHandler(testResultController.createTestResult));
router.get("/:id/test-result", asyncHandler(testResultController.getLatestTestResult));
router.get("/:id/tests", asyncHandler(testResultController.getTestHistory));

export default router;
