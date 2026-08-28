import { Router } from "express";

import * as authController from "../controllers/authController.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { credentialsSchema } from "../validation/authSchemas.js";

const router = Router();

// Public: these are how a caller obtains a session in the first place.
router.post("/register", validateBody(credentialsSchema), asyncHandler(authController.register));
router.post("/login", validateBody(credentialsSchema), asyncHandler(authController.login));
router.post("/logout", authController.logout);

// Requires a valid session — it exists to report the current one.
router.get("/me", requireAuth, authController.me);

export default router;
