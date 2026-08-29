"""
The combined YOLO fallback stage — `fallback_detection.py`.

The centrepiece of this suite is the same-component vs different-component
distinction: the merge must remove a detection ONLY when another model already
reported the same class in the same place. Overlap alone is not duplication —
components on a board legitimately overlap, and dropping the second one would
silently lose a valid detection.

Pure unit tests over hand-built `Detection` values: no model, no image, no
network.
"""

import pytest

from detection import SOURCE_CIRCUITLOOP, SOURCE_HF, BoundingBox, Detection
from fallback_detection import (
    NoFallbackModelsError,
    iou,
    merge_detections,
    run_fallback_detection,
)


def make(class_name, box, confidence=0.8, source=SOURCE_CIRCUITLOOP, text=""):
    x1, y1, x2, y2 = box
    return Detection(
        class_id=0,
        class_name=class_name,
        confidence=confidence,
        bbox=BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2),
        text=text,
        source=source,
    )


class _StubService:
    def __init__(self, detections=None, error=None, loaded=True, source=SOURCE_CIRCUITLOOP):
        self._detections = detections or []
        self._error = error
        self._loaded = loaded
        self._source = source
        self.calls = 0

    @property
    def is_loaded(self):
        return self._loaded

    @property
    def source(self):
        return self._source

    def detect(self, image_bytes, confidence=0.25):
        self.calls += 1
        if self._error is not None:
            raise self._error
        return list(self._detections)


# --- Same component vs different component -----------------------------------


def test_same_component_overlapping_is_deduplicated_to_one():
    custom = make("capacitor", (0, 0, 100, 100), confidence=0.6, source=SOURCE_CIRCUITLOOP)
    hf = make("capacitor", (5, 5, 105, 105), confidence=0.95, source=SOURCE_HF)

    merged = merge_detections([[custom], [hf]])

    assert len(merged) == 1


def test_the_custom_model_wins_a_same_component_overlap_even_with_lower_confidence():
    """Confidences from two independently trained models are not comparable on
    the same scale, so the domain-trained model wins the overlap rather than
    whichever number is larger."""
    custom = make("capacitor", (0, 0, 100, 100), confidence=0.55, source=SOURCE_CIRCUITLOOP)
    hf = make("capacitor", (5, 5, 105, 105), confidence=0.99, source=SOURCE_HF)

    merged = merge_detections([[custom], [hf]])

    assert len(merged) == 1
    assert merged[0].source == SOURCE_CIRCUITLOOP
    assert merged[0].confidence == pytest.approx(0.55)


def test_different_components_overlapping_are_both_kept():
    """A resistor boxed inside the same region as an IC is two real components.
    Overlap alone must never suppress."""
    ic = make("ic", (0, 0, 100, 100), confidence=0.9, source=SOURCE_CIRCUITLOOP)
    resistor = make("resistor", (2, 2, 98, 98), confidence=0.7, source=SOURCE_HF)

    merged = merge_detections([[ic], [resistor]])

    assert {d.class_name for d in merged} == {"ic", "resistor"}


def test_different_hf_labels_that_both_map_to_unknown_are_both_kept():
    """`connector` and `pads` both map to ComponentType `unknown` downstream.
    Comparing mapped types instead of raw class names would collapse two
    genuinely different components into one — this pins the raw comparison."""
    connector = make("connector", (0, 0, 100, 100), source=SOURCE_HF)
    pads = make("pads", (1, 1, 99, 99), source=SOURCE_HF)

    merged = merge_detections([[connector, pads]])

    assert {d.class_name for d in merged} == {"connector", "pads"}


def test_class_name_comparison_ignores_case():
    a = make("Capacitor", (0, 0, 100, 100), source=SOURCE_CIRCUITLOOP)
    b = make("capacitor", (2, 2, 102, 102), source=SOURCE_HF)

    assert len(merge_detections([[a], [b]])) == 1


# --- Overlap threshold --------------------------------------------------------


def test_same_class_below_the_iou_threshold_keeps_both():
    """Two real resistors side by side, barely touching."""
    left = make("resistor", (0, 0, 100, 100), source=SOURCE_CIRCUITLOOP)
    right = make("resistor", (90, 0, 190, 100), source=SOURCE_HF)

    merged = merge_detections([[left], [right]])

    assert len(merged) == 2


def test_disjoint_boxes_have_zero_iou():
    a = make("resistor", (0, 0, 10, 10))
    b = make("resistor", (50, 50, 60, 60))

    assert iou(a, b) == 0.0
    assert len(merge_detections([[a, b]])) == 2


def test_identical_boxes_have_iou_of_one():
    a = make("ic", (10, 10, 110, 110))
    b = make("ic", (10, 10, 110, 110))

    assert iou(a, b) == pytest.approx(1.0)


