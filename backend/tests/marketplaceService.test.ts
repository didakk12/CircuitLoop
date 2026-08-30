/**
 * marketplaceService behaviour, with the repository and componentService
 * replaced by in-memory fakes.
 *
 * The fakes are not stubs that return canned values — they reimplement the
 * ownership semantics of the real Cypher (a listing is only reachable through
 * its owner, a component only through `(:User)-[:OWNS]->`), so the ownership
 * assertions here genuinely exercise the service's handling of a repository
 * that hides other users' rows. The real Cypher that produces that behaviour is
 * covered separately in marketplaceRepository.test.ts against a live database.
 *
 * `settings` is stubbed with a 50ms publish timeout so the timeout path can be
 * asserted in milliseconds instead of the production 30 seconds. No database,
 * no network, and no Meta credentials are involved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MarketplaceListing, MarketplaceListingStatus } from "../src/types/entities.js";

const PUBLISH_TIMEOUT_MS = 50;

const mockSettings = vi.hoisted(() => ({
  marketplaceProvider: "test_fake",
  marketplacePublishTimeoutMs: 50,
  facebookMarketplaceCreateUrl: "https://www.facebook.com/marketplace/create/item",
  facebookPageAccessToken: undefined as string | undefined,
  facebookCatalogId: undefined as string | undefined,
}));

vi.mock("../src/config/env.js", () => ({ settings: mockSettings }));

/**
 * Shared in-memory state for both fakes. Hoisted for the same temporal-dead-zone
 * reason as the settings object above.
 */
const store = vi.hoisted(() => {
  interface StoredComponent {
    ownerId: string;
    detail: {
      id: string;
      scanId: string | null;
      type: string;
      label: string | null;
      name: string | null;
      condition: string;
    };
  }
  interface StoredListing {
    ownerId: string;
    listing: Record<string, unknown>;
  }
  return {
    components: new Map<string, StoredComponent>(),
    listings: new Map<string, StoredListing>(),
    /** Monotonic so createdAt values are strictly ordered — real timestamps can collide within a millisecond. */
    sequence: 0,
    nextTimestamp(): string {
      this.sequence += 1;
      return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + this.sequence * 1000).toISOString();
    },
    reset(): void {
      this.components.clear();
      this.listings.clear();
      this.sequence = 0;
    },
  };
});

vi.mock("../src/services/componentService.js", async () => {
  const { NotFoundError } = await import("../src/utils/errors.js");
  return {
    // Mirrors the real signature: throws for a component that is missing *or*
    // someone else's, so the two are indistinguishable to a caller.
    getComponentById: (id: string, ownerId: string) => {
      const entry = store.components.get(id);
      if (!entry || entry.ownerId !== ownerId) {
        return Promise.reject(new NotFoundError("Component", id));
      }
      return Promise.resolve(entry.detail);
    },
  };
});

