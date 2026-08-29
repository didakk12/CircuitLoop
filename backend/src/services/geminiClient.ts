/**
 * LLM generation via Gemini — the PRIMARY assistant provider.
 *
 * One provider adapter behind the `llmProvider.ts` seam, shaped exactly like
 * the Groq adapter in `llmClient.ts` (which is preserved and now serves as the
 * fallback; `llmFallback.ts` chains the two). `assistantService.ts` imports
 * `llmProvider.ts` and knows about neither.
 *
 * Like the Groq adapter, this file carries no assistant policy of its own: the
 * system prompt containing the component-scope / relevance rules is passed in
 * by the caller and lives in `assistantPrompt.ts`. Swapping providers
 * therefore changes nothing about the assistant's behaviour rules.
 *
 * API details, verified against the live API at implementation time rather
 * than assumed:
 * - Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/
 *   {model}:generateContent, and `:streamGenerateContent?alt=sse` for
 *   streaming.
 * - Auth: the `x-goog-api-key` request header.
 * - Model: `gemini-3.5-flash-lite`. `gemini-2.5-flash-lite` was measured
 *   returning 404 "no longer available to new users", naming this as its
 *   replacement; `GEMINI_MODEL` overrides it without a code change.
 *
 * Two shape differences from the OpenAI-compatible Groq API are handled here
 * and nowhere else:
 * - The system prompt is a separate top-level `systemInstruction`, not a
 *   message with `role: "system"`.
 * - The assistant's role is named `model`, not `assistant`.
 *
 * The API key (`GEMINI_API_KEY`) is read once via the existing typed
 * `settings` object, sent only as this request's own header, and never logged,
 * echoed, or returned in any response.
 */

import { z } from "zod";

import { settings } from "../config/env.js";
import type { ConversationTurn } from "./llmProvider.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
/**
 * Deliberately well above Gemini's measured latency rather than close to it.
 *
 * Measured on an assistant-sized prompt (full system policy + component record
 * + datasheet evidence): 1-2s to first token, ~2s total. But a cold first call
 * was observed exceeding 15s — the ceiling the Groq adapter uses, tuned for
 * Groq's speed — and because a timeout here silently demotes the request to
 * the Groq fallback, a tight bound costs the primary provider for no benefit.
 * On the streaming path this is an idle timeout, so a larger value only
 * affects genuinely stalled connections.
 */
const GEMINI_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 700;

/**
 * No `thinkingConfig` is sent, and that is deliberate — measured, not assumed.
 *
 * `gemini-3.5-flash-lite` is a thinking model, so the obvious move was to cap
 * its thinking the way the Groq adapter caps `reasoning_effort` for
 * `openai/gpt-oss-120b` (see llmClient.ts). Measured against this project's
 * real system prompt, that mitigation is the bug: with
 * `thinkingConfig: { thinkingLevel: "low" }` the STREAMING endpoint returns a
 * single frame carrying a thought signature and `"text": ""`, then ends — no
 * content at all, every time. `"high"` truncates instead (141 chars). With no
 * `thinkingConfig` the same request streams normally and repeatably
 * (7-11 frames, 515-1017 chars over four runs).
 *
 * Gemini manages its own thinking budget here; the empty-response and
 * empty-stream guards below stay as the real safety net, and they proved
 * themselves by catching exactly this failure and falling back cleanly.
 */

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * Assembles Gemini's `contents` array.
 *
 * The system prompt is NOT part of this — it goes in the request's separate
 * `systemInstruction` field, which is what keeps it structurally impossible
 * for a replayed history turn to displace or impersonate the policy.
 * `ConversationTurn` cannot express a system role either, so prior turns can
 * only ever appear as ordinary user/model messages between the policy and the
 * current question.
 *
 * Prior turns are sent as real conversation turns rather than being flattened
 * into the user prompt, so the model treats them as dialogue — which is what
 * makes a bare follow-up like "why?" resolve against the previous answer.
 */
function buildContents(userPrompt: string, history: readonly ConversationTurn[]): GeminiContent[] {
  return [
    ...history.map((turn) => ({
      role: turn.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: turn.content }],
    })),
    { role: "user" as const, parts: [{ text: userPrompt }] },
  ];
}

function buildRequestBody(
  systemPrompt: string,
  userPrompt: string,
  history: readonly ConversationTurn[],
): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: buildContents(userPrompt, history),
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  };
}

/**
 * One `generateContent` response. Every field is optional because a thinking
 * model legitimately returns parts that carry no `text` (thought signatures);
 * those are filtered out rather than treated as the answer.
 */
const geminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z.array(z.object({ text: z.string().nullish() }).passthrough()).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

/** Pulls the answer text out of a response, ignoring thought-only parts. */
function extractText(body: unknown): string {
  const parsed = geminiResponseSchema.safeParse(body);
  if (!parsed.success) {
    return "";
  }
  const parts = parsed.data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part.text)
    .filter((text): text is string => typeof text === "string")
    .join("");
}

