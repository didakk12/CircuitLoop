/**
 * CircuitLoop backend entry point.
 *
 * `createApp()` builds the Express app (routes, validation, error handling)
 * without touching the network or process lifecycle — `api.test.ts` imports
 * it directly and drives it with supertest. `main()` is the actual runtime
 * entry point: load + validate configuration, connect to Neo4j, bootstrap
 * the schema, start listening, and shut down cleanly.
 */

import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import { pathToFileURL } from "node:url";

import { settings } from "./config/env.js";
import { closeDriver, getDriver, initDriver } from "./db/neo4jDriver.js";
import { ensureConstraintsAndIndexes, ensureDataMigrations } from "./db/schema.js";
import * as hardwareService from "./services/hardwareService.js";
import { ensureUploadDir } from "./services/imageStorageService.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import apiRouter from "./routes/index.js";

export function createApp(): Express {
  const app = express();
  // Frontend (Vite dev server) runs on a different origin than this API —
  // localhost:5173 vs 127.0.0.1:8000 are distinct origins to a browser even
  // on the same machine, so without this, every fetch() from the frontend
  // fails at the browser's CORS check with "TypeError: Failed to fetch"
  // before the request body is ever readable server-side. Origins are
  // configurable (settings.corsOrigins) but never wildcarded.
  // `credentials: true` is required for the browser to send and store the
  // httpOnly session cookie on cross-origin calls. Origins stay explicitly
  // listed — a wildcard origin is not permitted alongside credentials, and
  // would defeat the point anyway.
  app.use(cors({ origin: [...settings.corsOrigins], credentials: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function log(level: "INFO" | "WARN" | "ERROR", message: string): void {
  // Minimal structured-enough logging for this phase; a real logger
  // (Section 11 of BACKEND_IMPLEMENTATION_PLAN.md) is a later concern.
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
}

async function main(): Promise<void> {
  log("INFO", `Connecting to Neo4j at ${settings.neo4j.uri} ...`);
  await initDriver(settings.neo4j);
  log("INFO", "Neo4j connectivity verified.");

  await ensureConstraintsAndIndexes(getDriver(), settings.neo4j.database);
  log("INFO", "Neo4j constraints and indexes are up to date.");

  await ensureDataMigrations(getDriver(), settings.neo4j.database);
  log("INFO", "Neo4j data migrations are up to date.");

  // Created at startup rather than lazily on first upload, so a bad or
  // unwritable CIRCUITLOOP_UPLOAD_DIR surfaces immediately instead of failing
  // the first scan a user attempts.
  const uploadDir = await ensureUploadDir();
  log("INFO", `Scan image storage ready at ${uploadDir}`);

  const app = createApp();

  const server = app.listen(settings.port, () => {
    log("INFO", `CircuitLoop backend listening on port ${settings.port}`);
  });

  // Fire-and-forget, and deliberately *after* the server is listening: the
  // ESP32 gateway is an optional peripheral, so looking for it must never
  // delay the API becoming available, and never fail startup if it isn't
  // there. `start()` catches everything internally and resolves to a
  // `disabled`/`scanning` state; the `.catch` here is the belt-and-braces
  // guarantee that even a bug inside it can't take the process down.
  void hardwareService.start().catch((error: unknown) => {
    log("WARN", `Hardware gateway did not start: ${error instanceof Error ? error.message : String(error)}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log("INFO", `Received ${signal}, shutting down gracefully...`);

    // Released before the Neo4j driver closes, because tearing the link down
    // resolves any in-flight command — a write that still needs the driver.
    // A serial port left open would also survive the process on some
    // platforms and block the next start with "port busy".
    void hardwareService.stop().catch((error: unknown) => {
      log("WARN", `Error while stopping the hardware gateway: ${String(error)}`);
    });

    server.close(() => {
      closeDriver()
        .then(() => {
          log("INFO", "Neo4j driver closed. Goodbye.");
          process.exit(0);
        })
        .catch((error: unknown) => {
          log("ERROR", `Error while closing Neo4j driver: ${String(error)}`);
          process.exit(1);
        });
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run the server when this file is executed directly (`tsx src/index.ts`
// / `node dist/index.js`) — not when imported by tests. `pathToFileURL` (not
// the bare `URL` constructor) is required here so this resolves correctly on
// Windows, where argv[1] is a backslash path that may contain spaces.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error: unknown) => {
    log("ERROR", `Fatal startup error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
