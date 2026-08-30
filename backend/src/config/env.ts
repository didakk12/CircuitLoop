/**
 * Centralized, typed configuration loader for the CircuitLoop backend.
 *
 * Loads environment variables from a local `.env` file (see `.env.example`
 * in the `backend/` root for the full list) and validates that every
 * required Neo4j connection setting is present *before* the rest of the
 * application is allowed to start. This is imported first by
 * `src/index.ts`, so a missing/misspelled variable fails immediately with
 * a clear message instead of surfacing later as a confusing Neo4j
 * connection error.
 *
 * Real credentials are never hardcoded here or anywhere else in the repo —
 * they live only in `backend/.env`, which is git-ignored (see the project
 * root `.gitignore`). This module is the *only* place `process.env` should
 * be read from; every other module imports the typed `settings` object
 * from here instead of touching `process.env` directly.
 */

import "dotenv/config";

/** Neo4j connection settings, validated non-empty at startup. */
export interface Neo4jSettings {
  readonly uri: string;
  readonly username: string;
  readonly password: string;
  /** Named database within the DBMS. `undefined` = use the server default. */
  readonly database: string | undefined;
}

/** Full typed backend configuration, assembled once at process startup. */
export interface Settings {
  readonly neo4j: Neo4jSettings;
  readonly logLevel: string;
  readonly port: number;
  /** Base URL of the internal Python ML service (ML_SERVICE_INTEGRATION_PLAN.md). Not secret, not fail-fast-required — the backend can start without it; calls to it simply fail with UpstreamServiceError until it's reachable. */
  readonly mlServiceUrl: string;
  /** Max accepted size for POST /api/scans/:id/upload's image, in bytes. Same 10MB default as ml-service/config.py's own limit (defense in depth on both hops). */
  readonly maxUploadBytes: number;
  /**
   * Gemini API key — the PRIMARY assistant provider (services/geminiClient.ts).
   * Undefined = the assistant falls back to Groq; if neither is configured,
   * assistantService.ts returns a generic unavailable message. Never sent to
   * the frontend.
   */
  readonly geminiApiKey: string | undefined;
  /**
   * Gemini model id. Verified against the live API: `gemini-2.5-flash-lite`
   * returns 404 "no longer available to new users" and names this as its
   * replacement. Overridable so the model can change without a code change.
   */
  readonly geminiModel: string;
  /** Groq API key — the assistant's FALLBACK provider (services/llmClient.ts), used only when Gemini fails. Undefined = no fallback. Never sent to the frontend. */
  readonly groqApiKey: string | undefined;
  /** Groq model id — see services/llmClient.ts for why this specific default was chosen (verified against Groq's current docs, not guessed). */
  readonly groqModel: string;
  /**
   * How many datasheet chunks to ask the ML service for per assistant
   * question, before the relevance threshold is applied. Retrieval returns
   * *at most* this many and often fewer.
   */
  readonly ragTopK: number;
  /**
   * Minimum cosine similarity a datasheet chunk must reach to be shown to
   * the LLM at all. Chunks below it are dropped, and the prompt then says
   * plainly that no relevant datasheet evidence was found.
   *
   * Default 0.65, calibrated against the real corpus rather than guessed:
   * off-topic queries top out around 0.63 while genuine electronics queries
   * start around 0.67. See ml-service/neo4j_store.py::DEFAULT_MIN_SCORE for
   * the measurements and for what this threshold deliberately does not try
   * to decide (whether a chunk is about the *selected part* — that is
   * established separately in assistantService.ts).
   */
  readonly ragMinScore: number;
  readonly tesseractCmd: string | undefined;
  readonly esp32Port: string | undefined;
  readonly esp32Baud: number | undefined;
  readonly esp32AckTimeoutMs: number;
  readonly heartbeatStaleAfterS: number;
  /** Origins allowed to call this API from a browser (CORS). Local dev tool per CIRCUIT_LOOP_PLAN.md §"Auth/security" — "CORS is wide open to localhost", not to arbitrary origins. */
  readonly corsOrigins: readonly string[];
  /** Secret used to sign session JWTs. Required — the app refuses to start without it, exactly like the Neo4j credentials, because a default would silently make every deployment forgeable. */
  readonly jwtSecret: string;
  /** How long an issued session cookie stays valid. */
  readonly jwtExpiresIn: string;
  /** Marks the auth cookie `Secure`. Off by default so http://localhost works; set true behind HTTPS. */
  readonly cookieSecure: boolean;
  /**
   * Directory holding uploaded scan images. Relative paths resolve against the
   * backend package root, so the default works unchanged on any machine and no
   * absolute path is ever baked into the repo or the database — only bare
   * filenames are stored on the Scan node.
   */
  readonly uploadDir: string;
  /**
   * Registry name of the marketplace provider used to publish listings — see
   * services/marketplaceProviders/registry.ts. Defaults to `manual_assist`,
   * which makes no network call at all and simply hands the user a pre-filled
   * Facebook create-listing link. Nothing about marketplace posting requires
   * Meta credentials in this default mode.
   */
  readonly marketplaceProvider: string;
  /**
   * Meta app id for the (not yet wired) Graph API provider. Optional in the
   * same sense as `geminiApiKey`: absent simply means that provider reports
   * itself unconfigured. Never sent to the frontend.
   */
  readonly facebookAppId: string | undefined;
  /** Page access token for the Graph API provider. Secret; optional; never sent to the frontend. */
  readonly facebookPageAccessToken: string | undefined;
  /** Commerce catalog id the Graph API provider would post into. Optional; never sent to the frontend. */
  readonly facebookCatalogId: string | undefined;
  /** Where `manual_assist` sends the user to finish posting by hand. Not secret. */
  readonly facebookMarketplaceCreateUrl: string;
  /**
   * Hard ceiling on one `provider.publish()` call. A provider that hangs must
   * not hold a request open forever, so the publish is raced against this and
   * the listing is marked `failed` if the timer wins. Default 30s.
   */
  readonly marketplacePublishTimeoutMs: number;
}

