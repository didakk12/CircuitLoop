"""
`gemini_detection.py` — the only detector.

Every HTTP call is stubbed: these tests never reach the network and never need
an API key. What they pin is the translation layer, which is where the real
risk lives — Gemini's 0-1000 normalised `[ymin, xmin, ymax, xmax]` boxes have
to become the clamped pixel coordinates the database stores and `Analysis.tsx`
draws, and every failure mode has to be classified correctly as either
"detection unavailable" (`GeminiUnavailableError`, a 503) or "the client sent
a bad image" (`ValueError`, a 400).
"""

import json

import cv2
import numpy as np
import pytest

import gemini_detection
from gemini_detection import (
    COMPONENT_LABELS,
    GeminiDetectionService,
    GeminiUnavailableError,
    _to_pixel_box,
)


@pytest.fixture
def image_bytes() -> bytes:
    """A real, decodable 200x100 JPEG — width and height deliberately differ so
    a swapped axis in the box conversion cannot pass unnoticed."""
    array = np.zeros((100, 200, 3), dtype=np.uint8)
    return cv2.imencode(".jpg", array)[1].tobytes()


class _StubResponse:
    def __init__(self, status_code=200, body=None, raise_on_json=False):
        self.status_code = status_code
        self._body = body
        self._raise_on_json = raise_on_json

    def json(self):
        if self._raise_on_json:
            raise ValueError("not json")
        return self._body


def gemini_body(entries) -> dict:
    """A generateContent response carrying `entries` as the model's JSON text."""
    return {"candidates": [{"content": {"parts": [{"text": json.dumps(entries)}]}}]}


def loaded_service(monkeypatch, response=None, error=None) -> GeminiDetectionService:
    service = GeminiDetectionService(api_key="test-key", model="gemini-3.5-flash-lite")
    service.load()

    def fake_post(*args, **kwargs):
        if error is not None:
            raise error
        return response

    monkeypatch.setattr(gemini_detection.httpx, "post", fake_post)
    return service


# --- Box conversion -----------------------------------------------------------


def test_normalised_boxes_become_pixel_coordinates(monkeypatch, image_bytes):
    """[ymin, xmin, ymax, xmax] at 0-1000 over a 200x100 image."""
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [{"label": "resistor", "confidence": 0.9, "box_2d": [100, 250, 500, 750], "text": "10K"}]
            )
        ),
    )

    detection = service.detect(image_bytes, confidence=0.25)[0]

    assert (detection.bbox.x1, detection.bbox.x2) == (50, 150)  # 0.25/0.75 of width 200
    assert (detection.bbox.y1, detection.bbox.y2) == (10, 50)  # 0.10/0.50 of height 100
    assert detection.class_name == "resistor"
    assert detection.text == "10K"
    assert detection.source == "gemini"


def test_boxes_are_clamped_to_the_image():
    box = _to_pixel_box(y_min=-200, x_min=-500, y_max=1500, x_max=2000, width=200, height=100)

    assert (box.x1, box.y1, box.x2, box.y2) == (0, 0, 200, 100)


def test_inverted_corners_are_normalised():
    box = _to_pixel_box(y_min=500, x_min=750, y_max=100, x_max=250, width=200, height=100)

    assert (box.x1, box.y1, box.x2, box.y2) == (50, 10, 150, 50)


def test_a_degenerate_box_is_dropped_rather_than_stored(monkeypatch, image_bytes):
    """A zero-area box would render as an invisible marker; it is not a
    detection worth persisting."""
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [{"label": "ic", "confidence": 0.9, "box_2d": [500, 500, 500, 500], "text": ""}]
            )
        ),
    )

    assert service.detect(image_bytes) == []


# --- Filtering and label handling --------------------------------------------


def test_detections_below_the_confidence_threshold_are_dropped(monkeypatch, image_bytes):
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [
                    {"label": "ic", "confidence": 0.9, "box_2d": [0, 0, 500, 500], "text": ""},
                    {"label": "led", "confidence": 0.1, "box_2d": [500, 500, 900, 900], "text": ""},
                ]
            )
        ),
    )

    detections = service.detect(image_bytes, confidence=0.5)

    assert [d.class_name for d in detections] == ["ic"]


