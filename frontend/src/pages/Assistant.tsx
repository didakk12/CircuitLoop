import { Bot, Send } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { askAssistant, getComponents } from "../api";
import type { ApiComponent } from "../api";

function Assistant() {
  const [components, setComponents] = useState<ApiComponent[]>([]);
  const [componentId, setComponentId] = useState<number | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    getComponents()
      .then((loadedComponents) => {
        setComponents(loadedComponents);
        setComponentId(loadedComponents[0]?.id ?? null);
      })
      .catch((requestError: Error) => setError(requestError.message));
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!componentId || !question.trim()) return;

    setIsLoading(true);
    setError(null);
    try {
      const response = await askAssistant(componentId, question.trim());
      setAnswer(response.message);
      setQuestion("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Request failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="page-content">
      <div className="page-heading">
        <p className="eyebrow">AI ASSISTANT</p>
        <h3>CircuitLoop Assistant</h3>
        <p>
          Ask questions about detected components, their
          technical information, and salvage potential.
        </p>
      </div>

      <section className="chat-panel">
        <div className="chat-welcome">
          <div className="assistant-icon">
            <Bot size={28} />
          </div>

          <h4>How can I help?</h4>

          <p>
            Ask me which components to salvage, what a component
            does, or how its test results should be interpreted.
          </p>
        </div>

        {components.length > 0 && (
          <label>
            Component
            <select
              value={componentId ?? ""}
              onChange={(event) => setComponentId(Number(event.target.value))}
            >
              {components.map((component) => (
                <option value={component.id} key={component.id}>
                  {component.name ?? `${component.type} #${component.id}`}
                </option>
              ))}
            </select>
          </label>
        )}

        {answer && <p>{answer}</p>}
        {error && <p>{error}</p>}

        <form className="chat-input" onSubmit={handleSubmit}>
          <input
            placeholder={components.length ? "Ask CircuitLoop..." : "Add a component first"}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={!componentId || isLoading}
          />

          <button type="submit" disabled={!componentId || !question.trim() || isLoading}>
            <Send size={18} />
          </button>
        </form>
      </section>
    </main>
  );
}

export default Assistant;