/**
 * Chains the two assistant providers: Gemini primary, Groq fallback.
 *
 *   User -> Gemini (geminiClient.ts)
 *        -> on failure, the existing Groq implementation (llmClient.ts)
 *
 * This module knows nothing about either provider's API — it only composes
 * two objects that satisfy `LlmProvider`. Both adapters stay fully functional
 * and independently testable; nothing was removed to add Gemini.
 *
 * Failures are never surfaced to the user from here. A Gemini failure is
 * logged and retried against Groq; only if Groq also fails does the error
 * propagate to `assistantService.ts`, which degrades to its generic
 * unavailable message as it always has.
 */

import * as gemini from "./geminiClient.js";
import * as groq from "./llmClient.js";
import type { ConversationTurn, LlmProvider } from "./llmProvider.js";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when EITHER provider is configured.
 *
 * Gemini alone, Groq alone, and both are all valid configurations. With
 * neither, `assistantService.ts` short-circuits to
 * `ASSISTANT_UNAVAILABLE_MESSAGE` exactly as it did before Gemini existed.
 */
export function isConfigured(): boolean {
  return gemini.isConfigured() || groq.isConfigured();
}

export async function generateAnswer(
  systemPrompt: string,
  userPrompt: string,
  history: readonly ConversationTurn[] = [],
): Promise<string> {
  if (gemini.isConfigured()) {
    try {
      return await gemini.generateAnswer(systemPrompt, userPrompt, history);
    } catch (error) {
      if (!groq.isConfigured()) {
        throw error;
      }
      console.warn(`Gemini answer generation failed, falling back to Groq: ${describe(error)}`);
    }
  }

  return groq.generateAnswer(systemPrompt, userPrompt, history);
}

/**
 * Streaming counterpart — with one deliberate restriction.
 *
 * The fallback only happens if Gemini fails BEFORE yielding its first
 * fragment. Once fragments have reached the client the frontend has already
 * rendered partial text, and restarting on Groq would splice two different
 * answers into a single message — a worse outcome than the error the user
 * would otherwise see. So a mid-stream failure propagates, which is exactly
 * what the single-provider implementation did.
 *
 * Nothing is buffered to achieve this: fragments are yielded as they arrive
 * and a flag records whether any escaped. Gemini's own empty-stream guard
 * throws before the first yield, so a stream that produced nothing still
 * falls back cleanly.
 */
export async function* generateAnswerStream(
  systemPrompt: string,
  userPrompt: string,
  history: readonly ConversationTurn[] = [],
): AsyncGenerator<string> {
  if (gemini.isConfigured()) {
    let produced = false;
    try {
      for await (const fragment of gemini.generateAnswerStream(systemPrompt, userPrompt, history)) {
        produced = true;
        yield fragment;
      }
      return;
    } catch (error) {
      if (produced || !groq.isConfigured()) {
        throw error;
      }
      console.warn(`Gemini streaming failed before any output, falling back to Groq: ${describe(error)}`);
    }
  }

  yield* groq.generateAnswerStream(systemPrompt, userPrompt, history);
}

/** Explicit check that this module satisfies the seam's contract. */
const _contract: LlmProvider = { isConfigured, generateAnswer, generateAnswerStream };
void _contract;
