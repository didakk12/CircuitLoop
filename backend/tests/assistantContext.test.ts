/**
 * Phase 2: what the assistant actually puts in front of the LLM.
 *
 * These tests assert the *context and data flow*, not the model's wording.
 * That is deliberate: the assistant must be able to field arbitrary questions
 * about a selected component, so pinning expected natural-language answers
 * would both be flaky and would re-introduce exactly the "only anticipated
 * questions work" coupling this phase removes. Instead, for each realistic
 * question, we assert that the information needed to answer it is present in
 * the prompt the LLM receives.
 *
 * Real Express app and real Neo4j; `mlServiceClient` and the `llmProvider`
 * seam are mocked so the suite is deterministic and needs neither the Python
 * service nor a real, costed LLM call.
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

import { settings } from "../src/config/env.js";
import { closeDriver } from "../src/db/neo4jDriver.js";
import * as llmProvider from "../src/services/llmProvider.js";
import { mlServiceClient } from "../src/services/mlServiceClient.js";
import { registerAndLogin, deleteTestUsers, deleteComponentsById } from "./helpers/authAgent.js";
import { connectForTests } from "./helpers/testNeo4j.js";

const { reachable } = await connectForTests();
const mockSearch = vi.mocked(mlServiceClient.searchKnowledge);
const mockIsConfigured = vi.mocked(llmProvider.isConfigured);
const mockGenerateAnswer = vi.mocked(llmProvider.generateAnswer);

/** One retrieved chunk, shaped like a real ml-service result. */
function chunk(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    part_name: "ICM7555",
    section: "electrical specifications",
    source_file: "REN_icm7555-56_DST_20200305_1.pdf",
    text: "Supply Voltage Range 2V to 18V. Supply current 60uA typical at VDD = 5V.",
    score: 0.79,
    ...overrides,
  };
}

