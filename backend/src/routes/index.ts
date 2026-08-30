import { Router } from "express";


import assistantRouter from "./assistant.js";
import authRouter from "./auth.js";
import componentsRouter from "./components.js";
import dashboardRouter from "./dashboard.js";
import detectionsRouter from "./detections.js";
import hardwareRouter from "./hardware.js";
import healthRouter from "./health.js";
import marketplaceRouter from "./marketplace.js";
import telemetryRouter from "./telemetry.js";
import { requireAuth } from "../middleware/auth.js";
import scansRouter from "./scans.js";
import testResultsRouter from "./testResults.js";

/** Mounted at `/api` in `src/index.ts`. */
const router = Router();

// Public: liveness, and the endpoints used to obtain a session.
router.use(healthRouter);
router.use("/auth", authRouter);

// Machine telemetry endpoint used by the Windows PowerShell agent.
// Authentication is intentionally handled separately from browser/session
// authentication because the agent does not use the user session cookie.
router.use("/v1", telemetryRouter);

// Everything below carries user data and requires a valid session. Applied
// once here rather than per-route so a newly added data route is protected by
// default — forgetting to opt in is the failure mode that leaks data.
router.use(requireAuth);

router.use("/scans", scansRouter);
router.use("/components", componentsRouter);
router.use("/components", testResultsRouter);
router.use("/detections", detectionsRouter);
router.use("/dashboard", dashboardRouter);
router.use("/assistant", assistantRouter);
router.use("/hardware", hardwareRouter);
router.use("/marketplace", marketplaceRouter);


export default router;
