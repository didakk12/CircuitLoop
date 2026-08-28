/**
 * POST /api/assistant — real Express app, real Neo4j; `mlServiceClient` and
 * the `llmProvider` seam are both mocked (same pattern as
 * tests/scanUpload.test.ts) so this suite is deterministic and doesn't
 * depend on the real Python service or a real, rate-limited/costed LLM
 * call. See the Phase 6 report for live end-to-end verification of this
 * endpoint, run separately.
 *
 * The provider is mocked at `llmProvider.js` (the provider-agnostic seam),
 * not at any specific adapter — switching the underlying LLM provider does
 * not change what this suite mocks or asserts.
 */

import type { Express } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/mlServiceClient.js", () => ({
  mlServiceClient: {
    detectComponents: vi.fn(),
    searchKnowledge: vi.fn(),
    checkHealth: vi.fn(),
  },
}));

vi.mock("../src/services/llmProvider.js", () => ({
  isConfigured: vi.fn(),
  generateAnswer: vi.fn(),
  generateAnswerStream: vi.fn(),
}));

import { closeDriver } from "../src/db/neo4jDriver.js";
import {
  ASSISTANT_UNAVAILABLE_MESSAGE,
  COMPONENT_SCOPE_SYSTEM_PROMPT,
  OFF_TOPIC_REFUSAL,
} from "../src/services/assistantPrompt.js";
import * as llmProvider from "../src/services/llmProvider.js";
import { mlServiceClient } from "../src/services/mlServiceClient.js";
import { UpstreamServiceError } from "../src/utils/errors.js";
import { registerAndLogin, deleteTestUsers, deleteComponentsById } from "./helpers/authAgent.js";
import { connectForTests } from "./helpers/testNeo4j.js";

const { reachable } = await connectForTests();
const mockSearch = vi.mocked(mlServiceClient.searchKnowledge);
const mockIsConfigured = vi.mocked(llmProvider.isConfigured);
const mockGenerateAnswer = vi.mocked(llmProvider.generateAnswer);
const mockGenerateAnswerStream = vi.mocked(llmProvider.generateAnswerStream);

/** Builds a fresh async generator each call (generators are single-use). */
function streamOf(fragments: string[], throwAtEnd?: Error) {
  return () =>
    (async function* () {
      for (const fragment of fragments) {
        yield fragment;
      }
      if (throwAtEnd) {
        throw throwAtEnd;
      }
    })();
}

/** Parses an SSE response body into the ordered list of event objects. */
function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data:".length).trim()) as Record<string, unknown>);
}

