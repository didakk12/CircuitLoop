/**
 * State-machine tests, driven entirely through `MockSerialAdapter` — no
 * board, no serial port, no native module, and (via the mocked repository)
 * no database. Every behaviour the real thing has to survive is provoked
 * deliberately here rather than waited for in the field.
 *
 * The repository is mocked rather than skipped-if-unreachable, because these
 * cases are about the *state machine*, not about Cypher: the real Cypher is
 * covered by `commandRepository.test.ts` against a live database. Mocking it
 * keeps this suite fast, deterministic, and runnable with nothing installed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hoisted so `vi.mock`'s factory (which vitest lifts above the imports) can
 * close over it, while tests below can still inspect and reset it.
 */
const repo = vi.hoisted(() => {
  let counter = 0;
  const created: Array<{ id: string; action: string; componentId: string | null }> = [];
  const resolutions: Array<{ id: string; status: string; ackReceived: boolean; detail: string | null }> = [];
  /** Component ids the fake considers owned by the requesting user; anything else reads as not-found. */
  const ownedComponentIds = new Set<string>();

  function makeCommand(action: string, componentId: string | null): {
    id: string;
    action: string;
    status: "pending";
    sentAt: string;
    resolvedAt: null;
    ackReceived: false;
    detail: null;
    componentId: string | null;
  } {
    counter += 1;
    const id = `cmd-${counter}`;
    created.push({ id, action, componentId });
    return {
      id,
      action,
      status: "pending",
      sentAt: new Date().toISOString(),
      resolvedAt: null,
      ackReceived: false,
      detail: null,
      componentId,
    };
  }

  return {
    created,
    resolutions,
    ownedComponentIds,
    reset(): void {
      counter = 0;
      created.length = 0;
      resolutions.length = 0;
      ownedComponentIds.clear();
    },
    createGatewayCommand: vi.fn((action: string) => Promise.resolve(makeCommand(action, null))),
    createComponentCommand: vi.fn((action: string, componentId: string, _ownerId: string) =>
      Promise.resolve(ownedComponentIds.has(componentId) ? makeCommand(action, componentId) : null),
    ),
    resolveCommand: vi.fn(
      (commandId: string, resolution: { status: string; ackReceived: boolean; detail: string | null }) => {
        resolutions.push({ id: commandId, ...resolution });
        return Promise.resolve(null);
      },
    ),
  };
});

vi.mock("../src/repositories/commandRepository.js", () => ({
  createGatewayCommand: repo.createGatewayCommand,
  createComponentCommand: repo.createComponentCommand,
  resolveCommand: repo.resolveCommand,
}));

const { DEFAULT_MOCK_PORT, MockSerialAdapter } = await import("../src/services/serial/MockSerialAdapter.js");
const hardwareService = await import("../src/services/hardwareService.js");
const { getCurrentState, getHardwareStatus } = await import("../src/services/hardwareState.js");
const { ConflictError, NotFoundError, UpstreamServiceError } = await import("../src/utils/errors.js");

const PROBE_ACTION = "I2C_PROBE:0x27";

/**
 * Timings small enough to keep the suite fast, but not so small that a
 * loaded CI box turns an ordinary scheduling delay into a spurious timeout.
 * `heartbeatIntervalMs` is parked far in the future by default so it can
 * never interleave with the behaviour a test is actually asserting.
 */
const fastConfig = {
  enabled: true,
  portOverride: undefined,
  baudRate: 115200,
  pollIntervalMs: 5,
  ackTimeoutMs: 60,
  reconnectDelayMs: 10,
  defaultAction: PROBE_ACTION,
  heartbeatIntervalMs: 1_000_000,
};

/** Polls until `predicate` holds, so tests wait on observable state rather than on a guessed sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for condition. Current state: ${getCurrentState()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A board that answers every command with a plain "ACK". */
const alwaysAcks = (): string => "ACK";

beforeEach(() => {
  repo.reset();
  repo.createGatewayCommand.mockClear();
  repo.createComponentCommand.mockClear();
  repo.resolveCommand.mockClear();
});

