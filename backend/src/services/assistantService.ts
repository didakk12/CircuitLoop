/**
 * Assistant orchestration — per ML_SERVICE_INTEGRATION_PLAN.md §6: Python
 * (ml-service) stays retrieval-only; this service assembles context
 * (component + latest test result, from Neo4j via the existing reused
 * services) and retrieval (via the existing reused mlServiceClient), then
 * asks whichever LLM provider `llmProvider.ts` currently points at to
 * answer — always under the same provider-agnostic component-scope policy
 * (`COMPONENT_SCOPE_SYSTEM_PROMPT` in assistantPrompt.ts).
 *
 * The scope policy is enforced by the LLM: it answers questions about the
 * selected component and returns `OFF_TOPIC_REFUSAL` for anything else.
 * When no provider is configured (or the configured one fails) there is
 * nothing that can make that judgement, so the assistant returns a generic
 * unavailable message and *no* component data or datasheet content — an
 * off-topic question must never be able to extract component information
 * just because the LLM is down.
 *
 * Datasheet retrieval (the ml-service) is treated as an *enhancement*, not
 * a hard dependency: if it is unreachable the assistant still answers from
 * the component + test-result context, and the prompt honestly says no
 * datasheet information was available. Only a genuine LLM failure (or an
 * unknown component) is surfaced as an error.
 */

import {
  ASSISTANT_UNAVAILABLE_MESSAGE,
  COMPONENT_SCOPE_SYSTEM_PROMPT,
} from "./assistantPrompt.js";
import * as componentService from "./componentService.js";
import * as llmProvider from "./llmProvider.js";
import { mlServiceClient } from "./mlServiceClient.js";
import * as testResultService from "./testResultService.js";
import type { AssistantResponse, AssistantStreamEvent } from "../types/dto.js";
import type { ComponentDetail, TestResult } from "../types/entities.js";
import type { MlSearchResult } from "../types/mlService.js";
import { NotFoundError } from "../utils/errors.js";

interface AssistantContext {
  componentSummary: string;
  testSummary: string;
  chunks: MlSearchResult[];
}

function summarizeComponent(component: ComponentDetail): string {
  const label = component.name ? `${component.type} (${component.name})` : component.type;
  return (
    `Component: ${label}. Condition: ${component.condition}. Status: ${component.status}. ` +
    `Detection confidence: ${Math.round(component.confidence * 100)}%.`
  );
}

function summarizeTestResult(testResult: TestResult | null): string {
  if (!testResult) {
    return "No test result has been recorded for this component yet.";
  }
  const unit = testResult.unit ?? "";
  const measured = testResult.measuredValue !== null ? `measured ${testResult.measuredValue}${unit}` : "no measurement recorded";
  const expected = testResult.expectedValue !== null ? ` (expected ${testResult.expectedValue}${unit})` : "";
  return `Latest test result: ${testResult.status} — ${measured}${expected}.`;
}

function formatChunks(chunks: MlSearchResult[]): string {
  if (chunks.length === 0) {
    return "No relevant datasheet information was found for this question.";
  }
  return chunks.map((chunk) => `${chunk.part_name} — ${chunk.section}:\n${chunk.text}`).join("\n\n");
}

function buildPrompt(question: string, context: AssistantContext): string {
  return (
    `${context.componentSummary}\n${context.testSummary}\n\n` +
    `Relevant datasheet excerpts:\n${formatChunks(context.chunks)}\n\n` +
    `Question: ${question}`
  );
}

/** Component is already confirmed to exist and be owned by the caller — any NotFoundError here can only mean "no test result yet". */
async function getLatestTestResultOrNull(componentId: string, ownerId: string): Promise<TestResult | null> {
  try {
    return await testResultService.getLatestTestResult(componentId, ownerId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return null;
    }
    throw error;
  }
}

function unavailableResponse(componentId: string): AssistantResponse {
  return { component_id: componentId, configured: false, message: ASSISTANT_UNAVAILABLE_MESSAGE };
}

