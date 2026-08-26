import os

from schemas import AssistantResponse


def answer_question(component_id: int, question: str) -> AssistantResponse:
    """Provide the integration boundary for a future RAG/agent implementation."""
    del question
    configured = bool(os.getenv("CIRCUITLOOP_AI_API_KEY"))
    message = "AI assistant is configured for integration." if configured else "AI assistant is not configured yet."
    return AssistantResponse(component_id=component_id, configured=configured, message=message)
