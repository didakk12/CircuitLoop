/**
 * HTTP-level tests for `/api/hardware`.
 *
 * Split into two halves on purpose:
 *
 *  - The authorization block needs no database at all. `requireAuth` rejects
 *    a request with no session cookie before it ever looks a user up, so
 *    these run everywhere and guarantee the new routes actually sit behind
 *    the gate — the failure mode that silently exposes an endpoint.
 *  - The behavioural block drives the real state machine through a
 *    `MockSerialAdapter` over real HTTP, and needs Neo4j for the session and
 *    for the `(:Command)` writes, so it skips gracefully without one.
 */

import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { settings } from "../src/config/env.js";
import { closeDriver, getDriver } from "../src/db/neo4jDriver.js";
import { HARDWARE_CHANGE_EVENT, hardwareEvents } from "../src/services/hardwareEvents.js";
import * as hardwareService from "../src/services/hardwareService.js";
import { getCurrentState } from "../src/services/hardwareState.js";
import { MockSerialAdapter } from "../src/services/serial/MockSerialAdapter.js";
import { deleteTestUsers } from "./helpers/authAgent.js";
import { connectForTests } from "./helpers/testNeo4j.js";

const { reachable } = await connectForTests();

const PROBE_ACTION = "I2C_PROBE:0x27";