const REQUIRED_NEO4J_VARS = [
  "NEO4J_URI",
  "NEO4J_USER",
  "NEO4J_PASSWORD",
] as const;

type RequiredNeo4jVar = (typeof REQUIRED_NEO4J_VARS)[number];

/** Reads an env var, treating an empty string the same as "unset". */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function findMissingRequiredVars(): RequiredNeo4jVar[] {
  return REQUIRED_NEO4J_VARS.filter((name) => readEnv(name) === undefined);
}

function parseIntOrUndefined(name: string): number | undefined {
  const raw = readEnv(name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name}=${JSON.stringify(raw)} must be an integer.`);
  }
  return parsed;
}

function parseIntOrDefault(name: string, fallback: number): number {
  return parseIntOrUndefined(name) ?? fallback;
}

/**
 * Reads a similarity threshold, which is only meaningful as a cosine value in
 * [0, 1]. Rejects out-of-range values loudly rather than clamping: a
 * threshold of 5 or -1 is a misconfiguration that would silently make
 * retrieval return everything or nothing, which is much harder to diagnose
 * later than a startup error here.
 */
function parseFloatInUnitRange(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(
      `Environment variable ${name}=${JSON.stringify(raw)} must be a number between 0 and 1 ` +
        `(it is a cosine similarity threshold).`,
    );
  }
  return parsed;
}

/**
 * Reads a secret that has no safe default. Deliberately fails fast rather than
 * falling back: a hardcoded fallback signing key would let anyone mint a valid
 * session for any deployment that forgot to set it, and the failure would be
 * silent. Same convention as the required Neo4j credentials above.
 */
function readRequiredSecret(name: string): string {
  const value = readEnv(name);
  if (value === undefined) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy backend/.env.example to backend/.env and set a long random value ` +
        `(e.g. \`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"\`).`,
    );
  }
  return value;
}

/**
 * Loads and validates all backend configuration.
 *
 * @throws {Error} naming exactly which required Neo4j environment
 * variable(s) are missing, if any are unset or blank. Copy
 * `backend/.env.example` to `backend/.env` and fill in real values to
 * resolve this.
 */
