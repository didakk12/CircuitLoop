/**
 * Assistant orchestration — per ML_SERVICE_INTEGRATION_PLAN.md §6: Python
 * (ml-service) stays retrieval-only; this service assembles context and
 * retrieval, then asks whichever LLM provider `llmProvider.ts` currently
 * points at to answer, under the shared policy in `assistantPrompt.ts`.
 *
 * What the LLM receives, in three clearly separated blocks:
 *   A. the selected component's stored record (identity, detection metadata,
 *      status, board position, provenance)
 *   B. its complete test history, oldest→newest, with derived counts
 *   C. datasheet excerpts retrieved from Neo4j, each labelled with whether it
 *      is actually about this part
 *
 * The assistant is deliberately not driven by any list of anticipated
 * questions: there is no keyword matching and no canned response anywhere in
 * this path. Whatever is known about the component is laid out, and the model
 * answers from it.
 *
 * Ownership: `componentService.getComponentById(id, ownerId)` is the first
 * thing that runs and is the only way a component enters this flow. It is
 * owner-scoped in Cypher, so another user's component id is indistinguishable
 * from a non-existent one (both 404) and no data about it is ever assembled.
 *
 * Datasheet retrieval is an *enhancement*, not a hard dependency: if the
 * ml-service is unreachable the assistant still answers from the component
 * and test context, and the prompt says plainly that no datasheet evidence
 * was available. Only a genuine LLM failure (or an unknown component) is
 * surfaced as an error.
 */

import {
  ASSISTANT_UNAVAILABLE_MESSAGE,
  COMPONENT_SCOPE_SYSTEM_PROMPT,
} from "./assistantPrompt.js";
import * as componentService from "./componentService.js";
import * as llmProvider from "./llmProvider.js";
import { mlServiceClient } from "./mlServiceClient.js";
import { settings } from "../config/env.js";
import type { AssistantResponse, AssistantStreamEvent } from "../types/dto.js";
import type { ConversationMessage } from "../validation/assistantSchemas.js";
import type { ComponentDetail, TestResult } from "../types/entities.js";
import type { MlSearchResult } from "../types/mlService.js";

/**
 * Most recent test results included verbatim. Bounded so a component that has
 * been tested hundreds of times cannot crowd the datasheet excerpts and the
 * question out of the context window. Counts below are computed over the
 * *whole* history regardless, so "has this ever failed?" stays correct even
 * when the listing is truncated.
 */
const MAX_TEST_HISTORY_ENTRIES = 20;

/**
 * Most recent conversation turns replayed to the model.
 *
 * Distinct from the schema's `MAX_HISTORY_MESSAGES` rejection cap: that one
 * refuses an abusive payload, this one keeps the prompt bounded no matter how
 * long a legitimate thread grows. Trimming takes the *newest* turns, because
 * a follow-up depends on what was just said, not on the start of the thread.
 *
 * 10 turns is roughly five exchanges — enough for "why?", "what about the
 * other one?", "expand on that" to resolve, while leaving the context window
 * to the component record, test history and datasheet excerpts, which are the
 * grounded material and must not be crowded out by chat.
 */
const HISTORY_TURNS_SENT_TO_LLM = 10;

interface RetrievedChunk extends MlSearchResult {
  /** True when this chunk's datasheet is for the component's own marking. */
  matchesComponentMarking: boolean;
}

interface AssistantContext {
  componentSummary: string;
  testSummary: string;
  chunks: RetrievedChunk[];
  /** Marking used for part-identity matching, for the "no evidence" wording. */
  componentMarking: string | null;
}

// ---------------------------------------------------------------------------
// A. Component record
// ---------------------------------------------------------------------------

function formatBoardPosition(component: ComponentDetail): string | null {
  const { x1, y1, x2, y2 } = component;
  if (x1 === null || y1 === null || x2 === null || y2 === null) {
    return null;
  }
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return (
    `bounding box (${x1}, ${y1}) to (${x2}, ${y2}) in scan-image pixels, ` +
    `${width}x${height}px`
  );
}

const STATUS_DESCRIPTIONS: Readonly<Record<ComponentDetail["status"], string>> = {
  not_tested: "not_tested (no test has been recorded for this unit)",
  pass: "pass (its most recent recorded test passed)",
  fail: "fail (its most recent recorded test failed)",
};

