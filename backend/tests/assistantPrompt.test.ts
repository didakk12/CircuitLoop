/**
 * The component-scope / relevance policy lives here, not in any provider
 * adapter — these assertions guard that it stays complete and that the
 * off-topic refusal wording is defined exactly once and referenced by the
 * system prompt, so a provider switch can't drop or fork it.
 */

import { describe, expect, it } from "vitest";

import {
  ASSISTANT_UNAVAILABLE_MESSAGE,
  COMPONENT_SCOPE_SYSTEM_PROMPT,
  OFF_TOPIC_REFUSAL,
} from "../src/services/assistantPrompt.js";

describe("assistantPrompt (provider-agnostic policy)", () => {
  it("restricts answers to the selected component and judges relevance semantically", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/only answer questions that are about the specific component/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/semantically/i);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/not by matching keywords or a fixed list/i);
  });

  it("instructs the model to emit the single canonical refusal, verbatim, for off-topic messages", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toContain(OFF_TOPIC_REFUSAL);
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/exactly this sentence and nothing more/i);
  });

  it("treats general-electronics questions not tied to this component as off-topic", () => {
    expect(COMPONENT_SCOPE_SYSTEM_PROMPT).toMatch(/electronics in general[\s\S]*still off-topic/i);
  });

  it("keeps the unavailable message free of component-specific wording", () => {
    expect(ASSISTANT_UNAVAILABLE_MESSAGE).not.toMatch(/component|datasheet/i);
  });
});
