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
 * Switching LLM provider later = write a new adapter module exposing those
 * functions (mirroring llmClient.ts) and change the single re-export below
 * to point at it. No other file changes, and none of the component-relevance
 * logic is touched.
 */

export type { ConversationTurn, LlmProvider } from "./llmClient.js";
export { isConfigured, generateAnswer, generateAnswerStream } from "./llmClient.js";