afterEach(async () => {
  await hardwareService.stop();
});

describe("hardwareService — port selection (pure)", () => {
  const allowlistConfig = { portOverride: undefined, vidPidAllowlist: ["1A86:7523", "10C4:EA60"] };

  it("selects a port whose VID:PID is allowlisted", () => {
    const selected = hardwareService.selectPort([DEFAULT_MOCK_PORT], allowlistConfig);
    expect(selected?.path).toBe("COM_TEST");
  });

  it("ignores ports whose VID:PID is not allowlisted", () => {
    const foreign = { path: "COM9", vendorId: "DEAD", productId: "BEEF" };
    expect(hardwareService.selectPort([foreign], allowlistConfig)).toBeNull();
  });

  it("ignores ports that report no USB ids at all", () => {
    // Built-in serial hardware — Intel AMT serial-over-LAN, Bluetooth
    // bridges. Opening one at random would be a genuinely bad surprise.
    const builtIn = { path: "COM3", manufacturer: "Intel" };
    expect(hardwareService.selectPort([builtIn], allowlistConfig)).toBeNull();
  });

  it("matches VID/PID case-insensitively and tolerates an 0x prefix", () => {
    const lowercase = { path: "COM4", vendorId: "0x1a86", productId: "7523" };
    expect(hardwareService.selectPort([lowercase], allowlistConfig)?.path).toBe("COM4");
  });

  it("picks the allowlisted port out of a list of decoys", () => {
    const ports = [
      { path: "COM1" },
      { path: "COM3", manufacturer: "Intel" },
      DEFAULT_MOCK_PORT,
      { path: "COM9", vendorId: "DEAD", productId: "BEEF" },
    ];
    expect(hardwareService.selectPort(ports, allowlistConfig)?.path).toBe("COM_TEST");
  });

  it("an explicit port override bypasses the allowlist entirely", () => {
    const unrecognised = { path: "COM7", vendorId: "DEAD", productId: "BEEF" };
    const selected = hardwareService.selectPort([unrecognised], {
      portOverride: "COM7",
      vidPidAllowlist: ["1A86:7523"],
    });
    expect(selected?.path).toBe("COM7");
  });

  it("matches an overridden port name case-insensitively", () => {
    const selected = hardwareService.selectPort([{ path: "COM7" }], {
      portOverride: "com7",
      vidPidAllowlist: [],
    });
    expect(selected?.path).toBe("COM7");
  });

  it("returns null when the overridden port is not present, rather than inventing one", () => {
    // A misspelled or unplugged CIRCUITLOOP_ESP32_PORT must stay a
    // recoverable "keep scanning", not a terminal failure.
    const selected = hardwareService.selectPort([DEFAULT_MOCK_PORT], {
      portOverride: "COM_MISSING",
      vidPidAllowlist: ["1A86:7523"],
    });
    expect(selected).toBeNull();
  });
});

