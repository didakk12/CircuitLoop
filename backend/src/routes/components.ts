import { Router } from "express";

import * as componentController from "../controllers/componentController.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { createComponentBodySchema, listComponentsQuerySchema, updateComponentBodySchema } from "../validation/componentSchemas.js";

const router = Router();

router.post("/", validateBody(createComponentBodySchema), asyncHandler(componentController.createComponent));
router.get("/", validateQuery(listComponentsQuerySchema), asyncHandler(componentController.listComponents));
router.get("/:id", asyncHandler(componentController.getComponent));
router.put("/:id", validateBody(updateComponentBodySchema), asyncHandler(componentController.updateComponent));
router.delete("/:id", asyncHandler(componentController.deleteComponent));

export default router;
