/**
 * Verifies YOLO_CLASS_TO_COMPONENT_TYPE (backend/src/services/detectionService.ts)
 * against the real trained model's actual class labels — not the mock
 * labels used in scanUpload.test.ts's "lossless mapping" test, which are
 * hand-typed and only prove the mapping *function* behaves correctly for
 * whatever strings it's given, not that those strings are what the real
 * model actually produces. This is the corresponding source-of-truth
 * check on the TS side; ml-service/tests/test_detection_service.py's
 * `test_real_model_class_names_match_the_verified_label_set` is the
 * matching check on the Python side, against the real loaded model.
 * Together they transitively prove the TS mapping is aligned with the
 * real model, without needing a cross-language call in this suite (which
 * would require Python/YOLO installed to run the TS tests at all —
 * exactly what this suite is designed to avoid).
 */

import { describe, expect, it } from "vitest";

import {
  CLASS_NAME_TO_COMPONENT_TYPE,
  GEMINI_CLASS_TO_COMPONENT_TYPE,
  HF_YOLO_CLASS_TO_COMPONENT_TYPE,
  mapClassNameToComponentType,
  YOLO_CLASS_TO_COMPONENT_TYPE,
} from "../src/services/detectionService.js";

// Re-verified directly against the real model.load() -> model.names in this
// same review pass (not recalled from memory) — see the Phase 7 review report.
const REAL_MODEL_LABELS = ["battery", "buzzer", "capacitor", "display", "ic", "relay", "resistor", "switch"];

/**
 * The labels Gemini emits that DO have an exact `ComponentType`. Not a closed
 * set: Gemini's response schema leaves `label` open-ended, so it can also name
 * components this union has no type for (see OPEN_VOCABULARY_GEMINI_LABELS).
 * Kept in sync with ml-service/gemini_detection.py's COMPONENT_LABELS, which
 * asserts the same list on the Python side.
 */
const GEMINI_LABELS = [
  "resistor", "capacitor", "led", "diode", "transistor", "ic", "microcontroller",
  "battery", "buzzer", "display", "relay", "switch", "unknown",
];

describe("YOLO_CLASS_TO_COMPONENT_TYPE", () => {
  it("has exactly one entry per real model label — no more, no fewer", () => {
    expect(Object.keys(YOLO_CLASS_TO_COMPONENT_TYPE).sort()).toEqual([...REAL_MODEL_LABELS].sort());
  });

  it("maps every real label losslessly to itself, never to 'unknown'", () => {
    for (const label of REAL_MODEL_LABELS) {
      expect(YOLO_CLASS_TO_COMPONENT_TYPE[label]).toBe(label);
    }
  });
});

/**
 * The merged runtime lookup. All three detectors now reach `detectAndPersist`
 * — Gemini as the primary, and both YOLO models through ml-service's combined
 * fallback stage — so a label from any of them has to map.
 */
describe("CLASS_NAME_TO_COMPONENT_TYPE", () => {
  it("covers every label all three detectors can emit", () => {
    const expected = new Set([
      ...Object.keys(YOLO_CLASS_TO_COMPONENT_TYPE),
      ...Object.keys(HF_YOLO_CLASS_TO_COMPONENT_TYPE),
      ...Object.keys(GEMINI_CLASS_TO_COMPONENT_TYPE),
    ]);

    expect(new Set(Object.keys(CLASS_NAME_TO_COMPONENT_TYPE))).toEqual(expected);
  });

  it("never contradicts any source table on a shared key", () => {
    // This is what makes merging safe rather than a source of silent
    // mis-mapping: no table can shadow another with a different meaning.
    for (const table of [
      YOLO_CLASS_TO_COMPONENT_TYPE,
      HF_YOLO_CLASS_TO_COMPONENT_TYPE,
      GEMINI_CLASS_TO_COMPONENT_TYPE,
    ]) {
      for (const [label, type] of Object.entries(table)) {
        expect(CLASS_NAME_TO_COMPONENT_TYPE[label]).toBe(type);
      }
    }
  });

  it("maps every Gemini label that has a ComponentType losslessly to itself", () => {
    // 'unknown' is in this list as a real answer meaning "a component I can see
    // but can't name" — not as a degraded mapping.
    for (const label of GEMINI_LABELS) {
      expect(CLASS_NAME_TO_COMPONENT_TYPE[label]).toBe(label);
    }
  });

  it("still maps the custom model's own labels losslessly", () => {
    for (const label of REAL_MODEL_LABELS) {
      expect(CLASS_NAME_TO_COMPONENT_TYPE[label]).toBe(label);
    }
  });

  it("keeps HF-only components as 'unknown' rather than force-fitting them", () => {
    for (const label of ["connector", "pads", "fuse", "heatsink", "inductor"]) {
      expect(CLASS_NAME_TO_COMPONENT_TYPE[label]).toBe("unknown");
    }
  });
});

/**
 * Gemini's detection vocabulary is open (ml-service/gemini_detection.py sends
 * `label` as a plain string, with no enum), so it can name components this
 * backend has no `ComponentType` for. These pin the intended split: the TYPE
 * degrades to 'unknown', which is a storage-schema limit; the detection itself
 * is never dropped and its raw label is never rewritten.
 */
const OPEN_VOCABULARY_GEMINI_LABELS = [
  "potentiometer",
  "mosfet",
  "crystal",
  "oscillator",
  "push button",
  "voltage regulator",
  "sensor",
  "transformer",
];

describe("open-vocabulary Gemini labels", () => {
  it("accepts 'switch', which has an exact ComponentType", () => {
    expect(mapClassNameToComponentType("switch")).toBe("switch");
  });

  it("normalises 'network switch' onto the 'switch' type", () => {
    // Deliberately lossy: a rack switch is not a PCB toggle switch. The
    // narrowing exists so the component stays queryable in the closed union,
    // and `Component.label` is what keeps "network switch" for display.
    expect(mapClassNameToComponentType("network switch")).toBe("switch");
    expect(GEMINI_CLASS_TO_COMPONENT_TYPE["network switch"]).toBe("switch");
  });

  it("accepts 'relay' — a ComponentType the local models can also emit", () => {
    expect(mapClassNameToComponentType("relay")).toBe("relay");
  });

  it("resolves a label with no ComponentType to the 'unknown' type", () => {
    for (const label of OPEN_VOCABULARY_GEMINI_LABELS) {
      expect(mapClassNameToComponentType(label)).toBe("unknown");
    }
  });

  it("normalises casing and surrounding whitespace before looking a label up", () => {
    expect(mapClassNameToComponentType("  Switch ")).toBe("switch");
    expect(mapClassNameToComponentType("POTENTIOMETER")).toBe("unknown");
  });
});
