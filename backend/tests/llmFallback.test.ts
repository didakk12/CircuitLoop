/**
 * Unit tests for llmFallback.ts — the Gemini-primary / Groq-fallback chain.
 *
 * Both adapters are mocked: this file is about the composition rule, not
 * about either provider's transport (covered by geminiClient.test.ts and
 * llmClient.test.ts).
 *
 * The rule with real consequences is the streaming one: a fallback is only
 * allowed BEFORE the first fragment reaches the client. After that the
 * frontend has already rendered partial text, and restarting on Groq would
 * splice two different answers into one message.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/geminiClient.js", () => ({
  isConfigured: vi.fn(),
  generateAnswer: vi.fn(),
  generateAnswerStream: vi.fn(),
}));

vi.mock("../src/services/llmClient.js", () => ({
  isConfigured: vi.fn(),
  generateAnswer: vi.fn(),
  generateAnswerStream: vi.fn(),
}));

import * as gemini from "../src/services/geminiClient.js";
import * as groq from "../src/services/llmClient.js";
import { generateAnswer, generateAnswerStream, isConfigured } from "../src/services/llmFallback.js";

const geminiMock = vi.mocked(gemini);
const groqMock = vi.mocked(groq);

/** An async generator yielding `fragments`, then optionally throwing. */
function streamOf(fragments: string[], error?: Error) {
  return async function* (): AsyncGenerator<string> {
    for (const fragment of fragments) {
      yield fragment;
    }
    if (error) {
      throw error;
    }
  };
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const fragment of gen) {
    out.push(fragment);
  }
  return out;
}

describe("llmFallback (Gemini primary, Groq fallback)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    geminiMock.isConfigured.mockReturnValue(true);
    groqMock.isConfigured.mockReturnValue(true);
  });

  describe("isConfigured", () => {
    it("is true when either provider is configured", () => {
      geminiMock.isConfigured.mockReturnValue(true);
      groqMock.isConfigured.mockReturnValue(false);
      expect(isConfigured()).toBe(true);

      geminiMock.isConfigured.mockReturnValue(false);
      groqMock.isConfigured.mockReturnValue(true);
      expect(isConfigured()).toBe(true);
    });

    it("is false only when neither is configured", () => {
      geminiMock.isConfigured.mockReturnValue(false);
      groqMock.isConfigured.mockReturnValue(false);

      expect(isConfigured()).toBe(false);
    });
  });

  describe("generateAnswer", () => {
    it("uses Gemini and never touches Groq on the happy path", async () => {
      geminiMock.generateAnswer.mockResolvedValue("Gemini's answer.");

      expect(await generateAnswer("SYS", "USR")).toBe("Gemini's answer.");
      expect(groqMock.generateAnswer).not.toHaveBeenCalled();
    });

    it("falls back to Groq when Gemini throws", async () => {
      geminiMock.generateAnswer.mockRejectedValue(new Error("Gemini request failed with status 503"));
      groqMock.generateAnswer.mockResolvedValue("Groq's answer.");

      expect(await generateAnswer("SYS", "USR")).toBe("Groq's answer.");
    });

    it("passes the identical prompts and history to the fallback", async () => {
      const history = [{ role: "user" as const, content: "What is this?" }];
      geminiMock.generateAnswer.mockRejectedValue(new Error("timeout"));
      groqMock.generateAnswer.mockResolvedValue("ok");

      await generateAnswer("SYS", "USR", history);

      expect(groqMock.generateAnswer).toHaveBeenCalledWith("SYS", "USR", history);
    });

    it("goes straight to Groq when Gemini is unconfigured", async () => {
      geminiMock.isConfigured.mockReturnValue(false);
      groqMock.generateAnswer.mockResolvedValue("Groq's answer.");

      expect(await generateAnswer("SYS", "USR")).toBe("Groq's answer.");
      expect(geminiMock.generateAnswer).not.toHaveBeenCalled();
    });

    it("propagates Gemini's error when there is no Groq to fall back to", async () => {
      groqMock.isConfigured.mockReturnValue(false);
      geminiMock.generateAnswer.mockRejectedValue(new Error("Gemini request failed with status 500"));

      await expect(generateAnswer("SYS", "USR")).rejects.toThrow(/status 500/);
      expect(groqMock.generateAnswer).not.toHaveBeenCalled();
    });

    it("propagates the fallback's error when both fail", async () => {
      geminiMock.generateAnswer.mockRejectedValue(new Error("gemini down"));
      groqMock.generateAnswer.mockRejectedValue(new Error("groq down"));

      // assistantService.ts catches this and degrades to its generic
      // unavailable message, exactly as it did with one provider.
      await expect(generateAnswer("SYS", "USR")).rejects.toThrow(/groq down/);
    });
  });

  describe("generateAnswerStream", () => {
    it("streams from Gemini and never touches Groq on the happy path", async () => {
      geminiMock.generateAnswerStream.mockImplementation(streamOf(["Hello ", "world."]));

      expect(await collect(generateAnswerStream("SYS", "USR"))).toEqual(["Hello ", "world."]);
      expect(groqMock.generateAnswerStream).not.toHaveBeenCalled();
    });

    it("falls back to Groq when Gemini fails before producing anything", async () => {
      geminiMock.generateAnswerStream.mockImplementation(
        streamOf([], new Error("Gemini returned an empty stream")),
      );
      groqMock.generateAnswerStream.mockImplementation(streamOf(["From ", "Groq."]));

      expect(await collect(generateAnswerStream("SYS", "USR"))).toEqual(["From ", "Groq."]);
    });

    it("propagates a mid-stream failure instead of splicing two answers together", async () => {
      // The client has already rendered "Half an ans"; restarting on Groq
      // would append a second, different answer to it.
      geminiMock.generateAnswerStream.mockImplementation(
        streamOf(["Half an ans"], new Error("Gemini stream failed: terminated")),
      );
      groqMock.generateAnswerStream.mockImplementation(streamOf(["A different answer."]));

      const fragments: string[] = [];
      await expect(
        (async () => {
          for await (const fragment of generateAnswerStream("SYS", "USR")) {
            fragments.push(fragment);
          }
        })(),
      ).rejects.toThrow(/terminated/);

      expect(fragments).toEqual(["Half an ans"]);
      expect(groqMock.generateAnswerStream).not.toHaveBeenCalled();
    });

    it("goes straight to Groq when Gemini is unconfigured", async () => {
      geminiMock.isConfigured.mockReturnValue(false);
      groqMock.generateAnswerStream.mockImplementation(streamOf(["From Groq."]));

      expect(await collect(generateAnswerStream("SYS", "USR"))).toEqual(["From Groq."]);
      expect(geminiMock.generateAnswerStream).not.toHaveBeenCalled();
    });

    it("propagates Gemini's error when there is no Groq to fall back to", async () => {
      groqMock.isConfigured.mockReturnValue(false);
      geminiMock.generateAnswerStream.mockImplementation(streamOf([], new Error("gemini down")));

      await expect(collect(generateAnswerStream("SYS", "USR"))).rejects.toThrow(/gemini down/);
      expect(groqMock.generateAnswerStream).not.toHaveBeenCalled();
    });
  });
});
