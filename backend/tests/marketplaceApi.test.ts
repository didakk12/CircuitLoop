/**
 * HTTP-level tests for `/api/marketplace`.
 *
 * Split into two suites for a reason. The authorization suite needs no
 * database — `requireAuth` rejects a session-less request before anything
 * touches Neo4j — so it runs everywhere, including CI with no database, and
 * that is exactly the check worth never skipping: a data route accidentally
 * mounted above `requireAuth` would leak every user's listings.
 *
 * The integration suite drives the real create -> edit -> publish flow through
 * the production write path and skips gracefully when Neo4j isn't reachable.
 * It tracks every record it creates and deletes them in teardown, the same
 * "identifiable test records + cleanup" strategy `api.test.ts` uses (no
 * injectable test transaction reaches through HTTP).
 */

import type { Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { settings } from "../src/config/env.js";
import { closeDriver, getDriver } from "../src/db/neo4jDriver.js";
import { deleteComponentsById, deleteTestUsers, registerAndLogin } from "./helpers/authAgent.js";
import { connectForTests } from "./helpers/testNeo4j.js";

const { reachable } = await connectForTests();

const { createApp } = await import("../src/index.js");

describe("marketplace routes (authorization)", () => {
  const app: Express = createApp();

  it("rejects every marketplace endpoint with 401 when no session cookie is present", async () => {
    const unauthenticated = [
      request(app).post("/api/marketplace/listings").send({ component_id: "any" }),
      request(app).get("/api/marketplace/listings?component_id=any"),
      request(app).get("/api/marketplace/listings/any"),
      request(app).patch("/api/marketplace/listings/any").send({ title: "x" }),
      request(app).post("/api/marketplace/listings/any/publish"),
    ];

    for (const pending of unauthenticated) {
      const response = await pending;
      expect(response.status).toBe(401);
    }
  });

  it("rejects a request carrying a garbage session cookie", async () => {
    const response = await request(app)
      .get("/api/marketplace/listings/any")
      .set("Cookie", "circuitloop_session=not-a-real-jwt");

    expect(response.status).toBe(401);
  });
});

describe.skipIf(!reachable)("marketplace API (integration)", () => {
  let app: Express;
  let api: Awaited<ReturnType<typeof registerAndLogin>>["agent"];
  let otherApi: Awaited<ReturnType<typeof registerAndLogin>>["agent"];
  const createdUserIds: string[] = [];
  const createdComponentIds: string[] = [];
  const createdListingIds: string[] = [];

  /** Creates a component owned by `agent` and tracks it for cleanup. */
  async function createComponent(
    agent: typeof api,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await agent
      .post("/api/components")
      .send({ type: "switch", label: "network switch", name: "CISCO SG300-52", confidence: 0.9, ...overrides })
      .expect(201);
    const id = response.body.id as string;
    createdComponentIds.push(id);
    return id;
  }

  beforeAll(async () => {
    app = createApp();
    const authed = await registerAndLogin(app);
    api = authed.agent;
    createdUserIds.push(authed.userId);

    const other = await registerAndLogin(app);
    otherApi = other.agent;
    createdUserIds.push(other.userId);
  });

  afterEach(async () => {
    if (createdListingIds.length > 0) {
      const session = getDriver().session({ database: settings.neo4j.database });
      try {
        await session.run("MATCH (m:MarketplaceListing) WHERE m.id IN $ids DETACH DELETE m", {
          ids: createdListingIds.splice(0),
        });
      } finally {
        await session.close();
      }
    }
    await deleteComponentsById(createdComponentIds.splice(0));
  });

  afterAll(async () => {
    await deleteTestUsers(createdUserIds.splice(0));
    await closeDriver();
  });

  it("creates a draft with 201, then returns the same one with 200 on a repeat POST", async () => {
    const componentId = await createComponent(api);

    const first = await api.post("/api/marketplace/listings").send({ component_id: componentId });
    expect(first.status).toBe(201);
    createdListingIds.push(first.body.id as string);
    expect(first.body.status).toBe("draft");
    // Title from label ?? type, never the OCR marking.
    expect(first.body.title).toBe("Network Switch");
    expect(first.body.title).not.toContain("CISCO");
    expect(first.body.price_estimate).toBeGreaterThan(0);

    // 200, not 201 — the duplicate-draft policy visible in the status code.
    const second = await api.post("/api/marketplace/listings").send({ component_id: componentId });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it("exposes image_url onto the existing scan image endpoint when the component has a scan", async () => {
    const scan = await api.post("/api/scans").send({}).expect(201);
    const scanId = scan.body.id as string;
    const componentId = await createComponent(api, { scan_id: scanId });

    const created = await api.post("/api/marketplace/listings").send({ component_id: componentId }).expect(201);
    createdListingIds.push(created.body.id as string);

    expect(created.body.image_url).toBe(`/api/scans/${scanId}/image`);
    // The internal scan id is not part of the contract — image_url is the only
    // thing a client can act on.
    expect(created.body.scan_id).toBeUndefined();

    const session = getDriver().session({ database: settings.neo4j.database });
    try {
      await session.run("MATCH (s:Scan {id: $id}) DETACH DELETE s", { id: scanId });
    } finally {
      await session.close();
    }
  });

  it("gets, lists, and patches a listing", async () => {
    const componentId = await createComponent(api);
    const created = await api.post("/api/marketplace/listings").send({ component_id: componentId }).expect(201);
    const listingId = created.body.id as string;
    createdListingIds.push(listingId);

    await api.get(`/api/marketplace/listings/${listingId}`).expect(200);

    const list = await api.get(`/api/marketplace/listings?component_id=${componentId}`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(listingId);

    const patched = await api
      .patch(`/api/marketplace/listings/${listingId}`)
      .send({ title: "Cisco-branded network switch", price_estimate: 14.5 })
      .expect(200);
    expect(patched.body.title).toBe("Cisco-branded network switch");
    expect(patched.body.price_estimate).toBeCloseTo(14.5);
    // An omitted field keeps its value — PATCH is a genuine partial update.
    expect(patched.body.description).toBe(created.body.description);
  });

  it("rejects a patch body with unknown or invalid fields", async () => {
    const componentId = await createComponent(api);
    const created = await api.post("/api/marketplace/listings").send({ component_id: componentId }).expect(201);
    const listingId = created.body.id as string;
    createdListingIds.push(listingId);

    // status/provider/external_url are set by the publish flow alone; an
    // attempt to set them must fail loudly, not appear to succeed.
    await api.patch(`/api/marketplace/listings/${listingId}`).send({ status: "published" }).expect(400);
    await api.patch(`/api/marketplace/listings/${listingId}`).send({ price_estimate: -5 }).expect(400);
    await api.patch(`/api/marketplace/listings/${listingId}`).send({ currency: "dollars" }).expect(400);
    await api.patch(`/api/marketplace/listings/${listingId}`).send({}).expect(400);
  });

  it("publishes through the default manual_assist provider and returns a manual-post link", async () => {
    const componentId = await createComponent(api);
    const created = await api.post("/api/marketplace/listings").send({ component_id: componentId }).expect(201);
    const listingId = created.body.id as string;
    createdListingIds.push(listingId);

    const published = await api.post(`/api/marketplace/listings/${listingId}/publish`).expect(200);

    expect(published.body.status).toBe("ready_for_manual_post");
    expect(published.body.external_url).toContain("facebook.com");
    expect(published.body.published_at).toBeNull();
    expect(published.body.error_message).toBeNull();
  });

  it("still allows editing after a manual-post publish, since nothing was actually posted", async () => {
    const componentId = await createComponent(api);
    const created = await api.post("/api/marketplace/listings").send({ component_id: componentId }).expect(201);
    const listingId = created.body.id as string;
    createdListingIds.push(listingId);
    await api.post(`/api/marketplace/listings/${listingId}/publish`).expect(200);

    await api.patch(`/api/marketplace/listings/${listingId}`).send({ title: "Still editable" }).expect(200);
  });

  it("returns 409 when editing a listing that has actually been published", async () => {
    const componentId = await createComponent(api);
    const created = await api.post("/api/marketplace/listings").send({ component_id: componentId }).expect(201);
    const listingId = created.body.id as string;
    createdListingIds.push(listingId);

    // Forced directly, because no shipped provider reaches `published` yet —
    // manual_assist deliberately stops at ready_for_manual_post.
    const session = getDriver().session({ database: settings.neo4j.database });
    try {
      await session.run("MATCH (m:MarketplaceListing {id: $id}) SET m.status = 'published'", { id: listingId });
    } finally {
      await session.close();
    }

    const response = await api.patch(`/api/marketplace/listings/${listingId}`).send({ title: "Too late" });

    expect(response.status).toBe(409);
    expect(response.body.detail).toContain("published");
  });

  it("creates a fresh listing for a component whose previous listing was published", async () => {
    const componentId = await createComponent(api);
    const first = await api.post("/api/marketplace/listings").send({ component_id: componentId }).expect(201);
    createdListingIds.push(first.body.id as string);

    const session = getDriver().session({ database: settings.neo4j.database });
    try {
      await session.run("MATCH (m:MarketplaceListing {id: $id}) SET m.status = 'published'", {
        id: first.body.id as string,
      });
    } finally {
      await session.close();
    }

    const second = await api.post("/api/marketplace/listings").send({ component_id: componentId }).expect(201);
    createdListingIds.push(second.body.id as string);

    expect(second.body.id).not.toBe(first.body.id);

    const history = await api.get(`/api/marketplace/listings?component_id=${componentId}`).expect(200);
    expect(history.body).toHaveLength(2);
  });

  it("404s across users on create, read, list, update, and publish", async () => {
    const componentId = await createComponent(api);
    const created = await api.post("/api/marketplace/listings").send({ component_id: componentId }).expect(201);
    const listingId = created.body.id as string;
    createdListingIds.push(listingId);

    // 404 everywhere, never 403 — a probing user must not learn that someone
    // else's component or listing id is real.
    await otherApi.post("/api/marketplace/listings").send({ component_id: componentId }).expect(404);
    await otherApi.get(`/api/marketplace/listings/${listingId}`).expect(404);
    await otherApi.get(`/api/marketplace/listings?component_id=${componentId}`).expect(404);
    await otherApi.patch(`/api/marketplace/listings/${listingId}`).send({ title: "mine now" }).expect(404);
    await otherApi.post(`/api/marketplace/listings/${listingId}/publish`).expect(404);

    // And the listing is untouched by any of it.
    const after = await api.get(`/api/marketplace/listings/${listingId}`).expect(200);
    expect(after.body.status).toBe("draft");
    expect(after.body.title).toBe(created.body.title);
  });

  it("404s for a component or listing that does not exist at all", async () => {
    await api.post("/api/marketplace/listings").send({ component_id: "does-not-exist" }).expect(404);
    await api.get("/api/marketplace/listings/does-not-exist").expect(404);
    await api.get("/api/marketplace/listings?component_id=does-not-exist").expect(404);
    await api.post("/api/marketplace/listings/does-not-exist/publish").expect(404);
  });

  it("400s on a malformed create body", async () => {
    await api.post("/api/marketplace/listings").send({}).expect(400);
    await api.post("/api/marketplace/listings").send({ component_id: "" }).expect(400);
    await api.get("/api/marketplace/listings").expect(400);
  });
});