vi.mock("../src/repositories/marketplaceRepository.js", () => {
  const ACTIVE: string[] = ["draft", "ready_for_manual_post", "failed"];

  const ownedListing = (id: string, ownerId: string): Record<string, unknown> | null => {
    const entry = store.listings.get(id);
    return entry && entry.ownerId === ownerId ? entry.listing : null;
  };

  return {
    ACTIVE_LISTING_STATUSES: ACTIVE,

    createListing: (input: Record<string, unknown>, ownerId: string) => {
      const component = store.components.get(input["componentId"] as string);
      if (!component || component.ownerId !== ownerId) {
        return Promise.resolve(null);
      }
      const now = store.nextTimestamp();
      const listing = {
        id: `listing-${store.listings.size + 1}`,
        ...input,
        status: "draft",
        externalUrl: null,
        externalListingId: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
      };
      store.listings.set(listing.id, { ownerId, listing });
      return Promise.resolve({ ...listing });
    },

    findActiveListingForComponent: (componentId: string, ownerId: string) => {
      const matches = [...store.listings.values()]
        .filter(
          (entry) =>
            entry.ownerId === ownerId &&
            entry.listing["componentId"] === componentId &&
            ACTIVE.includes(entry.listing["status"] as string),
        )
        .sort((a, b) => String(b.listing["createdAt"]).localeCompare(String(a.listing["createdAt"])));
      return Promise.resolve(matches[0] ? { ...matches[0].listing } : null);
    },

    getListingById: (id: string, ownerId: string) => {
      const listing = ownedListing(id, ownerId);
      return Promise.resolve(listing ? { ...listing } : null);
    },

    listListingsForComponent: (componentId: string, ownerId: string) => {
      const component = store.components.get(componentId);
      if (!component || component.ownerId !== ownerId) {
        // null, not [] — an empty array would confirm the component exists.
        return Promise.resolve(null);
      }
      const listings = [...store.listings.values()]
        .filter((entry) => entry.ownerId === ownerId && entry.listing["componentId"] === componentId)
        .sort((a, b) => String(a.listing["createdAt"]).localeCompare(String(b.listing["createdAt"])))
        .map((entry) => ({ ...entry.listing }));
      return Promise.resolve(listings);
    },

    updateListingContent: (id: string, update: Record<string, unknown>, ownerId: string) => {
      const listing = ownedListing(id, ownerId);
      // Mirrors the repository's own `status <> "published"` Cypher guard.
      if (!listing || listing["status"] === "published") {
        return Promise.resolve(null);
      }
      Object.assign(listing, update, { updatedAt: store.nextTimestamp() });
      return Promise.resolve({ ...listing });
    },

    applyPublishOutcome: (id: string, outcome: Record<string, unknown>, ownerId: string) => {
      const listing = ownedListing(id, ownerId);
      if (!listing) {
        return Promise.resolve(null);
      }
      Object.assign(listing, outcome, { updatedAt: store.nextTimestamp() });
      if (outcome["status"] === "published") {
        listing["publishedAt"] = store.nextTimestamp();
      }
      return Promise.resolve({ ...listing });
    },
  };
});

import type {
  MarketplaceDraft,
  MarketplaceProvider,
  MarketplacePublishResult,
} from "../src/services/marketplaceProviders/MarketplaceProvider.js";
import {
  registerMarketplaceProvider,
  unregisterMarketplaceProvider,
} from "../src/services/marketplaceProviders/registry.js";
import * as marketplaceService from "../src/services/marketplaceService.js";
import type { ComponentDetail } from "../src/types/entities.js";
import { ConflictError, NotFoundError } from "../src/utils/errors.js";

const OWNER = "owner-1";
const OTHER_USER = "other-user";

function makeComponent(overrides: Partial<ComponentDetail> = {}): ComponentDetail {
  return {
    id: "component-1",
    type: "switch",
    label: "network switch",
    name: "CISCO SG300-52",
    confidence: 0.91,
    condition: "good",
    salvagePriority: "high",
    x1: 0,
    y1: 0,
    x2: 10,
    y2: 10,
    status: "not_tested",
    createdAt: "2026-01-01T00:00:00.000Z",
    scanId: "scan-1",
    testResults: [],
    ...overrides,
  };
}

/** Registers a component the service's mocked componentService will find. */
function seedComponent(component: ComponentDetail, ownerId = OWNER): ComponentDetail {
  store.components.set(component.id, { ownerId, detail: component as never });
  return component;
}

/** Forces a listing into a given status without going through publish. */
function forceStatus(listing: MarketplaceListing, status: MarketplaceListingStatus): void {
  const entry = store.listings.get(listing.id);
  if (!entry) {
    throw new Error(`test setup: no listing ${listing.id}`);
  }
  entry.listing["status"] = status;
}

