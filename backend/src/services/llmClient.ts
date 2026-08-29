/**
 * LLM generation via Groq — one interchangeable provider adapter behind the
 * `llmProvider.ts` seam, and the only file in this project that knows about
 * a specific LLM provider. `assistantService.ts` imports `llmProvider.ts`,
 * never this file, and calls only `isConfigured()` / `generateAnswer()`; it
 * has no idea Groq exists.
 *
 * This adapter carries no assistant policy of its own: the system prompt
 * (which contains the component-scope / relevance rules) is passed in by
 * the caller. Replacing Groq means writing another file shaped like this
 * one — the scope behaviour comes along unchanged because it lives in
 * `assistantPrompt.ts`, not here.
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

/**
 * One prior turn of the conversation. Only `user` and `assistant` exist —
 * the system prompt is assembled server-side and is never client-supplied.
 */
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/** The shape every LLM provider adapter must expose. */
export interface LlmProvider {
  isConfigured(): boolean;
  generateAnswer(
    systemPrompt: string,
    userPrompt: string,
    history?: readonly ConversationTurn[],
  ): Promise<string>;
  /**
   * Same inputs as `generateAnswer`, but yields the answer in fragments as
   * the model produces them. Throws (before the first yield) on setup
   * failure; may also throw mid-iteration if the connection drops. Callers
   * treat any throw the same way they treat a `generateAnswer` rejection.
   */
  generateAnswerStream(
    systemPrompt: string,
    userPrompt: string,
    history?: readonly ConversationTurn[],
  ): AsyncGenerator<string>;
}

/**
 * Assembles the Groq `messages` array.
 *
 * The system prompt is always first and is never something a caller's history
 * can displace or duplicate: `ConversationTurn` cannot express a system role,
 * so replayed turns can only ever appear as ordinary user/assistant messages
 * between the policy and the current question.
 *
 * Prior turns are sent as real conversation turns rather than being flattened
 * into the user prompt, so the model treats them as dialogue — which is what
 * makes a bare follow-up like "why?" resolve against the previous answer.
 */
function buildMessages(
  systemPrompt: string,
  userPrompt: string,
  history: readonly ConversationTurn[],
): Array<{ role: string; content: string }> {
  return [
    { role: "system", content: systemPrompt },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: userPrompt },
  ];
}

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

/** One `chat.completion.chunk` from the streaming (`stream: true`) response. */
const groqStreamChunkSchema = z.object({
  choices: z
    .array(z.object({ delta: z.object({ content: z.string().nullish() }).optional() }))
    .optional(),
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
 * Sends `systemPrompt` (the provider-agnostic assistant policy —
 * `COMPONENT_SCOPE_SYSTEM_PROMPT`, assembled in assistantPrompt.ts) and
 * `userPrompt` (the question + assembled RAG/component/test context, built
 * by assistantService.ts) to Groq and returns the generated answer text.
 * Throws a generic `Error` on any failure — deliberately never includes the
 * raw response body, status text, or the API key in the thrown message, so
 * a caller logging or surfacing it can't leak either. `assistantService.ts`
 * catches this and falls back to a generic unavailable message; it is never
 * shown directly to the frontend.
 */
export async function generateAnswer(
  systemPrompt: string,
  userPrompt: string,
  history: readonly ConversationTurn[] = [],
): Promise<string> {
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
        messages: buildMessages(systemPrompt, userPrompt, history),
        temperature: 0.2,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        // `openai/gpt-oss-120b` is a reasoning model: it emits reasoning-channel
        // tokens before content and intermittently spends the whole completion
        // budget there, returning an empty message ("Groq returned an empty
        // response"/"...stream"). Capping the reasoning effort keeps it
        // producing actual content. Measured: eliminates the empty-response
        // failures seen at the default effort.
        reasoning_effort: "low",
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

/**
 * Streaming counterpart of `generateAnswer` — sends the same request with
 * `stream: true` and yields each `delta.content` fragment as Groq's SSE
 * frames arrive. Parsing is defensive: unknown/partial frames and the
 * trailing `[DONE]` sentinel are skipped rather than trusted or thrown on.
 *
 * The abort timer is an *idle* timeout (reset on every received chunk), not
 * a wall-clock one: a long but healthy answer must not be cut off, while a
 * silently stalled connection still ends.
 */
export async function* generateAnswerStream(
  systemPrompt: string,
  userPrompt: string,
  history: readonly ConversationTurn[] = [],
): AsyncGenerator<string> {
  if (!settings.groqApiKey) {
    throw new Error("Groq is not configured");
  }

  const controller = new AbortController();
  let idleTimer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  const resetIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  };

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
        messages: buildMessages(systemPrompt, userPrompt, history),
        temperature: 0.2,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        // See generateAnswer: caps the reasoning model's reasoning-channel
        // spend so a streamed response actually carries content deltas.
        reasoning_effort: "low",
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(idleTimer);
    throw new Error(`Groq request failed: ${describeNetworkError(error)}`);
  }

  if (!response.ok) {
    clearTimeout(idleTimer);
    throw new Error(`Groq request failed with status ${response.status}`);
  }
  if (!response.body) {
    clearTimeout(idleTimer);
    throw new Error("Groq returned no body for a streaming request");
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
        throw new Error(`Groq stream failed: ${describeNetworkError(error)}`);
      }
      if (chunk.done) {
        break;
      }
      resetIdleTimer();
      buffer += decoder.decode(chunk.value, { stream: true });

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
          const result = groqStreamChunkSchema.safeParse(parsed);
          if (!result.success) {
            continue;
          }
          const content = result.data.choices?.[0]?.delta?.content;
          if (typeof content === "string" && content.length > 0) {
            produced = true;
            yield content;
          }
        }
      }
    }
  } finally {
    clearTimeout(idleTimer);
    reader.releaseLock();
  }

  if (!produced) {
    throw new Error("Groq returned an empty stream");
  }
}