def test_a_switch_is_accepted(monkeypatch, image_bytes):
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [{"label": "switch", "confidence": 0.9, "box_2d": [0, 0, 500, 500], "text": ""}]
            )
        ),
    )

    assert [d.class_name for d in service.detect(image_bytes)] == ["switch"]


@pytest.mark.parametrize(
    "label",
    ["potentiometer", "relay", "mosfet", "crystal", "connector", "voltage regulator", "fuse"],
)
def test_a_label_outside_component_type_is_kept_verbatim(monkeypatch, image_bytes, label):
    """The whole point of the open vocabulary: a component Gemini CAN name must
    keep that name, even where the backend has no matching ComponentType. The
    narrowing to `unknown` is detectionService.ts's job, on the *type* — never
    on the label, which is the only record of what was actually seen."""
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [{"label": label, "confidence": 0.9, "box_2d": [0, 0, 500, 500], "text": ""}]
            )
        ),
    )

    detections = service.detect(image_bytes)

    assert [d.class_name for d in detections] == [label]
    # A label with no ComponentType has no fixed index — the detection survives
    # regardless; `relay` is here because it IS a ComponentType the local
    # models cannot see, and must come through under its own name too.
    expected_id = (
        COMPONENT_LABELS.index(label)
        if label in COMPONENT_LABELS
        else gemini_detection.UNMAPPED_CLASS_ID
    )
    assert detections[0].class_id == expected_id


def test_labels_are_normalised_for_case_and_whitespace_only(monkeypatch, image_bytes):
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [{"label": "  Push   Button ", "confidence": 0.9, "box_2d": [0, 0, 500, 500], "text": ""}]
            )
        ),
    )

    assert [d.class_name for d in service.detect(image_bytes)] == ["push button"]


def test_an_empty_label_becomes_unknown_rather_than_dropping_the_component(monkeypatch, image_bytes):
    """`unknown` is now reserved for a component that genuinely could not be
    named — a real component must still never be lost."""
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body([{"label": "   ", "confidence": 0.9, "box_2d": [0, 0, 500, 500], "text": ""}])
        ),
    )

    assert [d.class_name for d in service.detect(image_bytes)] == ["unknown"]


def test_malformed_entries_are_skipped_without_failing_the_image(monkeypatch, image_bytes):
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [
                    {"label": "ic", "confidence": 0.9, "box_2d": [0, 0, 500, 500], "text": "LM358"},
                    {"label": "resistor", "confidence": 0.9, "box_2d": [1, 2]},  # short box
                    {"confidence": 0.9, "box_2d": [0, 0, 100, 100]},  # no label
                    {"label": "led", "confidence": "high", "box_2d": [0, 0, 100, 100]},  # not numeric
                ]
            )
        ),
    )

    detections = service.detect(image_bytes)

    assert [d.class_name for d in detections] == ["ic"]
    assert detections[0].text == "LM358"


def test_a_missing_marking_becomes_an_empty_string(monkeypatch, image_bytes):
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body([{"label": "ic", "confidence": 0.9, "box_2d": [0, 0, 500, 500]}])
        ),
    )

    assert service.detect(image_bytes)[0].text == ""


def test_the_indexed_label_set_matches_the_backend_component_type_union():
    """COMPONENT_LABELS is no longer a restriction — only the labels with a
    stable `class_id`. Pinned so it stays aligned with `ComponentType` in
    backend/src/types/entities.ts."""
    assert set(COMPONENT_LABELS) == {
        "resistor", "capacitor", "led", "diode", "transistor", "ic", "microcontroller",
        "battery", "buzzer", "display", "relay", "switch", "unknown",
    }


def test_an_indexed_label_keeps_its_stable_class_id(monkeypatch, image_bytes):
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [{"label": "resistor", "confidence": 0.9, "box_2d": [0, 0, 500, 500], "text": ""}]
            )
        ),
    )

    assert service.detect(image_bytes)[0].class_id == COMPONENT_LABELS.index("resistor")


