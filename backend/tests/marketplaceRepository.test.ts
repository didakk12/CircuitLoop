/**
 * marketplaceRepository against a real Neo4j, using the project's
 * transaction-rollback pattern: one transaction per test, rolled back in
 * `afterEach`, so nothing is left behind. Skips gracefully when Neo4j isn't
 * reachable.
 *
 * What is actually under test here is the Cypher, and specifically the
 * ownership chain. `marketplaceService.test.ts` covers the service's *handling*
 * of a repository that hides other users' rows, using in-memory fakes; this
 * file is what proves the real queries hide them. Every operation is therefore
 * asserted twice — once as the owner, once as a second user who must see
 * nothing.
 */

import type { Session, Transaction } from "neo4j-driver";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { settings } from "../src/config/env.js";
import { closeDriver, getDriver } from "../src/db/neo4jDriver.js";
import * as componentRepository from "../src/repositories/componentRepository.js";
import * as marketplaceRepository from "../src/repositories/marketplaceRepository.js";
import * as scanRepository from "../src/repositories/scanRepository.js";
import type { MarketplaceListingInput } from "../src/repositories/marketplaceRepository.js";
import { connectForTests } from "./helpers/testNeo4j.js";
import { createTestUser } from "./helpers/testUser.js";

const { reachable } = await connectForTests();

function listingInput(componentId: string, overrides: Partial<MarketplaceListingInput> = {}): MarketplaceListingInput {
  return {
    componentId,
    scanId: null,
    provider: "manual_assist",
    title: "Network Switch",
    description: "Salvaged network switch recovered from a circuit board.",
    category: "Electronics > Components > Relays & Switching",
    priceEstimate: 1.25,
    currency: "USD",
    ...overrides,
  };
}

