/**
 * POST /api/assistant — real Express app, real Neo4j; `mlServiceClient` and
 * `llmClient` are both mocked (same pattern as tests/scanUpload.test.ts)
 * so this suite is deterministic and doesn't depend on the real Python
 * service or a real, rate-limited/costed Groq call. See the Phase 6 report
 * for live, real-Groq E2E verification of this endpoint, run separately.
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

vi.mock("../src/services/llmClient.js", () => ({
  isConfigured: vi.fn(),
  generateAnswer: vi.fn(),
}));

import { closeDriver } from "../src/db/neo4jDriver.js";
import * as componentRepository from "../src/repositories/componentRepository.js";
import * as llmClient from "../src/services/llmClient.js";
import { mlServiceClient } from "../src/services/mlServiceClient.js";
import { UpstreamServiceError } from "../src/utils/errors.js";
import { registerAndLogin, deleteTestUsers } from "./helpers/authAgent.js";
import { connectForTests } from "./helpers/testNeo4j.js";

const { reachable } = await connectForTests();
const mockSearch = vi.mocked(mlServiceClient.searchKnowledge);
const mockIsConfigured = vi.mocked(llmClient.isConfigured);
const mockGenerateAnswer = vi.mocked(llmClient.generateAnswer);

describe.skipIf(!reachable)("POST /api/assistant (integration, ml-service + llmClient mocked)", () => {
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
  });

  afterEach(async () => {
    for (const id of createdComponentIds.splice(0)) {
      await componentRepository.deleteComponent(id).catch(() => undefined);
    }
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

  it("returns a real Groq-generated answer when configured, and passes component/test/RAG context into the prompt", async () => {
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

    // Confirms RAG + component + test-result context actually reached the generation layer, not just the question.
    expect(mockGenerateAnswer).toHaveBeenCalledTimes(1);
    const promptSent = mockGenerateAnswer.mock.calls[0]?.[0] ?? "";
    expect(promptSent).toMatch(/Component: ic \(U1\)/);
    expect(promptSent).toMatch(/Latest test result: pass/);
    expect(promptSent).toMatch(/measured 4.9V/);
    expect(promptSent).toMatch(/LM7805/);
    expect(promptSent).toMatch(/Output voltage 5V/);
    expect(promptSent).toMatch(/What does this component do\?/);
  });

  it("falls back to retrieval-only when no provider is configured (generateAnswer never called)", async () => {
    const componentId = await createComponent();
    mockSearch.mockResolvedValueOnce({ results: [] });
    mockIsConfigured.mockReturnValue(false);

    const response = await api
      .post("/api/assistant")
      .send({ component_id: componentId, question: "What is this?" });

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(false);
    expect(response.body.message).toMatch(/no LLM provider is configured/);
    expect(mockGenerateAnswer).not.toHaveBeenCalled();
  });

  it("falls back gracefully (not a 500, no secrets/internal details leaked) when Groq generation fails", async () => {
    const componentId = await createComponent();
    mockSearch.mockResolvedValueOnce({ results: [] });
    mockIsConfigured.mockReturnValue(true);
    mockGenerateAnswer.mockRejectedValueOnce(new Error("Groq request failed with status 500"));

    const response = await api
      .post("/api/assistant")
      .send({ component_id: componentId, question: "What is this?" });

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(false);
    expect(response.body.message).toMatch(/temporarily unavailable/);
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

  it("propagates a genuine ml-service (retrieval) failure as a real error, not a fake answer", async () => {
    const componentId = await createComponent();
    mockSearch.mockRejectedValueOnce(new UpstreamServiceError(503, "ML service unreachable"));

    const response = await api
      .post("/api/assistant")
      .send({ component_id: componentId, question: "What is this?" });

    expect(response.status).toBe(503);
    expect(mockGenerateAnswer).not.toHaveBeenCalled();
  });
});
