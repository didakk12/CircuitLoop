import { Bot, Send } from "lucide-react";

function Assistant() {
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

        <div className="chat-input">
          <input placeholder="Ask CircuitLoop..." />

          <button>
            <Send size={18} />
          </button>
        </div>
      </section>
    </main>
  );
}

export default Assistant;