describe.skipIf(!reachable)("marketplaceRepository (integration)", () => {
  let session: Session;
  let tx: Transaction;
  let ownerId: string;
  let otherUserId: string;
  let componentId: string;

  beforeEach(async () => {
    session = getDriver().session({ database: settings.neo4j.database });
    tx = session.beginTransaction();
    ownerId = await createTestUser(tx);
    otherUserId = await createTestUser(tx);

    const component = await componentRepository.createComponent(
      {
        scanId: null,
        type: "switch",
        label: "network switch",
        name: "CISCO SG300-52",
        confidence: 0.9,
        condition: "good",
        salvagePriority: "high",
        x1: null,
        y1: null,
        x2: null,
        y2: null,
      },
      ownerId,
      tx,
    );
    componentId = component.id;
  });

  afterEach(async () => {
    await tx.rollback();
    await session.close();
  });

  afterAll(async () => {
    await closeDriver();
  });

  describe("createListing", () => {
    it("creates a listing linked to the component via LISTED_AS", async () => {
      const listing = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);

      expect(listing).not.toBeNull();
      expect(listing!.componentId).toBe(componentId);
      expect(listing!.status).toBe("draft");
      expect(listing!.title).toBe("Network Switch");
      expect(listing!.priceEstimate).toBeCloseTo(1.25);
      expect(listing!.externalUrl).toBeNull();
      expect(listing!.publishedAt).toBeNull();

      // The relationship, not just the denormalised componentId property —
      // every ownership query traverses the edge, so the edge has to be there.
      const edge = await tx.run<{ n: number }>(
        `MATCH (c:Component {id: $componentId})-[:LISTED_AS]->(m:MarketplaceListing {id: $id})
         RETURN count(*) AS n`,
        { componentId, id: listing!.id },
      );
      expect(Number(edge.records[0]!.get("n"))).toBe(1);
    });

    it("stores the scanId given to it, so image_url can be built without a traversal", async () => {
      const scan = await scanRepository.createScan({ imagePath: null, ownerId }, tx);
      const listing = await marketplaceRepository.createListing(
        listingInput(componentId, { scanId: scan.id }),
        ownerId,
        tx,
      );

      expect(listing!.scanId).toBe(scan.id);
    });

    it("returns null for a component belonging to another user", async () => {
      const listing = await marketplaceRepository.createListing(listingInput(componentId), otherUserId, tx);

      expect(listing).toBeNull();
    });

    it("returns null for a component that does not exist", async () => {
      const listing = await marketplaceRepository.createListing(listingInput("does-not-exist"), ownerId, tx);

      expect(listing).toBeNull();
    });
  });

  describe("getListingById", () => {
    it("is readable by its owner and invisible to everyone else", async () => {
      const listing = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);

      await expect(marketplaceRepository.getListingById(listing!.id, ownerId, tx)).resolves.not.toBeNull();
      // Indistinguishable from a listing that does not exist — the service
      // turns both into the same 404.
      await expect(marketplaceRepository.getListingById(listing!.id, otherUserId, tx)).resolves.toBeNull();
      await expect(marketplaceRepository.getListingById("does-not-exist", ownerId, tx)).resolves.toBeNull();
    });

    it("round-trips every field through Neo4j's own types", async () => {
      // Guards the mapper: datetime() comes back as a driver temporal, not a
      // string, and a float price must not arrive as a Neo4j Integer wrapper.
      const created = await marketplaceRepository.createListing(
        listingInput(componentId, { priceEstimate: 12.75, currency: "EUR" }),
        ownerId,
        tx,
      );
      const readBack = await marketplaceRepository.getListingById(created!.id, ownerId, tx);

      expect(readBack!.priceEstimate).toBeCloseTo(12.75);
      expect(readBack!.currency).toBe("EUR");
      expect(typeof readBack!.createdAt).toBe("string");
      expect(() => new Date(readBack!.createdAt).toISOString()).not.toThrow();
      expect(readBack!.errorMessage).toBeNull();
    });
  });

  describe("findActiveListingForComponent", () => {
    it("finds a draft listing", async () => {
      const created = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);

      const active = await marketplaceRepository.findActiveListingForComponent(componentId, ownerId, tx);

      expect(active?.id).toBe(created!.id);
    });

    it("treats ready_for_manual_post and failed as active, but never published", async () => {
      const created = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);

      for (const status of ["ready_for_manual_post", "failed"]) {
        await tx.run("MATCH (m:MarketplaceListing {id: $id}) SET m.status = $status", {
          id: created!.id,
          status,
        });
        const active = await marketplaceRepository.findActiveListingForComponent(componentId, ownerId, tx);
        expect(active?.id, `${status} must count as active`).toBe(created!.id);
      }

      // A published listing frees the component to be listed again — the whole
      // reason the policy is about *active* listings rather than any listing.
      await tx.run("MATCH (m:MarketplaceListing {id: $id}) SET m.status = 'published'", { id: created!.id });
      await expect(
        marketplaceRepository.findActiveListingForComponent(componentId, ownerId, tx),
      ).resolves.toBeNull();
    });

    it("returns null for another user, even though the listing is active", async () => {
      await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);

      await expect(
        marketplaceRepository.findActiveListingForComponent(componentId, otherUserId, tx),
      ).resolves.toBeNull();
    });

    it("returns the newest active listing when more than one somehow exists", async () => {
      const older = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);
      const newer = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);
      // Force a strict ordering: datetime() has millisecond resolution, so two
      // listings created in the same test can otherwise tie.
      await tx.run("MATCH (m:MarketplaceListing {id: $id}) SET m.createdAt = datetime() - duration('P1D')", {
        id: older!.id,
      });

      const active = await marketplaceRepository.findActiveListingForComponent(componentId, ownerId, tx);

      expect(active?.id).toBe(newer!.id);
    });
  });

  describe("listListingsForComponent", () => {
    it("returns the full history oldest-first, published ones included", async () => {
      const first = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);
      await tx.run(
        "MATCH (m:MarketplaceListing {id: $id}) SET m.status = 'published', m.createdAt = datetime() - duration('P1D')",
        { id: first!.id },
      );
      const second = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);

      const history = await marketplaceRepository.listListingsForComponent(componentId, ownerId, tx);

      expect(history?.map((listing) => listing.id)).toEqual([first!.id, second!.id]);
    });

    it("returns an empty array for an owned component with no listings", async () => {
      await expect(
        marketplaceRepository.listListingsForComponent(componentId, ownerId, tx),
      ).resolves.toEqual([]);
    });

    it("returns null — not an empty array — for a component the caller doesn't own", async () => {
      // The distinction matters: [] would confirm that someone else's component
      // id is real, which is exactly what the 404 is meant to hide.
      await expect(
        marketplaceRepository.listListingsForComponent(componentId, otherUserId, tx),
      ).resolves.toBeNull();
      await expect(
        marketplaceRepository.listListingsForComponent("does-not-exist", ownerId, tx),
      ).resolves.toBeNull();
    });
  });

  describe("updateListingContent", () => {
    it("updates the editable fields and bumps updatedAt", async () => {
      const created = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);

      const updated = await marketplaceRepository.updateListingContent(
        created!.id,
        {
          title: "Edited title",
          description: "Edited description",
          category: "Electronics > Components > Other",
          priceEstimate: 9.99,
          currency: "GBP",
        },
        ownerId,
        tx,
      );

      expect(updated!.title).toBe("Edited title");
      expect(updated!.priceEstimate).toBeCloseTo(9.99);
      expect(updated!.currency).toBe("GBP");
      // Unchanged by a content edit — these are the publish flow's to set.
      expect(updated!.status).toBe("draft");
      expect(updated!.provider).toBe("manual_assist");
    });

    it("refuses to update a published listing", async () => {
      const created = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);
      await tx.run("MATCH (m:MarketplaceListing {id: $id}) SET m.status = 'published'", { id: created!.id });

      const updated = await marketplaceRepository.updateListingContent(
        created!.id,
        {
          title: "Too late",
          description: created!.description,
          category: created!.category,
          priceEstimate: created!.priceEstimate,
          currency: created!.currency,
        },
        ownerId,
        tx,
      );

      // The Cypher-level guard, independent of the service's own check — this
      // is what makes a publish landing mid-edit safe.
      expect(updated).toBeNull();
      const readBack = await marketplaceRepository.getListingById(created!.id, ownerId, tx);
      expect(readBack!.title).toBe("Network Switch");
    });

    it("returns null for another user's listing and changes nothing", async () => {
      const created = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);

      const updated = await marketplaceRepository.updateListingContent(
        created!.id,
        {
          title: "Hijacked",
          description: created!.description,
          category: created!.category,
          priceEstimate: created!.priceEstimate,
          currency: created!.currency,
        },
        otherUserId,
        tx,
      );

      expect(updated).toBeNull();
      const readBack = await marketplaceRepository.getListingById(created!.id, ownerId, tx);
      expect(readBack!.title).toBe("Network Switch");
    });
  });

  describe("applyPublishOutcome", () => {
    it("records a successful publish and stamps publishedAt", async () => {
      const created = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);

      const published = await marketplaceRepository.applyPublishOutcome(
        created!.id,
        {
          status: "published",
          externalUrl: "https://example.test/listing/9",
          externalListingId: "9",
          errorMessage: null,
        },
        ownerId,
        tx,
      );

      expect(published!.status).toBe("published");
      expect(published!.externalUrl).toBe("https://example.test/listing/9");
      expect(published!.externalListingId).toBe("9");
      expect(published!.publishedAt).not.toBeNull();
    });

    it("does not stamp publishedAt for ready_for_manual_post", async () => {
      const created = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);

      const result = await marketplaceRepository.applyPublishOutcome(
        created!.id,
        {
          status: "ready_for_manual_post",
          externalUrl: "https://www.facebook.com/marketplace/create/item",
          externalListingId: null,
          errorMessage: null,
        },
        ownerId,
        tx,
      );

      // Nothing was posted, so a publish timestamp would make every later read
      // believe the listing is live.
      expect(result!.status).toBe("ready_for_manual_post");
      expect(result!.publishedAt).toBeNull();
    });

    it("records a failure with its message", async () => {
      const created = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);

      const failed = await marketplaceRepository.applyPublishOutcome(
        created!.id,
        {
          status: "failed",
          externalUrl: null,
          externalListingId: null,
          errorMessage: "manual_assist: Publishing timed out after 30000ms",
        },
        ownerId,
        tx,
      );

      expect(failed!.status).toBe("failed");
      expect(failed!.errorMessage).toContain("timed out");
      expect(failed!.publishedAt).toBeNull();
    });

    it("returns null for another user's listing and changes nothing", async () => {
      const created = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);

      const result = await marketplaceRepository.applyPublishOutcome(
        created!.id,
        { status: "published", externalUrl: "https://evil.test", externalListingId: "x", errorMessage: null },
        otherUserId,
        tx,
      );

      expect(result).toBeNull();
      const readBack = await marketplaceRepository.getListingById(created!.id, ownerId, tx);
      expect(readBack!.status).toBe("draft");
      expect(readBack!.externalUrl).toBeNull();
    });
  });

  it("keeps one user's listings out of another's component history entirely", async () => {
    // End-to-end ownership sweep: a second user with their own component and
    // listing must never see the first user's, through any read path.
    const theirComponent = await componentRepository.createComponent(
      {
        scanId: null,
        type: "resistor",
        label: "resistor",
        name: null,
        confidence: 0.5,
        condition: "unknown",
        salvagePriority: null,
        x1: null,
        y1: null,
        x2: null,
        y2: null,
      },
      otherUserId,
      tx,
    );
    const mine = await marketplaceRepository.createListing(listingInput(componentId), ownerId, tx);
    const theirs = await marketplaceRepository.createListing(
      listingInput(theirComponent.id, { title: "Theirs" }),
      otherUserId,
      tx,
    );

    const myHistory = await marketplaceRepository.listListingsForComponent(componentId, ownerId, tx);
    const theirHistory = await marketplaceRepository.listListingsForComponent(
      theirComponent.id,
      otherUserId,
      tx,
    );

    expect(myHistory?.map((l) => l.id)).toEqual([mine!.id]);
    expect(theirHistory?.map((l) => l.id)).toEqual([theirs!.id]);
  });
});