describe("hardwareService — connect and ACK", () => {
  it("detects the board, opens it, probes, and reaches connected on ACK", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });

    await hardwareService.start({ adapter, config: fastConfig });

    expect(getCurrentState()).toBe("connected");
    expect(adapter.openedPath).toBe("COM_TEST");
    expect(adapter.written).toEqual([`${PROBE_ACTION}\n`]);

    const status = getHardwareStatus();
    expect(status.connected).toBe(true);
    expect(status.port_path).toBe("COM_TEST");
    expect(status.last_ack_at).not.toBeNull();
    expect(status.last_error).toBeNull();
    expect(status.last_command?.status).toBe("success");
    expect(status.last_command?.ack_received).toBe(true);
    expect(status.last_command?.detail).toBe("ACK");
  });

  it("records the probe as a pending gateway command and then resolves it as success", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });

    await hardwareService.start({ adapter, config: fastConfig });

    expect(repo.created).toEqual([{ id: "cmd-1", action: PROBE_ACTION, componentId: null }]);
    expect(repo.resolutions).toEqual([
      { id: "cmd-1", status: "success", ackReceived: true, detail: "ACK" },
    ]);
  });

  it("lowers DTR and RTS before probing, so the board is not auto-reset into its bootloader", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });
    await hardwareService.start({ adapter, config: fastConfig });
    expect(adapter.signalCalls).toEqual([{ dtr: false, rts: false }]);
  });

  it("still connects when the platform cannot set DTR/RTS at all", async () => {
    const adapter = new MockSerialAdapter({
      autoRespond: alwaysAcks,
      setSignalsError: new Error("setSignals is not supported on this platform"),
    });

    await hardwareService.start({ adapter, config: fastConfig });

    // Best-effort means best-effort: an unsupported control line must not
    // cost us a working link.
    expect(getCurrentState()).toBe("connected");
  });

  it("stays in scanning, without opening anything, while no allowlisted board is present", async () => {
    const adapter = new MockSerialAdapter({ ports: [{ path: "COM3", manufacturer: "Intel" }] });

    await hardwareService.start({ adapter, config: fastConfig });

    expect(getCurrentState()).toBe("scanning");
    expect(adapter.openCallCount).toBe(0);
    // And it keeps looking rather than giving up after one pass.
    await waitFor(() => adapter.listPortsCallCount >= 3);
  });

  it("ignores unsolicited board chatter that arrives while nothing is pending", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });
    await hardwareService.start({ adapter, config: fastConfig });
    repo.resolveCommand.mockClear();

    // A board printing its boot banner must not "acknowledge" a command
    // that was never sent.
    adapter.emitLine("rst:0x1 (POWERON_RESET),boot:0x13");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(repo.resolveCommand).not.toHaveBeenCalled();
    expect(getCurrentState()).toBe("connected");
  });
});

describe("hardwareService — failure handling", () => {
  it("times out a silent board, records the timeout, and backs off to retry", async () => {
    const adapter = new MockSerialAdapter(); // never responds

    await hardwareService.start({
      adapter,
      config: { ...fastConfig, ackTimeoutMs: 30, reconnectDelayMs: 60_000 },
    });

    expect(getCurrentState()).toBe("error_retry");
    expect(repo.resolutions).toEqual([
      { id: "cmd-1", status: "timeout", ackReceived: false, detail: "No ACK within 30ms." },
    ]);
    expect(getHardwareStatus().last_error).toContain("No ACK");
    expect(getHardwareStatus().connected).toBe(false);
  });

  it("handles a busy port (open fails) without touching the pending-command path", async () => {
    const adapter = new MockSerialAdapter({
      openError: new Error("Access denied: the port is already open in another application"),
    });

    await hardwareService.start({ adapter, config: { ...fastConfig, reconnectDelayMs: 60_000 } });

    expect(getCurrentState()).toBe("error_retry");
    expect(getHardwareStatus().last_error).toContain("Could not open COM_TEST");
    // Nothing was ever sent, so nothing should have been recorded.
    expect(repo.created).toEqual([]);
  });

  it("handles a permission failure the same recoverable way", async () => {
    const adapter = new MockSerialAdapter({
      openError: new Error("Permission denied, cannot open /dev/ttyUSB0"),
    });

    await hardwareService.start({ adapter, config: { ...fastConfig, reconnectDelayMs: 60_000 } });

    expect(getCurrentState()).toBe("error_retry");
    expect(getHardwareStatus().last_error).toContain("Permission denied");
  });

  it("survives the cable being pulled mid-probe, resolving the in-flight command as failed", async () => {
    const adapter = new MockSerialAdapter(); // silent, so the probe stays pending

    const startPromise = hardwareService.start({
      adapter,
      // Long ACK timeout so the unplug — not the timeout — is what ends the probe.
      config: { ...fastConfig, ackTimeoutMs: 60_000, reconnectDelayMs: 60_000 },
    });
    await waitFor(() => getCurrentState() === "probing");

    adapter.emitClose(new Error("Port disconnected"));
    await startPromise;

    expect(getCurrentState()).toBe("error_retry");
    expect(repo.resolutions).toHaveLength(1);
    expect(repo.resolutions[0]?.status).toBe("failure");
    expect(repo.resolutions[0]?.ackReceived).toBe(false);
    expect(getHardwareStatus().last_error).toContain("disconnected");
  });

  it("handles a write that fails because the board vanished between open and probe", async () => {
    const adapter = new MockSerialAdapter({ writeError: new Error("Port is not open") });

    await hardwareService.start({ adapter, config: { ...fastConfig, reconnectDelayMs: 60_000 } });

    expect(getCurrentState()).toBe("error_retry");
    expect(repo.resolutions[0]?.status).toBe("failure");
  });

  it("rejects a garbage response line as malformed instead of reporting a healthy link", async () => {
    // What a baud-rate mismatch actually looks like: framing noise, not text.
    const adapter = new MockSerialAdapter({ autoRespond: () => "x".repeat(2000) });

    await hardwareService.start({ adapter, config: { ...fastConfig, reconnectDelayMs: 60_000 } });

    expect(getCurrentState()).toBe("error_retry");
    expect(repo.resolutions[0]?.status).toBe("failure");
    expect(repo.resolutions[0]?.detail).toContain("Malformed response");
    expect(getHardwareStatus().connected).toBe(false);
  });

  it("reconnects automatically after a disconnect and returns to connected", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });

    await hardwareService.start({ adapter, config: fastConfig });
    expect(getCurrentState()).toBe("connected");
    const opensBefore = adapter.openCallCount;

    adapter.emitClose(new Error("Device was unplugged"));

    await waitFor(() => getCurrentState() === "error_retry");
    await waitFor(() => getCurrentState() === "connected");
    expect(adapter.openCallCount).toBe(opensBefore + 1);
    expect(getHardwareStatus().last_error).toBeNull();
  });
});