/** A provider whose behaviour each test dictates. Registered under the configured default name. */
function registerProvider(publish: (draft: MarketplaceDraft) => Promise<MarketplacePublishResult>): void {
  const provider: MarketplaceProvider = { name: "test_fake", isConfigured: () => true, publish };
  registerMarketplaceProvider(provider);
}

beforeEach(() => {
  store.reset();
  mockSettings.marketplaceProvider = "test_fake";
  mockSettings.marketplacePublishTimeoutMs = PUBLISH_TIMEOUT_MS;
});

afterEach(() => {
  unregisterMarketplaceProvider("test_fake");
});

// ---------------------------------------------------------------------------

describe("draft generation", () => {
  it("titles the listing from the detector's label, never the OCR marking", async () => {
    // The bug this rules out: "CISCO SG300-52" is a brand string read off the
    // part, not what the part is. A listing headed with it advertises the
    // marking rather than the item.
    seedComponent(makeComponent({ label: "network switch", name: "CISCO SG300-52" }));

    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    expect(listing.title).toBe("Network Switch");
    expect(listing.title).not.toContain("CISCO");
  });

  it("falls back to the type when the label is missing, empty, or whitespace", async () => {
    for (const [index, label] of [null, "", "   "].entries()) {
      store.reset();
      seedComponent(makeComponent({ id: `component-${index}`, label, type: "capacitor" }));

      const { listing } = await marketplaceService.createDraft(`component-${index}`, OWNER);
      expect(listing.title).toBe("Capacitor");
    }
  });

  it("puts the marking in the description, labelled as a marking", async () => {
    seedComponent(makeComponent({ name: "74HC83" }));

    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    expect(listing.description).toContain("Marking on part: 74HC83");
  });

  it("omits the marking line entirely when the part carries none", async () => {
    seedComponent(makeComponent({ name: null }));

    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    expect(listing.description).not.toContain("Marking on part");
  });

  it("omits the marking line for a whitespace-only marking", async () => {
    seedComponent(makeComponent({ name: "   " }));

    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    expect(listing.description).not.toContain("Marking on part");
  });

  it("states the condition honestly and always discloses that the price is an estimate", async () => {
    seedComponent(makeComponent({ id: "c-good", condition: "good" }));
    seedComponent(makeComponent({ id: "c-damaged", condition: "damaged" }));
    seedComponent(makeComponent({ id: "c-uncertain", condition: "uncertain" }));

    const good = await marketplaceService.createDraft("c-good", OWNER);
    const damaged = await marketplaceService.createDraft("c-damaged", OWNER);
    const uncertain = await marketplaceService.createDraft("c-uncertain", OWNER);

    // "appears intact" is not "works" — nothing has been electrically tested.
    expect(good.listing.description).toContain("Not electrically tested");
    expect(damaged.listing.description).toContain("as-is");
    expect(uncertain.listing.description).toContain("untested");

    for (const result of [good, damaged, uncertain]) {
      expect(result.listing.description).toContain("estimate only");
    }
  });

  it("assigns a category from the component type", async () => {
    seedComponent(makeComponent({ id: "c-ic", type: "ic" }));
    seedComponent(makeComponent({ id: "c-unknown", type: "unknown" }));

    const ic = await marketplaceService.createDraft("c-ic", OWNER);
    const unknown = await marketplaceService.createDraft("c-unknown", OWNER);

    expect(ic.listing.category).toContain("Integrated Circuits");
    expect(unknown.listing.category).toContain("Other");
  });

  it("captures the component's scanId onto the listing at creation time", async () => {
    // Stored, not re-derived: the listing must keep pointing at the photo it
    // was written about even if the component is later re-parented.
    seedComponent(makeComponent({ scanId: "scan-42" }));

    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    expect(listing.scanId).toBe("scan-42");
  });

  it("tolerates a component with no scan", async () => {
    seedComponent(makeComponent({ scanId: null }));

    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    expect(listing.scanId).toBeNull();
  });

  it("prices the draft from the heuristic and stamps the configured provider", async () => {
    seedComponent(makeComponent({ type: "microcontroller", condition: "good" }));

    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    expect(listing.priceEstimate).toBeGreaterThan(0);
    expect(listing.currency).toBe("USD");
    expect(listing.provider).toBe("test_fake");
    expect(listing.status).toBe("draft");
  });
});

