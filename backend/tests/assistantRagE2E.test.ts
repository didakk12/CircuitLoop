/**
 * End-to-end RAG verification: real Neo4j, real ml-service, real embedding
 * model, real vector index. Only `llmProvider` is stubbed — so the answer is
 * not generated, but everything that produces the LLM's *input* runs for real.
 *
 * Every other assistant suite mocks `mlServiceClient`, which is right for
 * determinism but means none of them prove the retrieval chain actually
 * works. This one closes that gap: it asserts that a question about a
 * component whose marking exists in the corpus really does pull that part's
 * datasheet text out of Neo4j and into the prompt.
 *
 * OPT-IN. It requires `RAG_E2E=1` and a reachable ml-service, so the default
 * `npm test` stays hermetic — the same convention the rest of the TS suite
 * follows (see tests/mlServiceClient.test.ts: "no dependency on Python/YOLO/
 * Neo4j being available"). Gating on reachability alone would be worse than
 * useless: it would silently bind the unit suite to whatever build happens to
 * be listening on port 8001, so a stale ml-service would surface as a
 * confusing assistant-test failure rather than as "your service is out of
 * date".
 *
 * Run it explicitly:
 *
 *   RAG_E2E=1 npx vitest run tests/assistantRagE2E.test.ts
 *   RAG_E2E=1 ML_SERVICE_URL=http://127.0.0.1:8002 npx vitest run tests/assistantRagE2E.test.ts
 */

import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Deliberately NOT mocking mlServiceClient — that is the point of this file.
vi.mock("../src/services/llmProvider.js", () => ({
  isConfigured: vi.fn(() => true),
  generateAnswer: vi.fn(async () => "stubbed answer"),
  generateAnswerStream: vi.fn(),
}));

import { settings } from "../src/config/env.js";
import { closeDriver } from "../src/db/neo4jDriver.js";
import * as llmProvider from "../src/services/llmProvider.js";
import { registerAndLogin, deleteTestUsers, deleteComponentsById } from "./helpers/authAgent.js";
import { connectForTests } from "./helpers/testNeo4j.js";

const { reachable: neo4jReachable } = await connectForTests();

const E2E_ENABLED = process.env.RAG_E2E === "1";

