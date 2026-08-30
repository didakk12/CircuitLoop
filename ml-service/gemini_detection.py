"""
Gemini vision detection — the ONLY component detector this service runs.

A local YOLO fallback stage (`detection.py`/`fallback_detection.py`) used to
run when this raised `GeminiUnavailableError`; it was removed to keep this
service's memory footprint small on a constrained deployment, so a
`GeminiUnavailableError` now surfaces to `/detect`'s caller directly as a 503
rather than being caught and retried.

Design notes:

- It returns the `Detection`/`BoundingBox` dataclasses from `detection_types.py`
  verbatim, so the wire contract downstream (`schemas.py`,
  `backend/src/types/mlService.ts`, `detectionService.ts`, the Neo4j
  `Component` nodes, the `Analysis.tsx` overlay) is unchanged.

- Gemini returns boxes as `[ymin, xmin, ymax, xmax]` normalised to 0-1000,
  which is why the real pixel dimensions are read from the decoded image and
  the boxes converted and clamped here — the rest of the system stores and
  renders pixel coordinates.

- No Tesseract call: Gemini reads the printed marking itself and returns it in
  `text`, the same field an OCR gate used to fill on the now-removed YOLO path.

- `label` and `text` answer two different questions, and the prompt and the
  response schema's field descriptions both say so explicitly. `label` is the
  component TYPE, decided from visual evidence — shape, package, pins,
  connectors, symbols, context. `text` is what is PRINTED on the part —
  manufacturer, model, part number, value. A brand name must never become the
  label: a Cisco-branded box full of RJ45 ports is `label="network switch"`,
  `text="CISCO SG300-52 ..."`, never `label="cisco"`. Text is supporting
  evidence for the type, never the source of it.

- The label vocabulary is deliberately OPEN. Gemini is asked for the most
  specific technically meaningful name for whatever it can actually see, and
  the response schema types `label` as a plain string with no enum, so a
  `potentiometer`, `mosfet`, `crystal` or `connector` comes back named as
  such. The label is stored verbatim in `class_name`; it is never rewritten to
  `unknown` just because the backend has no matching `ComponentType`.
  Narrowing to the 13-value union is a DOWNSTREAM mapping concern —
  `mapClassNameToComponentType` in `detectionService.ts` resolves an unmapped
  label to the `unknown` ComponentType while `class_name` keeps what Gemini
  said. That keeps the detector's recall independent of the storage schema,
  and still gives the local models' blind spots (`led`, `diode`,
  `transistor`, `microcontroller`) first-class coverage.

The API key is read from the environment (`GEMINI_API_KEY`, via `config.py`),
sent only as this request's own `x-goog-api-key` header, and is never logged,
echoed, or included in a raised error.
"""

from __future__ import annotations

import base64
import json
import logging
import re
from pathlib import Path

import cv2
import httpx
import numpy as np

from detection_types import BoundingBox, Detection

logger = logging.getLogger(__name__)

GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

# Stable identifier attributing a detection to this model.
SOURCE_GEMINI = "gemini"

# Gemini normalises bounding boxes to this range on both axes.
GEMINI_BOX_SCALE = 1000

# The backend's complete ComponentType union (backend/src/types/entities.ts).
# NOT a restriction on what Gemini may return — it is only the set of labels
# that have a stable `class_id`. Any other label Gemini produces is kept
# verbatim and carries UNMAPPED_CLASS_ID.
COMPONENT_LABELS: tuple[str, ...] = (
    "resistor",
    "capacitor",
    "led",
    "diode",
    "transistor",
    "ic",
    "microcontroller",
    "battery",
    "buzzer",
    "display",
    "relay",
    "switch",
    "unknown",
)

# `class_id` for a label outside COMPONENT_LABELS. Detections are consumed by
# `class_name` everywhere downstream (schemas.py sends no id at all), so this is
# purely a marker that the label has no fixed index — never a reason to drop or
# rename the detection.
UNMAPPED_CLASS_ID = -1

# Illustrative only. These are named in the prompt to show the KIND of
# specificity wanted; they are explicitly not an allowlist, and the response
# schema does not constrain `label` to them.
EXAMPLE_LABELS: tuple[str, ...] = (
    "resistor",
    "capacitor",
    "led",
    "diode",
    "transistor",
    "ic",
    "microcontroller",
    "switch",
    "push button",
    "relay",
    "connector",
    "potentiometer",
    "fuse",
    "crystal",
    "oscillator",
    "transformer",
    "mosfet",
    "inductor",
    "sensor",
    "voltage regulator",
    "battery",
    "buzzer",
    "display",
    "heatsink",
)