describe("createDraft — duplicate-draft policy", () => {
  it("returns the existing active draft instead of creating a second one", async () => {
    seedComponent(makeComponent());

    const first = await marketplaceService.createDraft("component-1", OWNER);
    const second = await marketplaceService.createDraft("component-1", OWNER);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.listing.id).toBe(first.listing.id);
    expect(store.listings.size).toBe(1);
  });

  it("preserves the user's edits when the existing draft is handed back", async () => {
    // The reason the policy exists: clicking the button twice must not silently
    // discard what the user typed into the first draft.
    seedComponent(makeComponent());
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);
    await marketplaceService.updateDraft(listing.id, { title: "Hand-written title" }, OWNER);

    const again = await marketplaceService.createDraft("component-1", OWNER);

    expect(again.created).toBe(false);
    expect(again.listing.title).toBe("Hand-written title");
  });

  it("treats ready_for_manual_post and failed as active too", async () => {
    for (const status of ["ready_for_manual_post", "failed"] as MarketplaceListingStatus[]) {
      store.reset();
      seedComponent(makeComponent());
      const { listing } = await marketplaceService.createDraft("component-1", OWNER);
      forceStatus(listing, status);

      const again = await marketplaceService.createDraft("component-1", OWNER);

      expect(again.created, `${status} must count as active`).toBe(false);
      expect(again.listing.id).toBe(listing.id);
    }
  });

  it("creates a fresh listing once the previous one is published", async () => {
    // Re-listing after a successful post is explicitly allowed — a second unit,
    // or a relist after a sale.
    seedComponent(makeComponent());
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);
    forceStatus(listing, "published");

    const second = await marketplaceService.createDraft("component-1", OWNER);

    expect(second.created).toBe(true);
    expect(second.listing.id).not.toBe(listing.id);
    expect(store.listings.size).toBe(2);
  });
});

describe("updateDraft", () => {
  it("applies a partial patch and leaves untouched fields alone", async () => {
    seedComponent(makeComponent());
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    const updated = await marketplaceService.updateDraft(listing.id, { priceEstimate: 12.5 }, OWNER);

    expect(updated.priceEstimate).toBe(12.5);
    expect(updated.title).toBe(listing.title);
    expect(updated.description).toBe(listing.description);
  });

  it("rejects an edit to a published listing with 409 ConflictError", async () => {
    seedComponent(makeComponent());
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);
    forceStatus(listing, "published");

    let caught: unknown;
    try {
      await marketplaceService.updateDraft(listing.id, { title: "Too late" }, OWNER);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).statusCode).toBe(409);
  });

  it("leaves a published listing's content untouched after a rejected edit", async () => {
    seedComponent(makeComponent());
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);
    const originalTitle = listing.title;
    forceStatus(listing, "published");

    await expect(marketplaceService.updateDraft(listing.id, { title: "Too late" }, OWNER)).rejects.toThrow();

    const after = await marketplaceService.getListing(listing.id, OWNER);
    expect(after.title).toBe(originalTitle);
  });

  it("still allows editing a failed or manual-post listing — nothing was posted", async () => {
    for (const status of ["failed", "ready_for_manual_post", "draft"] as MarketplaceListingStatus[]) {
      store.reset();
      seedComponent(makeComponent());
      const { listing } = await marketplaceService.createDraft("component-1", OWNER);
      forceStatus(listing, status);

      const updated = await marketplaceService.updateDraft(listing.id, { title: `Edited ${status}` }, OWNER);
      expect(updated.title).toBe(`Edited ${status}`);
    }
  });
});

