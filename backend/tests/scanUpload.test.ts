/**
 * POST /api/scans/:id/upload — real Express app, real Neo4j, but
 * `mlServiceClient` mocked (vi.mock), so this suite doesn't need the real
 * Python service running — matching the same design principle as the rest
 * of the TS test suite. See tests/mlServiceClient.test.ts (Phase 3) for the
 * client's own tests, and the Phase 4 report for live, real-Python
 * verification of this endpoint.
 */

import type { Express } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/mlServiceClient.js", () => ({
  mlServiceClient: {
    detectComponents: vi.fn(),
    searchKnowledge: vi.fn(),
    checkHealth: vi.fn(),
  },
}));

import { settings } from "../src/config/env.js";
import { closeDriver, getDriver } from "../src/db/neo4jDriver.js";
import * as componentRepository from "../src/repositories/componentRepository.js";
import { mlServiceClient } from "../src/services/mlServiceClient.js";
import { UpstreamServiceError } from "../src/utils/errors.js";
import { deleteScanImages, deleteTestUsers, registerAndLogin } from "./helpers/authAgent.js";
import { connectForTests } from "./helpers/testNeo4j.js";

const { reachable } = await connectForTests();
const mockDetect = vi.mocked(mlServiceClient.detectComponents);

describe.skipIf(!reachable)("POST /api/scans/:id/upload (integration, ml-service mocked)", () => {
  let app: Express;
  /** Authenticated agent — every data route sits behind requireAuth. */
  let api: Awaited<ReturnType<typeof registerAndLogin>>["agent"];
  const createdUserIds: string[] = [];
  const createdScanIds: string[] = [];
  const createdComponentIds: string[] = [];

  beforeAll(async () => {
    const { createApp } = await import("../src/index.js");
    app = createApp();
    const authed = await registerAndLogin(app);
    api = authed.agent;
    createdUserIds.push(authed.userId);
  });

  beforeEach(() => {
    mockDetect.mockReset();
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

  async function createScan(): Promise<string> {
    const response = await api.post("/api/scans").send({});
    createdScanIds.push(response.body.id);
    return response.body.id as string;
  }

  it("persists detections through the existing createDetectionBatch path, mapping class_name losslessly", async () => {
    const scanId = await createScan();
    mockDetect.mockResolvedValueOnce({
      detections: [
        { class_name: "relay", confidence: 0.91, bbox: { x1: 1, y1: 2, x2: 3, y2: 4 }, text: "K1" },
        { class_name: "battery", confidence: 0.5, bbox: { x1: 5, y1: 6, x2: 7, y2: 8 }, text: "" },
      ],
    });

    const response = await api
      .post(`/api/scans/${scanId}/upload`)
      .attach("image", Buffer.from([0, 1, 2, 3]), { filename: "board.png", contentType: "image/png" });

    expect(response.status).toBe(201);
    expect(response.body).toHaveLength(2);
    const types = (response.body as { type: string }[]).map((c) => c.type).sort();
    expect(types).toEqual(["battery", "relay"]);
    expect(types).not.toContain("unknown");

    const relay = (response.body as { type: string; name: string | null; scan_id: string; id: string }[]).find(
      (c) => c.type === "relay",
    );
    expect(relay?.name).toBe("K1"); // OCR text became the component's name
    expect(relay?.scan_id).toBe(scanId);

    for (const c of response.body as { id: string }[]) {
      createdComponentIds.push(c.id);
    }

    expect(mockDetect).toHaveBeenCalledTimes(1);
    const call = mockDetect.mock.calls[0];
    expect(call?.[0].filename).toBe("board.png");
    expect(call?.[0].contentType).toBe("image/png");
  });

  it("returns 400 when no image field is provided", async () => {
    const scanId = await createScan();
    const response = await api.post(`/api/scans/${scanId}/upload`).field("confidence", "0.5");
    expect(response.status).toBe(400);
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it("returns 400 for an out-of-range confidence value", async () => {
    const scanId = await createScan();
    const response = await api
      .post(`/api/scans/${scanId}/upload`)
      .field("confidence", "1.5")
      .attach("image", Buffer.from([0]), { filename: "x.png", contentType: "image/png" });
    expect(response.status).toBe(400);
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it("rejects a non-image file via multer's fileFilter with 400, before ever calling ml-service", async () => {
    const scanId = await createScan();
    const response = await api
      .post(`/api/scans/${scanId}/upload`)
      .attach("image", Buffer.from("not an image"), { filename: "x.txt", contentType: "text/plain" });
    expect(response.status).toBe(400);
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it("returns 201 with an empty array when the scan exists but nothing is detected (not a 404)", async () => {
    const scanId = await createScan();
    mockDetect.mockResolvedValueOnce({ detections: [] });
    const response = await api
      .post(`/api/scans/${scanId}/upload`)
      .attach("image", Buffer.from([0]), { filename: "x.png", contentType: "image/png" });
    expect(response.status).toBe(201);
    expect(response.body).toEqual([]);
  });

  it("returns 404 when the scan doesn't exist AND nothing is detected (the empty-array ambiguity, resolved)", async () => {
    mockDetect.mockResolvedValueOnce({ detections: [] });
    const response = await api
      .post("/api/scans/does-not-exist/upload")
      .attach("image", Buffer.from([0]), { filename: "x.png", contentType: "image/png" });
    expect(response.status).toBe(404);
  });

  it("returns 404 when the scan doesn't exist (non-empty detections)", async () => {
    mockDetect.mockResolvedValueOnce({
      detections: [{ class_name: "resistor", confidence: 0.9, bbox: { x1: 0, y1: 0, x2: 1, y2: 1 }, text: "" }],
    });
    const response = await api
      .post("/api/scans/does-not-exist/upload")
      .attach("image", Buffer.from([0]), { filename: "x.png", contentType: "image/png" });
    expect(response.status).toBe(404);
  });

  it("translates an ml-service invalid_image upstream error into 400, not a generic 502", async () => {
    const scanId = await createScan();
    mockDetect.mockRejectedValueOnce(
      new UpstreamServiceError(
        502,
        "ML service returned an error (HTTP 400): invalid_image — Could not decode image bytes",
        "invalid_image",
        "Could not decode image bytes",
      ),
    );
    const response = await api
      .post(`/api/scans/${scanId}/upload`)
      .attach("image", Buffer.from([0]), { filename: "x.png", contentType: "image/png" });
    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/Could not decode image bytes/);
  });

  it("preserves a genuine upstream failure (service unavailable) as 503, not 400", async () => {
    const scanId = await createScan();
    mockDetect.mockRejectedValueOnce(new UpstreamServiceError(503, "ML service unreachable"));
    const response = await api
      .post(`/api/scans/${scanId}/upload`)
      .attach("image", Buffer.from([0]), { filename: "x.png", contentType: "image/png" });
    expect(response.status).toBe(503);
  });
});
