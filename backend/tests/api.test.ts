/**
 * End-to-end API tests: real Express app (`createApp()`), real Neo4j — no
 * mocking. Unlike the repository tests, these go through the production
 * write path (no injectable test transaction reaches through HTTP), so
 * every record this file creates is tracked by id and explicitly deleted
 * in `afterEach` — the "identifiable test records + cleanup" strategy
 * BACKEND_IMPLEMENTATION_PLAN.md §18 allows as the fallback to transaction
 * rollback. Skips gracefully if Neo4j isn't reachable.
 */

import type { Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { settings } from "../src/config/env.js";
import { closeDriver, getDriver } from "../src/db/neo4jDriver.js";
import * as componentRepository from "../src/repositories/componentRepository.js";
import { deleteScanImages, deleteTestUsers, registerAndLogin } from "./helpers/authAgent.js";
import { connectForTests } from "./helpers/testNeo4j.js";

const { reachable } = await connectForTests();

describe.skipIf(!reachable)("API (integration)", () => {
  let app: Express;
  /** Authenticated agent — every data route sits behind requireAuth. */
  let api: Awaited<ReturnType<typeof registerAndLogin>>["agent"];
  const createdUserIds: string[] = [];
  const createdComponentIds: string[] = [];
  const createdScanIds: string[] = [];

  beforeAll(async () => {
    const { createApp } = await import("../src/index.js");
    app = createApp();
    const authed = await registerAndLogin(app);
    api = authed.agent;
    createdUserIds.push(authed.userId);
  });

  afterEach(async () => {
    for (const id of createdComponentIds.splice(0)) {
      await componentRepository.deleteComponent(id).catch(() => undefined);
    }
    if (createdScanIds.length > 0) {
      const session = getDriver().session({ database: settings.neo4j.database });
      try {
        const scanIds = createdScanIds.splice(0);
        await session.run("MATCH (s:Scan) WHERE s.id IN $ids DETACH DELETE s", { ids: scanIds });
        await deleteScanImages(scanIds);
      } finally {
        await session.close();
      }
    }
  });

  afterAll(async () => {

    await deleteTestUsers(createdUserIds.splice(0));
    await closeDriver();
  });

  describe("GET /api/health", () => {
    it("returns 200 ok", async () => {
      const response = await api.get("/api/health");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: "ok", service: "CircuitLoop Backend" });
    });
  });

  describe("scans", () => {
    it("creates, lists, and retrieves a scan", async () => {
      const create = await api.post("/api/scans").send({});
      expect(create.status).toBe(201);
      expect(typeof create.body.id).toBe("string");
      // A freshly created scan has no image until one is uploaded to
      // /:id/upload. `image_path` is deliberately no longer part of the
      // response or settable by the client — the API exposes `image_url`
      // onto the ownership-checked image endpoint instead of any stored path.
      expect(create.body.image_url).toBeNull();
      expect(create.body.image_path).toBeUndefined();
      expect(create.body.total_components).toBe(0);
      expect(create.body.components).toEqual([]);
      createdScanIds.push(create.body.id);

      const list = await api.get("/api/scans");
      expect(list.status).toBe(200);
      expect(list.body.some((scan: { id: string }) => scan.id === create.body.id)).toBe(true);

      const get = await api.get(`/api/scans/${create.body.id}`);
      expect(get.status).toBe(200);
      expect(get.body.id).toBe(create.body.id);
    });

    it("rejects an invalid scan body with 400 {detail}", async () => {
      const response = await api.post("/api/scans").send({ image_path: 123 });
      expect(response.status).toBe(400);
      expect(typeof response.body.detail).toBe("string");
    });

    it("returns 404 {detail} for an unknown scan id", async () => {
      const response = await api.get("/api/scans/does-not-exist");
      expect(response.status).toBe(404);
      expect(response.body.detail).toMatch(/Scan not found/);
    });
  });

  describe("components", () => {
    it("creates a standalone component with default condition and not_tested status", async () => {
      const response = await api
        .post("/api/components")
        .send({ type: "resistor", name: "R1", confidence: 0.9 });
      expect(response.status).toBe(201);
      createdComponentIds.push(response.body.id);

      expect(response.body.scan_id).toBeNull();
      expect(response.body.condition).toBe("unknown");
      expect(response.body.status).toBe("not_tested");
      expect(response.body.test_results).toEqual([]);
    });

    it("rejects confidence outside [0,1] with 400", async () => {
      const response = await api
        .post("/api/components")
        .send({ type: "resistor", confidence: 1.5 });
      expect(response.status).toBe(400);
    });

    it("returns 404 when creating a component with a scan_id that doesn't exist", async () => {
      const response = await api
        .post("/api/components")
        .send({ type: "resistor", confidence: 0.5, scan_id: "does-not-exist" });
      expect(response.status).toBe(404);
      expect(response.body.detail).toMatch(/Scan not found/);
    });

    it("lists components and supports filtering by type", async () => {
      const created = await api.post("/api/components").send({ type: "led", confidence: 0.7 });
      createdComponentIds.push(created.body.id);

      const filtered = await api.get("/api/components").query({ type: "led" });
      expect(filtered.status).toBe(200);
      expect(filtered.body.every((c: { type: string }) => c.type === "led")).toBe(true);
      expect(filtered.body.some((c: { id: string }) => c.id === created.body.id)).toBe(true);
    });

    it("gets, updates, and deletes a component", async () => {
      const created = await api
        .post("/api/components")
        .send({ type: "capacitor", confidence: 0.6 });
      const id = created.body.id as string;

      const get = await api.get(`/api/components/${id}`);
      expect(get.status).toBe(200);

      const updated = await api
        .put(`/api/components/${id}`)
        .send({ type: "capacitor", confidence: 0.6, condition: "good", salvage_priority: "high" });
      expect(updated.status).toBe(200);
      expect(updated.body.condition).toBe("good");
      expect(updated.body.salvage_priority).toBe("high");

      const deleted = await api.delete(`/api/components/${id}`);
      expect(deleted.status).toBe(204);

      const getAfterDelete = await api.get(`/api/components/${id}`);
      expect(getAfterDelete.status).toBe(404);
    });

    it("returns 404 {detail} for update/delete/get on an unknown component", async () => {
      const get = await api.get("/api/components/does-not-exist");
      expect(get.status).toBe(404);

      const put = await api
        .put("/api/components/does-not-exist")
        .send({ type: "resistor", confidence: 0.5 });
      expect(put.status).toBe(404);

      const del = await api.delete("/api/components/does-not-exist");
      expect(del.status).toBe(404);
    });
  });

  describe("detections", () => {
    it("creates a batch of components DETECTED by a scan", async () => {
      const scan = await api.post("/api/scans").send({});
      createdScanIds.push(scan.body.id);

      const response = await api
        .post("/api/detections")
        .send({
          scan_id: scan.body.id,
          detections: [
            { type: "resistor", name: "R1", confidence: 0.94, bbox: { x1: 120, y1: 80, x2: 180, y2: 130 } },
          ],
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].scan_id).toBe(scan.body.id);
      createdComponentIds.push(response.body[0].id);

      const scanDetail = await api.get(`/api/scans/${scan.body.id}`);
      expect(scanDetail.body.total_components).toBe(1);
    });

    it("accepts every newly-added ComponentType (battery/buzzer/display/relay/switch) end-to-end, none coerced to unknown", async () => {
      // Verifies the ComponentType domain extension through the full HTTP
      // stack: validation (Zod) → controller → service → repository →
      // Neo4j → response. See ML_SERVICE_INTEGRATION_PLAN.md.
      const scan = await api.post("/api/scans").send({});
      createdScanIds.push(scan.body.id);

      const newTypes = ["battery", "buzzer", "display", "relay", "switch"] as const;
      const response = await api
        .post("/api/detections")
        .send({
          scan_id: scan.body.id,
          detections: newTypes.map((type, i) => ({
            type,
            confidence: 0.9,
            bbox: { x1: i, y1: i, x2: i + 10, y2: i + 10 },
          })),
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveLength(newTypes.length);
      const returnedTypes = response.body.map((c: { type: string }) => c.type);
      expect(returnedTypes.sort()).toEqual([...newTypes].sort());
      expect(returnedTypes).not.toContain("unknown");
      for (const c of response.body as { id: string }[]) {
        createdComponentIds.push(c.id);
      }
    });

    it("rejects an empty detections array with 400", async () => {
      const response = await api.post("/api/detections").send({ scan_id: "irrelevant", detections: [] });
      expect(response.status).toBe(400);
    });

    it("returns 404 when scan_id doesn't exist", async () => {
      const response = await api
        .post("/api/detections")
        .send({
          scan_id: "does-not-exist",
          detections: [{ type: "resistor", confidence: 0.9, bbox: { x1: 0, y1: 0, x2: 1, y2: 1 } }],
        });
      expect(response.status).toBe(404);
    });
  });

  describe("test results", () => {
    async function createComponent(): Promise<string> {
      const response = await api.post("/api/components").send({ type: "ic", confidence: 0.95 });
      createdComponentIds.push(response.body.id);
      return response.body.id as string;
    }

    it("records a passing test result and updates the component's status", async () => {
      const id = await createComponent();

      const created = await api
        .post(`/api/components/${id}/test`)
        .send({ expected_value: 5, measured_value: 4.9, unit: "V", status: "pass" });
      expect(created.status).toBe(201);
      expect(created.body.component_id).toBe(id);

      const component = await api.get(`/api/components/${id}`);
      expect(component.body.status).toBe("pass");
    });

    it("rejects a pass/fail result missing measured_value with 400", async () => {
      const id = await createComponent();
      const response = await api.post(`/api/components/${id}/test`).send({ status: "pass" });
      expect(response.status).toBe(400);
    });

    it("returns 404 when recording a test for an unknown component", async () => {
      const response = await api
        .post("/api/components/does-not-exist/test")
        .send({ status: "not_tested" });
      expect(response.status).toBe(404);
    });

    it("GET .../test-result returns 404 when the component exists but has no test yet", async () => {
      const id = await createComponent();
      const response = await api.get(`/api/components/${id}/test-result`);
      expect(response.status).toBe(404);
      expect(response.body.detail).toMatch(/TestResult not found/);
    });

    it("GET .../test-result returns 404 when the component itself doesn't exist", async () => {
      const response = await api.get("/api/components/does-not-exist/test-result");
      expect(response.status).toBe(404);
      expect(response.body.detail).toMatch(/Component not found/);
    });

    it("GET .../tests returns the full history, empty array if none yet", async () => {
      const id = await createComponent();
      const empty = await api.get(`/api/components/${id}/tests`);
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual([]);

      await api.post(`/api/components/${id}/test`).send({ status: "not_tested" });
      await api
        .post(`/api/components/${id}/test`)
        .send({ measured_value: 1, status: "pass" });

      const history = await api.get(`/api/components/${id}/tests`);
      expect(history.status).toBe(200);
      expect(history.body).toHaveLength(2);
    });
  });

  describe("dashboard", () => {
    it("returns aggregate stats with the expected shape", async () => {
      const response = await api.get("/api/dashboard/stats");
      expect(response.status).toBe(200);
      for (const key of [
        "total_scans",
        "total_components",
        "tested_components",
        "passed_components",
        "failed_components",
        "not_tested_components",
        "average_ai_confidence",
      ]) {
        expect(response.body).toHaveProperty(key);
      }
    });
  });

  describe("unknown routes", () => {
    it("returns 404 {detail} for a route that doesn't exist", async () => {
      const response = await api.get("/api/nope");
      expect(response.status).toBe(404);
      expect(typeof response.body.detail).toBe("string");
    });
  });
});
