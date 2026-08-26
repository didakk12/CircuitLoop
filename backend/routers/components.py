from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, selectinload

from backend.database import get_db
from backend.models import Component, Scan
from backend.schemas import ComponentCreate, ComponentResponse

router = APIRouter(prefix="/api/components", tags=["Components"])


def find_component(component_id: int, db: Session) -> Component:
    component = (
        db.query(Component)
        .options(selectinload(Component.test_results))
        .filter(Component.id == component_id)
        .first()
    )
    if component is None:
        raise HTTPException(status_code=404, detail="Component not found.")
    return component


@router.post("", response_model=ComponentResponse, status_code=201, summary="Create a detected component")
def create_component(component: ComponentCreate, db: Session = Depends(get_db)):
    if component.scan_id is not None and db.get(Scan, component.scan_id) is None:
        raise HTTPException(status_code=404, detail="Scan not found.")
    new_component = Component(**component.model_dump())
    db.add(new_component)
    db.commit()
    db.refresh(new_component)
    return new_component


@router.get("", response_model=list[ComponentResponse], summary="List detected components")
def get_components(db: Session = Depends(get_db)):
    return db.query(Component).options(selectinload(Component.test_results)).order_by(Component.id).all()


@router.get("/{component_id}", response_model=ComponentResponse, summary="Get a component with test results")
def get_component(component_id: int, db: Session = Depends(get_db)):
    return find_component(component_id, db)


@router.put("/{component_id}", response_model=ComponentResponse, summary="Update component information")
def update_component(component_id: int, updates: ComponentCreate, db: Session = Depends(get_db)):
    component = find_component(component_id, db)
    if updates.scan_id is not None and db.get(Scan, updates.scan_id) is None:
        raise HTTPException(status_code=404, detail="Scan not found.")
    for key, value in updates.model_dump().items():
        setattr(component, key, value)
    db.commit()
    db.refresh(component)
    return component


@router.delete("/{component_id}", status_code=204, summary="Delete a component")
def delete_component(component_id: int, db: Session = Depends(get_db)):
    component = find_component(component_id, db)
    scan = db.get(Scan, component.scan_id) if component.scan_id else None
    db.delete(component)
    db.commit()
    if scan:
        scan.total_components = db.query(Component).filter(Component.scan_id == scan.id).count()
        db.commit()
    return None
