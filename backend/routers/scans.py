from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, selectinload

from backend.database import get_db
from backend.models import Scan
from backend.schemas import ScanCreate, ScanResponse

router = APIRouter(prefix="/api/scans", tags=["Scans"])


@router.post("", response_model=ScanResponse, status_code=201, summary="Create a scan")
def create_scan(scan: ScanCreate, db: Session = Depends(get_db)):
    new_scan = Scan(image_path=scan.image_path)
    db.add(new_scan)
    db.commit()
    db.refresh(new_scan)
    return new_scan


@router.get("", response_model=list[ScanResponse], summary="List scans")
def get_scans(db: Session = Depends(get_db)):
    return db.query(Scan).options(selectinload(Scan.components)).order_by(Scan.timestamp.desc()).all()


@router.get("/{scan_id}", response_model=ScanResponse, summary="Get a scan with detections")
def get_scan(scan_id: int, db: Session = Depends(get_db)):
    scan = db.query(Scan).options(selectinload(Scan.components)).filter(Scan.id == scan_id).first()
    if scan is None:
        raise HTTPException(status_code=404, detail="Scan not found.")
    return scan
