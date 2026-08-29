import { z } from "zod";

/**
 * Conversation-history limits.
 *
 * Two separate bounds, doing two different jobs:
 *
 * - `MAX_HISTORY_*` below are *rejection* limits. They exist to stop a client
 *   sending an abusive payload, so exceeding them is a 400, not a silent
 *   truncation — a client that thinks it sent 500 turns should be told it
 *   didn't, rather than quietly having 490 dropped.
 *
 * - `HISTORY_TURNS_SENT_TO_LLM` in assistantService.ts is a *trimming* limit
 *   applied afterwards, keeping only the most recent turns so the prompt stays
 *   bounded regardless of how long the visible thread grows.
 *
 * History is client-supplied and therefore untrusted: it is the user's own
 * transcript replayed from their browser, never something the server stored.
 * It is validated for shape here and treated as ordinary conversation text
 * downstream — it can never widen what the user is allowed to see, because
 * every component access is authorised separately from `component_id`.
 */
export const MAX_HISTORY_MESSAGES = 50;
export const MAX_HISTORY_MESSAGE_CHARS = 4000;
export const MAX_QUESTION_CHARS = 4000;

/**
 * Only `user` and `assistant` turns are representable.
 *
 * `system`/`developer` are deliberately absent rather than filtered: the
 * system prompt is assembled server-side and is the sole carrier of the
 * assistant's policy, so a client-supplied system turn could only ever be an
 * attempt to override it. Zod rejects the whole request with a 400, which is
 * both louder and safer than stripping the message and continuing as though
 * the client had asked for something reasonable.
 */
export const conversationRoleSchema = z.enum(["user", "assistant"]);

export const conversationMessageSchema = z.object({
  role: conversationRoleSchema,
  content: z
    .string()
    .min(1, "history message content must not be empty")
    .max(MAX_HISTORY_MESSAGE_CHARS, `history message content must be at most ${MAX_HISTORY_MESSAGE_CHARS} characters`),
});

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const askAssistantBodySchema = z.object({
  component_id: z.string().min(1, "component_id must not be empty"),
  question: z
    .string()
    .min(1, "question must not be empty")
    .max(MAX_QUESTION_CHARS, `question must be at most ${MAX_QUESTION_CHARS} characters`),
  /**
   * Prior turns of this conversation, oldest first, as the client has them.
   * Optional and defaulted so existing callers (and the non-streaming
   * endpoint used without a thread) keep working unchanged.
   */
  history: z
    .array(conversationMessageSchema)
    .max(MAX_HISTORY_MESSAGES, `history must contain at most ${MAX_HISTORY_MESSAGES} messages`)
    .optional()
    .default([]),
});

export type AskAssistantBody = z.infer<typeof askAssistantBodySchema>;
