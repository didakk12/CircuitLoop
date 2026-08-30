"""
YOLO + OCR detection, refactored from the original CLI script
(`rag/scripts/yolo_ocr.py`, branch-only on `origin/RAG`/`origin/rag-integration`
— see ML_SERVICE_INTEGRATION_PLAN.md §9 Phase 1) into an importable,
service-callable module.

Changes from the original CLI script (all per ML_SERVICE_INTEGRATION_PLAN.md):
- Accepts in-memory image bytes (what an HTTP upload gives you), not only a
  file path — the original `extract_detected_text()` took a path.
- The model is loaded once, lazily, and reused across calls — not reloaded
  per call (§3's whole rationale for choosing an internal HTTP service over
  process-per-request).
- Per-box OCR failure no longer fails the whole request — an exception
  decoding one crop is caught, logged, and recorded as `text: ""` for that
  box only (§8's "partial detection failures" requirement).
- Returns raw YOLO `class_name` values exactly as the model produced them —
  no mapping to the TypeScript `ComponentType` enum happens here. That
  mapping is deliberately NOT implemented yet: see the class-list-vs-enum
  mismatch recorded in this phase's report. Mapping is TypeScript's
  responsibility per §2/§5 once that mismatch is resolved.

The original CLI entry point is preserved at the bottom for manual testing
(`python detection.py --image path/to/photo.jpg`), reusing the exact same
functions the future FastAPI endpoint will call — no duplicated logic.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np
import pytesseract
from ultralytics import YOLO

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL_PATH = PROJECT_ROOT / "models" / "pcb_yolo11s_best.pt"
DEFAULT_CONFIDENCE = 0.25

# Second, complementary detector — a pretrained YOLOv8s PCB model with 21 classes
# (https://huggingface.co/Arshia82sbn/pcb-yolov8s-detection). It exists purely for
# side-by-side benchmarking against DEFAULT_MODEL_PATH and does NOT participate in
# `/detect`, which still serves the original model alone. Nothing is merged,
# suppressed or ensembled yet — see `/detect/compare` in app.py.
HF_MODEL_PATH = PROJECT_ROOT / "models" / "pcb_yolov8s_hf_best.pt"

# Stable identifiers for attributing a detection to the model that produced it.
SOURCE_CIRCUITLOOP = "circuitloop_yolo11s"
SOURCE_HF = "hf_yolov8s"

# --- OCR quality gate -------------------------------------------------------
#
# These thresholds are calibrated from measurements, not convention. The
# numbers quoted below were produced by running this module's exact
# preprocessing + `pytesseract.image_to_data` over three populations:
# rendered legitimate markings, synthetic plastic-like texture, and the real
# YOLO crops from `frontend/src/assets/hero.png`.
#
# The problem being solved: `image_to_string` discards per-word confidence, so
# every hallucination Tesseract produced on a featureless component body was
# stored verbatim as the component's `name` (e.g. a switch named "es"),
# shadowing the correct YOLO class in the UI.
#
# NOTE: none of these rules look at letter case. Tesseract alters capitalisation
# on its own (measured: "SW1" -> "Swi"), and legitimate markings may be
# lowercase, so a case-based rule would be a capitalisation policy rather than a
# quality gate. See `_filter_ocr_words`.

# Below this, a crop has too few pixels to carry a glyph even after the 2x
# upscale. The real hero.png boxes at 3x5, 3x4 and 12x131 px produced nothing
# but noise.
MIN_OCR_CROP_PIXELS = 16

# Per-word confidence floor, sitting in the measured gap between junk and real
# text: junk reads scored 17 ("es" — the originally reported name), 20 ("bane",
# "a"); the weakest *legitimate* markings scored 27 ("SW1"), 30 ("LM358"),
# 33 ("220uF"). A conventional 60 floor would have rejected all three of those.
# Tesseract also reports -1 for non-text rows, which this floor discards.
MIN_OCR_WORD_CONFIDENCE = 25

# A word must be *strictly more* than this fraction alphanumeric — i.e. a clear
# majority, so a half-punctuation token like "P'" or "1," fails. Catches the
# *high*-confidence punctuation a confidence floor alone misses: ">" scored 76
# and 78, ";" scored 77. Every legitimate marking measured sat at 0.67 or above
# even when Tesseract appended an artefact ("C1;" -> 2/3).
MIN_OCR_ALPHANUMERIC_RATIO = 0.5

# Fraction of the crop's words that must survive the two per-word rules above.
# A genuine marking reads as one coherent word; a hallucination sprays
# fragments — the real hero.png buzzer crop emitted 23 words at mean confidence
# 31, of which only 7 survived. A crop that mostly failed was never text, so the
# surviving fragments are discarded too rather than being concatenated into a
# plausible-looking name.
MIN_OCR_WORD_KEEP_RATIO = 0.5

if tesseract_command := os.getenv("TESSERACT_CMD"):
    pytesseract.pytesseract.tesseract_cmd = tesseract_command
elif os.name == "nt":
    default_tesseract = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")
    if default_tesseract.exists():
        pytesseract.pytesseract.tesseract_cmd = str(default_tesseract)


@dataclass
class BoundingBox:
    x1: int
    y1: int
    x2: int
    y2: int


@dataclass
class Detection:
    class_id: int
    class_name: str  # raw YOLO label — NOT a ComponentType, see module docstring
    confidence: float
    bbox: BoundingBox
    text: str  # OCR result for this box; "" if OCR found nothing, read nothing credible, or failed (see _ocr_crop)
    # Which model produced this detection. Defaults to the original detector so
    # every existing caller and the `/detect` response are unaffected; the
    # comparison endpoint sets it explicitly per model.
    source: str = SOURCE_CIRCUITLOOP


class ModelNotLoadedError(RuntimeError):
    """Raised when detection is attempted before the model has successfully loaded."""


class DetectionService:
    """Loads the YOLO model once and serves detection requests against it.

    One instance is created at application startup (Phase 2's `app.py`) and
    reused for the process's lifetime — this is the object that keeps the
    model "warm" in memory, which is the entire reason this runs as a
    long-lived service instead of a per-request CLI invocation (see
    ML_SERVICE_INTEGRATION_PLAN.md §3).
    """

    def __init__(self, model_path: Path = DEFAULT_MODEL_PATH, source: str = SOURCE_CIRCUITLOOP) -> None:
        self._model_path = model_path
        self._model: YOLO | None = None
        # Tags every Detection this instance produces, so results from two
        # concurrently-loaded models stay independently attributable.
        self._source = source
        # Set the first time `ensure_loaded()` runs, whether or not it
        # succeeded — this is what stops a broken/missing weights file from
        # being retried (and re-logged) on every single fallback request.
        self._load_attempted = False

    @property
    def source(self) -> str:
        return self._source

    @property
    def model_path(self) -> Path:
        return self._model_path

    def load(self) -> None:
        """Loads the model. Call once at startup; raises if the weights file is missing/invalid."""
        if not self._model_path.exists():
            raise FileNotFoundError(f"YOLO model weights not found at {self._model_path}")
        self._model = YOLO(str(self._model_path))
        logger.info("YOLO model loaded from %s (classes: %s)", self._model_path, self._model.names)

    def ensure_loaded(self) -> None:
        """Loads the model on first use rather than at startup.

        The fallback stage is only ever reached once Gemini has already
        failed, so paying this model's load cost (disk I/O + RAM) at process
        startup — before it's known whether it will ever be needed — is pure
        waste on a memory-constrained deployment. A failed attempt sets
        `_load_attempted` so it is logged once and never retried per request
        (matching the eager path's original "log and move on" behavior),
        rather than re-attempting a broken/missing weights file on every
        fallback-triggered request.
        """
        if self._model is not None or self._load_attempted:
            return
        self._load_attempted = True
        try:
            self.load()
        except Exception as error:  # noqa: BLE001 — a lazy load failure must not crash the request
            logger.warning(
                "Lazy load of the %s model failed (%s); it will be skipped in the fallback stage.",
                self._source,
                error,
            )

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def class_names(self) -> dict[int, str]:
        """The model's real class-name mapping — see this phase's report for the full, verified list."""
        if self._model is None:
            raise ModelNotLoadedError("Call load() before accessing class_names")
        return self._model.names

    def detect(self, image_bytes: bytes, confidence: float = DEFAULT_CONFIDENCE) -> list[Detection]:
        if self._model is None:
            raise ModelNotLoadedError("Call load() before detect()")

        image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("Could not decode image bytes — not a valid image file")

        result = self._model.predict(source=image, conf=confidence, verbose=False)[0]
        detections: list[Detection] = []

        for box in result.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
            x1 = max(0, min(x1, image.shape[1]))
            y1 = max(0, min(y1, image.shape[0]))
            x2 = max(x1, min(x2, image.shape[1]))
            y2 = max(y1, min(y2, image.shape[0]))

            crop = image[y1:y2, x1:x2]
            class_id = int(box.cls[0])

            detections.append(
                Detection(
                    class_id=class_id,
                    class_name=result.names[class_id],
                    confidence=float(box.conf[0]),
                    bbox=BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2),
                    text=_ocr_crop(crop),
                    source=self._source,
                )
            )

        return detections


def _is_word_credible(text: str, confidence: float) -> bool:
    """Per-word gate: is this token plausibly real printed text rather than
    Tesseract's best guess at a shadow?

    Deliberately case-insensitive — see the note on the threshold constants.
    """
    if confidence < MIN_OCR_WORD_CONFIDENCE:
        return False

    visible = [character for character in text if not character.isspace()]
    if not visible:
        return False

    alphanumeric_ratio = sum(character.isalnum() for character in visible) / len(visible)
    return alphanumeric_ratio > MIN_OCR_ALPHANUMERIC_RATIO


def _filter_ocr_words(texts: list[str], confidences: list[float]) -> str:
    """Turn raw `image_to_data` output into a trustworthy marking, or "".

    Pure function over plain lists — no OpenCV, no Tesseract — so the quality
    rules can be tested directly without the binary installed.

    Whitespace is normalised to single spaces, which also collapses the
    embedded newlines that previously produced names like "ion\\nrat".
    """
    candidates = [
        (text.strip(), confidence)
        for text, confidence in zip(texts, confidences)
        if text.strip()
    ]
    if not candidates:
        return ""

    credible = [(text, confidence) for text, confidence in candidates if _is_word_credible(text, confidence)]
    if not credible:
        return ""

    # A crop where most words failed was never text to begin with; keeping the
    # survivors would just launder a few fragments into a plausible name.
    if len(credible) / len(candidates) < MIN_OCR_WORD_KEEP_RATIO:
        return ""

    return " ".join(text for text, _ in credible)


def _ocr_crop(crop: np.ndarray) -> str:
    """OCR a single detected region, returning "" unless the read is credible.

    Never raises — a failure here (including Tesseract not being installed) is
    isolated to this one box, per ML_SERVICE_INTEGRATION_PLAN.md §8: one bad
    crop shouldn't fail the whole detection request.

    Uses `image_to_data` rather than `image_to_string` specifically so per-word
    confidence is available to filter on; `image_to_string` discards it.
    """
    if crop.size == 0 or min(crop.shape[:2]) < MIN_OCR_CROP_PIXELS:
        return ""
    try:
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        processed = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
        data = pytesseract.image_to_data(processed, config="--psm 6", output_type=pytesseract.Output.DICT)
        confidences = [float(confidence) for confidence in data["conf"]]
        return _filter_ocr_words(list(data["text"]), confidences)
    except Exception as error:  # noqa: BLE001 — intentionally broad: OCR must never take down detection
        logger.warning("OCR failed for one detected region, continuing without its text: %s", error)
        return ""


def _cli() -> None:
    """Manual test entry point — preserves the original script's CLI usage,
    calling the exact same DetectionService the FastAPI endpoint will use."""
    parser = argparse.ArgumentParser(description="Run YOLO detection + OCR on an image (manual test tool)")
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument("--confidence", type=float, default=DEFAULT_CONFIDENCE)
    args = parser.parse_args()

    if not args.image.exists():
        raise SystemExit(f"Image not found: {args.image}")

    service = DetectionService(model_path=args.model)
    service.load()
    detections = service.detect(args.image.read_bytes(), confidence=args.confidence)

    print(json.dumps([asdict(d) for d in detections], indent=2, ensure_ascii=False))


if __name__ == "__main__":
    _cli()
