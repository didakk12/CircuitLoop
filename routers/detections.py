from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import Component, Scan
from schemas import ComponentResponse, DetectionBatchCreate

router = APIRouter(prefix="/api/detections", tags=["Computer Vision"])


@router.post("", response_model=list[ComponentResponse], status_code=201, summary="Store CV detections")
def create_detections(payload: DetectionBatchCreate, db: Session = Depends(get_db)):
    scan = db.get(Scan, payload.scan_id)
    if scan is None:
        raise HTTPException(status_code=404, detail="Scan not found.")
    components = [
        Component(
            scan_id=scan.id,
            type=detection.type,
            name=detection.name,
            confidence=detection.confidence,
            x1=detection.bbox.x1,
            y1=detection.bbox.y1,
            x2=detection.bbox.x2,
            y2=detection.bbox.y2,
        )
        for detection in payload.detections
    ]
    db.add_all(components)
    db.flush()
    scan.total_components = db.query(Component).filter(Component.scan_id == scan.id).count()
    db.commit()
    for component in components:
        db.refresh(component)
    return components
