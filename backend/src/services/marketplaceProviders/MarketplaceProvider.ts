/**
 * The seam between `marketplaceService` and whatever actually posts a listing.
 *
 * The service never knows which marketplace it is talking to: it looks a
 * provider up by name in `registry.ts` and calls `publish()`. Adding eBay,
 * Shopify, or Craigslist later is one new class implementing this interface
 * plus one `registry.set(...)` line — no `switch`, and no change to the
 * service, controller, routes, or repository.
 *
 * Providers are deliberately given a *snapshot* of the listing rather than the
 * live entity: they are transport, not persistence. Nothing here can mutate a
 * listing, decide its status, or reach the database.
 */

/** The listing content handed to a provider, exactly as it will be advertised. */
export interface MarketplaceDraft {
  readonly id: string;
  readonly componentId: string;
  /** Relative URL of the component's scan image (`/api/scans/{scanId}/image`), or null when the component has no scan. */
  readonly imageUrl: string | null;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly priceEstimate: number;
  readonly currency: string;
}

/**
 * What a provider reports back on success.
 *
 * `status` is limited to the two *successful* outcomes on purpose. A provider
 * never reports its own failure through a return value — it throws, and
 * `marketplaceService.publishDraft` is the single place that turns a throw (or
 * a timeout) into `status: "failed"`. That keeps "did this fail?" answerable in
 * exactly one place instead of two.
 */
export interface MarketplacePublishResult {
  /**
   * - `published` — the listing genuinely exists on the marketplace now.
   * - `ready_for_manual_post` — nothing was posted; the provider produced a
   *   link for the user to finish by hand (see `ManualAssistProvider`).
   */
  readonly status: "published" | "ready_for_manual_post";
  /** Where the listing lives upstream, or the link the user should open to post it manually. */
  readonly externalUrl: string | null;
  /** The provider's own identifier for the listing, when it issues one. */
  readonly externalListingId: string | null;
}

export interface MarketplaceProvider {
  /** Registry key and the value stored on the listing's `provider` property. Stable — it is persisted. */
  readonly name: string;
  /**
   * Whether this provider has everything it needs to run. Modelled on
   * `geminiClient.isConfigured()`: a provider missing its credentials reports
   * false here rather than failing mysteriously mid-publish.
   */
  isConfigured(): boolean;
  /**
   * Posts the draft, or throws. Throwing is the *only* way to report failure —
   * `publishDraft` catches it, records `status: "failed"` with the message, and
   * still answers the HTTP caller with 200.
   */
  publish(draft: MarketplaceDraft): Promise<MarketplacePublishResult>;
}
