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

import { YOLO_CLASS_TO_COMPONENT_TYPE } from "../src/services/detectionService.js";

// Re-verified directly against the real model.load() -> model.names in this
// same review pass (not recalled from memory) — see the Phase 7 review report.
const REAL_MODEL_LABELS = ["battery", "buzzer", "capacitor", "display", "ic", "relay", "resistor", "switch"];

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
