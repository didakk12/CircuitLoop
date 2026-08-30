/**
 * Zod request schemas for `/api/marketplace`, applied through
 * `middleware/validate.ts` exactly like every other route's.
 */

import { z } from "zod";

import { idParamSchema } from "./common.js";

export const createMarketplaceListingBodySchema = z.object({
  component_id: idParamSchema,
});

export type CreateMarketplaceListingBody = z.infer<typeof createMarketplaceListingBodySchema>;

/** Upper bounds on the free-text fields — generous for a real listing, but not unbounded, so one request can't store a megabyte on a node. */
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_CATEGORY_LENGTH = 200;

/**
 * PATCH is a genuine partial update: every field is optional and an omitted one
 * keeps its current value (see `marketplaceService.updateDraft`).
 *
 * `.strict()` rejects unknown keys rather than ignoring them, so an attempt to
 * PATCH `status`, `provider`, or `external_url` fails loudly instead of
 * appearing to succeed while changing nothing — those are set by the publish
 * flow alone and are not client-writable.
 */
export const updateMarketplaceListingBodySchema = z
  .object({
    title: z.string().trim().min(1, "title must not be empty").max(MAX_TITLE_LENGTH).optional(),
    description: z
      .string()
      .trim()
      .min(1, "description must not be empty")
      .max(MAX_DESCRIPTION_LENGTH)
      .optional(),
    category: z.string().trim().min(1, "category must not be empty").max(MAX_CATEGORY_LENGTH).optional(),
    // Finite and non-negative: a NaN or negative asking price is never a real
    // edit, and it would render as a broken listing rather than a cheap one.
    price_estimate: z
      .number()
      .finite("price_estimate must be a finite number")
      .nonnegative("price_estimate must be >= 0")
      .optional(),
    // ISO 4217-shaped. Not an enum of every world currency — that list would go
    // stale — but tight enough that free text can't land in a price field.
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter code (e.g. USD)")
      .optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one field must be provided",
  });

export type UpdateMarketplaceListingBody = z.infer<typeof updateMarketplaceListingBodySchema>;

export const listMarketplaceListingsQuerySchema = z.object({
  component_id: idParamSchema,
});

export type ListMarketplaceListingsQuery = z.infer<typeof listMarketplaceListingsQuerySchema>;