describe("hardwareService — disabled mode", () => {
  it("parks in disabled, never touching the adapter, when hardware support is switched off", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });

    await hardwareService.start({ adapter, config: { ...fastConfig, enabled: false } });

    expect(getCurrentState()).toBe("disabled");
    expect(adapter.listPortsCallCount).toBe(0);
    expect(adapter.openCallCount).toBe(0);
    expect(getHardwareStatus().last_error).toContain("disabled");
  });

  it("treats an unusable serial layer as terminal disabled, not as an endless retry loop", async () => {
    const adapter = new MockSerialAdapter({
      listPortsError: new Error("Cannot find module 'serialport'"),
    });

    await hardwareService.start({ adapter, config: fastConfig });

    expect(getCurrentState()).toBe("disabled");
    expect(getHardwareStatus().last_error).toContain("enumeration is unavailable");

    // Terminal really means terminal: enumeration is not retried on the poll
    // interval, because its failure is about the machine, not the hardware.
    const callsAfterFailure = adapter.listPortsCallCount;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(adapter.listPortsCallCount).toBe(callsAfterFailure);
  });

  it("refuses an action with 503 while disabled", async () => {
    const adapter = new MockSerialAdapter({ listPortsError: new Error("Cannot find module 'serialport'") });
    await hardwareService.start({ adapter, config: fastConfig });

    await expect(hardwareService.sendAction("LCD_SCAN", null, "user-1")).rejects.toBeInstanceOf(UpstreamServiceError);
    await expect(hardwareService.sendAction("LCD_SCAN", null, "user-1")).rejects.toMatchObject({ statusCode: 503 });
  });

  it("refuses an action with 503 while still scanning for a board", async () => {
    const adapter = new MockSerialAdapter({ ports: [{ path: "COM3" }] });
    await hardwareService.start({ adapter, config: fastConfig });
    expect(getCurrentState()).toBe("scanning");

    await expect(hardwareService.sendAction("LCD_SCAN", null, "user-1")).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});

