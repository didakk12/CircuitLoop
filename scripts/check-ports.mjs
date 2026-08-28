#!/usr/bin/env node
/**
 * Preflight for `npm run dev`: refuse to start if a port the stack needs is
 * already taken. Without this, a leftover `tsx watch` / vite from an earlier
 * run keeps serving the browser (with no ML service behind it), and every
 * scan fails with "ML service unreachable" while `npm run dev` looks fine.
 *
 * Detection is by *connecting* (not binding) so it catches a listener on any
 * address — 127.0.0.1, ::1, or 0.0.0.0 — which a bind test on a single
 * address would miss.
 */

import { connect } from "node:net";

function portFromUrl(url, fallback) {
  try {
    return Number(new URL(url).port) || fallback;
  } catch {
    return fallback;
  }
}

const checks = [
  { port: Number(process.env.PORT) || 8000, name: "backend" },
  { port: portFromUrl(process.env.ML_SERVICE_URL || "", 8001), name: "ML service" },
  { port: Number(process.env.VITE_PORT) || 5173, name: "frontend (Vite)" },
];

const somethingListening = (port, host) =>
  new Promise((resolve) => {
    const sock = connect({ port, host });
    const done = (result) => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(1_000);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false)); // ECONNREFUSED -> nothing there
  });

const inUse = async (port) =>
  (await somethingListening(port, "127.0.0.1")) || (await somethingListening(port, "::1"));

const busy = [];
for (const c of checks) {
  if (await inUse(c.port)) busy.push(c);
}

if (busy.length > 0) {
  console.error("");
  for (const c of busy) {
    console.error(`  Port ${c.port} (${c.name}) is already in use.`);
  }
  console.error("");
  console.error("  A dev process from an earlier run is probably still going. Stop it, then");
  console.error("  re-run `npm run dev`. To free the ports (PowerShell):");
  console.error("");
  console.error(`    foreach ($p in ${busy.map((c) => c.port).join(",")}) {`);
  console.error("      Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue |");
  console.error("        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }");
  console.error("    }");
  console.error("");
  process.exit(1);
}