export function loadSettings(): Settings {
  const missing = findMissingRequiredVars();
  if (missing.length > 0) {
    throw new Error(
      `Missing required Neo4j environment variable(s): ${missing.join(", ")}. ` +
        "Copy backend/.env.example to backend/.env and fill in your Neo4j " +
        "connection details (NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD).",
    );
  }

  // Safe: findMissingRequiredVars() above guarantees these are all present.
  const uri = readEnv("NEO4J_URI") as string;
  const username = readEnv("NEO4J_USER") as string;
  const password = readEnv("NEO4J_PASSWORD") as string;

  return {
    neo4j: {
      uri,
      username,
      password,
      database: readEnv("NEO4J_DATABASE"),
    },
    logLevel: readEnv("CIRCUITLOOP_LOG_LEVEL") ?? "INFO",
    port: parseIntOrDefault("PORT", 8000),
    // Default matches ml-service/config.py's own default port (8001).
    mlServiceUrl: readEnv("ML_SERVICE_URL") ?? "http://127.0.0.1:8001",
    maxUploadBytes: parseIntOrDefault("CIRCUITLOOP_MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    geminiApiKey: readEnv("GEMINI_API_KEY"),
    geminiModel: readEnv("GEMINI_MODEL") ?? "gemini-3.5-flash-lite",
    groqApiKey: readEnv("GROQ_API_KEY"),
    groqModel: readEnv("GROQ_MODEL") ?? "openai/gpt-oss-120b",
    ragTopK: parseIntOrDefault("CIRCUITLOOP_RAG_TOP_K", 5),
    ragMinScore: parseFloatInUnitRange("CIRCUITLOOP_RAG_MIN_SCORE", 0.65),
    tesseractCmd: readEnv("TESSERACT_CMD"),
    esp32Port: readEnv("CIRCUITLOOP_ESP32_PORT"),
    esp32Baud: parseIntOrUndefined("CIRCUITLOOP_ESP32_BAUD"),
    esp32AckTimeoutMs: parseIntOrDefault("CIRCUITLOOP_ESP32_ACK_TIMEOUT_MS", 5000),
    heartbeatStaleAfterS: parseIntOrDefault("CIRCUITLOOP_HEARTBEAT_STALE_AFTER_S", 30),
    // Defaults cover Vite's dev server under both hostnames a browser may use
    // (localhost and 127.0.0.1 are different CORS origins even though they
    // resolve to the same machine) — override via a comma-separated list for
    // any other deployment.
    jwtSecret: readRequiredSecret("JWT_SECRET"),
    jwtExpiresIn: readEnv("JWT_EXPIRES_IN") ?? "7d",
    cookieSecure: (readEnv("COOKIE_SECURE") ?? "false").toLowerCase() === "true",
    uploadDir: readEnv("CIRCUITLOOP_UPLOAD_DIR") ?? "uploads",
    marketplaceProvider: readEnv("CIRCUITLOOP_MARKETPLACE_PROVIDER") ?? "manual_assist",
    facebookAppId: readEnv("FACEBOOK_APP_ID"),
    facebookPageAccessToken: readEnv("FACEBOOK_PAGE_ACCESS_TOKEN"),
    facebookCatalogId: readEnv("FACEBOOK_CATALOG_ID"),
    facebookMarketplaceCreateUrl:
      readEnv("FACEBOOK_MARKETPLACE_CREATE_URL") ?? "https://www.facebook.com/marketplace/create/item",
    marketplacePublishTimeoutMs: parseIntOrDefault("CIRCUITLOOP_MARKETPLACE_PUBLISH_TIMEOUT_MS", 30_000),
    corsOrigins: (readEnv("CIRCUITLOOP_CORS_ORIGINS") ?? "http://localhost:5173,http://127.0.0.1:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  };
}

/**
 * Importing this module validates configuration immediately (fail fast),
 * matching the existing project convention (previously the Python
 * `config.py`) of surfacing missing configuration at import time rather
 * than deep inside a request handler.
 */
export const settings: Settings = loadSettings();
