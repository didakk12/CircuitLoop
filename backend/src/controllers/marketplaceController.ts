/**
 * Thin HTTP layer over `marketplaceService` — request in, DTO out, no business
 * logic. Ownership comes from `requireUser(req)`, the same way every other
 * authenticated controller in this codebase gets it.
 */

import type { Request, Response } from "express";

import { requireUser } from "../middleware/auth.js";
import * as marketplaceService from "../services/marketplaceService.js";
import {
  toMarketplaceListingResponse,
  type CreateMarketplaceListingRequest,
  type MarketplaceListingResponse,
  type UpdateMarketplaceListingRequest,
} from "../types/marketplaceDto.js";
import type { ListMarketplaceListingsQuery } from "../validation/marketplaceSchemas.js";

/**
 * 201 for a genuinely new draft, 200 when an existing active one was returned
 * instead — the duplicate-draft policy made visible in the status code, so a
 * client can tell "I created this" from "this already existed" without
 * comparing timestamps.
 */
export async function createListing(
  req: Request<Record<string, never>, MarketplaceListingResponse, CreateMarketplaceListingRequest>,
  res: Response<MarketplaceListingResponse>,
): Promise<void> {
  const user = requireUser(req);
  const { listing, created } = await marketplaceService.createDraft(req.body.component_id, user.id);
  res.status(created ? 201 : 200).json(toMarketplaceListingResponse(listing));
}

export async function getListing(
  req: Request<{ id: string }>,
  res: Response<MarketplaceListingResponse>,
): Promise<void> {
  const user = requireUser(req);
  const listing = await marketplaceService.getListing(req.params.id, user.id);
  res.status(200).json(toMarketplaceListingResponse(listing));
}

export async function listListings(
  req: Request,
  res: Response<MarketplaceListingResponse[]>,
): Promise<void> {
  const user = requireUser(req);
  const query = req.query as unknown as ListMarketplaceListingsQuery;
  const listings = await marketplaceService.listListingsForComponent(query.component_id, user.id);
  res.status(200).json(listings.map(toMarketplaceListingResponse));
}

export async function updateListing(
  req: Request<{ id: string }, MarketplaceListingResponse, UpdateMarketplaceListingRequest>,
  res: Response<MarketplaceListingResponse>,
): Promise<void> {
  const user = requireUser(req);
  const listing = await marketplaceService.updateDraft(
    req.params.id,
    {
      title: req.body.title,
      description: req.body.description,
      category: req.body.category,
      priceEstimate: req.body.price_estimate,
      currency: req.body.currency,
    },
    user.id,
  );
  res.status(200).json(toMarketplaceListingResponse(listing));
}

/**
 * Always 200 on a listing the caller owns, even when the provider failed —
 * `publishDraft` turns provider failures and timeouts into `status: "failed"`
 * on the returned listing rather than an exception, so there is no 5xx path
 * here to handle.
 */
export async function publishListing(
  req: Request<{ id: string }>,
  res: Response<MarketplaceListingResponse>,
): Promise<void> {
  const user = requireUser(req);
  const listing = await marketplaceService.publishDraft(req.params.id, user.id);
  res.status(200).json(toMarketplaceListingResponse(listing));
}