# --- Within one source --------------------------------------------------------


def test_within_one_source_the_higher_confidence_wins():
    weak = make("ic", (0, 0, 100, 100), confidence=0.4, source=SOURCE_HF)
    strong = make("ic", (3, 3, 103, 103), confidence=0.85, source=SOURCE_HF)

    merged = merge_detections([[weak, strong]])

    assert len(merged) == 1
    assert merged[0].confidence == pytest.approx(0.85)


# --- What the HF model adds ---------------------------------------------------


def test_hf_only_classes_survive_untouched():
    """The coverage the HF model exists to add: components the custom model's
    eight classes cannot see."""
    custom = make("ic", (0, 0, 50, 50), source=SOURCE_CIRCUITLOOP)
    hf_extras = [
        make("diode", (200, 200, 240, 240), source=SOURCE_HF),
        make("led", (300, 300, 330, 330), source=SOURCE_HF),
        make("inductor", (400, 400, 450, 450), source=SOURCE_HF),
    ]

    merged = merge_detections([[custom], hf_extras])

    assert {d.class_name for d in merged} == {"ic", "diode", "led", "inductor"}


def test_every_survivor_keeps_its_own_source():
    custom = make("ic", (0, 0, 50, 50), source=SOURCE_CIRCUITLOOP)
    hf = make("diode", (200, 200, 240, 240), source=SOURCE_HF)

    by_class = {d.class_name: d for d in merge_detections([[custom], [hf]])}

    assert by_class["ic"].source == SOURCE_CIRCUITLOOP
    assert by_class["diode"].source == SOURCE_HF


def test_text_and_confidence_are_carried_through_unchanged():
    detection = make("capacitor", (0, 0, 40, 40), confidence=0.42, text="220uF")

    merged = merge_detections([[detection]])

    assert merged[0].text == "220uF"
    assert merged[0].confidence == pytest.approx(0.42)


# --- Degenerate inputs --------------------------------------------------------


def test_empty_input_merges_to_empty():
    assert merge_detections([]) == []
    assert merge_detections([[], []]) == []


def test_a_single_group_passes_through():
    detections = [make("ic", (0, 0, 10, 10)), make("resistor", (20, 20, 30, 30))]

    assert merge_detections([detections]) == detections


# --- Running the stage --------------------------------------------------------


def test_the_stage_runs_every_loaded_model():
    custom = _StubService([make("ic", (0, 0, 50, 50))], source=SOURCE_CIRCUITLOOP)
    hf = _StubService([make("diode", (200, 200, 240, 240), source=SOURCE_HF)], source=SOURCE_HF)

    merged = run_fallback_detection([custom, hf], b"image", confidence=0.25)

    assert custom.calls == 1
    assert hf.calls == 1
    assert {d.class_name for d in merged} == {"ic", "diode"}


def test_the_stage_runs_with_only_one_model_available():
    custom = _StubService([make("ic", (0, 0, 50, 50))], source=SOURCE_CIRCUITLOOP)

    merged = run_fallback_detection([custom, None], b"image", confidence=0.25)

    assert [d.class_name for d in merged] == ["ic"]


def test_an_unloaded_model_is_skipped():
    custom = _StubService([make("ic", (0, 0, 50, 50))], source=SOURCE_CIRCUITLOOP)
    hf = _StubService(loaded=False, source=SOURCE_HF)

    merged = run_fallback_detection([custom, hf], b"image", confidence=0.25)

    assert hf.calls == 0
    assert len(merged) == 1


def test_one_model_failing_at_runtime_does_not_sink_the_stage():
    custom = _StubService([make("ic", (0, 0, 50, 50))], source=SOURCE_CIRCUITLOOP)
    hf = _StubService(error=RuntimeError("CUDA blew up"), source=SOURCE_HF)

    merged = run_fallback_detection([custom, hf], b"image", confidence=0.25)

    assert [d.class_name for d in merged] == ["ic"]


def test_an_undecodable_image_is_raised_not_swallowed():
    """A client error must surface as one rather than being reduced to a
    partial result from the other model."""
    custom = _StubService(error=ValueError("Could not decode image bytes"))

    with pytest.raises(ValueError):
        run_fallback_detection([custom], b"image", confidence=0.25)


def test_no_loaded_model_raises():
    with pytest.raises(NoFallbackModelsError):
        run_fallback_detection([None, None], b"image", confidence=0.25)


def test_every_model_failing_raises():
    custom = _StubService(error=RuntimeError("boom"), source=SOURCE_CIRCUITLOOP)
    hf = _StubService(error=RuntimeError("boom"), source=SOURCE_HF)

    with pytest.raises(NoFallbackModelsError):
        run_fallback_detection([custom, hf], b"image", confidence=0.25)
