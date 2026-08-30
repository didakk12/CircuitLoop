import { Router } from "express";

import * as marketplaceController from "../controllers/marketplaceController.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  createMarketplaceListingBodySchema,
  listMarketplaceListingsQuerySchema,
  updateMarketplaceListingBodySchema,
} from "../validation/marketplaceSchemas.js";

const router = Router();

// Mounted under `requireAuth` in routes/index.ts — no route here is public.
router.post(
  "/listings",
  validateBody(createMarketplaceListingBodySchema),
  asyncHandler(marketplaceController.createListing),
);
router.get(
  "/listings",
  validateQuery(listMarketplaceListingsQuerySchema),
  asyncHandler(marketplaceController.listListings),
);
router.get("/listings/:id", asyncHandler(marketplaceController.getListing));
router.patch(
  "/listings/:id",
  validateBody(updateMarketplaceListingBodySchema),
  asyncHandler(marketplaceController.updateListing),
);
router.post("/listings/:id/publish", asyncHandler(marketplaceController.publishListing));

export default router;
