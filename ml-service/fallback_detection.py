"""
The single YOLO fallback stage, used only when Gemini fails.

Detection has exactly two stages (see `/detect` in app.py):

    1. Gemini vision                       — primary
    2. custom YOLO11s + HF YOLOv8s TOGETHER — one combined fallback

This module is stage 2. Both local models run in the same stage and their
outputs are merged into one list; there is no "custom first, then HF"
cascade. Neither model runs at all when Gemini succeeds.

Nothing in `detection.py` is modified: each model still runs through its own
existing `DetectionService.detect()`, keeping its OCR quality gate and box
clamping exactly as they were. This module only decides which detections
survive when the two models describe the same thing twice.
"""

from __future__ import annotations

import logging

from detection import Detection, ModelNotLoadedError, SOURCE_CIRCUITLOOP

logger = logging.getLogger(__name__)

# Standard NMS default, and the same threshold `/detect/compare` was built to
# let overlap be evaluated at. Tunable in one place.
DEFAULT_IOU_THRESHOLD = 0.5

# Source identifier reported for a response served by this stage.
SOURCE_FALLBACK = "yolo_fallback"


class NoFallbackModelsError(RuntimeError):
    """Raised when the fallback stage is invoked with no loaded model at all.

    Only reachable when Gemini has already failed AND neither YOLO checkpoint
    loaded, which is the single case in which detection has nothing left to
    try.
    """


def run_fallback_detection(
    services,
    image_bytes: bytes,
    confidence: float,
    iou_threshold: float = DEFAULT_IOU_THRESHOLD,
) -> list[Detection]:
    """Runs every loaded fallback detector over the same image and merges the
    results into one de-duplicated list.

    Takes whichever services are actually available: both models, or either
    one alone. A model that fails at runtime is logged and skipped rather than
    failing the stage — losing one model's contribution is strictly better
    than losing the detection entirely. The stage fails only when no model
    produced a result and none was usable.
    """
    loaded = [service for service in services if service is not None and service.is_loaded]
    if not loaded:
        raise NoFallbackModelsError(
            "No fallback detection model is loaded (checked: custom YOLO11s, HF YOLOv8s)"
        )

    groups: list[list[Detection]] = []
    failures = 0
    for service in loaded:
        try:
            groups.append(service.detect(image_bytes, confidence=confidence))
        except (ModelNotLoadedError, ValueError):
            # An undecodable image is a client error and must surface as one,
            # not be swallowed into a partial result.
            raise
        except Exception as error:  # noqa: BLE001 — one model failing must not sink the stage
            failures += 1
            logger.warning(
                "Fallback model %s failed and was skipped: %s", service.source, error
            )

    if not groups:
        raise NoFallbackModelsError(
            f"Every fallback detection model failed ({failures} attempted)"
        )

    merged = merge_detections(groups, iou_threshold=iou_threshold)
    logger.info(
        "Fallback stage: %d model(s), %d raw detection(s) -> %d after merge",
        len(groups),
        sum(len(group) for group in groups),
        len(merged),
    )
    return merged


def merge_detections(
    groups: list[list[Detection]], iou_threshold: float = DEFAULT_IOU_THRESHOLD
) -> list[Detection]:
    """Merges several models' detections, removing only genuine duplicates.

    Two detections are duplicates ONLY when BOTH hold:

      * their boxes overlap with IoU >= `iou_threshold`, and
      * their raw `class_name` values match (case-insensitively).

    Overlap alone never suppresses anything. Components on a board are densely
    packed and legitimately overlap — a `resistor` boxed inside the same
    region as an `ic`, or an HF `connector` over a custom `switch`, are two
    real components and both are kept. A merge that dropped the second would
    silently lose a valid detection, which is the exact failure this rule
    exists to prevent.

    The comparison is on the raw `class_name`, not the mapped `ComponentType`:
    several HF labels (`connector`, `pads`, `fuse`, ...) all map to `unknown`
    downstream, so comparing mapped types would collapse genuinely different
    components into one.

    Among true duplicates, one survivor is chosen by SOURCE first, confidence
    second:

      * The custom YOLO11s wins over any other source, regardless of raw
        confidence. Its vocabulary maps losslessly onto `ComponentType`, its
        confidences are calibrated on this project's own data, and scores from
        two independently trained models are not comparable on the same scale
        — so the domain-trained model wins the overlap rather than whichever
        number happens to be larger.
      * Within one source, the higher confidence wins (ordinary greedy NMS).

    Every survivor keeps its own `source`, so a caller can still see which
    model produced each box.
    """
    flat = [detection for group in groups for detection in group]
    if len(flat) < 2:
        return list(flat)

    # Greedy NMS: the custom model's detections are considered first so that
    # they claim their region before any competing HF box is examined, which
    # is what makes the source preference hold independently of confidence.
    ordered = sorted(
        flat,
        key=lambda d: (d.source != SOURCE_CIRCUITLOOP, -d.confidence),
    )

    kept: list[Detection] = []
    for candidate in ordered:
        if any(_is_duplicate(candidate, existing, iou_threshold) for existing in kept):
            continue
        kept.append(candidate)

    return kept


def _is_duplicate(a: Detection, b: Detection, iou_threshold: float) -> bool:
    """Same component, same place — the only condition under which the merge
    is allowed to discard a detection."""
    if a.class_name.strip().lower() != b.class_name.strip().lower():
        return False
    return iou(a, b) >= iou_threshold


def iou(a: Detection, b: Detection) -> float:
    """Intersection over union of two detections' boxes; 0.0 when disjoint."""
    ax1, ay1, ax2, ay2 = a.bbox.x1, a.bbox.y1, a.bbox.x2, a.bbox.y2
    bx1, by1, bx2, by2 = b.bbox.x1, b.bbox.y1, b.bbox.x2, b.bbox.y2

    inter_width = min(ax2, bx2) - max(ax1, bx1)
    inter_height = min(ay2, by2) - max(ay1, by1)
    if inter_width <= 0 or inter_height <= 0:
        return 0.0

    intersection = inter_width * inter_height
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - intersection
    return intersection / union if union > 0 else 0.0
