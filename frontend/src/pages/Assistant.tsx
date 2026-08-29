import { AlertTriangle, Bot, Send, User as UserIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, getComponents, streamAssistant, toConversationHistory } from "../api";
import type { ApiComponent } from "../api";
import { useAuth } from "../auth/AuthContext";
import { loadChat, newMessageId, saveChat, type ChatMessage } from "../chatStorage";

/**
 * Connected to the real streaming assistant endpoint (POST
 * /api/assistant/stream). The answer renders as it is generated; the
 * component-scope policy and `OFF_TOPIC_REFUSAL` are enforced server-side
 * and unchanged — an off-topic question simply streams back the refusal.
 *
 * The thread (both sides) is persisted per (user, component) via
 * `chatStorage`, once per completed exchange, and restored on reload.
 */
function Assistant() {
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";

  const [components, setComponents] = useState<ApiComponent[]>([]);
  const [componentId, setComponentId] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    getComponents()
      .then((list) => {
        setComponents(list);
        if (list.length > 0) {
          setComponentId(list[0]!.id);
        }
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof ApiError ? err.message : "Could not load components.");
      });
  }, []);

  const selectedComponent = components.find((c) => c.id === componentId);
  const componentLabel = selectedComponent?.name || selectedComponent?.type || "the selected component";
  const hasComponents = components.length > 0;

  return (
    <main className="page-content">
      <div className="page-heading">
        <p className="eyebrow">AI ASSISTANT</p>
        <h3>CircuitLoop Assistant</h3>
        <p>
          Ask questions about a detected component, its
          technical information, and salvage potential.
        </p>
      </div>

      {loadError && (
        <section className="info-panel info-panel-error">
          <AlertTriangle size={20} />
          <div>
            <strong>Could not load components</strong>
            <p>{loadError}</p>
          </div>
        </section>
      )}

      <section className="chat-panel">
        {hasComponents && (
          <label className="assistant-component-select">
            Component
            <select value={componentId} onChange={(event) => setComponentId(event.target.value)}>
              {components.map((component) => (
                <option value={component.id} key={component.id}>
                  {component.name || component.type} ({component.type})
                </option>
              ))}
            </select>
          </label>
        )}

        {hasComponents && componentId ? (
          // Keyed by component so switching selection remounts the thread —
          // each component's saved conversation loads in the child's state
          // initializer, no synchronising effect required.
          <ComponentChat
            key={`${userId}:${componentId}`}
            userId={userId}
            componentId={componentId}
            componentLabel={componentLabel}
          />
        ) : (
          <div className="chat-thread">
            <div className="chat-welcome">
              <div className="assistant-icon">
                <Bot size={28} />
              </div>
              <h4>How can I help?</h4>
              <p>Scan a PCB first to have components to ask about.</p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

interface ComponentChatProps {
  userId: string;
  componentId: string;
  componentLabel: string;
}

function ComponentChat({ userId, componentId, componentLabel }: ComponentChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadChat(userId, componentId));
  const [question, setQuestion] = useState("");
  const [askError, setAskError] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);

  const threadEndRef = useRef<HTMLDivElement | null>(null);
  // Whether this instance is still on screen, and a handle on the current
  // in-flight stream. Both are only ever touched from the effect below or the
  // submit handler — never during render — so they stay plain refs.
  const mountedRef = useRef(true);
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Set here (not just at ref init) so React's mount → unmount → remount
    // cycle in dev leaves this `true`, not stuck `false`.
    mountedRef.current = true;
    return () => {
      // Real unmount (component switch / leaving the page): stop the in-flight
      // stream and ignore any late callbacks.
      mountedRef.current = false;
      streamAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const handleAsk = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || isAsking) {
      return;
    }

    const userMessage: ChatMessage = { id: newMessageId(), role: "user", content: text };
    const assistantMessage: ChatMessage = { id: newMessageId(), role: "assistant", content: "" };
    const withUserAndPlaceholder = [...messages, userMessage, assistantMessage];

    setMessages(withUserAndPlaceholder);
    setStreamingId(assistantMessage.id);
    setQuestion("");
    setAskError(null);
    setIsAsking(true);

    // Buffer streamed fragments and flush on an animation frame rather than
    // re-rendering per token — pacing stays driven by the real stream, with
    // no artificial delay.
    let answer = "";
    let frame = 0;
    const flush = () => {
      frame = 0;
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMessage.id ? { ...m, content: answer } : m)),
      );
    };
    const scheduleFlush = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(flush);
      }
    };

    const controller = new AbortController();
    streamAbortRef.current = controller;

    // Prior turns of *this* component's thread only. `messages` is this
    // ComponentChat's own state, and the parent keys the component on
    // `${userId}:${componentId}`, so switching component remounts with that
    // component's saved thread — another component's history can never be
    // sent here.
    const history = toConversationHistory(messages);

    try {
      await streamAssistant(
        componentId,
        text,
        {
          onDelta: (fragment) => {
            answer += fragment;
            scheduleFlush();
          },
          onUnavailable: (message) => {
            answer = message;
          },
          onDone: () => {
            /* the accumulated text is the answer */
          },
        },
        controller.signal,
        history,
      );

      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
      if (!mountedRef.current) {
        return;
      }
      const finalMessages = withUserAndPlaceholder.map((m) =>
        m.id === assistantMessage.id ? { ...m, content: answer } : m,
      );
      setMessages(finalMessages);
      saveChat(userId, componentId, finalMessages);
    } catch (err) {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
      if (!mountedRef.current) {
        return;
      }
      // Pre-stream failure (e.g. 404/400): keep the user's message, drop the
      // empty assistant placeholder, surface the error separately.
      const withoutPlaceholder = withUserAndPlaceholder.filter((m) => m.id !== assistantMessage.id);
      setMessages(withoutPlaceholder);
      saveChat(userId, componentId, withoutPlaceholder);
      setAskError(err instanceof ApiError ? err.message : "Something went wrong asking the assistant.");
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
      if (mountedRef.current) {
        setStreamingId(null);
        setIsAsking(false);
      }
    }
  };

  return (
    <>
      <div className="chat-thread">
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <div className="assistant-icon">
              <Bot size={28} />
            </div>
            <h4>How can I help?</h4>
            <p>
              Ask me about {componentLabel} — what it does, how to test it, or how to interpret its
              results.
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`chat-message chat-message-${message.role}`}>
              <div className="chat-avatar">
                {message.role === "assistant" ? <Bot size={16} /> : <UserIcon size={16} />}
              </div>
              <div className="chat-bubble">
                {message.content}
                {streamingId === message.id && <span className="chat-caret" aria-hidden="true" />}
              </div>
            </div>
          ))
        )}

        {askError && (
          <div className="chat-inline-error">
            <AlertTriangle size={15} />
            <span>{askError}</span>
          </div>
        )}

        <div ref={threadEndRef} />
      </div>

      <form className="chat-input" onSubmit={(event) => void handleAsk(event)}>
        <input
          placeholder={`Ask about ${componentLabel}...`}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={isAsking}
        />

        <button type="submit" disabled={!question.trim() || isAsking}>
          <Send size={18} />
        </button>
      </form>
    </>
  );
}

export default Assistant;
