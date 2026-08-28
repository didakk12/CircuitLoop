/**
 * Per-session persistence for the AI Assistant chat.
 *
 * Conversations are scoped to (signed-in user, selected component) and kept
 * in `localStorage`, so a page reload — or coming back to the Assistant
 * later in the same session — restores the thread. Persistence is
 * best-effort: any storage failure (private mode, quota) degrades to "no
 * history" rather than breaking the chat.
 *
 * The whole thread is written once per completed exchange (see
 * `pages/Assistant.tsx`), never per streamed token.
 */

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const KEY_PREFIX = "circuitloop.chat";

function keyFor(userId: string, componentId: string): string {
  return `${KEY_PREFIX}.${userId}.${componentId}`;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string"
  );
}

export function loadChat(userId: string, componentId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(keyFor(userId, componentId));
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isChatMessage) : [];
  } catch {
    return [];
  }
}

export function saveChat(userId: string, componentId: string, messages: ChatMessage[]): void {
  try {
    localStorage.setItem(keyFor(userId, componentId), JSON.stringify(messages));
  } catch {
    // Storage unavailable or full — history is a convenience, not a requirement.
  }
}

/** Stable id for a chat message, so streamed updates always target the same entry. */
export function newMessageId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