# Words that genuinely NAME a component type, used only by
# `_label_was_lifted_from_the_marking` to tell "the printed type name" apart
# from "a brand or part number lifted out of the printing". Not an allowlist:
# the vocabulary is still open, and a label absent from this set is accepted
# unchanged unless it can be shown to come verbatim from the marking.
COMPONENT_TYPE_VOCABULARY: frozenset[str] = frozenset(COMPONENT_LABELS) | frozenset(
    EXAMPLE_LABELS
) | frozenset(
    {
        "network switch",
        "ethernet switch",
        "router",
        "modem",
        "power supply",
        "psu",
        "hub",
        "chip",
        "integrated circuit",
        "resistor network",
        "capacitor bank",
        "toggle switch",
        "dip switch",
        "slide switch",
        "rotary switch",
        "tactile switch",
        "button",
        "jumper",
        "socket",
        "header",
        "port",
        "rj45 port",
        "usb port",
        "terminal block",
        "screw terminal",
        "antenna",
        "speaker",
        "microphone",
        "motor",
        "servo",
        "fan",
        "clock",
        "resonator",
        "varistor",
        "thermistor",
        "optocoupler",
        "voltage regulator",
        "regulator",
        "rectifier",
        "bridge rectifier",
        "zener diode",
        "schottky diode",
        "led display",
        "seven segment display",
        "lcd",
        "oled",
        "switch module",
        "relay module",
        "sensor module",
        "module",
        "board",
        "pcb",
    }
)

DETECTION_PROMPT = (
    "You are analysing a photograph of electronic hardware: a printed circuit board, an "
    "assembly, a module, or a complete piece of equipment.\n"
    "Detect EVERY visible electronic component or device, without exception.\n"
    "\n"
    "THE MOST IMPORTANT RULE: `label` is WHAT THE THING IS. `text` is WHAT IS PRINTED "
    "ON IT. These are two different fields and must never be mixed up.\n"
    "\n"
    "Work in TWO SEPARATE PASSES for every object, in this order:\n"
    "PASS 1 — VISUAL: look at the physical object and ignore all printed text "
    "completely, as if every marking were blurred out. Describe what you see in "
    "`visual_description` (shape, size, package and body style, pins, leads, terminals, "
    "ports, colour, material, polarity or pin-1 marks, position), then write the "
    "component type that this physical evidence implies into `label`.\n"
    "PASS 2 — MARKINGS: only now read the printed text on that same object and "
    "transcribe it into `text`.\n"
    "PASS 2 MUST NEVER CHANGE PASS 1. If pass 2 reads 'CISCO', 'TP-LINK', '74HC83' or "
    "'3.579545M', the label you decided in pass 1 stays exactly as it was. A marking is "
    "evidence about a component; it is never the component's identity.\n"
    "If pass 1 cannot determine the physical type, the label is 'unknown' — that is the "
    "correct answer. Falling back to the printed text as the label is NOT.\n"
    "\n"
    "Decide `label` from VISUAL EVIDENCE ONLY: the object's shape and size, its "
    "package and body style, its pins, leads, terminals, ports and connectors, its "
    "colour and material, any schematic symbols or polarity marks, and its context on "
    "the board or in the device. Printed text is SUPPORTING information — a part number "
    "may help you confirm a type you already suspect from the shape, but text alone "
    "never decides the label.\n"
    "\n"
    "NEVER use as a label: a manufacturer or brand name (cisco, tp-link, samsung, "
    "texas instruments), a model or part number (sg300-52, 74hc83, ne555), a printed "
    "value (10k, 220uf), a marketing string, or any fragment of printed text. Those all "
    "belong in `text`.\n"
    "Worked examples — in each, the label comes from the physical object and the printing "
    "goes to `text`, whatever it says:\n"
    "* A rack-mounted metal box with rows of RJ45 ports and status LEDs, covered in the "
    "word CISCO -> label 'network switch', text 'CISCO SG300-52 52-Port Gigabit Managed "
    "Switch'. label 'cisco' or 'sg300-52' would be WRONG.\n"
    "* The same box branded TP-Link -> label 'network switch', text 'TP-Link TL-SG1024D "
    "24-Port Gigabit Switch'. The brand changed; the label did NOT.\n"
    "* A black rectangular package with two rows of leads -> label 'ic', text '74HC83'. "
    "label '74hc83' would be WRONG.\n"
    "* A small silver oval metal can with two leads -> label 'crystal', text "
    "'3.579545M'. label '3.579545m' would be WRONG.\n"
    "\n"
    "For each component return:\n"
    "- label: the actual component type, in lowercase English — the most specific "
    "technically meaningful name for what the object IS. Examples of the KIND of answer "
    "wanted: "
    + ", ".join(EXAMPLE_LABELS)
    + ". That list is illustrative, NOT a closed set — if a component is something "
    "else, return its real type name. Never abbreviate and never return a fragment of a "
    "word. Use 'unknown' ONLY when the object is clearly a component but its type is "
    "genuinely unidentifiable from its appearance.\n"
    "- confidence: your confidence that the label is correct, from 0.0 to 1.0.\n"
    "- box_2d: the bounding box as [ymin, xmin, ymax, xmax], normalised to 0-1000.\n"
    "- text: every marking visible on that component, transcribed exactly as printed — "
    "the manufacturer or brand name, the model or part number, and any printed value or "
    "code, in reading order and separated by spaces. Use an empty string if there is no "
    "legible marking. Never guess a marking that you cannot actually read, and never put "
    "the component type here unless it is genuinely printed on the part.\n"
    "\n"
    "Return one entry per physical component. When the image shows a complete device or "
    "module rather than a bare board, return that device itself as a component (named by "
    "its type, e.g. 'network switch', 'power supply', 'router'), together with any "
    "distinct components visible on it. Do not return an entry for the bare board "
    "substrate, for solder pads, or for bare traces. Return an empty array if the image "
    "contains no electronic components."
)

