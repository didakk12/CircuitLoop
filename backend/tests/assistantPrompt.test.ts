/**
 * The component-scope / relevance policy lives in assistantPrompt.ts, not in
 * any provider adapter — these assertions guard that it stays complete and
 * that the off-topic refusal wording is defined exactly once and referenced
 * by the system prompt, so a provider switch can't drop or fork it.
 *
 * Phase 2 reshaped this prompt around the three labelled context blocks the
 * user prompt now carries (A component record, B test history, C datasheet
 * evidence) and deliberately *relaxed* the scope rule: the assistant must
 * answer any reasonable question about the selected component rather than
 * refusing anything it wasn't explicitly told to expect.
 */

import { describe, expect, it } from "vitest";

import {
  ASSISTANT_UNAVAILABLE_MESSAGE,
  COMPONENT_SCOPE_SYSTEM_PROMPT,
  OFF_TOPIC_REFUSAL,
} from "../src/services/assistantPrompt.js";

describe("assistantPrompt (provider-agnostic policy)", () => {
  it("scopes answers to the selected component and judges relevance by meaning", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Answer questions about the selected component/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/by meaning/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/not against any fixed list of expected questions/i);
  });

  it("instructs the model to emit the single canonical refusal, verbatim, for off-topic messages", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toContain(OFF_TOPIC_REFUSAL);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/exactly this sentence and nothing more/i);
  });

  it("does not refuse merely because a question is broad, unusual or unanticipated", () => {
    // Phase 2 requirement: the assistant must be dynamic. The previous prompt
    // told the model that general-electronics questions were off-topic, which
    // blocked legitimate explanations of how the selected part works.
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Never refuse merely because the question is unusual, broad, open-ended/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Background electronics explanation is in scope/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).not.toMatch(/electronics in general[\s\S]*still off-topic/i);
  });

  it("names the three context blocks the user prompt supplies", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Block A .* COMPONENT RECORD/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Block B .* TEST HISTORY/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Block C .* DATASHEET EVIDENCE/i);
  });

  it("keeps stored data, verified measurements, datasheet evidence and general knowledge distinct", () => {
    // Block B is the only physically verified source.
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/only physically verified information/i);
    // General knowledge is allowed but must be flagged as such.
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /general knowledge[\s\S]*flag it as general knowledge/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Never invent a specific part number, rating, pin assignment, measurement or test result/i,
    );
  });

  it("forbids presenting another part's datasheet as this component's specification", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /DIFFERENT PART are NOT evidence about the selected component/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /must not present their ratings, pinouts or values as belonging to this component/i,
    );
  });

  it("tells the model an untested component is still explainable, without inventing test data", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/never been tested/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/do not substitute a guess/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /never been tested can still be explained thoroughly/i,
    );
  });

  it("stops detection confidence being read as a health measure", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /confidence is how sure the vision model was about the component's TYPE/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/never a measure of its health/i);
  });

  it('treats "never assessed" as absence of judgement, not an inconclusive one', () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /never assessed.*no such judgement exists/is,
    );
  });

  it("tells the model to answer general-knowledge questions normally, not as a status report", () => {
    // A. Untested component + general question -> useful normal answer, no
    // forced "untested" dump.
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/General knowledge[\s\S]*answer it directly/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Do not turn it into a status report/i);
  });

  it("forbids opening an answer with a dump of the component record or empty fields", () => {
    // Untested component + general question must not begin with a big table.
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Do not open an answer with a dump of the component record/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /never tested.*never assessed.*never assigned.*unless they are relevant/is,
    );
  });

  it("separates general knowledge, component-specific facts and test-dependent questions", () => {
    // C. measurement questions: verified value only if it really exists.
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Component-specific facts[\s\S]*only if Block B or this component's own datasheet actually contains it/i,
    );
    // B. test-dependent questions: state plainly it has not been tested.
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Test-dependent questions[\s\S]*never been tested, say plainly/i,
    );
    // Mixed questions: general case + unit's value unknown.
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Mixed questions[\s\S]*this specific unit's actual value is unknown/i);
  });

  it("tells the model to stay conversational and not repeat the untested caveat every turn", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Keep it conversational/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Mention the untested status only when it materially affects the answer/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /do not begin successive replies with "because this component has never been tested"/i,
    );
  });

  it("tells the model to lead with the answer and match depth to the question", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Lead with a clear, useful answer/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/not set the scene, restate the question/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Match depth to the question/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Answer a simple question in one to three short paragraphs, or a few concise bullets/i,
    );
  });

  it("forbids expanding a general question into a full tutorial or reference article", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Do not expand a general question into a full tutorial or reference article unless the user asks/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Don't add tangential facts, adjacent topics, or "while we're here" detail/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Keep a formula, calculation or worked example only when it directly answers the question/i,
    );
  });

  it('bounds an open "tell me about X" answer to a short shape and no extra apparatus', () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /tell me about X.*what it is, what it does, the few most important practical concepts, and at most one short example/is,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /do not also add comparison tables, full parameter lists, or how to identify or test one unless that was asked/i,
    );
  });

  it("restricts headings to genuinely separate topics and avoids tables by default", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Use headings only when the answer genuinely splits into separate topics/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Never put a heading on a one-idea answer/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Avoid tables\./i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Use one only when the user explicitly asks for a table or a comparison/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/A table is never the default shape for an explanation/i);
  });

  it("forbids opening with a component-information table and unrequested metadata", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Never open with a component-information table or a recital of Block A/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /Component metadata .* appears only if the question is about it/i,
    );
  });

  it("bans repetition and boilerplate Conclusion / Next steps sections", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Say each thing once/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/"Conclusion", "Summary" or "Next steps"/i);
  });

  it("keeps RAG and pipeline machinery out of the visible answer", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Don't expose the machinery/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /no relevance scores, excerpt tags, block letters, chunk or component IDs/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /never quote the excerpt tags, section names, filenames or relevance scores/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Weave any datasheet fact you use into your own prose/i);
  });

  it("uses earlier turns to resolve follow-ups without re-deriving the whole thread", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(
      /follow-up like "why\?" or "what about the other one\?" makes sense/i,
    );
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/Say each thing once/i);
  });

  it("keeps the unavailable message free of component-specific wording", () => {
    expect(ASSISTANT_UNAVAILABLE_MESSAGE).not.toMatch(/component|datasheet/i);
  });
});
