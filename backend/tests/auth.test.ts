/**
 * Authentication and scan-image ownership.
 *
 * Real Express app, real Neo4j, real bcrypt/JWT — the security primitives are
 * never mocked, because their properties only mean anything end-to-end.
 *
 * The one external dependency that IS mocked is the Python ML service
 * (`mlServiceClient`): it is not a security primitive, and the scan-image
 * tests only need the upload endpoint to *succeed* so image persistence and
 * ownership can be checked. Detection behaviour itself is covered by
 * `scanUpload.test.ts`. Without this mock the suite would depend on a
 * separate service running on port 8001. Accounts created are tracked and
 * deleted in `afterAll`.
 */

import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/mlServiceClient.js", () => ({
  mlServiceClient: {
    detectComponents: vi.fn(),
    searchKnowledge: vi.fn(),
    checkHealth: vi.fn(),
  },
}));

import { mlServiceClient } from "../src/services/mlServiceClient.js";
import { deleteTestUsers, registerAndLogin } from "./helpers/authAgent.js";
import { connectForTests } from "./helpers/testNeo4j.js";

const { reachable } = await connectForTests();

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082",
  "hex",
);

describe.skipIf(!reachable)("auth + scan image ownership", () => {
  let app: Express;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const { createApp } = await import("../src/index.js");
    app = createApp();
  });

  afterAll(async () => {
    await deleteTestUsers(createdUserIds.splice(0));
  });

  async function newUser() {
    const authed = await registerAndLogin(app);
    createdUserIds.push(authed.userId);
    return authed;
  }

  describe("registration and login", () => {
    it("registers, returns the user without its password hash, and sets an httpOnly cookie", async () => {
      const email = `auth-test-${Date.now()}@example.test`;
      const response = await request(app)
        .post("/api/auth/register")
        .send({ email, password: "test-password-123" });

      expect(response.status).toBe(201);
      expect(response.body.email).toBe(email);
      expect(response.body.passwordHash).toBeUndefined();
      expect(response.body.password).toBeUndefined();
      createdUserIds.push(response.body.id as string);

      const cookie = response.headers["set-cookie"]?.[0] ?? "";
      expect(cookie).toContain("circuitloop_session=");
      expect(cookie).toContain("HttpOnly");
    });

    it("rejects a duplicate email with 409", async () => {
      const { email } = await newUser();
      const response = await request(app)
        .post("/api/auth/register")
        .send({ email, password: "another-password-123" });

      expect(response.status).toBe(409);
    });

    it("rejects a weak password and a malformed email with 400", async () => {
      await expect(
        request(app).post("/api/auth/register").send({ email: "a@b.test", password: "short" }).then((r) => r.status),
      ).resolves.toBe(400);
      await expect(
        request(app).post("/api/auth/register").send({ email: "nope", password: "test-password-123" }).then((r) => r.status),
      ).resolves.toBe(400);
    });

    it("gives the same 401 for a wrong password and an unknown account", async () => {
      const { email } = await newUser();

      const wrongPassword = await request(app)
        .post("/api/auth/login")
        .send({ email, password: "definitely-not-the-password" });
      const unknownAccount = await request(app)
        .post("/api/auth/login")
        .send({ email: `missing-${Date.now()}@example.test`, password: "test-password-123" });

      // Identical responses — a different message or status would let an
      // attacker enumerate which emails are registered.
      expect(wrongPassword.status).toBe(401);
      expect(unknownAccount.status).toBe(401);
      expect(wrongPassword.body.detail).toBe(unknownAccount.body.detail);
    });
  });

  describe("route protection", () => {
    it("rejects unauthenticated access to every data route with 401", async () => {
      for (const path of ["/api/scans", "/api/components", "/api/dashboard/stats"]) {
        const response = await request(app).get(path);
        expect(response.status, `${path} must require auth`).toBe(401);
      }
    });

    it("leaves health public", async () => {
      await expect(request(app).get("/api/health").then((r) => r.status)).resolves.toBe(200);
    });

    it("rejects a forged session cookie", async () => {
      const response = await request(app)
        .get("/api/scans")
        .set("Cookie", "circuitloop_session=not.a.real.jwt");

      expect(response.status).toBe(401);
    });

    it("logs out so the session no longer works", async () => {
      const { agent } = await newUser();
      await expect(agent.get("/api/scans").then((r) => r.status)).resolves.toBe(200);

      await agent.post("/api/auth/logout").expect(204);
      await expect(agent.get("/api/scans").then((r) => r.status)).resolves.toBe(401);
    });
  });

  describe("scan image persistence and ownership", () => {
    beforeEach(() => {
      // The image-persistence path runs after detection; an empty detection
      // result is enough to reach it deterministically.
      vi.mocked(mlServiceClient.detectComponents).mockResolvedValue({ detections: [] });
    });

    it("stores the uploaded image and serves it back to its owner", async () => {
      const { agent } = await newUser();

      const scan = await agent.post("/api/scans").send({}).expect(201);
      expect(scan.body.image_url).toBeNull();

      await agent
        .post(`/api/scans/${scan.body.id}/upload`)
        .attach("image", PNG_1X1, { filename: "board.png", contentType: "image/png" });

      const afterUpload = await agent.get(`/api/scans/${scan.body.id}`).expect(200);
      expect(afterUpload.body.image_url).toBe(`/api/scans/${scan.body.id}/image`);

      const image = await agent.get(`/api/scans/${scan.body.id}/image`).expect(200);
      expect(image.headers["content-type"]).toContain("image/png");
      expect(Buffer.from(image.body).equals(PNG_1X1)).toBe(true);
    });

    it("never exposes a filesystem path to the client", async () => {
      const { agent } = await newUser();
      const scan = await agent.post("/api/scans").send({}).expect(201);
      await agent
        .post(`/api/scans/${scan.body.id}/upload`)
        .attach("image", PNG_1X1, { filename: "board.png", contentType: "image/png" });

      const body = await agent.get(`/api/scans/${scan.body.id}`).expect(200);
      expect(JSON.stringify(body.body)).not.toContain("uploads");
      expect(body.body.image_path).toBeUndefined();
    });

    it("does not let another user read the image, and hides the scan's existence", async () => {
      const owner = await newUser();
      const other = await newUser();

      const scan = await owner.agent.post("/api/scans").send({}).expect(201);
      await owner.agent
        .post(`/api/scans/${scan.body.id}/upload`)
        .attach("image", PNG_1X1, { filename: "board.png", contentType: "image/png" });

      // 404 rather than 403: a 403 would confirm the id is real and let a user
      // enumerate other people's scans.
      await expect(
        other.agent.get(`/api/scans/${scan.body.id}/image`).then((r) => r.status),
      ).resolves.toBe(404);
      await expect(
        other.agent.get(`/api/scans/${scan.body.id}`).then((r) => r.status),
      ).resolves.toBe(404);
    });

    it("scopes scan history to its owner", async () => {
      const owner = await newUser();
      const other = await newUser();

      const scan = await owner.agent.post("/api/scans").send({}).expect(201);

      const ownerHistory = await owner.agent.get("/api/scans").expect(200);
      const otherHistory = await other.agent.get("/api/scans").expect(200);

      expect(ownerHistory.body.some((s: { id: string }) => s.id === scan.body.id)).toBe(true);
      expect(otherHistory.body.some((s: { id: string }) => s.id === scan.body.id)).toBe(false);
    });
  });
});
