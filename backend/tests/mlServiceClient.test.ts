/**
 * Unit tests for mlServiceClient.ts against a real, local, throwaway HTTP
 * server standing in for ml-service — no mocking library, no dependency on
 * Python/YOLO/FAISS being installed, per ML_SERVICE_INTEGRATION_PLAN.md's
 * explicit design goal that the TS suite must not require the Python
 * service to run. See tests/mlServiceClientLive.manual.ts for the
 * separate, real-Python-service manual verification.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createMlServiceClient } from "../src/services/mlServiceClient.js";
import { UpstreamServiceError } from "../src/utils/errors.js";

const SHORT_TIMEOUTS = { detectMs: 300, searchMs: 300, healthMs: 300 };

function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to bind mock server"));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  // closeAllConnections (Node 18.2+): drop any still-open sockets immediately
  // instead of waiting for them to end gracefully — matters for the timeout
  // test below, whose whole point is a connection that's deliberately never
  // responded to.
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

let activeServer: Server | undefined;

afterEach(async () => {
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe("mlServiceClient", () => {
  describe("checkHealth", () => {
    it("parses a valid health response", async () => {
      const { server, baseUrl } = await startMockServer((_req, res) => {
        sendJson(res, 200, { status: "ok", model_loaded: true, index_loaded: true });
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      await expect(client.checkHealth()).resolves.toEqual({
        status: "ok",
        model_loaded: true,
        index_loaded: true,
      });
    });

    it("does not retry on 5xx (single attempt, per the plan's 'not for /health' rule)", async () => {
      let attempts = 0;
      const { server, baseUrl } = await startMockServer((_req, res) => {
        attempts += 1;
        sendJson(res, 503, { error: "service_unavailable" });
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      const error = await client.checkHealth().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UpstreamServiceError);
      expect((error as UpstreamServiceError).statusCode).toBe(502);
      expect(attempts).toBe(1);
    });
  });

  describe("searchKnowledge", () => {
    it("sends the query/top_k body and parses a valid response", async () => {
      let receivedBody = "";
      const { server, baseUrl } = await startMockServer((req, res) => {
        req.on("data", (chunk: Buffer) => (receivedBody += chunk.toString()));
        req.on("end", () => {
          sendJson(res, 200, {
            results: [{ part_name: "DG401", section: "features", source_file: "x.pdf", text: "hello" }],
          });
        });
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      const result = await client.searchKnowledge("operating voltage", { topK: 5 });

      expect(JSON.parse(receivedBody)).toEqual({ query: "operating voltage", top_k: 5 });
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.part_name).toBe("DG401");
    });

    it("propagates a caller-supplied correlation id as X-Correlation-Id", async () => {
      let receivedHeader: string | undefined;
      const { server, baseUrl } = await startMockServer((req, res) => {
        receivedHeader = req.headers["x-correlation-id"] as string | undefined;
        sendJson(res, 200, { results: [] });
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      await client.searchKnowledge("test", { correlationId: "my-correlation-id" });

      expect(receivedHeader).toBe("my-correlation-id");
    });

    it("generates a correlation id when the caller doesn't supply one", async () => {
      let receivedHeader: string | undefined;
      const { server, baseUrl } = await startMockServer((req, res) => {
        receivedHeader = req.headers["x-correlation-id"] as string | undefined;
        sendJson(res, 200, { results: [] });
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      await client.searchKnowledge("test");

      expect(receivedHeader).toBeTruthy();
      expect(receivedHeader).toMatch(/^[0-9a-f-]{36}$/); // UUID shape, from utils/ids.ts::newId()
    });

    it("retries once on 5xx and succeeds if the retry succeeds", async () => {
      let attempts = 0;
      const { server, baseUrl } = await startMockServer((_req, res) => {
        attempts += 1;
        if (attempts === 1) {
          sendJson(res, 503, { error: "service_unavailable", detail: "still loading" });
        } else {
          sendJson(res, 200, { results: [] });
        }
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      const result = await client.searchKnowledge("test");

      expect(attempts).toBe(2);
      expect(result.results).toEqual([]);
    });

    it("throws UpstreamServiceError(502) after exhausting the single retry on persistent 5xx", async () => {
      let attempts = 0;
      const { server, baseUrl } = await startMockServer((_req, res) => {
        attempts += 1;
        sendJson(res, 500, { error: "internal_error" });
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      const error = await client.searchKnowledge("test").catch((e: unknown) => e);

      expect(attempts).toBe(2);
      expect(error).toBeInstanceOf(UpstreamServiceError);
      expect((error as UpstreamServiceError).statusCode).toBe(502);
      expect((error as UpstreamServiceError).upstreamError).toBe("internal_error");
    });

    it("does NOT retry on 4xx and throws UpstreamServiceError(502) immediately", async () => {
      let attempts = 0;
      const { server, baseUrl } = await startMockServer((_req, res) => {
        attempts += 1;
        sendJson(res, 422, { error: "validation_error", detail: "query: Field required" });
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      const error = await client.searchKnowledge("test").catch((e: unknown) => e);

      expect(attempts).toBe(1);
      expect(error).toBeInstanceOf(UpstreamServiceError);
      expect((error as UpstreamServiceError).statusCode).toBe(502);
      expect((error as UpstreamServiceError).upstreamError).toBe("validation_error");
    });

    it("rejects a response that doesn't match the expected shape (does not trust it blindly)", async () => {
      const { server, baseUrl } = await startMockServer((_req, res) => {
        sendJson(res, 200, { results: [{ part_name: "X" /* missing section/source_file/text */ }] });
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      const error = await client.searchKnowledge("test").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UpstreamServiceError);
      expect((error as UpstreamServiceError).statusCode).toBe(502);
    });

    it("rejects a non-JSON 200 response", async () => {
      const { server, baseUrl } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("not json");
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      const error = await client.searchKnowledge("test").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UpstreamServiceError);
      expect((error as UpstreamServiceError).statusCode).toBe(502);
    });

    it("throws UpstreamServiceError(503) when the service is unreachable", async () => {
      const { server, baseUrl } = await startMockServer((_req, res) => sendJson(res, 200, { results: [] }));
      await closeServer(server); // close immediately — baseUrl now points at nothing listening
      activeServer = undefined;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      const error = await client.searchKnowledge("test").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UpstreamServiceError);
      expect((error as UpstreamServiceError).statusCode).toBe(503);
    });

    it("throws UpstreamServiceError(503) on timeout", async () => {
      // Deliberately never responds — the client's own AbortController is
      // what ends this, not a server-side timer (a dangling server timer
      // that fires after the test moves on just slows the suite down for
      // no reason, see closeServer's closeAllConnections()).
      const { server, baseUrl } = await startMockServer(() => {
        /* never respond */
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: { detectMs: 300, searchMs: 100, healthMs: 300 } });
      const error = await client.searchKnowledge("test").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UpstreamServiceError);
      expect((error as UpstreamServiceError).statusCode).toBe(503);
    });
  });

  describe("detectComponents", () => {
    it("sends a multipart request and parses a valid response", async () => {
      let contentType = "";
      const { server, baseUrl } = await startMockServer((req, res) => {
        contentType = req.headers["content-type"] ?? "";
        req.on("data", () => undefined);
        req.on("end", () => {
          sendJson(res, 200, {
            detections: [
              { class_name: "relay", confidence: 0.9, bbox: { x1: 0, y1: 0, x2: 10, y2: 10 }, text: "" },
            ],
          });
        });
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      const result = await client.detectComponents({
        buffer: Buffer.from([0, 1, 2, 3]),
        filename: "board.png",
        contentType: "image/png",
      });

      expect(contentType).toMatch(/^multipart\/form-data/);
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0]?.class_name).toBe("relay"); // not coerced to "unknown" or a ComponentType
    });

    it("throws UpstreamServiceError(502) with the upstream detail on an invalid-image 400", async () => {
      const { server, baseUrl } = await startMockServer((req, res) => {
        req.on("data", () => undefined);
        req.on("end", () => {
          sendJson(res, 400, { error: "invalid_image", detail: "Could not decode image bytes" });
        });
      });
      activeServer = server;

      const client = createMlServiceClient({ baseUrl, timeouts: SHORT_TIMEOUTS });
      const error = await client
        .detectComponents({ buffer: Buffer.from([0]), filename: "x.png", contentType: "image/png" })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UpstreamServiceError);
      expect((error as UpstreamServiceError).statusCode).toBe(502);
      expect((error as UpstreamServiceError).upstreamError).toBe("invalid_image");
    });
  });
});
