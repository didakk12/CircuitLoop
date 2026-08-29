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
import { mlServiceClient } from "../src/services/mlServiceClient.js";
import { UpstreamServiceError } from "../src/utils/errors.js";
import { deleteComponentsById, deleteScanImages, deleteTestUsers, registerAndLogin } from "./helpers/authAgent.js";
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
    await deleteComponentsById(createdComponentIds.splice(0));
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

  it("keeps the detected label, the normalised type and the printed marking as three distinct fields", async () => {
    // The Cisco case, end to end through Neo4j. These three values must not
    // collapse into each other: the UI shows `label ?? type` as the identity
    // and `name` as markings, so if `name` ever stood in for the identity the
    // component would display as "CISCO SG300-52 …" instead of a switch.
    const scanId = await createScan();
    mockDetect.mockResolvedValueOnce({
      detections: [
        {
          class_name: "network switch",
          confidence: 0.99,
          bbox: { x1: 10, y1: 20, x2: 600, y2: 300 },
          text: "CISCO SG300-52 52-Port Gigabit Managed Switch",
        },
      ],
      source: "gemini",
    });

    const response = await api
      .post(`/api/scans/${scanId}/upload`)
      .attach("image", Buffer.from([0, 1, 2, 3]), { filename: "switch.jpg", contentType: "image/jpeg" });

    expect(response.status).toBe(201);
    const [component] = response.body as { id: string; type: string; label: string; name: string }[];

    expect(component?.label).toBe("network switch"); // what it IS — the display identity
    expect(component?.type).toBe("switch"); // the queryable ComponentType
    expect(component?.name).toBe("CISCO SG300-52 52-Port Gigabit Managed Switch"); // the marking
    // The marking is never promoted into either identity field.
    expect(component?.label).not.toBe(component?.name);
    expect(component?.type).not.toBe(component?.name);

    createdComponentIds.push(component!.id);

    // And it survives a re-read, not just the create response.
    const reread = await api.get(`/api/components/${component!.id}`);
    expect(reread.status).toBe(200);
    expect(reread.body).toMatchObject({
      label: "network switch",
      type: "switch",
      name: "CISCO SG300-52 52-Port Gigabit Managed Switch",
    });
  });

  it("preserves an open-vocabulary label that has no ComponentType, alongside its marking", async () => {
    const scanId = await createScan();
    mockDetect.mockResolvedValueOnce({
      detections: [
        {
          class_name: "potentiometer",
          confidence: 0.9,
          bbox: { x1: 1, y1: 2, x2: 3, y2: 4 },
          text: "B10K BOURNS",
        },
      ],
      source: "gemini",
    });

    const response = await api
      .post(`/api/scans/${scanId}/upload`)
      .attach("image", Buffer.from([0, 1, 2, 3]), { filename: "pot.jpg", contentType: "image/jpeg" });

    expect(response.status).toBe(201);
    const [component] = response.body as { id: string; type: string; label: string; name: string }[];

    // The type is lossy here; the label is where the real answer survives, and
    // it is what the user sees.
    expect(component?.label).toBe("potentiometer");
    expect(component?.type).toBe("unknown");
    expect(component?.name).toBe("B10K BOURNS");

    createdComponentIds.push(component!.id);
  });

  it("persists an open-vocabulary Gemini label as the 'unknown' type without dropping the detection", async () => {
    // Gemini's detection vocabulary is not restricted to ComponentType, so it
    // legitimately returns labels this schema cannot store as a type. Storing
    // them as 'unknown' is the mapping's limit; losing the component is not
    // acceptable, and neither is refusing the upload.
    const scanId = await createScan();
    mockDetect.mockResolvedValueOnce({
      detections: [
        { class_name: "potentiometer", confidence: 0.88, bbox: { x1: 1, y1: 2, x2: 3, y2: 4 }, text: "B10K" },
        { class_name: "switch", confidence: 0.8, bbox: { x1: 5, y1: 6, x2: 7, y2: 8 }, text: "" },
      ],
      source: "gemini",
    });

    const response = await api
      .post(`/api/scans/${scanId}/upload`)
      .attach("image", Buffer.from([0, 1, 2, 3]), { filename: "board.png", contentType: "image/png" });

    expect(response.status).toBe(201);
    const components = response.body as { id: string; type: string; name: string | null }[];
    expect(components).toHaveLength(2);
    expect(components.map((c) => c.type).sort()).toEqual(["switch", "unknown"]);
    // The potentiometer is stored, with its OCR marking, rather than discarded.
    expect(components.find((c) => c.type === "unknown")?.name).toBe("B10K");

    for (const c of components) {
      createdComponentIds.push(c.id);
    }
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