const fastConfig = {
  enabled: true,
  portOverride: undefined,
  baudRate: 115200,
  pollIntervalMs: 5,
  ackTimeoutMs: 150,
  reconnectDelayMs: 60_000,
  defaultAction: PROBE_ACTION,
  heartbeatIntervalMs: 1_000_000,
};

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for condition. Current state: ${getCurrentState()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------

describe("hardware routes — authorization (no database required)", () => {
  let app: Express;

  beforeAll(async () => {
    const { createApp } = await import("../src/index.js");
    app = createApp();
  });

  it("rejects GET /api/hardware/status without a session", async () => {
    const response = await request(app).get("/api/hardware/status");
    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty("detail");
  });

  it("rejects GET /api/hardware/stream without a session", async () => {
    const response = await request(app).get("/api/hardware/stream");
    expect(response.status).toBe(401);
  });

  it("rejects POST /api/hardware/action without a session", async () => {
    const response = await request(app).post("/api/hardware/action").send({ action: "LCD_SCAN" });
    expect(response.status).toBe(401);
  });

  it("does not leak hardware status through the unauthenticated 401 body", async () => {
    const response = await request(app).get("/api/hardware/status");
    expect(response.body).not.toHaveProperty("state");
    expect(response.body).not.toHaveProperty("port_path");
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(!reachable)("hardware routes — behaviour (integration)", () => {
  let server: Server;
  let baseUrl: string;
  let cookie: string;
  const createdUserIds: string[] = [];
  /** Gateway commands are standalone nodes with no owner, so they need their own cleanup. */
  let startedAt: string;

  /** Reads the session cookie out of a register/login response, across Node's two header APIs. */
  function readSessionCookie(response: Response): string {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    const raw = values.length > 0 ? values : [response.headers.get("set-cookie") ?? ""];
    return raw
      .map((value) => value.split(";")[0] ?? "")
      .filter((value) => value.length > 0)
      .join("; ");
  }

  beforeAll(async () => {
    startedAt = new Date().toISOString();
    const { createApp } = await import("../src/index.js");
    const app = createApp();
    // A real listening socket, because the SSE test needs a streaming body
    // that supertest's buffered response cannot give.
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const email = `hardware-route-test-${Date.now()}@example.test`;
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "test-password-123" }),
    });
    expect(response.status).toBe(201);
    cookie = readSessionCookie(response);
    createdUserIds.push(((await response.json()) as { id: string }).id);
  });

  afterEach(async () => {
    await hardwareService.stop();
  });

  afterAll(async () => {
    await hardwareService.stop();
    await new Promise((resolve) => server.close(resolve));

    // Gateway probes carry no owner, so deleteTestUsers cannot reach them.
    const session = getDriver().session({ database: settings.neo4j.database });
    try {
      await session.run(
        `MATCH (cmd:Command)
         WHERE cmd.componentId IS NULL AND cmd.sentAt >= datetime($since)
         DETACH DELETE cmd`,
        { since: startedAt },
      );
    } finally {
      await session.close();
    }

    await deleteTestUsers(createdUserIds.splice(0));
    await closeDriver();
  });

  function get(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { cookie } });
  }

  function postAction(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/hardware/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify(body),
    });
  }

  describe("GET /api/hardware/status", () => {
    it("returns 200 with the full status shape even when nothing is connected", async () => {
      await hardwareService.start({
        adapter: new MockSerialAdapter({ ports: [{ path: "COM3" }] }),
        config: fastConfig,
      });

      const response = await get("/api/hardware/status");
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      // Never a 404: "no board" is a describable state, not a missing resource.
      expect(body["state"]).toBe("scanning");
      expect(body["connected"]).toBe(false);
      expect(body).toHaveProperty("port_path");
      expect(body).toHaveProperty("last_ack_at");
      expect(body).toHaveProperty("last_error");
      expect(body).toHaveProperty("last_command");
    });

    it("reports connected once the board has acknowledged", async () => {
      await hardwareService.start({
        adapter: new MockSerialAdapter({ autoRespond: () => "ACK" }),
        config: fastConfig,
      });

      const body = (await (await get("/api/hardware/status")).json()) as Record<string, unknown>;
      expect(body["state"]).toBe("connected");
      expect(body["connected"]).toBe(true);
      expect(body["port_path"]).toBe("COM_TEST");
    });
  });

  describe("POST /api/hardware/action", () => {
    it("returns 503 when hardware support is disabled", async () => {
      await hardwareService.start({
        adapter: new MockSerialAdapter(),
        config: { ...fastConfig, enabled: false },
      });

      const response = await postAction({ action: "LCD_SCAN" });
      expect(response.status).toBe(503);
      expect((await response.json()) as { detail: string }).toHaveProperty("detail");
    });

    it("returns the resolved command on a successful ACK", async () => {
      await hardwareService.start({
        adapter: new MockSerialAdapter({ autoRespond: () => "ACK" }),
        config: fastConfig,
      });

      const response = await postAction({ action: "LCD_SCAN" });
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body["action"]).toBe("LCD_SCAN");
      expect(body["status"]).toBe("success");
      expect(body["ack_received"]).toBe(true);
      expect(body["component_id"]).toBeNull();
      expect(body["resolved_at"]).not.toBeNull();
    });

    it("returns 409 for a second action while one is already in flight", async () => {
      const adapter = new MockSerialAdapter({
        autoRespond: (written) => (written.startsWith("I2C_PROBE") ? "ACK" : null),
      });
      await hardwareService.start({ adapter, config: fastConfig });
      await waitFor(() => getCurrentState() === "connected");

      const first = postAction({ action: "COMPONENT_TEST" });
      await waitFor(() => getCurrentState() === "probing");

      const second = await postAction({ action: "LCD_SCAN" });
      expect(second.status).toBe(409);

      // The refused request never reached the wire; the first still ran to
      // its own (timed-out) conclusion.
      expect((await first).status).toBe(503);
      expect(adapter.written).toEqual([`${PROBE_ACTION}\n`, "COMPONENT_TEST\n"]);
    });

    it("returns 400 for an empty action", async () => {
      await hardwareService.start({
        adapter: new MockSerialAdapter({ autoRespond: () => "ACK" }),
        config: fastConfig,
      });
      const response = await postAction({ action: "   " });
      expect(response.status).toBe(400);
    });

    it("returns 400 for an action carrying an embedded newline", async () => {
      await hardwareService.start({
        adapter: new MockSerialAdapter({ autoRespond: () => "ACK" }),
        config: fastConfig,
      });
      // Would otherwise put a second, uncorrelated command on the wire.
      const response = await postAction({ action: "LCD_SCAN\nRELAY_TOGGLE:1" });
      expect(response.status).toBe(400);
    });

    it("returns 404 for a component the caller does not own", async () => {
      await hardwareService.start({
        adapter: new MockSerialAdapter({ autoRespond: () => "ACK" }),
        config: fastConfig,
      });
      const response = await postAction({ action: "COMPONENT_TEST", component_id: "not-mine" });
      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/hardware/stream", () => {
    it("sends an immediate snapshot frame and removes its listener when the client disconnects", async () => {
      await hardwareService.start({
        adapter: new MockSerialAdapter({ autoRespond: () => "ACK" }),
        config: fastConfig,
      });

      const listenersBefore = hardwareEvents.listenerCount(HARDWARE_CHANGE_EVENT);

      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/hardware/stream`, {
        headers: { cookie, accept: "text/event-stream" },
        signal: controller.signal,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toContain("no-cache");

      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const { value } = await reader!.read();
      const frame = new TextDecoder().decode(value);
      expect(frame.startsWith("data: ")).toBe(true);

      const snapshot = JSON.parse(frame.slice("data: ".length).trim()) as Record<string, unknown>;
      expect(snapshot["state"]).toBe("connected");
      expect(snapshot["connected"]).toBe(true);

      // The listener exists while the connection does...
      expect(hardwareEvents.listenerCount(HARDWARE_CHANGE_EVENT)).toBe(listenersBefore + 1);

      controller.abort();

      // ...and is gone once it doesn't. Without the req.on("close") cleanup
      // this count would grow by one per connection, forever.
      await waitFor(() => hardwareEvents.listenerCount(HARDWARE_CHANGE_EVENT) === listenersBefore);
    });

    it("pushes a frame for each subsequent state change", async () => {
      const adapter = new MockSerialAdapter({ autoRespond: () => "ACK" });
      await hardwareService.start({ adapter, config: fastConfig });

      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/hardware/stream`, {
        headers: { cookie, accept: "text/event-stream" },
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read(); // the snapshot

      adapter.emitClose(new Error("Device was unplugged"));

      const decoder = new TextDecoder();
      const states: string[] = [];
      // Read until the disconnect shows up, rather than assuming how many
      // frames it arrives in.
      while (!states.includes("error_retry")) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        for (const frame of decoder.decode(chunk.value).split("\n\n")) {
          const trimmed = frame.trim();
          if (trimmed.startsWith("data: ")) {
            states.push((JSON.parse(trimmed.slice("data: ".length)) as { state: string }).state);
          }
        }
      }

      expect(states).toContain("error_retry");
      controller.abort();
    });
  });
});