/** Is a real ml-service answering, with a corpus loaded? */
async function mlServiceReady(): Promise<boolean> {
  if (!E2E_ENABLED) {
    return false;
  }
  try {
    const response = await fetch(`${settings.mlServiceUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { index_loaded?: boolean };
    return body.index_loaded === true;
  } catch {
    return false;
  }
}

const mlReady = await mlServiceReady();
if (E2E_ENABLED && !mlReady) {
  console.warn(
    `[assistantRagE2E] RAG_E2E=1 but ml-service is not ready at ${settings.mlServiceUrl} — skipping live RAG tests.`,
  );
}

const mockGenerateAnswer = vi.mocked(llmProvider.generateAnswer);

describe.skipIf(!neo4jReachable || !mlReady)("assistant RAG end-to-end (real Neo4j + real ml-service)", () => {
  let app: Express;
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

  afterAll(async () => {
    await deleteComponentsById(createdComponentIds.splice(0));
    await deleteTestUsers(createdUserIds.splice(0));
    await closeDriver();
  });

  async function createComponent(body: Record<string, unknown>): Promise<string> {
    const response = await api.post("/api/components").send({ confidence: 0.9, ...body });
    expect(response.status).toBe(201);
    createdComponentIds.push(response.body.id);
    return response.body.id as string;
  }

  /** Real retrieval; returns the prompt the LLM would have received. */
  async function promptFor(componentId: string, question: string): Promise<string> {
    mockGenerateAnswer.mockClear();
    const response = await api.post("/api/assistant").send({ component_id: componentId, question });
    expect(response.status).toBe(200);
    return (mockGenerateAnswer.mock.calls.at(-1)?.[1] ?? "") as string;
  }

  it("pulls the selected component's own datasheet out of Neo4j and into the prompt", async () => {
    // ICM7555 is genuinely in the corpus (84 chunks from the Renesas datasheet).
    const componentId = await createComponent({ type: "ic", name: "ICM7555" });

    const prompt = await promptFor(componentId, "What is the maximum operating voltage?");

    // Retrieval ran and produced evidence...
    expect(prompt).not.toMatch(/No datasheet excerpt .* was relevant enough/);
    // ...it is this component's own datasheet, identified deterministically...
    expect(prompt).toMatch(/THIS COMPONENT'S OWN DATASHEET \(part ICM7555\)/);
    // ...sourced from the real indexed PDF...
    expect(prompt).toMatch(/REN_icm7555-56/);
    // ...carrying a real cosine score from the Neo4j vector index.
    expect(prompt).toMatch(/relevance 0\.\d{3}/);
  });

  it("anchors retrieval to the selected component, not just the question wording", async () => {
    // The identical question, asked against two different components, must
    // retrieve each one's own datasheet. This is the Phase 2 behaviour that a
    // question-only query could not deliver.
    const icmId = await createComponent({ type: "ic", name: "ICM7555" });
    const switchId = await createComponent({ type: "switch", name: "1773450" });

    const question = "What are this component's key characteristics?";
    const icmPrompt = await promptFor(icmId, question);
    const switchPrompt = await promptFor(switchId, question);

    expect(icmPrompt).toMatch(/ICM7555/);
    expect(switchPrompt).toMatch(/1773450/);
    // Each prompt is anchored to its own part rather than both collapsing onto
    // whichever chunk happens to match the shared question text.
    expect(switchPrompt).not.toMatch(/THIS COMPONENT'S OWN DATASHEET \(part ICM7555\)/);
  });

  it("reports no evidence rather than unrelated excerpts for a part absent from the corpus", async () => {
    const componentId = await createComponent({ type: "led", name: "ZZQQ-NOT-A-REAL-PART-9931" });

    const prompt = await promptFor(componentId, "What is the forward voltage of this exact part?");

    // Either nothing cleared the relevance threshold, or whatever did is
    // explicitly flagged as a different part. What must never happen is
    // another part's datasheet being presented as this component's.
    const noEvidence = /No datasheet excerpt .* was relevant enough/.test(prompt);
    const flaggedForeign = /None of the excerpts below is the datasheet for/.test(prompt);
    expect(noEvidence || flaggedForeign).toBe(true);
    expect(prompt).not.toMatch(/THIS COMPONENT'S OWN DATASHEET/);
  });

  it("filters an off-topic question down to no datasheet evidence", async () => {
    const componentId = await createComponent({ type: "ic", name: "ICM7555" });

    // Retrieval still runs (the query is prefixed with the component identity),
    // but nothing in a datasheet corpus is relevant to this, and the threshold
    // must drop whatever came back rather than dressing it up as evidence.
    const prompt = await promptFor(componentId, "best hiking trails in Norway");

    expect(prompt).toMatch(/No datasheet excerpt .* was relevant enough/);
  });

  it("combines live retrieval with the component record and test history in one prompt", async () => {
    const componentId = await createComponent({
      type: "ic",
      name: "ICM7555",
      x1: 10,
      y1: 20,
      x2: 60,
      y2: 80,
    });
    await api
      .post(`/api/components/${componentId}/test`)
      .send({ status: "pass", measured_value: 4.99, expected_value: 5, unit: "V" });

    const prompt = await promptFor(componentId, "Summarize everything you know about this component.");

    // A: real stored record
    expect(prompt).toContain(`Component ID: ${componentId}`);
    expect(prompt).toMatch(/bounding box \(10, 20\) to \(60, 80\)/);
    // B: real test history from Neo4j
    expect(prompt).toMatch(/Total tests recorded: 1 \(1 passed, 0 failed\)/);
    expect(prompt).toMatch(/measured 4\.99V/);
    // C: real datasheet evidence from the Neo4j vector index
    expect(prompt).toMatch(/THIS COMPONENT'S OWN DATASHEET \(part ICM7555\)/);
    // All three blocks, in order.
    expect(prompt.indexOf("=== A.")).toBeLessThan(prompt.indexOf("=== B."));
    expect(prompt.indexOf("=== B.")).toBeLessThan(prompt.indexOf("=== C."));
  });

  it("passes conversation history alongside live retrieval", async () => {
    const componentId = await createComponent({ type: "ic", name: "ICM7555" });
    const history = [
      { role: "user", content: "What does this component do?" },
      { role: "assistant", content: "It is a CMOS timer." },
    ];

    mockGenerateAnswer.mockClear();
    const response = await api
      .post("/api/assistant")
      .send({ component_id: componentId, question: "Why?", history });
    expect(response.status).toBe(200);

    const call = mockGenerateAnswer.mock.calls.at(-1);
    expect(call?.[2]).toEqual(history);
    // And retrieval still ran for real against the current question.
    expect(call?.[1]).toMatch(/=== C\. DATASHEET EVIDENCE/);
  });
});
