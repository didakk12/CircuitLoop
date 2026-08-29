/**
 * Unit tests for geminiClient.ts (the primary provider adapter) — `fetch` and
 * the typed `settings` object are stubbed so nothing here needs a real
 * GEMINI_API_KEY or makes a real, costed Gemini call.
 *
 * The adapter must be pure transport: it carries no assistant policy of its
 * own and forwards whatever system prompt the caller passes (that prompt, with
 * the component-scope rules, is owned by assistantPrompt.ts and covered by
 * assistantPrompt.test.ts).
 *
 * Most of what is pinned here is the shape translation Gemini needs and Groq
 * does not: the system prompt is a separate `systemInstruction` rather than a
 * message, the assistant role is called `model`, and a thinking model returns
 * parts that carry no text at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({
  settings: { geminiApiKey: "test-key", geminiModel: "test-model" },
}));

import { generateAnswer, generateAnswerStream, isConfigured } from "../src/services/geminiClient.js";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    systemInstruction?: { parts: { text: string }[] };
    contents: { role: string; parts: { text: string }[] }[];
    generationConfig?: { thinkingConfig?: unknown; maxOutputTokens?: number; temperature?: number };
  };
}

/** A generateContent response body carrying `text` as the model's answer. */
function responseBody(text: string): string {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
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

function captureFetch(makeResponse: () => Response): () => CapturedRequest {
  const captured: Partial<CapturedRequest> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: { body: string; headers: Record<string, string> }) => {
      captured.url = url;
      captured.headers = init.headers;
      captured.body = JSON.parse(init.body);
      return Promise.resolve(makeResponse());
    }),
  );
  return () => captured as CapturedRequest;
}