def test_the_response_schema_leaves_the_label_open_ended():
    """No enum: Gemini must be free to name any component it recognises."""
    label_schema = gemini_detection.RESPONSE_SCHEMA["items"]["properties"]["label"]

    assert label_schema["type"] == "STRING"
    assert "enum" not in label_schema


def test_the_prompt_asks_for_every_component_by_its_most_specific_name():
    prompt = gemini_detection.DETECTION_PROMPT

    assert "EVERY visible electronic component" in prompt
    assert "most specific" in prompt
    assert "NOT a closed set" in prompt
    for label in ("switch", "potentiometer", "mosfet", "relay", "connector"):
        assert label in prompt


# --- Component type vs. printed marking ---------------------------------------


def test_the_prompt_separates_the_component_type_from_the_printed_marking():
    """The two fields answer different questions, and the prompt has to say so
    in terms strong enough that a brand plastered over a device does not become
    its type."""
    prompt = gemini_detection.DETECTION_PROMPT

    assert "`label` is WHAT THE THING IS" in prompt
    assert "`text` is WHAT IS PRINTED" in prompt
    # The type must be read off the object, not off its printing.
    assert "VISUAL EVIDENCE ONLY" in prompt
    for cue in ("shape", "package", "pins", "connectors", "context"):
        assert cue in prompt
    assert "SUPPORTING information" in prompt
    # And the specific failure mode is named outright.
    assert "NEVER use as a label" in prompt
    for forbidden in ("manufacturer or brand name", "model or part number", "printed value"):
        assert forbidden in prompt
    assert "label 'cisco' or 'sg300-52' would be WRONG" in prompt


def test_the_response_schema_states_the_type_marking_split_on_both_fields():
    """Prose in the prompt is not the only guard: the schema descriptions carry
    the same contract at the field the model is actually filling in."""
    properties = gemini_detection.RESPONSE_SCHEMA["items"]["properties"]

    label_description = properties["label"]["description"]
    assert "component TYPE" in label_description
    assert "NEVER a brand name, manufacturer, model number, part number" in label_description

    text_description = properties["text"]["description"]
    assert "printed ON the component" in text_description
    assert "brand or manufacturer" in text_description


@pytest.mark.parametrize(
    ("label", "text"),
    [
        ("network switch", "CISCO SG300-52 52-Port Gigabit Managed Switch"),
        ("switch", "CISCO"),
        ("ic", "74HC83"),
        ("network switch", "tp-link TL-SG1024D 24-Port Gigabit Switch"),
    ],
)
def test_the_type_and_the_marking_survive_as_separate_fields(monkeypatch, image_bytes, label, text):
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [{"label": label, "confidence": 0.95, "box_2d": [0, 0, 500, 500], "text": text}]
            )
        ),
    )

    detection = service.detect(image_bytes)[0]

    assert detection.class_name == label
    assert detection.text == text
    # The marking is never promoted into the type, whatever it says.
    assert detection.class_name != detection.text


def test_the_prompt_specifies_two_separate_passes_in_order():
    """Visual classification first, marking transcription second, and the
    second explicitly forbidden from revising the first."""
    prompt = gemini_detection.DETECTION_PROMPT

    assert "TWO SEPARATE PASSES" in prompt
    assert "PASS 1 — VISUAL" in prompt
    assert "PASS 2 — MARKINGS" in prompt
    assert "PASS 2 MUST NEVER CHANGE PASS 1" in prompt
    assert "as if every marking were blurred out" in prompt
    # 'unknown' is the correct answer when pass 1 fails — not the printed text.
    assert "the label is 'unknown' — that is the" in prompt
    assert "Falling back to the printed text as the label is NOT" in prompt


def test_the_prompt_carries_a_worked_example_for_each_kind_of_marking():
    prompt = gemini_detection.DETECTION_PROMPT

    for fragment in (
        "label 'cisco' or 'sg300-52' would be WRONG",
        "The brand changed; the label did NOT",
        "label 'ic', text '74HC83'",
        "label 'crystal', text",
        "label '74hc83' would be WRONG",
    ):
        assert fragment in prompt


