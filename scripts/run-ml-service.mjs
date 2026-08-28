#!/usr/bin/env node
/**
 * Starts the Python ML service (ml-service/app.py) using its own virtualenv
 * interpreter, so `npm run dev` at the repo root can bring it up alongside
 * the Node backend and the Vite frontend without a second terminal.
 *
 * The ML service is still an independent process on 127.0.0.1:8001 — this
 * script only removes the friction of remembering the platform-specific
 * venv path. It intentionally does NOT create the venv or install
 * dependencies; if the venv is missing it prints the exact setup commands
 * and exits, rather than silently doing a slow ~1-2GB install.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mlDir = join(repoRoot, "ml-service");

// Windows: .venv\Scripts\python.exe   ·   macOS/Linux: .venv/bin/python
const venvPython =
  process.platform === "win32"
    ? join(mlDir, ".venv", "Scripts", "python.exe")
    : join(mlDir, ".venv", "bin", "python");

if (!existsSync(venvPython)) {
  const py = process.platform === "win32" ? "python" : "python3";
  const pip =
    process.platform === "win32"
      ? ".venv\\Scripts\\python.exe -m pip"
      : ".venv/bin/python -m pip";
  console.error(
    [
      "",
      "  ML service virtualenv not found:",
      `    ${venvPython}`,
      "",
      "  Create it once (this download is large — a few minutes):",
      "",
      "    cd ml-service",
      `    ${py} -m venv .venv`,
      `    ${pip} install --upgrade pip`,
      `    ${pip} install -r requirements.txt`,
      "    cd ..",
      "",
      "  Then re-run `npm run dev`.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const child = spawn(venvPython, ["app.py"], {
  cwd: mlDir,
  stdio: "inherit",
  env: process.env,
});

// Poll our own /health and print one obvious line when the models are
// loaded, so `npm run dev` output shows exactly when scanning becomes
// possible (the app is NOT usable for scans until this appears).
const healthUrl = `${(process.env.ML_SERVICE_URL || "http://127.0.0.1:8001").replace(/\/$/, "")}/health`;
let announced = false;
const startedAt = Date.now();
const poll = setInterval(async () => {
  if (announced || child.exitCode !== null) {
    clearInterval(poll);
    return;
  }
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
    const body = res.ok ? await res.json() : null;
    if (body?.model_loaded === true && body?.index_loaded === true) {
      announced = true;
      clearInterval(poll);
      console.log(
        `\n✅ ML SERVICE READY — models loaded, scanning available (${Math.round((Date.now() - startedAt) / 1000)}s)\n`,
      );
    }
  } catch {
    /* not up yet */
  }
}, 1_000);
poll.unref?.();

child.on("exit", (code, signal) => {
  clearInterval(poll);
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
