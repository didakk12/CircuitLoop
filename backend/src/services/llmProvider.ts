/**
 * The provider-agnostic seam for LLM answer generation.
 *
 * The rest of the application (assistantService.ts) depends only on this
 * module and this shape:
 *
 *   isConfigured(): boolean
 *   generateAnswer(systemPrompt, userPrompt, history?): Promise<string>
 *   generateAnswerStream(systemPrompt, userPrompt, history?): AsyncGenerator<string>
 *
 * `history` is the bounded, validated list of prior conversation turns
 * (Phase 3). Adapters send it as real conversation turns between the system
 * prompt and the current question.
 *
 * `systemPrompt` is always `COMPONENT_SCOPE_SYSTEM_PROMPT` from
 * assistantPrompt.ts — the component-scope / relevance policy lives there,
 * never in a provider adapter.
 *
 * Behind this seam sits `llmFallback.ts`, which chains two adapters:
 *
 *   Gemini (geminiClient.ts)  — primary
 *   Groq   (llmClient.ts)     — fallback, used only when Gemini fails
 *
 * The types below live here rather than in an adapter because they describe
 * the seam itself, not any one provider. Adding or reordering providers is a
 * change to `llmFallback.ts` and this one re-export; no other file changes,
 * and none of the component-relevance logic is touched.
 */

/**
 * One prior turn of the conversation. Only `user` and `assistant` exist —
 * the system prompt is assembled server-side and is never client-supplied.
 * (Adapters map `assistant` onto whatever their provider calls that role.)
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

export { isConfigured, generateAnswer, generateAnswerStream } from "./llmFallback.js";