def test_the_schema_makes_the_model_commit_to_a_type_before_reading_any_marking():
    """The ordering IS the mechanism: generation is autoregressive, so with
    `text` last the marking is not in context when `label` is produced."""
    item = gemini_detection.RESPONSE_SCHEMA["items"]

    ordering = item["propertyOrdering"]
    assert ordering.index("visual_description") < ordering.index("label")
    assert ordering.index("label") < ordering.index("text")
    assert ordering[-1] == "text"
    # Every field must actually be produced, or the ordering guarantees nothing.
    assert set(item["required"]) == set(ordering)

    visual = item["properties"]["visual_description"]["description"]
    assert "PASS 1" in visual
    assert "Do NOT read, quote or mention any printed word" in visual
    assert "PASS 2" in item["properties"]["text"]["description"]


def test_the_visual_description_field_is_scaffolding_and_never_reaches_a_detection(
    monkeypatch, image_bytes
):
    """It exists to force the model's hand during generation; the wire contract
    downstream is unchanged."""
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [
                    {
                        "box_2d": [0, 0, 500, 500],
                        "visual_description": "black rectangular package, two rows of leads",
                        "label": "ic",
                        "confidence": 0.9,
                        "text": "74HC83",
                    }
                ]
            )
        ),
    )

    detection = service.detect(image_bytes)[0]

    assert detection.class_name == "ic"
    assert detection.text == "74HC83"
    assert not hasattr(detection, "visual_description")


# --- The label must not move when only the printing changes -------------------

# One physical object, photographed with different things printed on it. The
# label is a claim about the object, so it must be identical in every row.
SAME_OBJECT_DIFFERENT_BRANDS = [
    ("network switch", "CISCO SG300-52 52-Port Gigabit Managed Switch"),
    ("network switch", "TP-Link TL-SG1024D 24-Port Gigabit Switch"),
    ("network switch", "NETGEAR GS324 24-Port Gigabit"),
    ("network switch", "HPE OfficeConnect 1820-24G J9980A"),
    ("network switch", ""),
]


@pytest.mark.parametrize(("label", "marking"), SAME_OBJECT_DIFFERENT_BRANDS)
def test_changing_the_printed_text_does_not_change_the_label(monkeypatch, image_bytes, label, marking):
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [{"label": label, "confidence": 0.95, "box_2d": [0, 0, 500, 500], "text": marking}]
            )
        ),
    )

    detection = service.detect(image_bytes)[0]

    assert detection.class_name == "network switch"
    assert detection.text == marking


def test_one_label_survives_across_every_brand_in_a_single_image(monkeypatch, image_bytes):
    """The same assertion at image level: five differently branded units, one
    type. If the printing were driving the label, these would diverge."""
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [
                    {"label": label, "confidence": 0.9, "box_2d": [i * 100, 0, i * 100 + 90, 500], "text": marking}
                    for i, (label, marking) in enumerate(SAME_OBJECT_DIFFERENT_BRANDS)
                ]
            )
        ),
    )

    detections = service.detect(image_bytes)

    assert {d.class_name for d in detections} == {"network switch"}
    assert [d.text for d in detections] == [marking for _, marking in SAME_OBJECT_DIFFERENT_BRANDS]


@pytest.mark.parametrize(
    ("component_label", "marking"),
    [
        ("ic", "74HC83"),
        ("ic", "NE555P TEXAS INSTRUMENTS"),
        ("crystal", "3.579545M"),
        ("capacitor", "220 16V L35"),
        ("resistor", "10K"),
        ("network switch", "CISCO SG300-52"),
        ("potentiometer", "B10K BOURNS"),
        ("mosfet", "IRFZ44N"),
    ],
)
def test_the_type_is_kept_and_the_marking_is_kept_separately_for_every_component(
    monkeypatch, image_bytes, component_label, marking
):
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [{"label": component_label, "confidence": 0.9, "box_2d": [0, 0, 500, 500], "text": marking}]
            )
        ),
    )

    detection = service.detect(image_bytes)[0]

    assert detection.class_name == component_label
    assert detection.text == marking


# --- The guard behind the schema ---------------------------------------------


