/**
 * Orchestrates the detection-upload flow:
 *   image bytes -> ml-service /detect -> map raw class_name -> ComponentType
 *   -> persist via the EXISTING componentService/componentRepository (reused
 *   verbatim, no second Neo4j write path) -> ComponentDetail[]
 *
 * Per ML_SERVICE_INTEGRATION_PLAN.md §7/§9 Phase 4 and the component-domain
 * extension: the class-name -> ComponentType mapping is now lossless for
 * every class the verified model actually produces. `unknown` is reserved
 * for a genuinely unrecognized label (e.g. a future model version), never
 * used for any of the 8 known classes.
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
 * Class-name mapping for the second, complementary detector — the pretrained
 * YOLOv8s PCB model (https://huggingface.co/Arshia82sbn/pcb-yolov8s-detection),
 * which emits 21 classes against our 13 `ComponentType` values.
 *
 * Purely additive and currently UNUSED by the detection flow: `/detect` still
 * serves the primary model alone, and the second model is reachable only via
 * the ml-service `/detect/compare` benchmarking endpoint. This table exists so
 * the mapping is decided and reviewable *before* any decision about combining
 * the two models — mapping the model's vocabulary onto ours, rather than
 * altering the model.
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

/** `unknown` is the fallback ONLY for a label outside the verified set above — never for one of the 8 known classes. */
function mapClassNameToComponentType(className: string): ComponentType {
  return YOLO_CLASS_TO_COMPONENT_TYPE[className] ?? "unknown";
}

function toComponentInput(scanId: string, detection: MlDetection): ComponentInput {
  const ocrText = detection.text.trim();
  return {
    scanId,
    type: mapClassNameToComponentType(detection.class_name),
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
