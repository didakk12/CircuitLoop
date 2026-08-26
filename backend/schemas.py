from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ScanCreate(BaseModel):
    image_path: str | None = None


class ComponentCreate(BaseModel):
    scan_id: int | None = None
    type: str = Field(min_length=1)
    name: str | None = None
    confidence: float = Field(ge=0, le=1)
    x1: float | None = None
    y1: float | None = None
    x2: float | None = None
    y2: float | None = None


class TestResultCreate(BaseModel):
    expected_value: float | None = None
    measured_value: float | None = None
    unit: str | None = None
    status: Literal["pass", "fail", "not_tested"]

    @model_validator(mode="after")
    def require_measurement_for_tested_result(self):
        if self.status in {"pass", "fail"} and self.measured_value is None:
            raise ValueError("measured_value is required for pass or fail results")
        return self


class TestResultResponse(TestResultCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int
    component_id: int
    timestamp: datetime


class ComponentResponse(ComponentCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int
    status: str
    created_at: datetime
    test_results: list[TestResultResponse] = Field(default_factory=list)


class ScanResponse(ScanCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int
    timestamp: datetime
    total_components: int
    components: list[ComponentResponse] = Field(default_factory=list)


class DetectionBoundingBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float


class DetectionCreate(BaseModel):
    type: str = Field(min_length=1)
    name: str | None = None
    confidence: float = Field(ge=0, le=1)
    bbox: DetectionBoundingBox


class DetectionBatchCreate(BaseModel):
    scan_id: int
    detections: list[DetectionCreate] = Field(min_length=1)


class DashboardStats(BaseModel):
    total_scans: int
    total_components: int
    tested_components: int
    passed_components: int
    failed_components: int
    not_tested_components: int
    average_ai_confidence: float | None


class AssistantRequest(BaseModel):
    component_id: int
    question: str = Field(min_length=1)


class AssistantResponse(BaseModel):
    component_id: int
    configured: bool
    message: str