describe.skipIf(!reachable)("POST /api/assistant (integration, ml-service + llmProvider mocked)", () => {
  let app: Express;
  /** Authenticated agent — every data route sits behind requireAuth. */
  let api: Awaited<ReturnType<typeof registerAndLogin>>["agent"];
  const createdUserIds: string[] = [];
  const createdComponentIds: string[] = [];

  beforeAll(async () => {
    const { createApp } = await import("../src/index.js");
    app = createApp();
    const authed = await registerAndLogin(app);
    api = authed.agent;
    createdUserIds.push(authed.userId);
  });

  beforeEach(() => {
    mockSearch.mockReset();
    mockIsConfigured.mockReset();
    mockGenerateAnswer.mockReset();
    mockGenerateAnswerStream.mockReset();
  });

  afterEach(async () => {
    await deleteComponentsById(createdComponentIds.splice(0));
  });

  afterAll(async () => {

    await deleteTestUsers(createdUserIds.splice(0));
    await closeDriver();
  });

  async function createComponent(): Promise<string> {
    const response = await api.post("/api/components").send({ type: "ic", name: "U1", confidence: 0.9 });
    createdComponentIds.push(response.body.id);
    return response.body.id as string;
  }

  it("generates an answer under the shared component-scope system prompt, with component/test/RAG context in the user prompt", async () => {
    const componentId = await createComponent();
    await api
      .post(`/api/components/${componentId}/test`)
      .send({ expected_value: 5, measured_value: 4.9, unit: "V", status: "pass" });

    mockSearch.mockResolvedValueOnce({
      results: [{ part_name: "LM7805", section: "electrical characteristics", source_file: "x.pdf", text: "Output voltage 5V" }],
    });
    mockIsConfigured.mockReturnValue(true);
    mockGenerateAnswer.mockResolvedValueOnce("This is a 5V linear voltage regulator, and it passed its latest test.");

    const response = await api
      .post("/api/assistant")
      .send({ component_id: componentId, question: "What does this component do?" });

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(true);
    expect(response.body.message).toBe("This is a 5V linear voltage regulator, and it passed its latest test.");

    expect(mockGenerateAnswer).toHaveBeenCalledTimes(1);
    // The scope/relevance policy is passed as the system prompt — always the
    // same shared constant, regardless of which provider is behind the seam.
    const systemPromptSent = mockGenerateAnswer.mock.calls[0]?.[0] ?? "";
    expect(systemPromptSent).toBe(COMPONENT_SCOPE_SYSTEM_PROMPT);

    // Confirms RAG + component + test-result context actually reached the generation layer, not just the question.
    const userPromptSent = mockGenerateAnswer.mock.calls[0]?.[1] ?? "";
    expect(userPromptSent).toMatch(/Component: ic \(U1\)/);
    expect(userPromptSent).toMatch(/Latest test result: pass/);
    expect(userPromptSent).toMatch(/measured 4.9V/);
    expect(userPromptSent).toMatch(/LM7805/);
    expect(userPromptSent).toMatch(/Output voltage 5V/);
    expect(userPromptSent).toMatch(/What does this component do\?/);
  });

  it("passes an off-topic refusal from the provider straight through (configured stays true)", async () => {
    const componentId = await createComponent();
    mockSearch.mockResolvedValueOnce({ results: [] });
    mockIsConfigured.mockReturnValue(true);
    mockGenerateAnswer.mockResolvedValueOnce(OFF_TOPIC_REFUSAL);

    const response = await api
      .post("/api/assistant")
      .send({ component_id: componentId, question: "What is your favorite pizza?" });

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(true);
    expect(response.body.message).toBe(OFF_TOPIC_REFUSAL);
  });

  it("returns a generic unavailable message with NO component/datasheet data when no provider is configured", async () => {
    const componentId = await createComponent();
    mockIsConfigured.mockReturnValue(false);

    const response = await api
      .post("/api/assistant")
      .send({ component_id: componentId, question: "What is your favorite pizza?" });

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(false);
    expect(response.body.message).toBe(ASSISTANT_UNAVAILABLE_MESSAGE);
    // The no-LLM path must not become a backdoor to component data / retrieval.
    expect(mockGenerateAnswer).not.toHaveBeenCalled();
    expect(mockSearch).not.toHaveBeenCalled();
    expect(response.body.message).not.toMatch(/Component:|datasheet|confidence/i);
  });

  it("returns the same generic unavailable message (no leaked details) when the provider fails", async () => {
    const componentId = await createComponent();
    mockSearch.mockResolvedValueOnce({ results: [] });
    mockIsConfigured.mockReturnValue(true);
    mockGenerateAnswer.mockRejectedValueOnce(new Error("Groq request failed with status 500"));

    const response = await api
      .post("/api/assistant")
      .send({ component_id: componentId, question: "What is this?" });

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(false);
    expect(response.body.message).toBe(ASSISTANT_UNAVAILABLE_MESSAGE);
    expect(response.body.message).not.toMatch(/500|GROQ_API_KEY|Bearer|api\.groq\.com/i);
  });

  it("returns 404 when the component doesn't exist (generation never attempted)", async () => {
    mockIsConfigured.mockReturnValue(true);
    const response = await api
      .post("/api/assistant")
      .send({ component_id: "does-not-exist", question: "What is this?" });

    expect(response.status).toBe(404);
    expect(mockGenerateAnswer).not.toHaveBeenCalled();
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("rejects an empty question with 400", async () => {
    const componentId = await createComponent();
    const response = await api.post("/api/assistant").send({ component_id: componentId, question: "" });
    expect(response.status).toBe(400);
    expect(mockGenerateAnswer).not.toHaveBeenCalled();
  });

  it("degrades gracefully when datasheet retrieval is unavailable — still answers, with no excerpts in the prompt", async () => {
    const componentId = await createComponent();
    mockIsConfigured.mockReturnValue(true);
    mockSearch.mockRejectedValueOnce(new UpstreamServiceError(503, "ML service unreachable"));
    mockGenerateAnswer.mockResolvedValueOnce("A resistor limits current in a circuit.");

    const response = await api
      .post("/api/assistant")
      .send({ component_id: componentId, question: "What is this resistor for?" });

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(true);
    expect(response.body.message).toBe("A resistor limits current in a circuit.");
    expect(mockGenerateAnswer).toHaveBeenCalledTimes(1);
    // The component-scope policy still applies; the prompt is honest about the missing datasheet context.
    expect(mockGenerateAnswer.mock.calls[0]?.[0]).toBe(COMPONENT_SCOPE_SYSTEM_PROMPT);
    expect(mockGenerateAnswer.mock.calls[0]?.[1] ?? "").toMatch(/No relevant datasheet information was found/);
  });

  describe("POST /api/assistant/stream (SSE)", () => {
    it("streams the answer as delta frames under the shared system prompt, then a done frame", async () => {
      const componentId = await createComponent();
      mockSearch.mockResolvedValueOnce({
        results: [{ part_name: "LM7805", section: "features", source_file: "x.pdf", text: "5V regulator" }],
      });
      mockIsConfigured.mockReturnValue(true);
      mockGenerateAnswerStream.mockImplementation(streamOf(["This is ", "a 5V regulator."]));

      const response = await api
        .post("/api/assistant/stream")
        .send({ component_id: componentId, question: "What does this do?" });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toMatch(/text\/event-stream/);

      const events = parseSse(response.text);
      expect(events).toEqual([
        { type: "delta", text: "This is " },
        { type: "delta", text: "a 5V regulator." },
        { type: "done", configured: true },
      ]);

      // Same provider-agnostic policy + context guarantees as the non-streaming path.
      expect(mockGenerateAnswerStream.mock.calls[0]?.[0]).toBe(COMPONENT_SCOPE_SYSTEM_PROMPT);
      expect(mockGenerateAnswerStream.mock.calls[0]?.[1] ?? "").toMatch(/LM7805/);
    });

    it("streams an off-topic refusal through unchanged as delta text", async () => {
      const componentId = await createComponent();
      mockSearch.mockResolvedValueOnce({ results: [] });
      mockIsConfigured.mockReturnValue(true);
      mockGenerateAnswerStream.mockImplementation(streamOf([OFF_TOPIC_REFUSAL]));

      const response = await api
        .post("/api/assistant/stream")
        .send({ component_id: componentId, question: "What is your favorite pizza?" });

      const events = parseSse(response.text);
      expect(events).toEqual([
        { type: "delta", text: OFF_TOPIC_REFUSAL },
        { type: "done", configured: true },
      ]);
    });

    it("emits a single unavailable frame (no stream, no retrieval) when no provider is configured", async () => {
      const componentId = await createComponent();
      mockIsConfigured.mockReturnValue(false);

      const response = await api
        .post("/api/assistant/stream")
        .send({ component_id: componentId, question: "What is your favorite pizza?" });

      expect(response.status).toBe(200);
      expect(parseSse(response.text)).toEqual([
        { type: "unavailable", text: ASSISTANT_UNAVAILABLE_MESSAGE },
      ]);
      expect(mockGenerateAnswerStream).not.toHaveBeenCalled();
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it("ends with an unavailable frame if the provider fails mid-stream", async () => {
      const componentId = await createComponent();
      mockSearch.mockResolvedValueOnce({ results: [] });
      mockIsConfigured.mockReturnValue(true);
      mockGenerateAnswerStream.mockImplementation(
        streamOf(["partial answer"], new Error("Groq stream failed: terminated")),
      );

      const response = await api
        .post("/api/assistant/stream")
        .send({ component_id: componentId, question: "What is this?" });

      const events = parseSse(response.text);
      expect(events[0]).toEqual({ type: "delta", text: "partial answer" });
      expect(events.at(-1)).toEqual({ type: "unavailable", text: ASSISTANT_UNAVAILABLE_MESSAGE });
      expect(events).not.toContainEqual({ type: "done", configured: true });
      expect(response.text).not.toMatch(/terminated|Groq/i);
    });

    it("returns a normal JSON 404 (not an SSE stream) for an unknown component", async () => {
      mockIsConfigured.mockReturnValue(true);
      const response = await api
        .post("/api/assistant/stream")
        .send({ component_id: "does-not-exist", question: "What is this?" });

      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(mockGenerateAnswerStream).not.toHaveBeenCalled();
    });

    it("rejects an empty question with 400 before streaming", async () => {
      const componentId = await createComponent();
      const response = await api
        .post("/api/assistant/stream")
        .send({ component_id: componentId, question: "" });

      expect(response.status).toBe(400);
      expect(mockGenerateAnswerStream).not.toHaveBeenCalled();
    });

    it("still streams (datasheet-free) when retrieval is unavailable", async () => {
      const componentId = await createComponent();
      mockIsConfigured.mockReturnValue(true);
      mockSearch.mockRejectedValueOnce(new UpstreamServiceError(503, "ML service unreachable"));
      mockGenerateAnswerStream.mockImplementation(streamOf(["A resistor limits current."]));

      const response = await api
        .post("/api/assistant/stream")
        .send({ component_id: componentId, question: "What is this resistor for?" });

      expect(response.status).toBe(200);
      const events = parseSse(response.text);
      expect(events).toContainEqual({ type: "delta", text: "A resistor limits current." });
      expect(events).toContainEqual({ type: "done", configured: true });
      expect(mockGenerateAnswerStream.mock.calls[0]?.[1] ?? "").toMatch(/No relevant datasheet information was found/);
    });
  });
});
