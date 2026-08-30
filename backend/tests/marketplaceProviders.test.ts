/**
 * Provider registry and the two shipped provider implementations.
 *
 * `settings` is stubbed so nothing here needs Meta credentials or makes a
 * network call — which is also the point being tested for ManualAssistProvider:
 * the default provider must be fully offline and deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `vi.hoisted` (not a plain `const`) because `vi.mock` factories are hoisted
 * above every import: a factory closing over an ordinary top-level binding runs
 * before that binding is initialised and dies in the temporal dead zone. This
 * object is mutable so individual tests can flip credentials on and off.
 */
const mockSettings = vi.hoisted(() => ({
  marketplaceProvider: "manual_assist",
  facebookMarketplaceCreateUrl: "https://www.facebook.com/marketplace/create/item",
  facebookPageAccessToken: undefined as string | undefined,
  facebookCatalogId: undefined as string | undefined,
}));

vi.mock("../src/config/env.js", () => ({ settings: mockSettings }));

import { FacebookGraphProvider } from "../src/services/marketplaceProviders/FacebookGraphProvider.js";
import { ManualAssistProvider } from "../src/services/marketplaceProviders/ManualAssistProvider.js";
import type {
  MarketplaceDraft,
  MarketplaceProvider,
  MarketplacePublishResult,
} from "../src/services/marketplaceProviders/MarketplaceProvider.js";
import {
  getMarketplaceProvider,
  marketplaceProviderNames,
  registerMarketplaceProvider,
  unregisterMarketplaceProvider,
} from "../src/services/marketplaceProviders/registry.js";
import { UpstreamServiceError } from "../src/utils/errors.js";

const draft: MarketplaceDraft = {
  id: "listing-1",
  componentId: "component-1",
  imageUrl: "/api/scans/scan-1/image",
  title: "Network Switch",
  description: "Salvaged network switch recovered from a circuit board.",
  category: "Electronics > Components > Relays & Switching",
  priceEstimate: 1.25,
  currency: "USD",
};

describe("marketplace provider registry", () => {
  const originalSettings = { ...mockSettings };

  beforeEach(() => {
    Object.assign(mockSettings, originalSettings);
  });

  afterEach(() => {
    unregisterMarketplaceProvider("test_fake");
  });

  it("registers both shipped providers at module load", () => {
    expect(marketplaceProviderNames()).toContain("manual_assist");
    expect(marketplaceProviderNames()).toContain("facebook_graph");
  });

  it("defaults to the configured provider when no name is given", () => {
    mockSettings.marketplaceProvider = "facebook_graph";
    expect(getMarketplaceProvider().name).toBe("facebook_graph");
  });

  it("looks a provider up by explicit name, ignoring the configured default", () => {
    mockSettings.marketplaceProvider = "facebook_graph";
    expect(getMarketplaceProvider("manual_assist").name).toBe("manual_assist");
  });

  it("accepts a newly registered provider through the same lookup production uses", () => {
    // This is the extension point the whole registry exists for: one class plus
    // one register() call, with no change to the service layer.
    const fake: MarketplaceProvider = {
      name: "test_fake",
      isConfigured: () => true,
      publish: (): Promise<MarketplacePublishResult> =>
        Promise.resolve({ status: "published", externalUrl: "https://example.test/1", externalListingId: "1" }),
    };
    registerMarketplaceProvider(fake);

    expect(getMarketplaceProvider("test_fake")).toBe(fake);
    expect(marketplaceProviderNames()).toContain("test_fake");
  });

  it("throws a clear, option-naming error for an unregistered provider", () => {
    // A typo'd CIRCUITLOOP_MARKETPLACE_PROVIDER should tell the operator what
    // the valid values are, not just that this one was wrong.
    expect(() => getMarketplaceProvider("nope")).toThrowError(UpstreamServiceError);
    expect(() => getMarketplaceProvider("nope")).toThrowError(/manual_assist/);
    expect(() => getMarketplaceProvider("nope")).toThrowError(/CIRCUITLOOP_MARKETPLACE_PROVIDER/);
  });

  it("removes a provider on unregister", () => {
    registerMarketplaceProvider({
      name: "test_fake",
      isConfigured: () => true,
      publish: () => Promise.resolve({ status: "published", externalUrl: null, externalListingId: null }),
    });
    unregisterMarketplaceProvider("test_fake");

    expect(marketplaceProviderNames()).not.toContain("test_fake");
  });
});

describe("ManualAssistProvider", () => {
  const provider = new ManualAssistProvider();

  it("needs no configuration", () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it("returns ready_for_manual_post with the create-listing link, never 'published'", async () => {
    const result = await provider.publish(draft);

    // The distinction is the entire honesty guarantee of this provider:
    // nothing was posted, so the listing must not claim it was.
    expect(result.status).toBe("ready_for_manual_post");
    expect(result.externalUrl).toBe(mockSettings.facebookMarketplaceCreateUrl);
    // No listing exists upstream, so there is no upstream id to invent.
    expect(result.externalListingId).toBeNull();
  });

  it("is deterministic — the same draft always produces the same result", async () => {
    await expect(provider.publish(draft)).resolves.toEqual(await provider.publish(draft));
  });

  it("makes no network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await provider.publish(draft);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("FacebookGraphProvider", () => {
  const provider = new FacebookGraphProvider();
  const originalSettings = { ...mockSettings };

  beforeEach(() => {
    Object.assign(mockSettings, originalSettings);
  });

  it("reports itself unconfigured when either credential is missing", () => {
    mockSettings.facebookPageAccessToken = undefined;
    mockSettings.facebookCatalogId = undefined;
    expect(provider.isConfigured()).toBe(false);

    // A token with no catalog to post into is as unusable as neither.
    mockSettings.facebookPageAccessToken = "token";
    expect(provider.isConfigured()).toBe(false);

    mockSettings.facebookPageAccessToken = undefined;
    mockSettings.facebookCatalogId = "catalog";
    expect(provider.isConfigured()).toBe(false);
  });

  it("reports itself configured once both credentials are set", () => {
    mockSettings.facebookPageAccessToken = "token";
    mockSettings.facebookCatalogId = "catalog";
    expect(provider.isConfigured()).toBe(true);
  });

  it("rejects with a not-configured error naming the missing variables", async () => {
    mockSettings.facebookPageAccessToken = undefined;
    mockSettings.facebookCatalogId = undefined;

    await expect(provider.publish(draft)).rejects.toThrowError(UpstreamServiceError);
    await expect(provider.publish(draft)).rejects.toThrowError(/FACEBOOK_PAGE_ACCESS_TOKEN/);
    await expect(provider.publish(draft)).rejects.toThrowError(/manual_assist/);
  });

  it("still rejects when fully configured, because publishing is not implemented", async () => {
    // The stub must never resolve with a fake success: a listing marked
    // `published` when nothing was posted is the one outcome worth ruling out
    // by construction.
    mockSettings.facebookPageAccessToken = "token";
    mockSettings.facebookCatalogId = "catalog";

    await expect(provider.publish(draft)).rejects.toThrowError(/not implemented/i);
  });

  it("never echoes a credential value in its error message", async () => {
    mockSettings.facebookPageAccessToken = "super-secret-token";
    mockSettings.facebookCatalogId = "secret-catalog-id";

    let message = "";
    try {
      await provider.publish(draft);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toBe("");
    expect(message).not.toContain("super-secret-token");
    expect(message).not.toContain("secret-catalog-id");
  });
});
