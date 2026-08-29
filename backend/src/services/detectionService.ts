/**
 * Orchestrates the detection-upload flow:
 *   image bytes -> ml-service /detect -> map raw class_name -> ComponentType
 *   -> persist via the EXISTING componentService/componentRepository (reused
 *   verbatim, no second Neo4j write path) -> ComponentDetail[]
 *
 * Unchanged by the move to Gemini: ml-service now serves `/detect` from
 * Gemini first and from the combined custom-YOLO11s + HF-YOLOv8s fallback
 * stage only when Gemini fails, but the response shape is identical either
 * way, so everything below works the same for both. The only adjustment was
 * to the class-name table — every label any of the three models can emit must
 * map, since all three now reach this code.
 *
 * Per ML_SERVICE_INTEGRATION_PLAN.md §7/§9 Phase 4 and the component-domain
 * extension: the mapping is lossless for every class the models actually
 * produce. `unknown` is reserved for a genuinely unrecognized label (e.g. a
 * future model version) and for real components this schema has no
 * `ComponentType` for yet — never as a catch-all for a label that does have
 * an equivalent.
 */

import { mlServiceClient } from "./mlServiceClient.js";
import * as componentService from "./componentService.js";
import type { ComponentInput } from "../repositories/componentRepository.js";
import * as scanRepository from "../repositories/scanRepository.js";
import type { ComponentDetail, ComponentType } from "../types/entities.js";
import type { MlDetection } from "../types/mlService.js";
import { NotFoundError, UpstreamServiceError, ValidationError } from "../utils/errors.js";

/**
 * Verified against the real trained model in Phase 1 (re-verified in the
 * Phase 7 review — see ml-service/tests/test_detection_service.py's
 * `test_real_model_class_names_match_the_verified_label_set`, the
 * corresponding source-of-truth check against the actual model) — not
 * guessed. Lossless: every real class maps to itself. Exported so
 * tests/detectionService.test.ts can assert its key set directly, rather
 * than only indirectly through hand-constructed mock detection responses.
 */
export const YOLO_CLASS_TO_COMPONENT_TYPE: Readonly<Record<string, ComponentType>> = {
  battery: "battery",
  buzzer: "buzzer",
  capacitor: "capacitor",
  display: "display",
  ic: "ic",
  relay: "relay",
  resistor: "resistor",
  switch: "switch",
};

/**
 * Class-name mapping for the complementary pretrained YOLOv8s PCB model
 * (https://huggingface.co/Arshia82sbn/pcb-yolov8s-detection), which emits 21
 * classes against our 13 `ComponentType` values.
 *
 * No longer unused: this model is now half of ml-service's combined fallback
 * detection stage, so its labels genuinely reach `detectAndPersist` whenever
 * Gemini is unavailable. That is why `CLASS_NAME_TO_COMPONENT_TYPE` below
 * merges this table in rather than consulting the primary one alone — an
 * unmapped `diode` would otherwise be silently recorded as `unknown`.
 *
 * Eleven classes have exact internal equivalents. The remaining ten are real
 * PCB components we simply have no `ComponentType` for yet; they map to
 * `unknown` rather than being force-fitted to a near-miss type, so a
 * `connector` is never silently recorded as something it isn't. Widening
 * `ComponentType` to cover them is a schema decision, deliberately not taken
 * here.
 */
export const HF_YOLO_CLASS_TO_COMPONENT_TYPE: Readonly<Record<string, ComponentType>> = {
  // Direct equivalents (11)
  battery: "battery",
  buzzer: "buzzer",
  capacitor: "capacitor",
  diode: "diode",
  display: "display",
  ic: "ic",
  led: "led",
  relay: "relay",
  resistor: "resistor",
  switch: "switch",
  transistor: "transistor",
  // Genuine components with no ComponentType equivalent yet (10)
  button: "unknown",
  clock: "unknown",
  connector: "unknown",
  fuse: "unknown",
  heatsink: "unknown",
  inductor: "unknown",
  pads: "unknown",
  pins: "unknown",
  potentiometer: "unknown",
  transformer: "unknown",
};

/**
 * Class names Gemini can emit that the two YOLO tables do not already cover.
 *
 * Gemini's label vocabulary is deliberately OPEN — its response schema types
 * `label` as a plain string with no enum, so it can name any component it
 * recognises (`potentiometer`, `mosfet`, `crystal`, ...). This table therefore
 * cannot be exhaustive by construction, and is not meant to be: it names the
 * labels with an exact `ComponentType` that the two YOLO tables do not already
 * cover — types the local models were never trained to see, the coverage the
 * primary detector adds.
 *
 * Anything else Gemini names falls through to the `unknown` ComponentType in
 * `mapClassNameToComponentType` below. That is a limitation of THIS mapping
 * and of the Neo4j schema behind it, not of the detector: the raw label Gemini
 * produced is preserved verbatim in `MlDetection.class_name` and is never
 * rewritten upstream. Widening `ComponentType` to store those types is a
 * schema decision, deliberately not taken here.
 */