describe.skipIf(!reachable)("assistant selected-component context (integration)", () => {
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

  beforeEach(() => {
    mockSearch.mockReset();
    mockIsConfigured.mockReset();
    mockGenerateAnswer.mockReset();
    mockIsConfigured.mockReturnValue(true);
    mockGenerateAnswer.mockResolvedValue("answer");
    mockSearch.mockResolvedValue({ results: [] });
  });

  afterEach(async () => {
    await deleteComponentsById(createdComponentIds.splice(0));
  });

  afterAll(async () => {
    await deleteTestUsers(createdUserIds.splice(0));
    await closeDriver();
  });

  async function createComponent(body: Record<string, unknown> = {}): Promise<string> {
    const response = await api.post("/api/components").send({
      type: "ic",
      name: "ICM7555",
      confidence: 0.91,
      // POST /api/components takes flat coordinates; the nested `bbox` shape
      // belongs to POST /api/detections.
      x1: 120,
      y1: 240,
      x2: 180,
      y2: 300,
      ...body,
    });
    expect(response.status).toBe(201);
    createdComponentIds.push(response.body.id);
    return response.body.id as string;
  }

  async function recordTest(componentId: string, body: Record<string, unknown>): Promise<void> {
    const response = await api.post(`/api/components/${componentId}/test`).send(body);
    expect(response.status).toBe(201);
  }

  /**
   * Records results in order, leaving a gap so each lands in a distinct
   * millisecond. Neo4j's `datetime()` has millisecond clock resolution
   * (measured), so back-to-back writes share a timestamp and have no
   * recoverable order — see componentRepository.getComponentById. Any test
   * that asserts chronology must space its writes; this mirrors real usage,
   * where results are recorded by a human seconds apart.
   */
  async function recordTestsInOrder(
    componentId: string,
    bodies: Array<Record<string, unknown>>,
  ): Promise<void> {
    for (const body of bodies) {
      await recordTest(componentId, body);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  }

  /** Asks a question and returns the user prompt the LLM was handed. */
  async function promptFor(componentId: string, question: string): Promise<string> {
    const response = await api.post("/api/assistant").send({ component_id: componentId, question });
    expect(response.status).toBe(200);
    expect(mockGenerateAnswer).toHaveBeenCalled();
    return (mockGenerateAnswer.mock.calls.at(-1)?.[1] ?? "") as string;
  }

  // -------------------------------------------------------------------------
  // Task 11 — arbitrary questions about a selected component
  // -------------------------------------------------------------------------

  describe("arbitrary questions have the information needed to answer them", () => {
    it("covers all ten representative questions from one fully-populated component", async () => {
      const componentId = await createComponent();
      await recordTestsInOrder(componentId, [
        { status: "fail", measured_value: 3.1, expected_value: 5, unit: "V" },
        { status: "pass", measured_value: 4.98, expected_value: 5, unit: "V" },
      ]);

      mockSearch.mockResolvedValue({ results: [chunk()] });

      // Each entry: the question, and the facts that must be in the prompt for
      // it to be answerable at all.
      const cases: Array<[string, RegExp[]]> = [
        ["What does this component do?", [/Type: ic/, /ICM7555/]],
        ["What are its inputs and outputs?", [/ICM7555/, /Supply Voltage Range/]],
        ["What is this component used for?", [/Type: ic/, /ICM7555/]],
        ["What is its maximum operating voltage?", [/Supply Voltage Range 2V to 18V/]],
        ["What is its expected voltage?", [/expected 5V/]],
        ["What are the current test results?", [/Most recent test: pass/, /measured 4\.98V/]],
        ["Has this component ever failed?", [/Has ever failed: yes/]],
        ["How many times has it been tested?", [/Total tests recorded: 2/]],
        ["Where is this component located on the board?", [/bounding box \(120, 240\) to \(180, 300\)/]],
        [
          "Summarize everything you know about this component.",
          [/COMPONENT RECORD/, /TEST HISTORY/, /DATASHEET EVIDENCE/, /Type: ic/, /Total tests recorded: 2/],
        ],
      ];

      for (const [question, required] of cases) {
        const prompt = await promptFor(componentId, question);
        for (const pattern of required) {
          expect(prompt, `"${question}" is missing ${pattern}`).toMatch(pattern);
        }
        // The question itself always reaches the model verbatim.
        expect(prompt).toContain(question);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Task 4 — expanded component context
  // -------------------------------------------------------------------------

  describe("component record", () => {
    it("includes id, type, marking, status, confidence, position, timestamp and scan link", async () => {
      const componentId = await createComponent();
      const prompt = await promptFor(componentId, "Tell me about this component.");

      expect(prompt).toContain(`Component ID: ${componentId}`);
      expect(prompt).toMatch(/Type: ic/);
      expect(prompt).toMatch(/Marking read from the component by OCR: "ICM7555"/);
      expect(prompt).toMatch(/Current status: not_tested/);
      expect(prompt).toMatch(/Detection confidence: 91%/);
      expect(prompt).toMatch(/bounding box \(120, 240\) to \(180, 300\).*60x60px/);
      expect(prompt).toMatch(/First detected\/created at: \d{4}-/);
    });

    it("says the part number is unknown when OCR read no marking", async () => {
      const componentId = await createComponent({ name: null });
      const prompt = await promptFor(componentId, "What is this?");

      expect(prompt).toMatch(/OCR read no legible text/);
      expect(prompt).toMatch(/exact part number is unknown/);
    });

    it("reports a missing bounding box as not recorded rather than omitting it", async () => {
      const componentId = await createComponent({ x1: null, y1: null, x2: null, y2: null });
      const prompt = await promptFor(componentId, "Where is it?");

      expect(prompt).toMatch(/Position on the scanned board: not recorded/);
    });

    // Task 6: status comes from the component's own field.
    it("reports the component's own status field, not one inferred from tests", async () => {
      const componentId = await createComponent();
      await recordTest(componentId, { status: "fail", measured_value: 0 });

      const prompt = await promptFor(componentId, "What is its status?");
      expect(prompt).toMatch(/Current status: fail/);
    });
  });

  // -------------------------------------------------------------------------
  // Task 7 — condition / salvagePriority honesty
  // -------------------------------------------------------------------------

  describe("condition and salvage priority are reported honestly", () => {
    it('says "never assessed" rather than emitting unknown/null as findings', async () => {
      // The detection pipeline never populates these (detectionService.ts
      // writes condition:"unknown", salvagePriority:null for every component),
      // so this is the state of essentially every real scanned component.
      const componentId = await createComponent();
      const prompt = await promptFor(componentId, "What condition is it in?");

      expect(prompt).toMatch(/Condition: never assessed/);
      expect(prompt).toMatch(/Salvage priority: never assigned/);
      // The bare word must not appear as though an assessment concluded it.
      expect(prompt).not.toMatch(/Condition estimate.*unknown/);
    });

    it("reports them as estimates when they genuinely are populated", async () => {
      const componentId = await createComponent({ condition: "damaged", salvage_priority: "low" });
      const prompt = await promptFor(componentId, "Is it worth salvaging?");

      expect(prompt).toMatch(/Condition estimate \(from the scan image, not a measurement\): damaged/);
      expect(prompt).toMatch(/Salvage priority: low/);
    });

    it("never presents detection confidence as a health measure", async () => {
      const componentId = await createComponent();
      const prompt = await promptFor(componentId, "Is it healthy?");

      expect(prompt).toMatch(/not a measure of the component's health/);
    });
  });

  // -------------------------------------------------------------------------
  // Task 5 — complete test history
  // -------------------------------------------------------------------------

  describe("test history", () => {
    it("sends every recorded test with derived totals, not just the latest", async () => {
      const componentId = await createComponent();
      await recordTestsInOrder(componentId, [
        { status: "fail", measured_value: 1.2, expected_value: 5, unit: "V" },
        { status: "fail", measured_value: 3.4, expected_value: 5, unit: "V" },
        { status: "pass", measured_value: 5.01, expected_value: 5, unit: "V" },
      ]);

      const prompt = await promptFor(componentId, "How has it behaved over time?");

      expect(prompt).toMatch(/Total tests recorded: 3 \(1 passed, 2 failed\)/);
      expect(prompt).toMatch(/Has ever failed: yes/);
      expect(prompt).toMatch(/Most recent test: pass/);
      // Every individual measurement is present, so "what changed between
      // tests?" is answerable.
      expect(prompt).toMatch(/measured 1\.2V/);
      expect(prompt).toMatch(/measured 3\.4V/);
      expect(prompt).toMatch(/measured 5\.01V/);
      expect(prompt).toMatch(/Test history \(oldest first\)/);
    });

    it("lists distinctly-timestamped results in chronological order", async () => {
      // Regression: `collect()` guarantees no ordering, so before
      // componentRepository added an explicit ORDER BY the history came back
      // arbitrarily ordered and "most recent" could name the wrong result.
      const componentId = await createComponent();
      await recordTestsInOrder(
        componentId,
        [0, 1, 2, 3, 4, 5].map((index) => ({
          status: index === 5 ? "pass" : "fail",
          measured_value: index,
          unit: "V",
        })),
      );

      const prompt = await promptFor(componentId, "what is the latest result?");

      expect(prompt).toMatch(/Total tests recorded: 6 \(1 passed, 5 failed\)/);
      expect(prompt).toMatch(/Most recent test: pass .* measured 5V/);

      // The listing runs oldest -> newest. (The first capture is the
      // "Most recent test:" header line, which repeats the newest value.)
      const listed = [...prompt.matchAll(/measured (\d)V/g)].map((match) => match[1]);
      expect(listed).toEqual(["5", "0", "1", "2", "3", "4", "5"]);
    });

    it("still reports correct totals when results share a timestamp", async () => {
      // Neo4j's datetime() has millisecond resolution, so back-to-back writes
      // are genuinely indistinguishable in time and their relative order is
      // not recoverable. The derived facts the assistant relies on most —
      // how many tests, whether it ever failed — must stay correct anyway.
      const componentId = await createComponent();
      for (let index = 0; index < 6; index++) {
        await recordTest(componentId, {
          status: index === 0 ? "fail" : "pass",
          measured_value: index,
          unit: "V",
        });
      }

      const prompt = await promptFor(componentId, "how many tests?");
      expect(prompt).toMatch(/Total tests recorded: 6 \(5 passed, 1 failed\)/);
      expect(prompt).toMatch(/Has ever failed: yes/);
    });

    it("reports no failures when every test passed", async () => {
      const componentId = await createComponent();
      await recordTest(componentId, { status: "pass", measured_value: 5 });

      const prompt = await promptFor(componentId, "Has it ever failed?");
      expect(prompt).toMatch(/Total tests recorded: 1 \(1 passed, 0 failed\)/);
      expect(prompt).toMatch(/Has ever failed: no/);
    });

    it("states plainly that an untested component has no history, and still sends its record", async () => {
      const componentId = await createComponent();
      const prompt = await promptFor(componentId, "What does this component do?");

      expect(prompt).toMatch(/never been tested/);
      // The point of this phase: an untested component is still explainable.
      expect(prompt).toMatch(/Type: ic/);
      expect(prompt).toMatch(/ICM7555/);
      // And no fabricated measurement appears.
      expect(prompt).not.toMatch(/Total tests recorded/);
      expect(prompt).not.toMatch(/measured \d/);
    });
  });

  // -------------------------------------------------------------------------
  // Untested-component behaviour (prompt/assistant-behaviour improvement)
  //
  // These assert the *inputs* the model is given, plus the system-prompt rules
  // that shape its output — the repo deliberately does not pin model wording
  // (see this file's header). The behavioural expectations (natural answer for
  // general questions, explicit "not tested" for test-dependent ones, no
  // invented measurements) are enforced by assistantPrompt.test.ts.
  // -------------------------------------------------------------------------

  describe("untested component", () => {
    it("A. general question still receives the full component + RAG context, not just an 'untested' notice", async () => {
      const componentId = await createComponent(); // never tested
      mockSearch.mockResolvedValue({ results: [chunk()] });

      const prompt = await promptFor(componentId, "Tell me about resistors.");

      // Everything needed for a normal, useful answer is present:
      expect(prompt).toMatch(/Type: ic/);
      expect(prompt).toMatch(/ICM7555/);
      expect(prompt).toMatch(/Supply Voltage Range 2V to 18V/); // datasheet evidence
      expect(prompt).toContain("Tell me about resistors.");
      // The untested status is available for a brief mention, not fabricated away:
      expect(prompt).toMatch(/never been tested/);
      // No fabricated measurements sneak in.
      expect(prompt).not.toMatch(/Total tests recorded/);
      expect(prompt).not.toMatch(/measured \d/);
    });

    it("B. test-dependent question has the 'never tested' fact and no pass/fail verdict to report", async () => {
      const componentId = await createComponent();

      const prompt = await promptFor(componentId, "Has this resistor failed?");

      expect(prompt).toMatch(/Current status: not_tested/);
      expect(prompt).toMatch(/never been tested/);
      expect(prompt).not.toMatch(/Has ever failed: (yes|no)/);
    });

    it("C. measurement question carries no measured value the model could echo as verified", async () => {
      const componentId = await createComponent();
      // No datasheet either — nothing that could be mistaken for a verified value.
      mockSearch.mockResolvedValue({ results: [] });

      const prompt = await promptFor(componentId, "What is the resistance of this resistor?");

      expect(prompt).not.toMatch(/measured \d/);
      expect(prompt).toMatch(/No datasheet excerpt .* was relevant enough/);
      expect(prompt).toMatch(/Do not invent specifications/);
    });

    it("F. an untested component still gets its own datasheet retrieved and merged", async () => {
      const componentId = await createComponent();
      mockSearch.mockResolvedValue({ results: [chunk()] });

      const prompt = await promptFor(componentId, "What supply voltage does this part take?");
      expect(prompt).toMatch(/THIS COMPONENT'S OWN DATASHEET \(part ICM7555\)/);
      expect(mockSearch).toHaveBeenCalledTimes(1);
    });
  });

  describe("tested component (E. behaviour unchanged)", () => {
    it("still sends full derived verdicts and every measurement for a tested unit", async () => {
      const componentId = await createComponent();
      await recordTestsInOrder(componentId, [
        { status: "fail", measured_value: 3.1, expected_value: 5, unit: "V" },
        { status: "pass", measured_value: 4.98, expected_value: 5, unit: "V" },
      ]);

      const prompt = await promptFor(componentId, "Did this component pass?");
      expect(prompt).toMatch(/Total tests recorded: 2 \(1 passed, 1 failed\)/);
      expect(prompt).toMatch(/Has ever failed: yes/);
      expect(prompt).toMatch(/Most recent test: pass/);
      expect(prompt).toMatch(/measured 4\.98V/);
      expect(prompt).not.toMatch(/never been tested/);
    });
  });

  // -------------------------------------------------------------------------
  // Task 12 — RAG behaviour
  // -------------------------------------------------------------------------

  describe("component-aware RAG retrieval", () => {
    it("puts the component marking, type and question into the retrieval query", async () => {
      const componentId = await createComponent();
      await promptFor(componentId, "What is the maximum operating voltage?");

      expect(mockSearch).toHaveBeenCalledTimes(1);
      const [query] = mockSearch.mock.calls[0]!;
      expect(query).toContain("ICM7555"); // A. marking
      expect(query).toContain("ic"); // B. type
      expect(query).toContain("What is the maximum operating voltage?"); // C. question
      // Identity leads, so the embedding is anchored to the part.
      expect(query).toBe("ICM7555 ic What is the maximum operating voltage?");
    });

    it("falls back to type plus question when the component has no marking", async () => {
      const componentId = await createComponent({ name: null });
      await promptFor(componentId, "What is this?");

      const [query] = mockSearch.mock.calls[0]!;
      expect(query).toBe("ic What is this?");
      // No stray separator from the absent marking.
      expect(query).not.toMatch(/^\s|\s\s/);
    });

    it("passes the configured top-k and relevance threshold to retrieval", async () => {
      const componentId = await createComponent();
      await promptFor(componentId, "anything");

      const [, options] = mockSearch.mock.calls[0]!;
      expect(options).toMatchObject({ topK: settings.ragTopK, minScore: settings.ragMinScore });
      expect(settings.ragMinScore).toBeGreaterThan(0);
      expect(settings.ragMinScore).toBeLessThanOrEqual(1);
    });

    it("passes retrieved datasheet text through to the LLM", async () => {
      const componentId = await createComponent();
      mockSearch.mockResolvedValue({ results: [chunk()] });

      const prompt = await promptFor(componentId, "What voltage does it take?");
      expect(prompt).toMatch(/Supply Voltage Range 2V to 18V/);
      expect(prompt).toMatch(/REN_icm7555-56_DST_20200305_1\.pdf/);
      expect(prompt).toMatch(/relevance 0\.790/);
    });

    it("labels an excerpt as this component's own datasheet when the part matches", async () => {
      const componentId = await createComponent();
      mockSearch.mockResolvedValue({ results: [chunk()] });

      const prompt = await promptFor(componentId, "What is its supply voltage?");
      expect(prompt).toMatch(/THIS COMPONENT'S OWN DATASHEET \(part ICM7555\)/);
    });

    it("labels an excerpt for a different part as reference only, and warns none match", async () => {
      const componentId = await createComponent();
      mockSearch.mockResolvedValue({ results: [chunk({ part_name: "DG401" })] });

      const prompt = await promptFor(componentId, "What is its on-resistance?");
      expect(prompt).toMatch(/DIFFERENT PART \(DG401\)/);
      expect(prompt).toMatch(/not evidence about the selected component/);
      expect(prompt).toMatch(/None of the excerpts below is the datasheet for "ICM7555"/);
    });

    it("matches markings that differ only in case or punctuation", async () => {
      const componentId = await createComponent({ name: "icm-7555" });
      mockSearch.mockResolvedValue({ results: [chunk()] });

      const prompt = await promptFor(componentId, "supply voltage?");
      expect(prompt).toMatch(/THIS COMPONENT'S OWN DATASHEET/);
    });

    it("does not claim a match on very short, noisy corpus part names", async () => {
      const componentId = await createComponent({ name: "4" });
      mockSearch.mockResolvedValue({ results: [chunk({ part_name: "4" })] });

      const prompt = await promptFor(componentId, "what is it?");
      expect(prompt).toMatch(/DIFFERENT PART/);
    });

    it("tells the LLM no datasheet evidence exists when everything was below threshold", async () => {
      const componentId = await createComponent();
      // Retrieval applies the threshold and legitimately returns nothing.
      mockSearch.mockResolvedValue({ results: [] });

      const prompt = await promptFor(componentId, "What is its maximum rating?");
      expect(prompt).toMatch(/No datasheet excerpt .* was relevant enough/);
      expect(prompt).toMatch(/Do not invent specifications/);
    });

    it("still answers, with no excerpts, when retrieval is unavailable", async () => {
      const componentId = await createComponent();
      mockSearch.mockRejectedValue(new Error("ML service unreachable"));

      const prompt = await promptFor(componentId, "What does this do?");
      expect(prompt).toMatch(/No datasheet excerpt .* was relevant enough/);
      // The component context is unaffected.
      expect(prompt).toMatch(/Type: ic/);
    });
  });

  // -------------------------------------------------------------------------
  // Prompt structure (task 10)
  // -------------------------------------------------------------------------

  describe("prompt structure", () => {
    it("separates component record, test history and datasheet evidence into labelled blocks", async () => {
      const componentId = await createComponent();
      const prompt = await promptFor(componentId, "Summarize this component.");

      const recordAt = prompt.indexOf("=== A. COMPONENT RECORD");
      const testAt = prompt.indexOf("=== B. TEST HISTORY");
      const sheetAt = prompt.indexOf("=== C. DATASHEET EVIDENCE");
      const questionAt = prompt.indexOf("=== QUESTION ===");

      expect(recordAt).toBeGreaterThanOrEqual(0);
      expect(testAt).toBeGreaterThan(recordAt);
      expect(sheetAt).toBeGreaterThan(testAt);
      expect(questionAt).toBeGreaterThan(sheetAt);
    });
  });

  // -------------------------------------------------------------------------
  // Task 13 — cross-user isolation
  // -------------------------------------------------------------------------

  describe("cross-user isolation", () => {
    it("404s when another user asks about a component they do not own, before any retrieval or LLM call", async () => {
      const componentAId = await createComponent({ name: "SECRET-PART-A" });
      await recordTest(componentAId, { status: "pass", measured_value: 42 });

      const authedB = await registerAndLogin(app);
      createdUserIds.push(authedB.userId);

      mockSearch.mockClear();
      mockGenerateAnswer.mockClear();

      const response = await authedB.agent
        .post("/api/assistant")
        .send({ component_id: componentAId, question: "Tell me about this component." });

      expect(response.status).toBe(404);
      // Nothing about A's component was assembled, retrieved for, or generated.
      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockGenerateAnswer).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body)).not.toMatch(/SECRET-PART-A/);
    });

    it("404s on the streaming endpoint too, as JSON rather than an SSE stream", async () => {
      const componentAId = await createComponent({ name: "SECRET-PART-A" });

      const authedB = await registerAndLogin(app);
      createdUserIds.push(authedB.userId);

      mockSearch.mockClear();

      const response = await authedB.agent
        .post("/api/assistant/stream")
        .send({ component_id: componentAId, question: "Tell me about this component." });

      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(mockSearch).not.toHaveBeenCalled();
      expect(response.text).not.toMatch(/SECRET-PART-A/);
    });

    it("answers normally for the owner, confirming the 404s were about ownership", async () => {
      const componentId = await createComponent({ name: "SECRET-PART-A" });

      const prompt = await promptFor(componentId, "Tell me about this component.");
      expect(prompt).toMatch(/SECRET-PART-A/);
    });
  });

  // -------------------------------------------------------------------------
  // One database read (task 5)
  // -------------------------------------------------------------------------

  describe("query efficiency", () => {
    it("uses the test history already attached to the component, issuing no second lookup", async () => {
      // The test-result service is not mocked here; if the assistant were
      // still calling getLatestTestResult it would hit Neo4j a second time.
      // We assert the observable consequence instead: full history is present
      // from the single ownership-resolving read.
      const componentId = await createComponent();
      await recordTest(componentId, { status: "pass", measured_value: 1 });
      await recordTest(componentId, { status: "pass", measured_value: 2 });

      const prompt = await promptFor(componentId, "history?");
      expect(prompt).toMatch(/Total tests recorded: 2/);
      expect(prompt).toMatch(/measured 1/);
      expect(prompt).toMatch(/measured 2/);
    });
  });
});
