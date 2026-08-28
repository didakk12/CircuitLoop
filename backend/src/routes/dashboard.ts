import { Router } from "express";

import * as dashboardController from "../controllers/dashboardController.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.get("/stats", asyncHandler(dashboardController.getStats));

export default router;
