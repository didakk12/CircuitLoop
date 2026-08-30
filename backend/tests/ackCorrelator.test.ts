/**
 * Pure unit tests for both ACK correlators — no adapter, no timers, no
 * database.
 *
 * The `TaggedAckCorrelator` cases are the load-bearing ones: it is not wired
 * into the running service, so these tests are the only thing standing
 * between "the abstraction is genuinely sufficient for a tagged protocol"
 * and "we asserted that it was in a comment".
 */

import { describe, expect, it } from "vitest";

import { SimpleAckCorrelator, TaggedAckCorrelator } from "../src/services/serial/ackCorrelator.js";

describe("SimpleAckCorrelator", () => {
  const correlator = new SimpleAckCorrelator();

  it("parses any line as untagged, preserving it verbatim", () => {
    expect(correlator.parseLine("ACK")).toEqual({ commandId: null, raw: "ACK" });
    expect(correlator.parseLine("I2C device found at 0x27")).toEqual({
      commandId: null,
      raw: "I2C device found at 0x27",
    });
  });

  it("does not invent a command id even from a line that happens to look tagged", () => {
    // The point of the Simple correlator is that it makes no claims about
    // structure. A board that coincidentally prints "ACK:7" is still just
    // text to it.
    expect(correlator.parseLine("ACK:7").commandId).toBeNull();
  });

  it("matches whatever is pending, because single-in-flight leaves only one candidate", () => {
    const parsed = correlator.parseLine("anything at all");
    expect(correlator.matchesPending(parsed, "command-a")).toBe(true);
    expect(correlator.matchesPending(parsed, "command-b")).toBe(true);
  });

  it("has no per-command state to corrupt", () => {
    correlator.onCommandSent("command-a", "I2C_PROBE:0x27");
    correlator.onCommandSent("command-b", "LCD_SCAN");
    expect(correlator.matchesPending(correlator.parseLine("ACK"), "command-a")).toBe(true);
  });
});

describe("TaggedAckCorrelator", () => {
  const correlator = new TaggedAckCorrelator();

  it("formats an outgoing command as CMD:<id>:<action>", () => {
    expect(TaggedAckCorrelator.formatCommand("abc-123", "I2C_PROBE:0x27")).toBe("CMD:abc-123:I2C_PROBE:0x27");
  });

  it("parses the command id out of ACK:<id>", () => {
    expect(correlator.parseLine("ACK:abc-123")).toEqual({ commandId: "abc-123", raw: "ACK:abc-123" });
  });

  it("parses ACK:<id>:<detail> and keeps colons inside the detail", () => {
    const parsed = correlator.parseLine("ACK:abc-123:device found at 0x27:ok");
    expect(parsed.commandId).toBe("abc-123");
    expect(parsed.raw).toBe("ACK:abc-123:device found at 0x27:ok");
  });

  it("tolerates surrounding whitespace", () => {
    expect(correlator.parseLine("  ACK:abc-123  ").commandId).toBe("abc-123");
  });

  it("treats board chatter as untagged rather than throwing", () => {
    for (const line of ["rst:0x1 (POWERON_RESET)", "ACK", "ACK:", "", "NACK:abc-123"]) {
      const parsed = correlator.parseLine(line);
      expect(parsed.commandId).toBeNull();
    }
  });

  it("matches only the command whose id is on the wire", () => {
    const parsed = correlator.parseLine("ACK:abc-123");
    expect(correlator.matchesPending(parsed, "abc-123")).toBe(true);
    expect(correlator.matchesPending(parsed, "different-id")).toBe(false);
  });

  it("refuses to match untagged chatter against a pending command", () => {
    // This is precisely the discrimination SimpleAckCorrelator cannot make,
    // and the reason the tagged protocol would not need single-in-flight.
    const chatter = correlator.parseLine("rst:0x1 (POWERON_RESET)");
    expect(correlator.matchesPending(chatter, "abc-123")).toBe(false);
  });
});