function stubFetchReturning(text: string): () => CapturedRequest {
  return captureFetch(
    () =>
      new Response(responseBody(text), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

function stubFetchStreaming(chunks: string[]): () => CapturedRequest {
  return captureFetch(() => sseResponse(chunks));
}

/** One SSE frame carrying a text delta, as Gemini sends them. */
function deltaFrame(text: string): string {
  return `data: ${responseBody(text)}\n\n`;
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const fragment of gen) {
    out.push(fragment);
  }
  return out;
}

describe("geminiClient (Gemini adapter)", () => {
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

    it("sends the caller's system prompt as systemInstruction, not as a message", async () => {
      // This is what makes it structurally impossible for a replayed history
      // turn to displace or impersonate the assistant policy.
      await generateAnswer("SYSTEM POLICY TEXT", "Question: What does this do?");

      const { systemInstruction, contents } = getRequest().body;
      expect(systemInstruction).toEqual({ parts: [{ text: "SYSTEM POLICY TEXT" }] });
      expect(contents).toEqual([{ role: "user", parts: [{ text: "Question: What does this do?" }] }]);
      expect(JSON.stringify(contents)).not.toContain("SYSTEM POLICY TEXT");
    });

    it("maps the assistant role onto Gemini's `model`, in order", async () => {
      await generateAnswer("SYS", "And why?", [
        { role: "user", content: "What is this?" },
        { role: "assistant", content: "A resistor." },
      ]);

      expect(getRequest().body.contents).toEqual([
        { role: "user", parts: [{ text: "What is this?" }] },
        { role: "model", parts: [{ text: "A resistor." }] },
        { role: "user", parts: [{ text: "And why?" }] },
      ]);
    });

    it("sends no thinkingConfig — measured to break streaming on this model", async () => {
      // Regression guard. Capping thinking (the mitigation the Groq adapter
      // uses for its reasoning model) makes gemini-3.5-flash-lite's streaming
      // endpoint return one empty text part and stop. See the comment in
      // geminiClient.ts for the measurements.
      await generateAnswer("SYSTEM", "Question?");

      const config = getRequest().body.generationConfig;
      expect(config?.thinkingConfig).toBeUndefined();
      expect(config?.maxOutputTokens).toBe(700);
      expect(config?.temperature).toBe(0.2);
    });

    it("calls the configured model and sends the key only as a header", async () => {
      await generateAnswer("SYSTEM", "Question?");

      const request = getRequest();
      expect(request.url).toContain("/test-model:generateContent");
      expect(request.headers["x-goog-api-key"]).toBe("test-key");
      expect(request.url).not.toContain("test-key");
      expect(JSON.stringify(request.body)).not.toContain("test-key");
    });

    it("returns the model's answer text unchanged (e.g. an off-topic refusal)", async () => {
      stubFetchReturning("I can only help with questions about the selected component.");

      const answer = await generateAnswer("SYSTEM", "Question: What is your favorite pizza?");

      expect(answer).toBe("I can only help with questions about the selected component.");
    });

    it("ignores thought-only parts and joins the text ones", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [{ thoughtSignature: "abc" }, { text: "Real " }, { text: "answer." }],
                    },
                  },
                ],
              }),
              { status: 200 },
            ),
          ),
        ),
      );

      expect(await generateAnswer("SYS", "USR")).toBe("Real answer.");
    });

    it("throws when the response carries no text at all", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response(JSON.stringify({ candidates: [{ content: { parts: [{ thoughtSignature: "x" }] } }] }), {
              status: 200,
            }),
          ),
        ),
      );

      await expect(generateAnswer("SYS", "USR")).rejects.toThrow(/empty response/);
    });

    it("throws a status-only error (no body leak) on a non-2xx response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response('{"error":{"message":"key AQ.xyz invalid"}}', { status: 403 }))),
      );

      await expect(generateAnswer("SYS", "USR")).rejects.toThrow(/status 403/);
      await expect(generateAnswer("SYS", "USR")).rejects.not.toThrow(/AQ\.xyz/);
    });

    it("throws on a non-JSON response", async () => {
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("<html>gateway</html>", { status: 200 }))));

      await expect(generateAnswer("SYS", "USR")).rejects.toThrow(/non-JSON/);
    });
  });

  describe("generateAnswerStream", () => {
    it("streams to the SSE endpoint and yields each text fragment in order", async () => {
      const getRequest = stubFetchStreaming([deltaFrame("This "), deltaFrame("is it."), "data: [DONE]\n\n"]);

      const fragments = await collect(generateAnswerStream("SYS", "USR"));

      expect(fragments).toEqual(["This ", "is it."]);
      expect(getRequest().url).toContain(":streamGenerateContent?alt=sse");
      expect(getRequest().body.systemInstruction).toEqual({ parts: [{ text: "SYS" }] });
      expect(getRequest().body.generationConfig?.thinkingConfig).toBeUndefined();
    });

    it("parses CRLF-separated frames, which is what Gemini actually sends", async () => {
      // Regression guard for a measured, silent failure: Gemini separates its
      // SSE frames with \r\n\r\n and emits no \n\n at all. Splitting on \n\n
      // alone (correct for Groq) found no frame boundary, so every stream
      // looked empty and fell through to the fallback provider.
      stubFetchStreaming([
        `data: ${responseBody("Real ")}\r\n\r\n`,
        `data: ${responseBody("content.")}\r\n\r\n`,
        "data: [DONE]\r\n\r\n",
      ]);

      expect(await collect(generateAnswerStream("SYS", "USR"))).toEqual(["Real ", "content."]);
    });

    it("reassembles SSE frames split across network chunks", async () => {
      const whole = deltaFrame("Hello");
      stubFetchStreaming([whole.slice(0, 20), whole.slice(20), "data: [DONE]\n\n"]);

      expect((await collect(generateAnswerStream("SYS", "USR"))).join("")).toBe("Hello");
    });

    it("skips frames that carry no text rather than treating them as content", async () => {
      stubFetchStreaming([
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ thoughtSignature: "x" }] } }] })}\n\n`,
        deltaFrame("Answer."),
        "data: [DONE]\n\n",
      ]);

      expect(await collect(generateAnswerStream("SYS", "USR"))).toEqual(["Answer."]);
    });

    it("tolerates unparseable frames without failing the stream", async () => {
      stubFetchStreaming(["data: {not json\n\n", deltaFrame("Answer."), "data: [DONE]\n\n"]);

      expect(await collect(generateAnswerStream("SYS", "USR"))).toEqual(["Answer."]);
    });

    it("throws (rejects) when the stream carries no content", async () => {
      // Thrown before the first yield, which is what lets llmFallback.ts hand
      // the question to Groq cleanly.
      stubFetchStreaming(["data: [DONE]\n\n"]);

      await expect(collect(generateAnswerStream("SYS", "USR"))).rejects.toThrow(/empty stream/);
    });

    it("throws a status-only error (no body leak) on a non-2xx response", async () => {
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("rate limited: key ...", { status: 429 }))));

      await expect(collect(generateAnswerStream("SYS", "USR"))).rejects.toThrow(/status 429/);
    });
  });
});