/**
 * Datasheet excerpts improve an answer but are not required for one — the
 * component-scope policy and the component/test context stand on their own.
 * If the ml-service is unreachable or erroring, log it and continue with no
 * excerpts rather than failing the whole request: `formatChunks([])` renders
 * as "no datasheet information was found", which the system prompt already
 * instructs the model to be honest about.
 */
async function retrieveDatasheetChunksOrEmpty(question: string): Promise<MlSearchResult[]> {
  try {
    const searchResponse = await mlServiceClient.searchKnowledge(question);
    return searchResponse.results;
  } catch (error) {
    console.error(
      `[assistantService] datasheet retrieval unavailable, answering without excerpts: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

type PreparedExchange =
  | { kind: "unavailable" }
  | { kind: "ready"; userPrompt: string };

/**
 * Shared setup for both the streaming and non-streaming entry points:
 * confirm the component exists, and — only if a provider is configured —
 * assemble the user prompt (component + test-result + datasheet context).
 *
 * `getComponentById` throws `NotFoundError` for an unknown component *or*
 * one owned by another user (indistinguishable), which both callers let
 * propagate as a real 404. The no-provider short-circuit happens here,
 * before any retrieval, so an off-topic question can never trigger
 * component data access when there's no LLM to scope-check it.
 */
async function prepareExchange(
  ownerId: string,
  componentId: string,
  question: string,
): Promise<PreparedExchange> {
  const component = await componentService.getComponentById(componentId, ownerId);

  if (!llmProvider.isConfigured()) {
    return { kind: "unavailable" };
  }

  const testResult = await getLatestTestResultOrNull(componentId, ownerId);
  const chunks = await retrieveDatasheetChunksOrEmpty(question);

  const context: AssistantContext = {
    componentSummary: summarizeComponent(component),
    testSummary: summarizeTestResult(testResult),
    chunks,
  };

  return { kind: "ready", userPrompt: buildPrompt(question, context) };
}

export async function askAssistant(
  ownerId: string,
  componentId: string,
  question: string,
): Promise<AssistantResponse> {
  const prepared = await prepareExchange(ownerId, componentId, question);
  if (prepared.kind === "unavailable") {
    return unavailableResponse(componentId);
  }

  try {
    const message = await llmProvider.generateAnswer(COMPONENT_SCOPE_SYSTEM_PROMPT, prepared.userPrompt);
    return { component_id: componentId, configured: true, message };
  } catch (error) {
    // Logged for operator visibility, never surfaced to the client — the
    // provider adapter already guarantees this message has no secrets in
    // it, but the client-facing message is a fixed constant regardless,
    // independent of whatever the adapter threw, and carries no component
    // or datasheet content.
    console.error(
      `[assistantService] LLM generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return unavailableResponse(componentId);
  }
}

/**
 * Streaming counterpart of `askAssistant`, yielding typed events for the
 * SSE endpoint. Same policy, same guarantees:
 * - unknown component -> `NotFoundError` propagates (caller sends a 404
 *   before any SSE headers).
 * - no provider / provider failure -> a single `unavailable` event whose
 *   text replaces anything already streamed; no partial or component-
 *   derived content is emitted from a failed generation.
 * - `COMPONENT_SCOPE_SYSTEM_PROMPT` is the system prompt, unchanged — the
 *   off-topic refusal streams through as ordinary `delta` text.
 */
export async function* streamAssistant(
  ownerId: string,
  componentId: string,
  question: string,
): AsyncGenerator<AssistantStreamEvent> {
  const prepared = await prepareExchange(ownerId, componentId, question);
  if (prepared.kind === "unavailable") {
    yield { type: "unavailable", text: ASSISTANT_UNAVAILABLE_MESSAGE };
    return;
  }

  try {
    for await (const fragment of llmProvider.generateAnswerStream(
      COMPONENT_SCOPE_SYSTEM_PROMPT,
      prepared.userPrompt,
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
