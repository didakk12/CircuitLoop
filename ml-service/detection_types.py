"""
Shared detection value types.

Split out of the former `detection.py` (the local YOLO detector, removed —
Gemini is now the only detector this service runs) so `gemini_detection.py`
has a home for these that doesn't drag in a deleted module.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class BoundingBox:
    x1: int
    y1: int
    x2: int
    y2: int


@dataclass
class Detection:
    class_id: int
    class_name: str  # raw detector label — NOT a ComponentType, see gemini_detection.py's module docstring
    confidence: float
    bbox: BoundingBox
    text: str  # printed marking, read by the detector itself; "" if none legible
    source: str
