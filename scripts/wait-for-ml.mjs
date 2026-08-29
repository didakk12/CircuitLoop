#!/usr/bin/env node
/**
 * Blocks until the ML service reports it has finished loading its models,
 * then exits 0. Used by `npm run dev` to hold the frontend back until the
 * whole stack can actually serve a scan — the ML service takes ~25s to load
 * two YOLO models and the sentence-transformer, and to connect to Neo4j and
 * verify its RAG vector index; a scan that lands in that window fails with
 * "ML service unreachable".
 *
 * Exits 1 (which tears the `npm run dev` stack down via
 * `--kill-others-on-fail`) if the service never becomes ready within the
 * timeout — e.g. it crashed on startup.
 */

const url = (process.env.ML_SERVICE_URL || "http://127.0.0.1:8001").replace(/\/$/, "");
const healthUrl = `${url}/health`;
const TIMEOUT_MS = 120_000;
const POLL_MS = 1_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ready() {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.status === "ok" && body?.model_loaded === true && body?.index_loaded === true;
  } catch {
    return false;
  }
}

const startedAt = Date.now();
process.stdout.write(`waiting for ML service to finish loading (${healthUrl}) ...\n`);

for (;;) {
  if (await ready()) {
    process.stdout.write(`✅ ML service ready — models + index loaded (${Math.round((Date.now() - startedAt) / 1000)}s)\n`);
    process.exit(0);
  }
  if (Date.now() - startedAt > TIMEOUT_MS) {
    process.stderr.write(
      `❌ ML service did not become ready within ${TIMEOUT_MS / 1000}s (${healthUrl}). ` +
        `Check the [ml] output above for a crash or a missing virtualenv.\n`,
    );
    process.exit(1);
  }
  await sleep(POLL_MS);
}
