"""
Unit-level tests for DetectionService, independent of the HTTP layer —
covers the "service errors" and "OCR failure handling" requirements
directly at their source.
"""

import numpy as np
import pytest

import detection as detection_module
from detection import DetectionService, ModelNotLoadedError


def test_detect_raises_before_load_is_called():
    service = DetectionService()

    with pytest.raises(ModelNotLoadedError):
        service.detect(b"irrelevant")


def test_class_names_raises_before_load_is_called():
    service = DetectionService()

    with pytest.raises(ModelNotLoadedError):
        _ = service.class_names


def test_real_model_class_names_match_the_verified_label_set():
    """Source-of-truth check: the TS backend's YOLO_CLASS_TO_COMPONENT_TYPE
    mapping table (backend/src/services/detectionService.ts) assumes these
    exact 8 labels, verified by actually loading the real trained model in
    Phase 1 — not guessed. This test re-verifies that assumption against
    the real model on every run, so a swapped/retrained .pt file with
    different classes would fail here rather than silently producing
    "unknown" components. See backend/tests/detectionService.test.ts for
    the corresponding check that the TS mapping table's keys match this
    same set."""
    service = DetectionService()
    service.load()

    assert service.class_names == {
        0: "battery",
        1: "buzzer",
        2: "capacitor",
        3: "display",
        4: "ic",
        5: "relay",
        6: "resistor",
        7: "switch",
    }


def test_ocr_failure_is_isolated_to_the_affected_box_and_does_not_crash_detection(sample_image_bytes, monkeypatch):
    """Simulates a genuine Tesseract failure (not just it being uninstalled)
    to prove detect() never raises because of an OCR problem — every
    detection still comes back, just with empty text for the affected
    box(es), per detection.py's `_ocr_crop`.

    Patches `image_to_data`, which is what `_ocr_crop` actually calls — it was
    switched from `image_to_string` so per-word confidence is available to the
    quality gate. Patching the old name here would leave this test passing
    while exercising nothing.
    """

    def broken_ocr(*_args, **_kwargs):
        raise RuntimeError("simulated OCR engine failure")

    monkeypatch.setattr(detection_module.pytesseract, "image_to_data", broken_ocr)

    service = DetectionService()
    service.load()
    detections = service.detect(sample_image_bytes, confidence=0.01)

    assert len(detections) > 0
    assert all(d.text == "" for d in detections)


# --- OCR quality gate -------------------------------------------------------
#
# `_filter_ocr_words` is a pure function over `image_to_data`'s parallel
# text/confidence lists, so these tests pin the rules down directly without
# needing a Tesseract binary or a PCB photo. Confidence values below are the
# ones actually measured against the real preprocessing pipeline — see the
# constants in detection.py for how they were obtained.


# Group 1: MEASURED. Both the strings and their confidences were produced by
# re-running this module's real preprocessing + image_to_data over the YOLO
# crops of frontend/src/assets/hero.png. "es" at confidence 17 is the read that
# prompted this work — a switch whose `name` became "es".
@pytest.mark.parametrize(
    ("texts", "confidences", "reason"),
    [
        ([">", "es"], [78.0, 17.0], "the reported case, exactly as measured on hero.png"),
        (["es"], [17.0], "low-confidence hallucination"),
        (["bane"], [20.0], "low-confidence hallucination"),
        (["a"], [20.0], "low-confidence single character"),
    ],
)
def test_measured_junk_is_rejected(texts, confidences, reason):
    assert detection_module._filter_ocr_words(texts, confidences) == "", reason


# Group 2: STRUCTURAL. These are rejected on shape alone, so they are tested at
# *high* confidence — proving the rule is structural and not just the floor
# doing the work. ">" and ";" really did score 76-78 on hero.png.
@pytest.mark.parametrize(
    ("texts", "confidences", "reason"),
    [
        ([">"], [76.0], "confident but wholly non-alphanumeric"),
        ([";"], [77.0], "confident but wholly non-alphanumeric"),
        (["P'"], [90.0], "exactly half punctuation — not a clear majority"),
        (["1,"], [90.0], "exactly half punctuation"),
        (["   "], [90.0], "whitespace only"),
        ([], [], "no words at all"),
        (["text"], [-1.0], "Tesseract's non-text sentinel outranks any structure"),
    ],
)
def test_structurally_invalid_reads_are_rejected_regardless_of_confidence(texts, confidences, reason):
    assert detection_module._filter_ocr_words(texts, confidences) == "", reason


# Group 3: RECORDED BUT UNVERIFIED. These strings are real — they are in
# ml-service/data/yolo_ocr.json — but that file records no confidences and the
# PCB photo that produced them is not in this repo, so their true scores are
# unknown. The confidences here are representative of the *measured* junk
# population (15-25), NOT measurements of these specific strings. They pin down
# the intended behaviour; confirming that real junk actually scores this low is
# a verification step against the real board, not something this test proves.
@pytest.mark.parametrize(
    ("texts", "confidences", "reason"),
    [
        (["Se:"], [18.0], "recorded junk"),
        (["le"], [19.0], "recorded junk"),
        (["fl"], [15.0], "recorded junk"),
        (["‘oe"], [21.0], "recorded junk"),
        (["CO", ":"], [24.0, 20.0], "recorded junk, punctuation plus a weak token"),
        (["ion", "rat"], [22.0, 24.0], "recorded multi-line junk"),
        (
            ["HUNTUHUTIALUNIT", "mare", "'", "Mena", "wITnnihih"],
            [31.0, 20.0, 0.0, 33.0, 18.0],
            "the recorded IC garble: a mostly-failing crop is rejected wholesale",
        ),
    ],
)
def test_recorded_junk_is_rejected_at_representative_confidences(texts, confidences, reason):
    assert detection_module._filter_ocr_words(texts, confidences) == "", reason