export const GEMINI_CLASS_TO_COMPONENT_TYPE: Readonly<Record<string, ComponentType>> = {
  led: "led",
  diode: "diode",
  transistor: "transistor",
  microcontroller: "microcontroller",
  // A whole network switch normalises to the `switch` type so it stays
  // queryable in the existing union. The narrowing is lossy — a rack switch is
  // not a PCB toggle switch — which is exactly why `Component.label` keeps
  // "network switch" verbatim and is what the UI displays.
  "network switch": "switch",
  // Gemini emits this deliberately, meaning "a component I can see but cannot
  // name" — a real answer, not an unrecognised label. Listed explicitly so it
  // maps by intent rather than by falling through to the default below.
  unknown: "unknown",
};

/**
 * The single lookup used at runtime, covering every label any of the three
 * detectors can produce.
 *
 * Merging is safe and lossless: the three tables agree on every key they
 * share (`capacitor` -> `capacitor` in all of them), so no entry can shadow a
 * different meaning. The order below is the precedence — the project's own
 * model first — which matters only if that invariant is ever broken.
 */
export const CLASS_NAME_TO_COMPONENT_TYPE: Readonly<Record<string, ComponentType>> = {
  ...HF_YOLO_CLASS_TO_COMPONENT_TYPE,
  ...GEMINI_CLASS_TO_COMPONENT_TYPE,
  ...YOLO_CLASS_TO_COMPONENT_TYPE,
};

/**
 * `unknown` is the fallback for a label outside every table above — never for
 * a class one of the YOLO models is known to emit. Since Gemini's vocabulary is
 * open, an open-vocabulary label ("potentiometer", "mosfet") legitimately lands
 * here: it becomes the `unknown` *ComponentType* while the detection's own
 * `class_name` keeps the name Gemini gave it.
 *
 * Exported for the mapping tests, which pin exactly that behaviour.
 */
export function mapClassNameToComponentType(className: string): ComponentType {
  return CLASS_NAME_TO_COMPONENT_TYPE[className.trim().toLowerCase()] ?? "unknown";
}

/**
 * One detection as a persistable component.
 *
 * The three identity-ish fields are deliberately distinct and must stay that
 * way — collapsing them is what previously made a Cisco switch display as
 * "CISCO SG300-52 …":
 *
 *   type  — the detector's label narrowed to `ComponentType`, for querying.
 *   label — the detector's label verbatim, the display identity.
 *   name  — the marking printed on the part, evidence only.
 */
function toComponentInput(scanId: string, detection: MlDetection): ComponentInput {
  const ocrText = detection.text.trim();
  const rawLabel = detection.class_name.trim();
  return {
    scanId,
    type: mapClassNameToComponentType(detection.class_name),
    label: rawLabel.length > 0 ? rawLabel : null,
    name: ocrText.length > 0 ? ocrText : null,
    confidence: detection.confidence,
    condition: "unknown",
    salvagePriority: null,
    x1: detection.bbox.x1,
    y1: detection.bbox.y1,
    x2: detection.bbox.x2,
    y2: detection.bbox.y2,
  };
}

/**
 * Upstream reasons that reflect a problem with *what the user uploaded*,
 * not with the ML service itself — these get surfaced as a proper 400
 * `ValidationError`, not a generic 502, per this phase's explicit
 * requirement not to expose every upstream failure as a flat 502 where a
 * more specific client-facing status is appropriate. Anything else
 * (`service_unavailable`, `internal_error`, unreachable, timeout, or an
 * unrecognized upstream reason) is a genuine upstream failure and passes
 * through as `UpstreamServiceError` (502/503) unchanged.
 */
const USER_INPUT_UPSTREAM_ERRORS = new Set(["invalid_image", "unsupported_media_type", "payload_too_large"]);

function translateDetectionError(error: unknown): Error {
  if (error instanceof UpstreamServiceError && error.upstreamError && USER_INPUT_UPSTREAM_ERRORS.has(error.upstreamError)) {
    const reason = error.upstreamDetail ?? error.upstreamError;
    return new ValidationError(`Uploaded image could not be processed: ${reason}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface DetectAndPersistInput {
  scanId: string;
  /** Authenticated user; the scan must belong to them and every persisted component is owned by them. */
  ownerId: string;
  imageBuffer: Buffer;
  filename: string;
  contentType: string;
  confidence?: number;
  correlationId?: string;
}

export async function detectAndPersist(input: DetectAndPersistInput): Promise<ComponentDetail[]> {
  let detections: MlDetection[];
  try {
    const response = await mlServiceClient.detectComponents(
      { buffer: input.imageBuffer, filename: input.filename, contentType: input.contentType },
      { confidence: input.confidence, correlationId: input.correlationId },
    );
    detections = response.detections;
  } catch (error) {
    throw translateDetectionError(error);
  }

  if (detections.length === 0) {
    // createDetectionBatch's Cypher (UNWIND over the input list) can't tell
    // "scan not found" apart from "scan found, model detected nothing" when
    // given an empty array — both produce zero rows. Rather than touch that
    // already-tested, reused query, this one case is checked explicitly
    // here using the existing scanRepository.scanExists helper (already
    // used by componentService for the same purpose elsewhere).
    if (!(await scanRepository.scanExists(input.scanId, input.ownerId))) {
      throw new NotFoundError("Scan", input.scanId);
    }
    return [];
  }

  const componentInputs = detections.map((detection) => toComponentInput(input.scanId, detection));

  // Reused verbatim — no second Neo4j persistence path.
  return componentService.createDetectionBatch(input.scanId, componentInputs, input.ownerId);
}