/** True once GEMINI_API_KEY is set — generation is only ever attempted when this is true. */
export function isConfigured(): boolean {
  return Boolean(settings.geminiApiKey);
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "request timed out" : error.message;
  }
  return String(error);
}

function endpoint(method: string, query = ""): string {
  return `${GEMINI_API_BASE}/${settings.geminiModel}:${method}${query}`;
}

function requestHeaders(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", "x-goog-api-key": apiKey };
}

/**
 * Sends `systemPrompt` (the provider-agnostic assistant policy —
 * `COMPONENT_SCOPE_SYSTEM_PROMPT`, assembled in assistantPrompt.ts) and
 * `userPrompt` (the question + assembled RAG/component/test context, built by
 * assistantService.ts) to Gemini and returns the generated answer text.
 *
 * Throws a generic `Error` on any failure — deliberately never including the
 * raw response body, status text, or the API key, so a caller logging or
 * surfacing it cannot leak either. `llmFallback.ts` catches this and retries
 * against Groq; if that also fails, assistantService.ts falls back to a
 * generic unavailable message. Neither is ever shown directly to the frontend.
 */
export async function generateAnswer(
  systemPrompt: string,
  userPrompt: string,
  history: readonly ConversationTurn[] = [],
): Promise<string> {
  const apiKey = settings.geminiApiKey;
  if (!apiKey) {
    throw new Error("Gemini is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(endpoint("generateContent"), {
      method: "POST",
      headers: requestHeaders(apiKey),
      body: JSON.stringify(buildRequestBody(systemPrompt, userPrompt, history)),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`Gemini request failed: ${describeNetworkError(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Deliberately generic — never forwards Gemini's response body (which
    // could echo request details) to the caller.
    throw new Error(`Gemini request failed with status ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Gemini returned a non-JSON response");
  }

  const content = extractText(body).trim();
  if (!content) {
    throw new Error("Gemini returned an empty response");
  }

  return content;
}

/**
 * Streaming counterpart of `generateAnswer` — sends the same request to
 * `:streamGenerateContent?alt=sse` and yields each text fragment as the SSE
 * frames arrive. Parsing is defensive: unknown/partial frames and any
 * `[DONE]` sentinel are skipped rather than trusted or thrown on.
 *
 * The abort timer is an *idle* timeout (reset on every received chunk), not a
 * wall-clock one: a long but healthy answer must not be cut off, while a
 * silently stalled connection still ends.
 *
 * The empty-stream guard at the end matters more than it looks: because it
 * throws *before* anything has been yielded, `llmFallback.ts` can still hand
 * the question to Groq cleanly. A stream that produced nothing is exactly the
 * case worth falling back on.
 */
export async function* generateAnswerStream(
  systemPrompt: string,
  userPrompt: string,
  history: readonly ConversationTurn[] = [],
): AsyncGenerator<string> {
  const apiKey = settings.geminiApiKey;
  if (!apiKey) {
    throw new Error("Gemini is not configured");
  }

  const controller = new AbortController();
  let idleTimer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  const resetIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  };

  let response: Response;
  try {
    response = await fetch(endpoint("streamGenerateContent", "?alt=sse"), {
      method: "POST",
      headers: requestHeaders(apiKey),
      body: JSON.stringify(buildRequestBody(systemPrompt, userPrompt, history)),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(idleTimer);
    throw new Error(`Gemini request failed: ${describeNetworkError(error)}`);
  }

  if (!response.ok) {
    clearTimeout(idleTimer);
    throw new Error(`Gemini request failed with status ${response.status}`);
  }
  if (!response.body) {
    clearTimeout(idleTimer);
    throw new Error("Gemini returned no body for a streaming request");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let produced = false;

  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw new Error(`Gemini stream failed: ${describeNetworkError(error)}`);
      }
      if (chunk.done) {
        break;
      }
      resetIdleTimer();
      // CRLF is normalised away before any splitting. Measured: Gemini
      // separates its SSE frames with \r\n\r\n and emits no \n\n at all, so
      // the plain `split("\n\n")` this adapter was first written with (correct
      // for Groq, which uses LF) never found a frame boundary — every stream
      // came back empty and silently fell through to the Groq fallback.
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");

      // SSE frames are separated by a blank line; keep the trailing partial.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          const trimmed = line.trimStart();
          if (!trimmed.startsWith("data:")) {
            continue;
          }
          const data = trimmed.slice("data:".length).trim();
          if (data === "" || data === "[DONE]") {
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          const text = extractText(parsed);
          if (text.length > 0) {
            produced = true;
            yield text;
          }
        }
      }
    }
  } finally {
    clearTimeout(idleTimer);
    reader.releaseLock();
  }

  if (!produced) {
    throw new Error("Gemini returned an empty stream");
  }
}