describe("publishDraft", () => {
  it("records a provider's success and stamps publishedAt", async () => {
    seedComponent(makeComponent());
    registerProvider(() =>
      Promise.resolve({
        status: "published",
        externalUrl: "https://example.test/listing/9",
        externalListingId: "9",
      }),
    );
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    const published = await marketplaceService.publishDraft(listing.id, OWNER);

    expect(published.status).toBe("published");
    expect(published.externalUrl).toBe("https://example.test/listing/9");
    expect(published.externalListingId).toBe("9");
    expect(published.errorMessage).toBeNull();
    expect(published.publishedAt).not.toBeNull();
  });

  it("does not stamp publishedAt for ready_for_manual_post — nothing was posted", async () => {
    seedComponent(makeComponent());
    registerProvider(() =>
      Promise.resolve({
        status: "ready_for_manual_post",
        externalUrl: "https://www.facebook.com/marketplace/create/item",
        externalListingId: null,
      }),
    );
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    const result = await marketplaceService.publishDraft(listing.id, OWNER);

    expect(result.status).toBe("ready_for_manual_post");
    expect(result.publishedAt).toBeNull();
  });

  it("turns a thrown provider error into status 'failed' rather than propagating it", async () => {
    seedComponent(makeComponent());
    registerProvider(() => Promise.reject(new Error("upstream exploded")));
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    // The whole point: the endpoint must not 5xx and the draft must survive.
    const result = await marketplaceService.publishDraft(listing.id, OWNER);

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("upstream exploded");
    // The provider name is included because "which marketplace failed" is the
    // first question anyone reading this asks.
    expect(result.errorMessage).toContain("test_fake");
    expect(result.externalUrl).toBeNull();
  });

  it("turns a synchronously-thrown provider error into status 'failed' too", async () => {
    seedComponent(makeComponent());
    registerProvider(() => {
      throw new Error("threw before returning a promise");
    });
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    const result = await marketplaceService.publishDraft(listing.id, OWNER);

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("threw before returning a promise");
  });

  it("fails a hung provider on the timeout instead of hanging the request", async () => {
    seedComponent(makeComponent());
    // Never resolves — the exact failure mode the timeout exists for.
    registerProvider(() => new Promise<MarketplacePublishResult>(() => {}));
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    const startedAt = Date.now();
    const result = await marketplaceService.publishDraft(listing.id, OWNER);
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("timed out");
    expect(result.errorMessage).toContain(String(PUBLISH_TIMEOUT_MS));
    // Bounded, not merely eventual: a generous ceiling that still proves the
    // race resolved on the timer rather than on the (never-settling) provider.
    expect(elapsed).toBeLessThan(2000);
  }, 5000);

  it("fails cleanly when the configured provider name is not registered", async () => {
    seedComponent(makeComponent());
    mockSettings.marketplaceProvider = "no_such_provider";
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    // A typo'd env var is a misconfiguration, not a lost draft or a 500.
    const result = await marketplaceService.publishDraft(listing.id, OWNER);

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("no_such_provider");
  });

  it("leaves a failed listing editable and re-publishable", async () => {
    seedComponent(makeComponent());
    registerProvider(() => Promise.reject(new Error("transient outage")));
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);
    await marketplaceService.publishDraft(listing.id, OWNER);

    await expect(marketplaceService.updateDraft(listing.id, { title: "Retry" }, OWNER)).resolves.toMatchObject({
      title: "Retry",
    });

    registerProvider(() =>
      Promise.resolve({ status: "published", externalUrl: "https://example.test/2", externalListingId: "2" }),
    );
    const retried = await marketplaceService.publishDraft(listing.id, OWNER);

    expect(retried.status).toBe("published");
    expect(retried.errorMessage).toBeNull();
  });

  it("is a no-op on an already-published listing and never calls the provider twice", async () => {
    seedComponent(makeComponent());
    const publish = vi.fn(() =>
      Promise.resolve({
        status: "published" as const,
        externalUrl: "https://example.test/1",
        externalListingId: "1",
      }),
    );
    registerProvider(publish);
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);
    const first = await marketplaceService.publishDraft(listing.id, OWNER);

    const second = await marketplaceService.publishDraft(listing.id, OWNER);

    // Re-posting would create a duplicate upstream and overwrite the ids
    // recording the first post — exactly what immutability exists to prevent.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(second.externalListingId).toBe(first.externalListingId);
    expect(second.publishedAt).toBe(first.publishedAt);
  });

  it("hands the provider the listing's current content, not the component's original draft", async () => {
    seedComponent(makeComponent());
    let received: MarketplaceDraft | null = null;
    registerProvider((draft) => {
      received = draft;
      return Promise.resolve({ status: "published", externalUrl: null, externalListingId: null });
    });
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);
    await marketplaceService.updateDraft(listing.id, { title: "Edited title", priceEstimate: 99 }, OWNER);

    await marketplaceService.publishDraft(listing.id, OWNER);

    expect(received).not.toBeNull();
    expect(received!.title).toBe("Edited title");
    expect(received!.priceEstimate).toBe(99);
    expect(received!.imageUrl).toBe("/api/scans/scan-1/image");
  });
});