describe("hardwareService — single in-flight command", () => {
  /** Answers the automatic probe but stays silent for anything else, so a user action can be held pending. */
  const acksProbeOnly = (written: string): string | null => (written.startsWith("I2C_PROBE") ? "ACK" : null);

  it("rejects an overlapping action with 409 rather than interleaving two writes", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: acksProbeOnly });
    await hardwareService.start({ adapter, config: { ...fastConfig, ackTimeoutMs: 200, reconnectDelayMs: 60_000 } });
    expect(getCurrentState()).toBe("connected");

    const first = hardwareService.sendAction("COMPONENT_TEST", null, "user-1");
    await waitFor(() => getCurrentState() === "probing");

    await expect(hardwareService.sendAction("LCD_SCAN", null, "user-1")).rejects.toBeInstanceOf(ConflictError);

    // The first command still runs to its own conclusion — the second was
    // refused, not merged into it — and only it ever reached the wire.
    await expect(first).rejects.toMatchObject({ statusCode: 503 });
    expect(adapter.written).toEqual([`${PROBE_ACTION}\n`, "COMPONENT_TEST\n"]);
  });

  it("accepts a fresh action once the previous one has resolved", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });
    await hardwareService.start({ adapter, config: fastConfig });

    const first = await hardwareService.sendAction("COMPONENT_TEST", null, "user-1");
    expect(first.status).toBe("success");

    const second = await hardwareService.sendAction("LCD_SCAN", null, "user-1");
    expect(second.status).toBe("success");
    expect(adapter.written).toEqual([`${PROBE_ACTION}\n`, "COMPONENT_TEST\n", "LCD_SCAN\n"]);
  });

  it("accepts any action string, so new firmware commands need no backend change", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });
    await hardwareService.start({ adapter, config: fastConfig });

    for (const action of ["CAPTURE_READING", "PINOUT_CHECK", "RELAY_TOGGLE:3", "SOMETHING_INVENTED_TOMORROW"]) {
      const command = await hardwareService.sendAction(action, null, "user-1");
      expect(command.action).toBe(action);
    }
  });
});

describe("hardwareService — component-targeted actions", () => {
  it("links a command to a component the caller owns", async () => {
    repo.ownedComponentIds.add("component-1");
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });
    await hardwareService.start({ adapter, config: fastConfig });

    const command = await hardwareService.sendAction("COMPONENT_TEST", "component-1", "user-1");

    expect(command.componentId).toBe("component-1");
    expect(repo.createComponentCommand).toHaveBeenCalledWith("COMPONENT_TEST", "component-1", "user-1");
  });

  it("reports a component the caller does not own as not found, and sends nothing", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });
    await hardwareService.start({ adapter, config: fastConfig });
    const writesBefore = adapter.written.length;

    await expect(
      hardwareService.sendAction("COMPONENT_TEST", "someone-elses-component", "user-1"),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(adapter.written).toHaveLength(writesBefore);
    // Refusing ownership must not knock the link over.
    expect(getCurrentState()).toBe("connected");
  });
});

describe("hardwareService — lifecycle", () => {
  it("start() is idempotent: a second call creates no duplicate port, timers, or listeners", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });

    await hardwareService.start({ adapter, config: fastConfig });
    const listPortsAfterFirst = adapter.listPortsCallCount;

    await hardwareService.start({ adapter, config: fastConfig });

    expect(adapter.openCallCount).toBe(1);
    expect(adapter.listPortsCallCount).toBe(listPortsAfterFirst);
    expect(getCurrentState()).toBe("connected");
  });

  it("stop() closes the port, drops every listener, and resets the reported state", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });
    await hardwareService.start({ adapter, config: fastConfig });
    expect(hardwareService.isStarted()).toBe(true);

    await hardwareService.stop();

    expect(hardwareService.isStarted()).toBe(false);
    expect(adapter.closeCallCount).toBeGreaterThanOrEqual(1);
    expect(adapter.hasListeners).toBe(false);
    expect(getCurrentState()).toBe("disabled");
  });

  it("stop() resolves a command that was still in flight rather than orphaning it", async () => {
    const adapter = new MockSerialAdapter(); // silent
    const startPromise = hardwareService.start({
      adapter,
      config: { ...fastConfig, ackTimeoutMs: 60_000, reconnectDelayMs: 60_000 },
    });
    await waitFor(() => getCurrentState() === "probing");

    await hardwareService.stop();
    await startPromise;

    expect(repo.resolutions).toEqual([
      { id: "cmd-1", status: "failure", ackReceived: false, detail: "Hardware service stopped." },
    ]);
  });

  it("stop() is safe to call when the service was never started", async () => {
    await expect(hardwareService.stop()).resolves.toBeUndefined();
  });

  it("stops scanning entirely after stop(), leaving no orphaned poll timer", async () => {
    const adapter = new MockSerialAdapter({ ports: [{ path: "COM3" }] });
    await hardwareService.start({ adapter, config: fastConfig });
    await waitFor(() => adapter.listPortsCallCount >= 2);

    await hardwareService.stop();
    const callsAtStop = adapter.listPortsCallCount;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(adapter.listPortsCallCount).toBe(callsAtStop);
  });
});

