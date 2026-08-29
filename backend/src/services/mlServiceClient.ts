/**
 * HTTP client for the internal Python ML service (`ml-service/`), per
 * ML_SERVICE_INTEGRATION_PLAN.md §3/§5/§8.
 *
 * Responsibilities, all per the plan:
 * - request construction (multipart for /detect, JSON for /search)
 * - response validation — every response is parsed through a Zod schema
 *   (`validation/mlServiceSchemas.ts`) before anything else touches it;
 *   nothing from the Python service is trusted blindly
 * - timeout handling — 30s /detect, 10s /search, 3s /health (fixed per
 *   the plan, not env-configurable — these are call-shape constants, not
 *   deployment config)
 * - error translation — every failure becomes an `UpstreamServiceError`
 *   (503 unreachable/timeout, 502 reached-but-erroring or invalid shape)
 * - correlation ID propagation — generates one via the existing
 *   `utils/ids.ts::newId()` if the caller doesn't supply one, sent as
 *   `X-Correlation-Id` on every request
 * - retry — at most one retry, only for /detect and /search, only on
 *   network error or 5xx (never on 4xx, never for /health)
 *
 * This module does not know what a `ComponentType` is and does not talk
 * to Neo4j — it is purely a typed transport layer. Interpreting a
 * detection's `class_name` is the caller's job (Phase 4, not built yet).
 */

import type { ZodType } from "zod";

import { settings } from "../config/env.js";
import type { MlDetectResponse, MlHealthResponse, MlSearchResponse } from "../types/mlService.js";
import { UpstreamServiceError } from "../utils/errors.js";
import { newId } from "../utils/ids.js";
import {
  mlDetectResponseSchema,
  mlErrorResponseSchema,
  mlHealthResponseSchema,
  mlSearchResponseSchema,
} from "../validation/mlServiceSchemas.js";

export interface MlServiceClientTimeouts {
  readonly detectMs: number;
  readonly searchMs: number;
  readonly healthMs: number;
}

const DEFAULT_TIMEOUTS: MlServiceClientTimeouts = {
  detectMs: 30_000,
  searchMs: 10_000,
  healthMs: 3_000,
};

export interface MlServiceClientOptions {
  /** Defaults to `settings.mlServiceUrl`. Overridable for tests. */
  baseUrl?: string;
  /** Defaults to the plan's fixed timeouts. Overridable for tests (so a timeout test doesn't take 30 real seconds). */
  timeouts?: Partial<MlServiceClientTimeouts>;
}

export interface DetectImageInput {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

export interface DetectOptions {
  confidence?: number;
  correlationId?: string;
}

export interface SearchOptions {
  topK?: number;
  /**
   * Minimum cosine similarity a chunk must reach to be returned. Omitted =
   * the ML service applies its own calibrated default. Callers in the
   * assistant path always pass `settings.ragMinScore` so the effective
   * production threshold is configured in exactly one place.
   */
  minScore?: number;
  correlationId?: string;
}

export interface HealthOptions {
  correlationId?: string;
}

export interface MlServiceClient {
  detectComponents(image: DetectImageInput, options?: DetectOptions): Promise<MlDetectResponse>;
  searchKnowledge(query: string, options?: SearchOptions): Promise<MlSearchResponse>;
  checkHealth(options?: HealthOptions): Promise<MlHealthResponse>;
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "request timed out" : error.message;
  }
  return String(error);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  correlationId: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { ...init.headers, "X-Correlation-Id": correlationId },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Reached the service, but it returned a non-2xx status — parse its ErrorResponse body best-effort. */
async function buildUpstreamErrorFromResponse(response: Response): Promise<UpstreamServiceError> {
  let upstreamError: string | undefined;
  let upstreamDetail: string | undefined;
  try {
    const body: unknown = await response.json();
    const parsed = mlErrorResponseSchema.safeParse(body);
    if (parsed.success) {
      upstreamError = parsed.data.error;
      upstreamDetail = parsed.data.detail ?? undefined;
    }
  } catch {
    // Body wasn't JSON / didn't match — fall through with just the status code.
  }

  const message = upstreamError
    ? `ML service returned an error (HTTP ${response.status}): ${upstreamError}${upstreamDetail ? ` — ${upstreamDetail}` : ""}`
    : `ML service returned HTTP ${response.status}`;
  return new UpstreamServiceError(502, message, upstreamError, upstreamDetail);
}

async function parseAndValidate<T>(response: Response, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new UpstreamServiceError(502, "ML service returned a non-JSON response", undefined);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new UpstreamServiceError(
      502,
      `ML service returned an unexpected response shape: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

async function requestJson<T>(params: {
  url: string;
  init: RequestInit;
  timeoutMs: number;
  retryable: boolean;
  schema: ZodType<T>;
  correlationId: string;
}): Promise<T> {
  const { url, init, timeoutMs, retryable, schema, correlationId } = params;
  const maxAttempts = retryable ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, init, timeoutMs, correlationId);
    } catch (error) {
      if (attempt < maxAttempts) {
        continue; // network error/timeout — retry once
      }
      throw new UpstreamServiceError(503, `ML service unreachable at ${url}: ${describeNetworkError(error)}`);
    }

    if (!response.ok) {
      if (response.status >= 500 && attempt < maxAttempts) {
        continue; // 5xx — retry once
      }
      throw await buildUpstreamErrorFromResponse(response);
    }

    return parseAndValidate(response, schema);
  }

  // Unreachable given the loop above always returns or throws — satisfies TS's control-flow analysis.
  throw new UpstreamServiceError(503, `ML service unreachable at ${url}`);
}

export function createMlServiceClient(options: MlServiceClientOptions = {}): MlServiceClient {
  const baseUrl = options.baseUrl ?? settings.mlServiceUrl;
  const timeouts: MlServiceClientTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };

  return {
    async detectComponents(image, detectOptions = {}) {
      const correlationId = detectOptions.correlationId ?? newId();
      const formData = new FormData();
      formData.append("image", new Blob([image.buffer], { type: image.contentType }), image.filename);
      if (detectOptions.confidence !== undefined) {
        formData.append("confidence", String(detectOptions.confidence));
      }

      return requestJson({
        url: `${baseUrl}/detect`,
        init: { method: "POST", body: formData },
        timeoutMs: timeouts.detectMs,
        retryable: true,
        schema: mlDetectResponseSchema,
        correlationId,
      });
    },

    async searchKnowledge(query, searchOptions = {}) {
      const correlationId = searchOptions.correlationId ?? newId();

      return requestJson({
        url: `${baseUrl}/search`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            top_k: searchOptions.topK ?? 3,
            // Only sent when the caller specified one, so the ML service's
            // own default stays authoritative for direct/CLI callers.
            ...(searchOptions.minScore !== undefined ? { min_score: searchOptions.minScore } : {}),
          }),
        },
        timeoutMs: timeouts.searchMs,
        retryable: true,
        schema: mlSearchResponseSchema,
        correlationId,
      });
    },

    async checkHealth(healthOptions = {}) {
      const correlationId = healthOptions.correlationId ?? newId();

      return requestJson({
        url: `${baseUrl}/health`,
        init: { method: "GET" },
        timeoutMs: timeouts.healthMs,
        retryable: false,
        schema: mlHealthResponseSchema,
        correlationId,
      });
    },
  };
}

/** Process-wide default client, using `settings.mlServiceUrl` and the plan's fixed timeouts. */
export const mlServiceClient: MlServiceClient = createMlServiceClient();
