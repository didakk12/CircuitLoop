import { Router } from "express";

import {
getTelemetry,
receiveTelemetry,
} from "../controllers/telemetryController.js";

import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.post("/telemetry", asyncHandler(receiveTelemetry));

router.get("/telemetry", asyncHandler(getTelemetry));

export default router;