# The over-rejection guard. The worst-case confidences here (SW1=27, LM358=30,
# 220uF=33) were measured on cleanly rendered text — real silkscreen scores
# lower still. This test is what fails if anyone raises the floor toward the
# conventional 60, which would discard all three.
@pytest.mark.parametrize(
    ("marking", "confidence"),
    [
        ("1K", 95.0),
        ("R10", 76.0),
        ("104", 82.0),
        ("4u7", 81.0),
        ("220uF", 33.0),
        ("LM358", 30.0),
        ("SW1", 27.0),
        ("C12", 69.0),
        ("ON", 95.0),
        ("OFF", 96.0),
    ],
)
def test_legitimate_short_markings_are_preserved(marking, confidence):
    assert detection_module._filter_ocr_words([marking], [confidence]) == marking


def test_filtering_is_case_neutral():
    """Locks out reintroducing a capitalisation policy. Tesseract alters case on
    its own (measured: 'SW1' -> 'Swi'), and lowercase markings are legitimate,
    so case must never decide credibility — only confidence and structure do."""
    assert detection_module._filter_ocr_words(["ab"], [90.0]) == "ab"
    assert detection_module._filter_ocr_words(["AB"], [90.0]) == "AB"
    assert detection_module._filter_ocr_words(["ab"], [10.0]) == ""
    assert detection_module._filter_ocr_words(["AB"], [10.0]) == ""


def test_incoherent_crop_is_rejected_even_though_some_words_pass():
    """The real hero.png buzzer crop: 23 words, only 7 credible. A crop that
    mostly failed was never text, so the survivors are discarded rather than
    concatenated into a plausible-looking name."""
    texts = ["ok"] * 7 + ["x"] * 16
    confidences = [90.0] * 7 + [5.0] * 16

    assert detection_module._filter_ocr_words(texts, confidences) == ""


def test_coherent_crop_is_kept():
    texts = ["LM358", "N4"]
    confidences = [91.0, 88.0]

    assert detection_module._filter_ocr_words(texts, confidences) == "LM358 N4"


def test_whitespace_and_newlines_are_normalised_to_single_spaces():
    """Previously multi-line reads were stored verbatim, producing names with
    embedded newlines such as "ion\\nrat"."""
    result = detection_module._filter_ocr_words(["220uF\n", "  16V  "], [80.0, 75.0])

    assert result == "220uF 16V"


def test_crop_below_the_minimum_size_is_skipped_without_invoking_tesseract(monkeypatch):
    """The real hero.png boxes included 3x5, 3x4 and 12x131 px crops. Tesseract
    must not even be consulted for these."""

    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("Tesseract must not be invoked for an undersized crop")

    monkeypatch.setattr(detection_module.pytesseract, "image_to_data", fail_if_called)

    tiny_crop = np.zeros((5, 3, 3), dtype=np.uint8)

    assert detection_module._ocr_crop(tiny_crop) == ""


def test_empty_crop_is_skipped():
    assert detection_module._ocr_crop(np.zeros((0, 0, 3), dtype=np.uint8)) == ""


# --- Second, complementary detector -----------------------------------------
#
# The HF YOLOv8s model is loaded alongside the original for benchmarking only
# (`/detect/compare`). These tests pin down that it is genuinely a second,
# independent detector and that adding it did not disturb the original.
#
# Both models are loaded once per module rather than per test: each checkpoint
# is ~20MB of weights and constructing them repeatedly in one process exhausts
# memory.


@pytest.fixture(scope="module")
def primary_service() -> DetectionService:
    service = DetectionService()
    service.load()
    return service


@pytest.fixture(scope="module")
def hf_service() -> DetectionService:
    service = DetectionService(
        model_path=detection_module.HF_MODEL_PATH, source=detection_module.SOURCE_HF
    )
    service.load()
    return service


def test_hf_model_file_is_present_and_loads(hf_service):
    assert hf_service.is_loaded


def test_hf_model_exposes_its_own_21_class_vocabulary(hf_service):
    """Source-of-truth check against the real checkpoint, mirroring the
    equivalent test for the primary model. The TS mapping table
    HF_YOLO_CLASS_TO_COMPONENT_TYPE assumes exactly these labels, so a swapped
    checkpoint fails here rather than silently producing "unknown" components."""
    assert set(hf_service.class_names.values()) == {
        "battery", "button", "buzzer", "capacitor", "clock", "connector", "diode",
        "display", "fuse", "heatsink", "ic", "inductor", "led", "pads", "pins",
        "potentiometer", "relay", "resistor", "switch", "transformer", "transistor",
    }


def test_the_two_models_are_distinct(primary_service, hf_service):
    assert primary_service.source == detection_module.SOURCE_CIRCUITLOOP
    assert hf_service.source == detection_module.SOURCE_HF
    assert primary_service.model_path != hf_service.model_path
    assert len(primary_service.class_names) == 8
    assert len(hf_service.class_names) == 21


def test_every_detection_is_attributable_to_the_model_that_produced_it(
    primary_service, hf_service, sample_image_bytes
):
    """Without this, two concurrently-loaded models' raw outputs become
    indistinguishable the moment they are collected together."""
    for service in (primary_service, hf_service):
        for detection in service.detect(sample_image_bytes, confidence=0.01):
            assert detection.source == service.source


def test_detection_source_defaults_to_the_primary_model():
    """Existing callers construct DetectionService() with no source argument —
    they must keep producing primary-model detections unchanged."""
    assert DetectionService().source == detection_module.SOURCE_CIRCUITLOOP
