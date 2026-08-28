/**
 * LLM generation via Groq — the only file in this project that knows about
 * a specific LLM provider, per the explicit requirement to keep the
 * provider isolated to this layer. `assistantService.ts` only calls
 * `isConfigured()`/`generateAnswer()`; it has no idea Groq exists.
 *
 * API details (endpoint, auth, request/response shape, model id) were
 * verified against Groq's official docs at implementation time, not
 * assumed:
 * - Endpoint: POST https://api.groq.com/openai/v1/chat/completions (OpenAI-
 *   compatible Chat Completions shape) — console.groq.com/docs/api-reference
 * - Model: `openai/gpt-oss-120b` — confirmed production/active via
 *   console.groq.com/docs/model/openai/gpt-oss-120b. The two Llama models
 *   this project might otherwise have defaulted to
 *   (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`) are past their
 *   documented August 16, 2026 deprecation date as of this implementation
 *   and Groq's own docs (console.groq.com/docs/deprecations) name
 *   `openai/gpt-oss-120b` as the recommended replacement — deliberately
 *   not used here.
 *
 * The API key (`GROQ_API_KEY`) is read once via the existing typed
 * `settings` object, sent only as the Groq request's own Authorization
 * header, and never logged, echoed, or returned in any response.
 */

import { z } from "zod";

import { settings } from "../config/env.js";

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TIMEOUT_MS = 15_000;
const MAX_COMPLETION_TOKENS = 700;

const SYSTEM_PROMPT = `You are the CircuitLoop assistant. You help a user understand one specific electronic component that CircuitLoop has detected and stored, using only the context provided in the user's message (component details, its latest test result if any, and retrieved datasheet excerpts).

Rules you must follow:
- Answer primarily using the provided context. Do not invent component specifications, part numbers, ratings, or test results that are not present in it.
- The retrieved datasheet excerpts may come from a different, similar, or unrelated part. If they do not clearly and specifically apply to the exact component described, say so explicitly instead of presenting them as if they do.
- If information needed to answer the question is missing from the provided context, clearly say it's missing or uncertain rather than guessing or filling the gap with general knowledge presented as fact.
- Be concise, technically accurate, and directly address the user's question.`;

const groqResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string(),
        }),
      }),
    )
    .min(1),
});

/** True once GROQ_API_KEY is set — generation is only ever attempted when this is true. */
export function isConfigured(): boolean {
  return Boolean(settings.groqApiKey);
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "request timed out" : error.message;
  }
  return String(error);
}

/**
 * Sends `userPrompt` (the question + assembled RAG/component/test context,
 * built by assistantService.ts) to Groq and returns the generated answer
 * text. Throws a generic `Error` on any failure — deliberately never
 * includes the raw response body, status text, or the API key in the
 * thrown message, so a caller logging or surfacing it can't leak either.
 * `assistantService.ts` catches this and falls back to the retrieval-only
 * response; it is never shown directly to the frontend.
 */
export async function generateAnswer(userPrompt: string): Promise<string> {
  if (!settings.groqApiKey) {
    throw new Error("Groq is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.groqApiKey}`,
      },
      body: JSON.stringify({
        model: settings.groqModel,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`Groq request failed: ${describeNetworkError(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Deliberately generic — never forwards Groq's response body (which
    // could echo request details) to the caller.
    throw new Error(`Groq request failed with status ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Groq returned a non-JSON response");
  }

  const parsed = groqResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("Groq returned an unexpected response shape");
  }

  const content = parsed.data.choices[0]?.message.content.trim();
  if (!content) {
    throw new Error("Groq returned an empty response");
  }

  return content;
}
