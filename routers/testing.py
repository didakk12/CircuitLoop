from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import Component, TestResult
from schemas import TestResultCreate, TestResultResponse

router = APIRouter(prefix="/api/components", tags=["Testing"])


@router.post("/{component_id}/test", response_model=TestResultResponse, status_code=201, summary="Record a component test")
def create_test_result(component_id: int, result: TestResultCreate, db: Session = Depends(get_db)):
    component = db.get(Component, component_id)
    if component is None:
        raise HTTPException(status_code=404, detail="Component not found.")
    new_result = TestResult(component_id=component_id, **result.model_dump())
    component.status = result.status
    db.add(new_result)
    db.commit()
    db.refresh(new_result)
    return new_result


@router.get("/{component_id}/test-result", response_model=TestResultResponse, summary="Get the latest test result")
def get_latest_test_result(component_id: int, db: Session = Depends(get_db)):
    if db.get(Component, component_id) is None:
        raise HTTPException(status_code=404, detail="Component not found.")
    result = (
        db.query(TestResult)
        .filter(TestResult.component_id == component_id)
        .order_by(TestResult.timestamp.desc(), TestResult.id.desc())
        .first()
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Test result not found.")
    return result