describe("hardwareService — heartbeat", () => {
  it("re-probes on the heartbeat, transiently re-entering probing and staying connected", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });

    await hardwareService.start({ adapter, config: { ...fastConfig, heartbeatIntervalMs: 15 } });
    expect(getCurrentState()).toBe("connected");

    await waitFor(() => adapter.written.length >= 3);
    expect(getCurrentState()).toBe("connected");
    // Every heartbeat is a real, recorded command — not a silent poke.
    expect(repo.created.length).toBeGreaterThanOrEqual(3);
    expect(repo.created.every((command) => command.action === PROBE_ACTION)).toBe(true);
  });

  it("drops to error_retry when the board stops answering the heartbeat", async () => {
    let responsive = true;
    const adapter = new MockSerialAdapter({ autoRespond: () => (responsive ? "ACK" : null) });

    await hardwareService.start({
      adapter,
      config: { ...fastConfig, heartbeatIntervalMs: 10, ackTimeoutMs: 30, reconnectDelayMs: 60_000 },
    });
    expect(getCurrentState()).toBe("connected");

    responsive = false;
    await waitFor(() => getCurrentState() === "error_retry");
    expect(repo.resolutions.some((resolution) => resolution.status === "timeout")).toBe(true);
  });
});

describe("hardwareService — status shape", () => {
  it("derives `connected` from `state` and never reports them inconsistently", async () => {
    const adapter = new MockSerialAdapter({ autoRespond: alwaysAcks });

    const seen: Array<{ state: string; connected: boolean }> = [];
    const { hardwareEvents, HARDWARE_CHANGE_EVENT } = await import("../src/services/hardwareEvents.js");
    const listener = (status: { state: string; connected: boolean }): void => {
      seen.push({ state: status.state, connected: status.connected });
    };
    hardwareEvents.on(HARDWARE_CHANGE_EVENT, listener as never);

    try {
      await hardwareService.start({ adapter, config: fastConfig });
    } finally {
      hardwareEvents.off(HARDWARE_CHANGE_EVENT, listener as never);
    }

    expect(seen.length).toBeGreaterThan(0);
    for (const frame of seen) {
      expect(frame.connected).toBe(frame.state === "connected");
    }
    // The transitions a client would render, in order.
    expect(seen.map((frame) => frame.state)).toContain("connecting");
    expect(seen.map((frame) => frame.state)).toContain("probing");
    expect(seen.at(-1)?.state).toBe("connected");
  });

  it("emits nothing when a re-asserted state changes nothing", async () => {
    const adapter = new MockSerialAdapter({ ports: [{ path: "COM3" }] });
    await hardwareService.start({ adapter, config: fastConfig });

    const { hardwareEvents, HARDWARE_CHANGE_EVENT } = await import("../src/services/hardwareEvents.js");
    let frames = 0;
    const listener = (): void => {
      frames += 1;
    };
    hardwareEvents.on(HARDWARE_CHANGE_EVENT, listener as never);

    // Several scan ticks pass, all finding nothing and all re-asserting
    // "scanning". A connected browser must not be woken for any of them.
    await waitFor(() => adapter.listPortsCallCount >= 4);
    hardwareEvents.off(HARDWARE_CHANGE_EVENT, listener as never);

    expect(frames).toBe(0);
  });
});
