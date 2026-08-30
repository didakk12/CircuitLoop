/**
 * Wire-format DTOs for `/api/marketplace`, following the same conventions as
 * `types/dto.ts`: `snake_case` field names, string ids, and a mapping function
 * that is the only sanctioned way to serialise the entity.
 *
 * Kept in its own file rather than appended to `dto.ts` so this feature adds no
 * lines to a shared file it doesn't have to.
 */

import type { MarketplaceListing, MarketplaceListingStatus } from "./entities.js";

export interface CreateMarketplaceListingRequest {
  component_id: string;
}

export interface UpdateMarketplaceListingRequest {
  title?: string;
  description?: string;
  category?: string;
  price_estimate?: number;
  currency?: string;
}

export interface MarketplaceListingResponse {
  id: string;
  component_id: string;
  provider: string;
  status: MarketplaceListingStatus;
  title: string;
  description: string;
  category: string;
  price_estimate: number;
  currency: string;
  /**
   * URL of the scan image this listing advertises, or null.
   *
   * Points at the existing ownership-checked `GET /api/scans/:id/image`
   * endpoint — the same convention `ScanResponse.image_url` uses, and no new
   * image endpoint is introduced. Built from the `scanId` captured on the
   * listing at creation, so it keeps showing the photo the listing was written
   * about even if the component is later re-parented.
   */
  image_url: string | null;
  /** Where the listing lives upstream, or the manual-post link. Null until publish is attempted. */
  external_url: string | null;
  external_listing_id: string | null;
  /** Why the last publish attempt failed. Null unless `status` is `failed`. */
  error_message: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

/**
 * `scanId` itself is deliberately not exposed: the client needs the image, not
 * the internal id, and `image_url` already carries everything it can act on.
 */
export function toMarketplaceListingResponse(listing: MarketplaceListing): MarketplaceListingResponse {
  return {
    id: listing.id,
    component_id: listing.componentId,
    provider: listing.provider,
    status: listing.status,
    title: listing.title,
    description: listing.description,
    category: listing.category,
    price_estimate: listing.priceEstimate,
    currency: listing.currency,
    image_url: listing.scanId === null ? null : `/api/scans/${listing.scanId}/image`,
    external_url: listing.externalUrl,
    external_listing_id: listing.externalListingId,
    error_message: listing.errorMessage,
    created_at: listing.createdAt,
    updated_at: listing.updatedAt,
    published_at: listing.publishedAt,
  };
}