RESPONSE_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "box_2d": {
                "type": "ARRAY",
                "items": {"type": "INTEGER"},
                "description": "Bounding box [ymin, xmin, ymax, xmax], normalised to 0-1000.",
            },
            # PASS 1's written output, and the reason the ordering below is not
            # cosmetic: the model must describe the physical object BEFORE it is
            # allowed to name it, and it has not read out any marking at that
            # point. Its content is intentionally unused downstream.
            "visual_description": {
                "type": "STRING",
                "description": (
                    "PASS 1 — describe ONLY the physical object: its shape, size, body and "
                    "package style, number and kind of pins/leads/terminals/ports, colour, "
                    "material, polarity or pin-1 marks, and where it sits. Do NOT read, "
                    "quote or mention any printed word, brand, number or code here."
                ),
            },
            # No enum: the label vocabulary is open by design (see module
            # docstring). Restricting it here is what previously cost real
            # detections like "potentiometer" their identity.
            "label": {
                "type": "STRING",
                "description": (
                    "PASS 1's conclusion — the component TYPE implied by the "
                    "visual_description you just wrote, and by nothing else: e.g. 'switch', "
                    "'resistor', 'capacitor', 'ic', 'connector', 'crystal', 'network "
                    "switch'. NEVER a brand name, manufacturer, model number, part number, "
                    "printed value or any other printed text — those belong in 'text'. If "
                    "the visual evidence does not identify a type, use 'unknown'."
                ),
            },
            "confidence": {
                "type": "NUMBER",
                "description": "Confidence that the label is correct, 0.0 to 1.0.",
            },
            "text": {
                "type": "STRING",
                "description": (
                    "PASS 2, performed AFTER the label is fixed and never allowed to change "
                    "it — the markings printed ON the component, transcribed exactly: brand "
                    "or manufacturer, model or part number, and any printed value or code. "
                    "Empty string when there is no legible marking."
                ),
            },
        },
        "required": ["box_2d", "visual_description", "label", "confidence", "text"],
        # THIS ORDER IS THE MECHANISM, not a formatting preference. Gemini
        # generates the fields of an object in `propertyOrdering`, and
        # generation is autoregressive: with `text` emitted LAST, the printed
        # marking literally does not exist in the model's context at the moment
        # it commits to `label`. Pass 2 therefore cannot contaminate pass 1 —
        # a guarantee no amount of prompt wording can give, which is why the
        # prose instruction alone was not enough.
        "propertyOrdering": ["box_2d", "visual_description", "label", "confidence", "text"],
    },
}


