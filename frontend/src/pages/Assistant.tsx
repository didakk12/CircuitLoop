import { AlertTriangle, Bot, Send } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, askAssistant, getComponents } from "../api";
import type { ApiAssistantResponse, ApiComponent } from "../api";

/**
 * Connected to the real POST /api/assistant (Phase 6). `configured: false`
 * in the response means the backend has no LLM provider set up yet — an
 * intentionally undecided project requirement (ML_SERVICE_INTEGRATION_PLAN.md
 * §6) — in which case `message` is still real, retrieval-based content
 * assembled from the component's data and the matching datasheet excerpts,
 * never a fabricated answer. That state is shown to the user honestly
 * rather than hidden.
 */
function Assistant() {
  const [components, setComponents] = useState<ApiComponent[]>([]);
  const [componentId, setComponentId] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<ApiAssistantResponse | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);

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

  const handleAsk = async (event: FormEvent) => {
    event.preventDefault();
    if (!componentId || !question.trim() || isAsking) {
      return;
    }

    setIsAsking(true);
    setAskError(null);

    try {
      const response = await askAssistant(componentId, question.trim());
      setAnswer(response);
    } catch (err) {
      setAskError(err instanceof ApiError ? err.message : "Something went wrong asking the assistant.");
    } finally {
      setIsAsking(false);
    }
  };

  const selectedComponent = components.find((c) => c.id === componentId);

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
        {components.length > 0 && (
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

        {!answer && !askError && (
          <div className="chat-welcome">
            <div className="assistant-icon">
              <Bot size={28} />
            </div>

            <h4>How can I help?</h4>

            <p>
              {components.length > 0
                ? `Ask me about ${selectedComponent?.name || selectedComponent?.type || "the selected component"} — what it does, how to test it, or how to interpret its results.`
                : "Scan a PCB first to have components to ask about."}
            </p>
          </div>
        )}

        {askError && (
          <div className="chat-welcome">
            <div className="assistant-icon">
              <AlertTriangle size={28} />
            </div>
            <h4>Something went wrong</h4>
            <p>{askError}</p>
          </div>
        )}

        {answer && !askError && (
          <div className="chat-welcome">
            <div className="assistant-icon">
              <Bot size={28} />
            </div>
            {!answer.configured && (
              <p style={{ marginBottom: "10px" }}>
                <em>No AI generation provider is configured yet — showing the relevant information found instead.</em>
              </p>
            )}
            <p style={{ whiteSpace: "pre-wrap", textAlign: "left" }}>{answer.message}</p>
          </div>
        )}

        <form className="chat-input" onSubmit={(event) => void handleAsk(event)}>
          <input
            placeholder={components.length > 0 ? "Ask CircuitLoop..." : "Add a component first"}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={components.length === 0 || isAsking}
          />

          <button type="submit" disabled={components.length === 0 || !question.trim() || isAsking}>
            <Send size={18} />
          </button>
        </form>
      </section>
    </main>
  );
}

export default Assistant;
