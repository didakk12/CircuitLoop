/**
 * Unit tests for llmClient.ts (the Groq provider adapter) — `fetch` and the
 * typed `settings` object are stubbed so nothing here needs a real
 * GROQ_API_KEY or makes a real, rate-limited/costed Groq call.
 *
 * The adapter must be pure transport: it carries no assistant policy of its
 * own and forwards whatever system prompt the caller passes (that prompt,
 * with the component-scope rules, is owned by assistantPrompt.ts and
 * covered by assistantPrompt.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({
  settings: { groqApiKey: "test-key", groqModel: "test-model" },
}));

import { generateAnswer, generateAnswerStream, isConfigured } from "../src/services/llmClient.js";

interface CapturedRequest {
  url: string;
  body: { model: string; stream?: boolean; messages: { role: string; content: string }[] };
}

/** A Response whose body streams the given raw SSE text chunks (as the network would deliver them). */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function stubFetchStreaming(chunks: string[]): () => CapturedRequest {
  const captured: Partial<CapturedRequest> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: { body: string }) => {
      captured.url = url;
      captured.body = JSON.parse(init.body);
      return Promise.resolve(sseResponse(chunks));
    }),
  );
  return () => captured as CapturedRequest;
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const fragment of gen) {
    out.push(fragment);
  }
  return out;
}

function stubFetchReturning(content: string): () => CapturedRequest {
  const captured: Partial<CapturedRequest> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: { body: string }) => {
      captured.url = url;
      captured.body = JSON.parse(init.body);
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
  return () => captured as CapturedRequest;
}

describe("llmClient (Groq adapter)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports configured when a key is present", () => {
    expect(isConfigured()).toBe(true);
  });

  describe("generateAnswer", () => {
    let getRequest: () => CapturedRequest;

    beforeEach(() => {
      getRequest = stubFetchReturning("A 5V linear regulator.");
    });

    it("forwards the caller's system prompt and user prompt verbatim, in order", async () => {
      await generateAnswer("SYSTEM POLICY TEXT", "Component: ic (U1)...\n\nQuestion: What does this do?");

      const { messages } = getRequest().body;
      expect(messages).toEqual([
        { role: "system", content: "SYSTEM POLICY TEXT" },
        { role: "user", content: "Component: ic (U1)...\n\nQuestion: What does this do?" },
      ]);
    });

    it("returns the model's answer text unchanged (e.g. an off-topic refusal)", async () => {
      getRequest = stubFetchReturning("I can only help with questions about the selected component.");

      const answer = await generateAnswer("SYSTEM", "Question: What is your favorite pizza?");

      expect(answer).toBe("I can only help with questions about the selected component.");
    });
  });

  describe("generateAnswerStream", () => {
    it("requests a stream and yields each delta.content fragment in order", async () => {
      const getRequest = stubFetchStreaming([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"This "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"is it."}}]}\n\n',
        "data: [DONE]\n\n",
      ]);

      const fragments = await collect(generateAnswerStream("SYS", "USR"));

      expect(fragments).toEqual(["This ", "is it."]);
      expect(getRequest().body.stream).toBe(true);
      expect(getRequest().body.messages).toEqual([
        { role: "system", content: "SYS" },
        { role: "user", content: "USR" },
      ]);
    });

    it("reassembles SSE frames split across network chunks", async () => {
      stubFetchStreaming([
        'data: {"choices":[{"delta":{"con',
        'tent":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);

      expect((await collect(generateAnswerStream("SYS", "USR"))).join("")).toBe("Hello");
    });

    it("throws (rejects) when the stream carries no content", async () => {
      stubFetchStreaming(["data: [DONE]\n\n"]);
      await expect(collect(generateAnswerStream("SYS", "USR"))).rejects.toThrow();
    });

    it("throws a status-only error (no body leak) on a non-2xx response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(new Response("rate limited: key ...", { status: 429 })),
        ),
      );
      await expect(collect(generateAnswerStream("SYS", "USR"))).rejects.toThrow(/status 429/);
    });
  });
});
