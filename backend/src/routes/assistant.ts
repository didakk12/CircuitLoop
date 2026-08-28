import { Router } from "express";

import * as assistantController from "../controllers/assistantController.js";
import { validateBody } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { askAssistantBodySchema } from "../validation/assistantSchemas.js";

const router = Router();

router.post("/", validateBody(askAssistantBodySchema), asyncHandler(assistantController.askAssistant));

export default router;