@pytest.mark.parametrize(
    ("bad_label", "marking"),
    [
        ("cisco", "CISCO SG300-52 52-Port Gigabit Managed Switch"),
        ("sg300-52", "CISCO SG300-52 52-Port Gigabit Managed Switch"),
        ("tp-link", "TP-Link TL-SG1024D 24-Port Gigabit Switch"),
        ("tl-sg1024d", "TP-Link TL-SG1024D 24-Port Gigabit Switch"),
        ("74hc83", "74HC83"),
        ("ne555p", "NE555P TEXAS INSTRUMENTS"),
        ("3.579545m", "3.579545M"),
        ("irfz44n", "IRFZ44N"),
    ],
)
def test_a_label_read_off_the_printing_becomes_unknown_without_losing_the_detection(
    monkeypatch, image_bytes, bad_label, marking
):
    """The last line of defence: when the label can be shown to come from the
    marking, the type claim is withdrawn — but the box and the marking, which
    are real, are kept. 'unknown' is what the prompt asks for in this case."""
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [{"label": bad_label, "confidence": 0.9, "box_2d": [0, 0, 500, 500], "text": marking}]
            )
        ),
    )

    detections = service.detect(image_bytes)

    assert len(detections) == 1
    assert detections[0].class_name == "unknown"
    assert detections[0].text == marking


@pytest.mark.parametrize(
    ("label", "marking"),
    [
        # The type name genuinely printed on the part must NOT be stripped.
        ("switch", "TL-SG1024D 24-Port Gigabit Switch"),
        ("network switch", "CISCO SG300-52 52-Port Gigabit Managed Switch"),
        ("relay", "RELAY 12VDC"),
        ("fuse", "FUSE 250V 2A"),
        ("capacitor", "CAPACITOR 220uF"),
        # A short label must not collide with a fragment of a longer word:
        # 'ic' appears inside 'CISCO' as a substring but not as a word.
        ("ic", "CISCO SG300-52"),
        # A label the marking says nothing about is never touched.
        ("potentiometer", "B10K BOURNS"),
        ("crystal", "16.000 MHZ"),
    ],
)
def test_a_legitimate_type_is_never_stripped_by_the_guard(monkeypatch, image_bytes, label, marking):
    service = loaded_service(
        monkeypatch,
        response=_StubResponse(
            body=gemini_body(
                [{"label": label, "confidence": 0.9, "box_2d": [0, 0, 500, 500], "text": marking}]
            )
        ),
    )

    assert service.detect(image_bytes)[0].class_name == label


def test_the_guard_is_evidence_based_not_a_brand_name_guess():
    """It fires only where the marking demonstrably contains the label. An
    unfamiliar label with no supporting marking is accepted as-is — the
    vocabulary stays open."""
    assert gemini_detection._label_was_lifted_from_the_marking("cisco", "CISCO SG300-52")
    assert not gemini_detection._label_was_lifted_from_the_marking("cisco", "")
    assert not gemini_detection._label_was_lifted_from_the_marking("ethernet transformer", "")
    assert not gemini_detection._label_was_lifted_from_the_marking("gate driver", "UCC27524")


def test_the_prompt_asks_for_a_whole_device_to_be_named_by_its_type():
    """A photo of a complete device is not a photo of nothing: the device
    itself is the component the user cares about. Previously the prompt said
    only 'do not return the board itself', which suppressed it."""
    prompt = gemini_detection.DETECTION_PROMPT

    assert "complete device or module" in prompt
    assert "network switch" in prompt
    # The bare-substrate exclusion must survive — it is what keeps a PCB scan
    # from returning the board as a component.
    assert "bare board substrate" in prompt


# --- Thinking-model responses -------------------------------------------------


def test_thought_only_parts_are_ignored_when_reading_the_response(monkeypatch, image_bytes):
    """3.5 Flash-Lite interleaves `thoughtSignature`-only parts with content;
    assuming parts[0] is the answer would break on those."""
    body = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {"thoughtSignature": "abc123"},
                        {"text": json.dumps([{"label": "ic", "confidence": 0.9, "box_2d": [0, 0, 500, 500], "text": ""}])},
                    ]
                }
            }
        ]
    }
    service = loaded_service(monkeypatch, response=_StubResponse(body=body))

    assert [d.class_name for d in service.detect(image_bytes)] == ["ic"]


# --- Failure classification ---------------------------------------------------