/**
 * The component's stored record, as facts rather than prose.
 *
 * `condition` and `salvagePriority` are handled carefully. Both are nullable
 * fields that the detection pipeline never populates — `detectionService.ts`
 * writes `condition: "unknown"` and `salvagePriority: null` for every
 * detected component, and no UI path sets them afterwards. They are only
 * populated if someone writes them through the components API directly.
 * So they are reported only when they actually carry a value, and their
 * absence is stated as "never assessed" rather than being emitted as a
 * finding of "unknown" that the model might repeat as though a real
 * assessment had concluded nothing.
 */
function summarizeComponent(component: ComponentDetail): string {
  const lines: string[] = [
    `Component ID: ${component.id}`,
    `Type: ${component.type}`,
    component.name
      ? `Marking read from the component by OCR: "${component.name}"`
      : `Marking: none — OCR read no legible text off this component. Its exact part number is unknown.`,
    `Current status: ${STATUS_DESCRIPTIONS[component.status]}`,
    `Detection confidence: ${Math.round(component.confidence * 100)}% — how sure the vision model was that this is a ${component.type}. It is not a measure of the component's health.`,
  ];

  lines.push(
    component.condition !== "unknown"
      ? `Condition estimate (from the scan image, not a measurement): ${component.condition}`
      : `Condition: never assessed. No condition estimate has been recorded for this component.`,
  );

  lines.push(
    component.salvagePriority !== null
      ? `Salvage priority: ${component.salvagePriority}`
      : `Salvage priority: never assigned.`,
  );

  const position = formatBoardPosition(component);
  lines.push(
    position !== null
      ? `Position on the scanned board: ${position}`
      : `Position on the scanned board: not recorded.`,
  );

  lines.push(`First detected/created at: ${component.createdAt}`);
  lines.push(
    component.scanId !== null
      ? `Detected in scan: ${component.scanId}`
      : `Not linked to any scan (created directly, not from a board scan).`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// B. Test history
// ---------------------------------------------------------------------------

function formatMeasurement(testResult: TestResult): string {
  const unit = testResult.unit ?? "";
  const measured =
    testResult.measuredValue !== null
      ? `measured ${testResult.measuredValue}${unit}`
      : "no measurement recorded";
  const expected =
    testResult.expectedValue !== null ? `, expected ${testResult.expectedValue}${unit}` : "";
  return `${measured}${expected}`;
}

/**
 * The component's full test history, oldest first, with counts derived over
 * every result — not just the latest one, so questions about whether it has
 * *ever* failed, how often it has been tested, or how readings changed
 * between runs are answerable.
 *
 * `testResults` comes attached to the ComponentDetail that ownership
 * resolution already loaded, so this costs no extra query.
 *
 * It arrives already ordered oldest-first by `componentRepository`, which
 * sorts on Neo4j's native temporal value. The sort below is a stable
 * re-affirmation of that for any caller constructing a ComponentDetail by
 * other means; because it is stable and deliberately has no tiebreaker, two
 * entries whose mapped timestamps are equal keep the database's ordering.
 * A tiebreaker on `id` would be worse than none — it would replace the
 * correct chronological order with an arbitrary UUID order whenever two tests
 * landed in the same millisecond, which mapping through a JS `Date` makes
 * indistinguishable.
 */
function summarizeTestHistory(testResults: readonly TestResult[]): string {
  if (testResults.length === 0) {
    return (
      "This component has never been tested. There are no measurements, no pass/fail " +
      "verdicts, and no history for this unit. Anything about how this specific unit " +
      "actually behaves is therefore unknown — but the component record above and any " +
      "datasheet evidence below still describe what this kind of part is and does."
    );
  }

  const ordered = [...testResults].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
  const passed = ordered.filter((result) => result.status === "pass").length;
  const failed = ordered.filter((result) => result.status === "fail").length;
  const latest = ordered[ordered.length - 1]!;

  const header = [
    `Total tests recorded: ${ordered.length} (${passed} passed, ${failed} failed).`,
    `Has ever failed: ${failed > 0 ? "yes" : "no"}.`,
    `Most recent test: ${latest.status} on ${latest.timestamp} — ${formatMeasurement(latest)}.`,
  ];

  const shown = ordered.slice(-MAX_TEST_HISTORY_ENTRIES);
  const omitted = ordered.length - shown.length;
  if (omitted > 0) {
    header.push(
      `Full history is ${ordered.length} entries; the ${shown.length} most recent are listed below (${omitted} older ${omitted === 1 ? "entry is" : "entries are"} omitted, but the counts above cover all of them).`,
    );
  }

  const listing = shown.map(
    (result, index) =>
      `  ${index + 1 + omitted}. ${result.timestamp} — ${result.status} — ${formatMeasurement(result)}`,
  );

  return [...header, "", "Test history (oldest first):", ...listing].join("\n");
}

// ---------------------------------------------------------------------------
// C. Datasheet retrieval
// ---------------------------------------------------------------------------

/** Uppercase alphanumerics only, so "ICM-7555" and "icm7555" compare equal. */
function normalizePartToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Whether a retrieved chunk is actually the selected component's own
 * datasheet, decided here rather than left to the model or to the similarity
 * score.
 *
 * This exists because the score genuinely cannot answer it. Measured against
 * the real corpus: a query naming a part that is *absent* still scores
 * 0.671–0.758 against other parts' datasheets, overlapping the 0.731–0.792
 * range of parts that are present. No threshold separates those. Comparing
 * the OCR marking to the chunk's part name does separate them, so the prompt
 * can tell the model which excerpts are evidence about *this* part and which
 * are merely related reading.
 *
 * The 3-character floor avoids spurious matches against the short, noisy
 * part names the ingestion pipeline extracted from some PDFs (e.g. "4").
 */
function chunkMatchesMarking(chunk: MlSearchResult, marking: string | null): boolean {
  if (marking === null) {
    return false;
  }
  const normalizedMarking = normalizePartToken(marking);
  const normalizedPart = normalizePartToken(chunk.part_name);
  if (normalizedMarking.length < 3 || normalizedPart.length < 3) {
    return false;
  }
  return normalizedMarking.includes(normalizedPart) || normalizedPart.includes(normalizedMarking);
}

/**
 * The retrieval query: the component's identity followed by the question.
 *
 * Previously only the question was embedded, which meant a question like
 * "what is the maximum operating voltage?" carried nothing identifying the
 * selected part and matched essentially at random across the corpus. Putting
 * the OCR marking and the type in front anchors the embedding to the part.
 */
export function buildRetrievalQuery(component: ComponentDetail, question: string): string {
  return [component.name ?? "", component.type, question]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
}

function formatChunks(chunks: RetrievedChunk[], marking: string | null): string {
  if (chunks.length === 0) {
    return (
      "No datasheet excerpt in the knowledge base was relevant enough to this question " +
      "to be included. Treat this as: no datasheet evidence is available here. Do not " +
      "invent specifications, ratings or part numbers to fill the gap."
    );
  }

  const anyMatch = chunks.some((chunk) => chunk.matchesComponentMarking);
  const preamble =
    anyMatch || marking === null
      ? ""
      : `None of the excerpts below is the datasheet for "${marking}". They are related reference material only.\n\n`;

  const body = chunks
    .map((chunk) => {
      const provenance = chunk.matchesComponentMarking
        ? `THIS COMPONENT'S OWN DATASHEET (part ${chunk.part_name})`
        : `DIFFERENT PART (${chunk.part_name}) — related reference only, not evidence about the selected component`;
      return (
        `[${provenance}; section "${chunk.section}"; source ${chunk.source_file}; ` +
        `relevance ${chunk.score.toFixed(3)}]\n${chunk.text}`
      );
    })
    .join("\n\n");

  return preamble + body;
}

/**
 * Datasheet excerpts improve an answer but are not required for one. If the
 * ml-service is unreachable or erroring, log it and continue with none:
 * `formatChunks([])` renders as an explicit "no datasheet evidence available",
 * which the system prompt instructs the model to be honest about.
 */
async function retrieveDatasheetChunks(
  component: ComponentDetail,
  question: string,
): Promise<RetrievedChunk[]> {
  try {
    const response = await mlServiceClient.searchKnowledge(
      buildRetrievalQuery(component, question),
      { topK: settings.ragTopK, minScore: settings.ragMinScore },
    );
    return response.results.map((result) => ({
      ...result,
      matchesComponentMarking: chunkMatchesMarking(result, component.name),
    }));
  } catch (error) {
    console.error(
      `[assistantService] datasheet retrieval unavailable, answering without excerpts: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildPrompt(question: string, context: AssistantContext): string {
  return (
    `=== A. COMPONENT RECORD (stored data about the selected component) ===\n` +
    `${context.componentSummary}\n\n` +
    `=== B. TEST HISTORY (measurements actually taken on this unit) ===\n` +
    `${context.testSummary}\n\n` +
    `=== C. DATASHEET EVIDENCE (retrieved from the datasheet knowledge base) ===\n` +
    `${formatChunks(context.chunks, context.componentMarking)}\n\n` +
    `=== QUESTION ===\n${question}`
  );
}

function unavailableResponse(componentId: string): AssistantResponse {
  return { component_id: componentId, configured: false, message: ASSISTANT_UNAVAILABLE_MESSAGE };
}

type PreparedExchange =
  | { kind: "unavailable" }
  | { kind: "ready"; userPrompt: string; history: ConversationMessage[] };

/**
 * Keeps the most recent turns, dropping older ones.
 *
 * History arrives already validated for role and length; this is purely the
 * context-budget trim. It is deliberately applied server-side rather than
 * trusted to the client, so a client that replays its entire thread still
 * produces a bounded prompt.
 */
function boundHistory(history: readonly ConversationMessage[]): ConversationMessage[] {
  return history.slice(-HISTORY_TURNS_SENT_TO_LLM);
}

/**
 * Shared setup for both entry points: resolve the component under the
 * caller's ownership, then — only if a provider is configured — assemble the
 * prompt.
 *
 * `getComponentById` throws `NotFoundError` for an unknown component *or* one
 * owned by another user (deliberately indistinguishable); both callers let it
 * propagate as a real 404. The no-provider short-circuit happens before any
 * retrieval, so a question can never trigger component data access or an
 * ml-service call when there is no LLM to answer it.
 *
 * One database read: the ComponentDetail already carries the full test
 * history, so no separate test-result query is issued.
 */
async function prepareExchange(
  ownerId: string,
  componentId: string,
  question: string,
  history: readonly ConversationMessage[],
): Promise<PreparedExchange> {
  const component = await componentService.getComponentById(componentId, ownerId);

  if (!llmProvider.isConfigured()) {
    return { kind: "unavailable" };
  }

  // Retrieval is driven by the *current* question only, never by replayed
  // history: a follow-up like "why?" carries no retrievable content, and
  // folding old turns into the embedding would drag retrieval back toward
  // whatever was asked earlier instead of what was asked now.
  const chunks = await retrieveDatasheetChunks(component, question);

  const context: AssistantContext = {
    componentSummary: summarizeComponent(component),
    testSummary: summarizeTestHistory(component.testResults),
    chunks,
    componentMarking: component.name,
  };

  return {
    kind: "ready",
    userPrompt: buildPrompt(question, context),
    history: boundHistory(history),
  };
}

export async function askAssistant(
  ownerId: string,
  componentId: string,
  question: string,
  history: readonly ConversationMessage[] = [],
): Promise<AssistantResponse> {
  const prepared = await prepareExchange(ownerId, componentId, question, history);
  if (prepared.kind === "unavailable") {
    return unavailableResponse(componentId);
  }

  try {
    const message = await llmProvider.generateAnswer(
      COMPONENT_SCOPE_SYSTEM_PROMPT,
      prepared.userPrompt,
      prepared.history,
    );
    return { component_id: componentId, configured: true, message };
  } catch (error) {
    // Logged for operator visibility, never surfaced: the client-facing
    // message is a fixed constant regardless of what the adapter threw, and
    // carries no component or datasheet content.
    console.error(
      `[assistantService] LLM generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return unavailableResponse(componentId);
  }
}

/**
 * Streaming counterpart of `askAssistant`, yielding typed events for the SSE
 * endpoint. Same policy, same guarantees:
 * - unknown/unowned component -> `NotFoundError` propagates (caller sends a
 *   404 before any SSE headers).
 * - no provider / provider failure -> a single `unavailable` event whose text
 *   replaces anything already streamed.
 */
export async function* streamAssistant(
  ownerId: string,
  componentId: string,
  question: string,
  history: readonly ConversationMessage[] = [],
): AsyncGenerator<AssistantStreamEvent> {
  const prepared = await prepareExchange(ownerId, componentId, question, history);
  if (prepared.kind === "unavailable") {
    yield { type: "unavailable", text: ASSISTANT_UNAVAILABLE_MESSAGE };
    return;
  }

  try {
    for await (const fragment of llmProvider.generateAnswerStream(
      COMPONENT_SCOPE_SYSTEM_PROMPT,
      prepared.userPrompt,
      prepared.history,
    )) {
      if (fragment.length > 0) {
        yield { type: "delta", text: fragment };
      }
    }
    yield { type: "done", configured: true };
  } catch (error) {
    console.error(
      `[assistantService] LLM streaming failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    yield { type: "unavailable", text: ASSISTANT_UNAVAILABLE_MESSAGE };
  }
}