describe("ownership scoping", () => {
  it("404s on create for a component owned by someone else", async () => {
    seedComponent(makeComponent(), OTHER_USER);

    await expect(marketplaceService.createDraft("component-1", OWNER)).rejects.toThrowError(NotFoundError);
  });

  it("404s on create for a component that does not exist", async () => {
    await expect(marketplaceService.createDraft("nope", OWNER)).rejects.toThrowError(NotFoundError);
  });

  it("404s on read, update, and publish for another user's listing", async () => {
    seedComponent(makeComponent());
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    // 404 rather than 403 throughout: a probing user must not be able to tell
    // an existing listing they don't own from one that isn't there.
    await expect(marketplaceService.getListing(listing.id, OTHER_USER)).rejects.toThrowError(NotFoundError);
    await expect(
      marketplaceService.updateDraft(listing.id, { title: "theirs now" }, OTHER_USER),
    ).rejects.toThrowError(NotFoundError);
    await expect(marketplaceService.publishDraft(listing.id, OTHER_USER)).rejects.toThrowError(NotFoundError);
  });

  it("404s on list for another user's component", async () => {
    seedComponent(makeComponent(), OTHER_USER);

    await expect(marketplaceService.listListingsForComponent("component-1", OWNER)).rejects.toThrowError(
      NotFoundError,
    );
  });

  it("does not let another user's failed publish attempt touch the listing", async () => {
    seedComponent(makeComponent());
    registerProvider(() => Promise.resolve({ status: "published", externalUrl: null, externalListingId: null }));
    const { listing } = await marketplaceService.createDraft("component-1", OWNER);

    await expect(marketplaceService.publishDraft(listing.id, OTHER_USER)).rejects.toThrowError(NotFoundError);

    const after = await marketplaceService.getListing(listing.id, OWNER);
    expect(after.status).toBe("draft");
  });
});

describe("listListingsForComponent", () => {
  it("returns the component's full history oldest-first, including published ones", async () => {
    seedComponent(makeComponent());
    const first = await marketplaceService.createDraft("component-1", OWNER);
    forceStatus(first.listing, "published");
    const second = await marketplaceService.createDraft("component-1", OWNER);

    const history = await marketplaceService.listListingsForComponent("component-1", OWNER);

    expect(history.map((l) => l.id)).toEqual([first.listing.id, second.listing.id]);
  });

  it("returns an empty array for an owned component that has never been listed", async () => {
    seedComponent(makeComponent());

    await expect(marketplaceService.listListingsForComponent("component-1", OWNER)).resolves.toEqual([]);
  });
});