def test_an_undecodable_image_raises_value_error_not_unavailable(monkeypatch):
    """A bad upload is a client error: it must become a 400, never a 503."""
    service = loaded_service(monkeypatch, response=_StubResponse(body=gemini_body([])))

    with pytest.raises(ValueError):
        service.detect(b"definitely not an image")


@pytest.mark.parametrize("status", [400, 401, 404, 429, 500, 503])
def test_a_non_200_status_is_unavailable(monkeypatch, image_bytes, status):
    service = loaded_service(monkeypatch, response=_StubResponse(status_code=status, body={}))

    with pytest.raises(GeminiUnavailableError):
        service.detect(image_bytes)


def test_a_transport_failure_is_unavailable(monkeypatch, image_bytes):
    service = loaded_service(monkeypatch, error=OSError("connection reset"))

    with pytest.raises(GeminiUnavailableError):
        service.detect(image_bytes)


def test_a_non_json_body_is_unavailable(monkeypatch, image_bytes):
    service = loaded_service(monkeypatch, response=_StubResponse(raise_on_json=True))

    with pytest.raises(GeminiUnavailableError):
        service.detect(image_bytes)


def test_malformed_detection_json_is_unavailable(monkeypatch, image_bytes):
    body = {"candidates": [{"content": {"parts": [{"text": "{not json"}]}}]}
    service = loaded_service(monkeypatch, response=_StubResponse(body=body))

    with pytest.raises(GeminiUnavailableError):
        service.detect(image_bytes)


def test_an_empty_candidate_list_is_unavailable(monkeypatch, image_bytes):
    service = loaded_service(monkeypatch, response=_StubResponse(body={"candidates": []}))

    with pytest.raises(GeminiUnavailableError):
        service.detect(image_bytes)


def test_a_non_array_result_is_unavailable(monkeypatch, image_bytes):
    body = {"candidates": [{"content": {"parts": [{"text": json.dumps({"label": "ic"})}]}}]}
    service = loaded_service(monkeypatch, response=_StubResponse(body=body))

    with pytest.raises(GeminiUnavailableError):
        service.detect(image_bytes)


def test_an_empty_detection_list_is_a_valid_result(monkeypatch, image_bytes):
    """An image with no components is not a failure and must not fall back."""
    service = loaded_service(monkeypatch, response=_StubResponse(body=gemini_body([])))

    assert service.detect(image_bytes) == []


# --- Configuration ------------------------------------------------------------


def test_an_unconfigured_service_cannot_load_or_detect():
    service = GeminiDetectionService(api_key="", model="gemini-3.5-flash-lite")

    with pytest.raises(GeminiUnavailableError):
        service.load()
    assert not service.is_loaded
    with pytest.raises(GeminiUnavailableError):
        service.detect(b"anything")


def test_the_api_key_never_appears_in_a_raised_error(monkeypatch, image_bytes):
    service = loaded_service(monkeypatch, response=_StubResponse(status_code=403, body={}))

    with pytest.raises(GeminiUnavailableError) as raised:
        service.detect(image_bytes)

    assert "test-key" not in str(raised.value)


def test_the_key_is_sent_only_as_the_request_header(monkeypatch, image_bytes):
    captured = {}

    service = GeminiDetectionService(api_key="test-key", model="gemini-3.5-flash-lite")
    service.load()

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        return _StubResponse(body=gemini_body([]))

    monkeypatch.setattr(gemini_detection.httpx, "post", fake_post)
    service.detect(image_bytes)

    assert captured["headers"]["x-goog-api-key"] == "test-key"
    assert "test-key" not in captured["url"]
    assert "test-key" not in json.dumps(captured["json"])


def test_the_configured_model_is_the_one_called(monkeypatch, image_bytes):
    captured = {}

    service = GeminiDetectionService(api_key="k", model="gemini-9.9-experimental")
    service.load()

    def fake_post(url, **kwargs):
        captured["url"] = url
        return _StubResponse(body=gemini_body([]))

    monkeypatch.setattr(gemini_detection.httpx, "post", fake_post)
    service.detect(image_bytes)

    assert captured["url"].endswith("/gemini-9.9-experimental:generateContent")
