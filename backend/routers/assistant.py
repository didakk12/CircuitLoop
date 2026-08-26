from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models import Component
from backend.schemas import AssistantRequest, AssistantResponse
from backend.services.ai_service import answer_question

router = APIRouter(prefix="/api", tags=["Assistant"])


@router.post("/assistant", response_model=AssistantResponse, summary="Ask about a component")
def ask_assistant(request: AssistantRequest, db: Session = Depends(get_db)):
    if db.get(Component, request.component_id) is None:
        raise HTTPException(status_code=404, detail="Component not found.")
    return answer_question(request.component_id, request.question)
