from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models import Component, Scan
from backend.schemas import DashboardStats

router = APIRouter(prefix="/api/dashboard", tags=["Dashboard"])


@router.get("/stats", response_model=DashboardStats, summary="Get dashboard statistics")
def get_stats(db: Session = Depends(get_db)):
    counts = dict(db.query(Component.status, func.count(Component.id)).group_by(Component.status).all())
    return DashboardStats(
        total_scans=db.query(Scan).count(),
        total_components=db.query(Component).count(),
        tested_components=counts.get("pass", 0) + counts.get("fail", 0),
        passed_components=counts.get("pass", 0),
        failed_components=counts.get("fail", 0),
        not_tested_components=counts.get("not_tested", 0),
        average_ai_confidence=db.query(func.avg(Component.confidence)).scalar(),
    )