class GeminiUnavailableError(RuntimeError):
    """Gemini could not produce a result for this image.

    Covers every non-image failure mode — unconfigured key, network error,
    timeout, non-200 status, unparseable or unexpectedly-shaped body. `app.py`
    catches exactly this and turns it into a 503 for `/detect`'s caller. A
    genuinely invalid *image* must NOT be reported through it: that stays a
    `ValueError`, surfaced to the client as a 400 instead.

    Messages are kept generic and never include the response body or the key.
    """


class GeminiDetectionService:
    """Calls Gemini's vision API once per image. Stateless apart from config —
    there is no local model to keep warm."""

    def __init__(self, api_key: str, model: str, timeout_s: float = 30.0) -> None:
        self._api_key = api_key
        self._model = model
        self._timeout_s = timeout_s
        self._loaded = False

    @property
    def source(self) -> str:
        return SOURCE_GEMINI

    @property
    def model_name(self) -> str:
        return self._model

    @property
    def model_path(self) -> Path:
        """No local weights file; the model id stands in for it."""
        return Path(self._model)

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    @property
    def class_names(self) -> dict[int, str]:
        return dict(enumerate(COMPONENT_LABELS))

    def load(self) -> None:
        """No weights to read — this only asserts the service is configured."""
        if not self._api_key:
            raise GeminiUnavailableError("GEMINI_API_KEY is not set")
        self._loaded = True
        logger.info("Gemini detection ready (model: %s)", self._model)

    def detect(self, image_bytes: bytes, confidence: float = 0.25) -> list[Detection]:
        if not self._loaded or not self._api_key:
            raise GeminiUnavailableError("Gemini detection is not configured")

        # Decoded locally for two reasons: it validates the upload (so a
        # corrupt file fails as a 400 before any network call), and Gemini's
        # normalised boxes need real pixel
        # dimensions to be converted back.
        image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("Could not decode image bytes — not a valid image file")
        height, width = image.shape[:2]

        raw = self._request_detections(image_bytes)
        return self._to_detections(raw, width=width, height=height, confidence=confidence)

    def _request_detections(self, image_bytes: bytes) -> list[dict]:
        payload = {
            "contents": [
                {
                    "parts": [
                        {
                            "inline_data": {
                                "mime_type": "image/jpeg",
                                "data": base64.b64encode(image_bytes).decode("ascii"),
                            }
                        },
                        {"text": DETECTION_PROMPT},
                    ]
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": RESPONSE_SCHEMA,
                # Classification should be reproducible for the same image.
                "temperature": 0.0,
            },
        }

        try:
            response = httpx.post(
                f"{GEMINI_API_BASE}/{self._model}:generateContent",
                headers={"x-goog-api-key": self._api_key, "Content-Type": "application/json"},
                json=payload,
                timeout=self._timeout_s,
            )
        except Exception as error:  # noqa: BLE001 — any transport failure means "fall back"
            raise GeminiUnavailableError(f"Gemini request failed: {type(error).__name__}") from error

        if response.status_code != 200:
            # Deliberately status-only: the body can echo request details.
            raise GeminiUnavailableError(f"Gemini returned HTTP {response.status_code}")

        try:
            body = response.json()
        except Exception as error:  # noqa: BLE001
            raise GeminiUnavailableError("Gemini returned a non-JSON response") from error

        text = _extract_text(body)
        if text is None:
            raise GeminiUnavailableError("Gemini returned no usable content")

        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as error:
            raise GeminiUnavailableError("Gemini returned malformed detection JSON") from error

        if not isinstance(parsed, list):
            raise GeminiUnavailableError("Gemini returned an unexpected detection shape")
        return [item for item in parsed if isinstance(item, dict)]

    def _to_detections(
        self, raw: list[dict], *, width: int, height: int, confidence: float
    ) -> list[Detection]:
        detections: list[Detection] = []

        for item in raw:
            label = item.get("label")
            box = item.get("box_2d")
            if not isinstance(label, str) or not isinstance(box, list) or len(box) != 4:
                # One malformed entry is skipped rather than failing the whole
                # image.
                logger.warning("Skipping malformed Gemini detection entry")
                continue

            # Normalised for casing and stray whitespace only. The label is
            # otherwise kept EXACTLY as Gemini named it, including labels the
            # backend has no ComponentType for ("potentiometer", "mosfet",
            # ...): collapsing those to "unknown" here would discard the one
            # place that information exists. detectionService.ts maps what it
            # can and stores "unknown" as the *type*, and `class_name` still
            # carries the real name.
            label = " ".join(label.split()).lower()
            if not label:
                logger.warning("Gemini returned an empty label; recording it as 'unknown'")
                label = "unknown"

            marking = item.get("text")
            marking = marking.strip() if isinstance(marking, str) else ""
            if _label_was_lifted_from_the_marking(label, marking):
                # Last line of defence behind the two-pass schema. The box and
                # the marking are both still real, so the detection is kept —
                # only the identity claim, which we can show came from the
                # printing rather than from the object, is withdrawn.
                logger.warning(
                    "Gemini's label was read off the component's printing; "
                    "recording the type as 'unknown' and keeping the marking in text"
                )
                label = "unknown"

            try:
                score = float(item.get("confidence", 0.0))
                y_min, x_min, y_max, x_max = (float(value) for value in box)
            except (TypeError, ValueError):
                logger.warning("Skipping Gemini detection entry with non-numeric fields")
                continue

            if score < confidence:
                continue

            bbox = _to_pixel_box(
                y_min=y_min, x_min=x_min, y_max=y_max, x_max=x_max, width=width, height=height
            )
            if bbox is None:
                continue

            detections.append(
                Detection(
                    class_id=(
                        COMPONENT_LABELS.index(label) if label in COMPONENT_LABELS else UNMAPPED_CLASS_ID
                    ),
                    class_name=label,
                    confidence=max(0.0, min(score, 1.0)),
                    bbox=bbox,
                    # The marking is kept in full even when it cost the label
                    # its type above — it is the evidence for what the part is.
                    text=marking,
                    source=SOURCE_GEMINI,
                )
            )

        return detections


def _label_was_lifted_from_the_marking(label: str, marking: str) -> bool:
    """True when the label looks read off the component instead of judged from it.

    The narrow, evidence-based test — deliberately not a guess about what
    "sounds like a brand", which would be unfalsifiable and would punish real
    open-vocabulary labels:

        the label appears verbatim in the printed marking
        AND it is not a word used to name a component type

    'cisco' inside 'CISCO SG300-52 ...' and 'sg300-52' inside the same string
    both trip it. 'switch' inside 'TL-SG1024D 24-Port Gigabit Switch' does not,
    because `switch` names a type — a component whose type name is genuinely
    printed on it keeps that type.

    Matching is on whole words so a short label cannot collide with a fragment
    of a longer one ('ic' must not match inside 'CISCO'), and a label absent
    from the marking is never touched: this can only catch a label the printing
    can be shown to be the source of.
    """
    if not marking or label in COMPONENT_TYPE_VOCABULARY:
        return False
    return re.search(rf"\b{re.escape(label)}\b", marking.lower()) is not None


def _extract_text(body: object) -> str | None:
    """Pulls the model's text out of a generateContent response.

    Thinking models interleave `thoughtSignature`-only parts with the real
    content, so parts are filtered on actually carrying `text` rather than
    assuming `parts[0]` is the answer.
    """
    if not isinstance(body, dict):
        return None
    candidates = body.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return None
    content = candidates[0].get("content") if isinstance(candidates[0], dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list):
        return None

    chunks = [
        part["text"] for part in parts if isinstance(part, dict) and isinstance(part.get("text"), str)
    ]
    joined = "".join(chunks).strip()
    return joined or None


def _to_pixel_box(
    *, y_min: float, x_min: float, y_max: float, x_max: float, width: int, height: int
) -> BoundingBox | None:
    """Converts one 0-1000 normalised `[ymin, xmin, ymax, xmax]` box to pixels.

    Clamped to the image. Returns None for a degenerate (zero-area) box rather
    than storing a marker the UI would draw as an invisible or inverted
    rectangle.
    """
    x1 = int(round(x_min / GEMINI_BOX_SCALE * width))
    y1 = int(round(y_min / GEMINI_BOX_SCALE * height))
    x2 = int(round(x_max / GEMINI_BOX_SCALE * width))
    y2 = int(round(y_max / GEMINI_BOX_SCALE * height))

    # Tolerate a model that emits the corners in the wrong order.
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1

    x1 = max(0, min(x1, width))
    y1 = max(0, min(y1, height))
    x2 = max(x1, min(x2, width))
    y2 = max(y1, min(y2, height))

    if x2 <= x1 or y2 <= y1:
        return None
    return BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2)
