/**
 * Placeholder for real Meta Graph API publishing.
 *
 * Registered and selectable today, but not wired to the network: `publish()`
 * always throws. That is a deliberate choice over silently succeeding — a
 * provider that returned a fake `published` status would tell the user their
 * component is for sale when nothing was posted, which is the one failure mode
 * worth ruling out by construction.
 *
 * The throw is caught by `marketplaceService.publishDraft` like any other
 * provider failure, so selecting this provider produces a listing in
 * `status: "failed"` carrying a clear message — never a 5xx, and never a lost
 * draft. Switching back to `manual_assist` and re-publishing always works.
 *
 * When the real integration lands, only this file changes.
 */

import { settings } from "../../config/env.js";
import { UpstreamServiceError } from "../../utils/errors.js";
import type { MarketplaceDraft, MarketplaceProvider, MarketplacePublishResult } from "./MarketplaceProvider.js";

export const FACEBOOK_GRAPH_PROVIDER_NAME = "facebook_graph";

export class FacebookGraphProvider implements MarketplaceProvider {
  readonly name = FACEBOOK_GRAPH_PROVIDER_NAME;

  /**
   * Both credentials are required: a page access token with no catalog to post
   * into is as unusable as a catalog with no token. `facebookAppId` is not
   * checked because it identifies the app rather than authorising the call.
   */
  isConfigured(): boolean {
    return Boolean(settings.facebookPageAccessToken) && Boolean(settings.facebookCatalogId);
  }

  publish(_draft: MarketplaceDraft): Promise<MarketplacePublishResult> {
    // Two distinct messages, because they call for two different fixes: set
    // the credentials, versus wait for (or contribute) the integration.
    // Neither message ever echoes a credential value.
    if (!this.isConfigured()) {
      return Promise.reject(
        new UpstreamServiceError(
          503,
          "Facebook Graph provider is not configured: set FACEBOOK_PAGE_ACCESS_TOKEN and FACEBOOK_CATALOG_ID, " +
            "or use CIRCUITLOOP_MARKETPLACE_PROVIDER=manual_assist to post by hand.",
        ),
      );
    }

    return Promise.reject(
      new UpstreamServiceError(
        503,
        "Facebook Graph publishing is not implemented yet. Use " +
          "CIRCUITLOOP_MARKETPLACE_PROVIDER=manual_assist to generate a create-listing link instead.",
      ),
    );
  }
}
