/**
 * The default marketplace provider — and deliberately the least clever one.
 *
 * Facebook has no public API that creates a peer-to-peer Marketplace listing,
 * so the honest default is not to pretend otherwise: this provider makes no
 * network call, posts nothing, and instead returns the Facebook
 * create-listing URL for the user to finish by hand. The listing lands in
 * `ready_for_manual_post`, which is explicitly *not* `published` — it stays
 * editable, and it does not consume the component's one active draft slot in a
 * way that implies the item is actually up for sale.
 *
 * Being fully offline makes it deterministic: it cannot time out, cannot fail,
 * and needs no credentials, which is exactly what a default should be.
 */

import { settings } from "../../config/env.js";
import type { MarketplaceDraft, MarketplaceProvider, MarketplacePublishResult } from "./MarketplaceProvider.js";

export const MANUAL_ASSIST_PROVIDER_NAME = "manual_assist";

export class ManualAssistProvider implements MarketplaceProvider {
  readonly name = MANUAL_ASSIST_PROVIDER_NAME;

  /**
   * Always true. There is nothing to configure: the create-listing URL has a
   * working default in `settings`, and no credential is involved.
   */
  isConfigured(): boolean {
    return true;
  }

  publish(_draft: MarketplaceDraft): Promise<MarketplacePublishResult> {
    return Promise.resolve({
      status: "ready_for_manual_post",
      externalUrl: settings.facebookMarketplaceCreateUrl,
      // No listing exists upstream, so there is no upstream id to record.
      // Inventing one here would make a later `externalListingId` check
      // wrongly believe something had been posted.
      externalListingId: null,
    });
  }
}
