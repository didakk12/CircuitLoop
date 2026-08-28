/**
 * Assistant orchestration — per ML_SERVICE_INTEGRATION_PLAN.md §6: Python
 * (ml-service) stays retrieval-only; this service assembles context
 * (component + latest test result, from Neo4j via the existing reused
 * services) and retrieval (via the existing reused mlServiceClient), then
 * either generates a real answer (once a provider is chosen — see
 * llmClient.ts) or returns an honest, clearly-labeled retrieval-only
 * fallback. No fake AI response is ever produced.
 */

import * as componentService from "./componentService.js";
import * as llmClient from "./llmClient.js";
import { mlServiceClient } from "./mlServiceClient.js";
import * as testResultService from "./testResultService.js";
import type { AssistantResponse } from "../types/dto.js";
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

function buildContextBody(context: AssistantContext): string {
  return (
    `${context.componentSummary}\n${context.testSummary}\n\n` +
    `Relevant datasheet excerpts:\n${formatChunks(context.chunks)}`
  );
}

function buildNotConfiguredMessage(context: AssistantContext): string {
  return (
    "AI-generated answers aren't available yet — no LLM provider is configured for this project. " +
    "Here's the relevant information that was found instead:\n\n" +
    buildContextBody(context)
  );
}

/**
 * Used when a provider *is* configured but the actual Groq call failed
 * (timeout, network error, bad response, etc. — see llmClient.ts). Never
 * includes the underlying error/status/secrets — just an honest, generic
 * note, same fallback content as the not-configured case.
 */
function buildGenerationFailedMessage(context: AssistantContext): string {
  return (
    "AI-generated answers are temporarily unavailable right now. " +
    "Here's the relevant information that was found instead:\n\n" +
    buildContextBody(context)
  );
}

function buildPrompt(question: string, context: AssistantContext): string {
  return (
    `${context.componentSummary}\n${context.testSummary}\n\n` +
    `Relevant datasheet excerpts:\n${formatChunks(context.chunks)}\n\n` +
    `Question: ${question}`
  );
}

/** Component is already confirmed to exist by the caller — any NotFoundError here can only mean "no test result yet". */
async function getLatestTestResultOrNull(componentId: string): Promise<TestResult | null> {
  try {
    return await testResultService.getLatestTestResult(componentId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return null;
    }
    throw error;
  }
}

export async function askAssistant(componentId: string, question: string): Promise<AssistantResponse> {
  // Throws NotFoundError("Component", componentId) -> propagates as a real 404 if invalid.
  const component = await componentService.getComponentById(componentId);
  const testResult = await getLatestTestResultOrNull(componentId);

  // Reused verbatim from Phase 3 — retry/timeout/error-translation already built and tested there.
  const searchResponse = await mlServiceClient.searchKnowledge(question);

  const context: AssistantContext = {
    componentSummary: summarizeComponent(component),
    testSummary: summarizeTestResult(testResult),
    chunks: searchResponse.results,
  };

  if (llmClient.isConfigured()) {
    try {
      const message = await llmClient.generateAnswer(buildPrompt(question, context));
      return { component_id: componentId, configured: true, message };
    } catch (error) {
      // Logged for operator visibility, never surfaced to the client —
      // llmClient.ts already guarantees this message has no secrets/raw
      // response details in it, but the client-facing message is built
      // fresh here regardless, independent of whatever llmClient threw.
      console.error(`[assistantService] Groq generation failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        component_id: componentId,
        configured: false,
        message: buildGenerationFailedMessage(context),
      };
    }
  }

  return {
    component_id: componentId,
    configured: false,
    message: buildNotConfiguredMessage(context),
  };
}
