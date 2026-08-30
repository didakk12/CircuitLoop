/**
 * The automatic hardware-ACK state machine.
 *
 * Replaces the manual "run a pyserial one-liner in a terminal to see if the
 * board is alive" workflow with a supervised loop that finds the gateway,
 * opens it, proves it responds, and keeps proving it — recording every
 * exchange as a `(:Command)` node and publishing every transition to the
 * frontend over SSE.
 *
 * ```
 *            ┌──────────┐  esp32Enabled=false, or the serial layer
 *            │ DISABLED │◀─ itself is unusable (missing native module,
 *            └──────────┘   denied enumeration). Terminal.
 *                 ▲
 *   adapter.listPorts() throws
 *                 │
 *            ┌──────────┐  poll listPorts() every pollIntervalMs,
 *   ┌───────▶│ SCANNING │  filtered by VID/PID allowlist or portOverride
 *   │        └────┬─────┘
 *   │             │ candidate found
 *   │        ┌────▼───────┐
 *   │        │ CONNECTING │ open @ baud, best-effort setSignals(dtr/rts off)
 *   │        └────┬───────┘
 *   │             │ open ok
 *   │        ┌────▼─────┐  write action, create pending (:Command),
 *   │        │ PROBING  │  await ACK up to ackTimeoutMs.
 *   │        └────┬─────┘  ALSO the single-in-flight concurrency gate.
 *   │             │ ACK matched
 *   │        ┌────▼──────┐
 *   │        │ CONNECTED │ ──heartbeat──▶ transiently re-enters PROBING
 *   │        └───────────┘
 *   │             │ close / timeout / write failure
 *   │      ┌──────▼───────┐
 *   └──────┤ ERROR_RETRY  │ wait reconnectDelayMs, resolve pending command
 *          └──────────────┘
 * ```
 *
 * Three invariants hold everywhere in this file:
 *
 * 1. **Nothing escapes.** Every adapter call, every repository call, and
 *    every timer callback is wrapped. A serial cable, a permissions quirk,
 *    or a peripheral that was never plugged in must not be able to reject an
 *    unhandled promise, crash the process, or block an unrelated route. A
 *    failure's only effect is a state transition and a log line.
 *
 * 2. **At most one command is in flight.** `PROBING` *is* the lock — there is
 *    no separate queue. This is what makes `SimpleAckCorrelator`'s positional
 *    matching correct (exactly one command a reply could belong to), and it
 *    is why an overlapping `sendAction()` fails fast with 409 rather than
 *    interleaving two writes on one wire.
 *
 * 3. **`state` is the truth.** `connected` is derived from it in
 *    `hardwareState.ts` and never set independently.
 */

import { NodeSerialAdapter } from "./serial/NodeSerialAdapter.js";
import { SimpleAckCorrelator, type AckCorrelator } from "./serial/ackCorrelator.js";
import type { PortInfo, SerialAdapter } from "./serial/SerialAdapter.js";
import { getCurrentState, resetHardwareState, updateHardwareState } from "./hardwareState.js";
import { settings } from "../config/env.js";
import * as commandRepository from "../repositories/commandRepository.js";
import type { Command } from "../types/entities.js";
import { HardwareState } from "../types/hardwareDto.js";
import { AppError, ConflictError, NotFoundError, UpstreamServiceError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

/**
 * The stable log payload for every hardware event. One line per event, always
 * these keys, so the stream is greppable and machine-readable without a log
 * parser that knows about each individual message.
 */
interface HardwareLogPayload {
  event: string;
  entityType: "hardware_command" | "hardware_connection";
  entityId?: string;
  state?: string;
  error?: string;
  timestamp: string;
}

/**
 * Same `log(level, message)` shape as the helpers in `src/index.ts` and
 * `src/middleware/errorHandler.ts` — this project keeps a small local logger
 * per module rather than a shared logging package (a real logger is Section
 * 11 of BACKEND_IMPLEMENTATION_PLAN.md, a later concern). The *message* here
 * is the JSON payload above, which is what makes these lines structured.
 */
function log(level: "INFO" | "WARN" | "ERROR", payload: Omit<HardwareLogPayload, "timestamp">): void {
  const full: HardwareLogPayload = { ...payload, timestamp: new Date().toISOString() };
  console.log(`[${full.timestamp}] [${level}] ${JSON.stringify(full)}`);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HardwareConfig {
  enabled: boolean;
  /** Explicit port path. When set, the VID/PID allowlist is not consulted at all. */
  portOverride: string | undefined;
  baudRate: number;
  ackTimeoutMs: number;
  pollIntervalMs: number;
  reconnectDelayMs: number;
  defaultAction: string;
  vidPidAllowlist: readonly string[];
  heartbeatIntervalMs: number;
}

/**
 * The heartbeat runs at ten times the port-scan interval (30s at the default
 * 3s poll), rather than at the poll interval itself.
 *
 * Every heartbeat writes a durable `(:Command)` node, so the cadence is
 * really a decision about how fast the graph grows: at the 3s poll interval
 * it would be ~29,000 nodes a day for an idle, healthy board. Ten-to-one
 * keeps liveness detection well inside a user's attention span while keeping
 * that bounded, and it derives from the existing knob instead of adding
 * another environment variable to tune.
 */
const HEARTBEAT_INTERVAL_MULTIPLIER = 10;

/**
 * A response line longer than this, or one containing a NUL byte, is not a
 * response — it is line noise. This is exactly what a baud-rate mismatch
 * looks like on the wire: the UART frames garbage, and the readline parser
 * hands back a very long run of junk with no terminator in sight. Treating
 * it as an ACK would report a healthy link that cannot actually be talked to,
 * so it is surfaced as a `502` malformed-response instead.
 */
const MAX_RESPONSE_LINE_CHARS = 1024;

function configFromSettings(): HardwareConfig {
  const pollIntervalMs = settings.esp32PollIntervalMs;
  return {
    enabled: settings.esp32Enabled,
    portOverride: settings.esp32Port,
    // 115200 is the CircuitLoop firmware's rate; CIRCUITLOOP_ESP32_BAUD
    // overrides it for a board flashed with something else.
    baudRate: settings.esp32Baud ?? 115200,
    ackTimeoutMs: settings.esp32AckTimeoutMs,
    pollIntervalMs,
    reconnectDelayMs: settings.esp32ReconnectDelayMs,
    defaultAction: settings.esp32DefaultAction,
    vidPidAllowlist: settings.esp32VidPidAllowlist,
    heartbeatIntervalMs: pollIntervalMs * HEARTBEAT_INTERVAL_MULTIPLIER,
  };
}

export interface HardwareServiceDeps {
  /** Defaults to the real `NodeSerialAdapter`. Tests inject `MockSerialAdapter`. */
  adapter?: SerialAdapter;
  /**
   * Defaults to `SimpleAckCorrelator`, matching the firmware's current
   * untagged protocol. Swapping in `TaggedAckCorrelator` when the firmware
   * gains request ids is a change to this one line and nothing else.
   */
  correlator?: AckCorrelator;
  /** Per-field overrides of the environment-derived configuration. Tests use it for millisecond timings. */
  config?: Partial<HardwareConfig>;
}

// ---------------------------------------------------------------------------
// Module state (singleton — one serial port per process)
// ---------------------------------------------------------------------------

interface PendingCommand {
  command: Command;
  timer: NodeJS.Timeout;
  resolve: (command: Command) => void;
  reject: (error: AppError) => void;
}

let started = false;
let adapter: SerialAdapter | null = null;
let correlator: AckCorrelator = new SimpleAckCorrelator();
let config: HardwareConfig = configFromSettings();

let scanTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let pending: PendingCommand | null = null;

/**
 * Incremented by every `stop()` and every teardown-and-rescan. Async work in
 * flight (an awaited `listPorts`, an in-progress `open`) captures the value
 * it started under and checks it before touching module state, so a slow
 * adapter call that resolves *after* a stop can't resurrect a torn-down
 * connection or schedule a timer on a service that is meant to be idle.
 */
let generation = 0;

function clearTimer(timer: NodeJS.Timeout | null): null {
  if (timer !== null) {
    clearTimeout(timer);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Port selection
// ---------------------------------------------------------------------------

/** Normalises a USB id to uppercase hex without an `0x` prefix, for comparison. */
function normalizeUsbId(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim().replace(/^0x/i, "").toUpperCase();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Chooses the port to talk to, or `null` if none qualifies.
 *
 * An explicit `portOverride` short-circuits the allowlist entirely — an
 * operator who has named a port has already answered the question the
 * allowlist exists to answer, and a USB-serial chip we don't recognise is
 * the most likely reason they had to name one. It still has to be *present*,
 * so an unplugged or misspelled port leaves the machine scanning rather than
 * failing hard, which is what keeps a bad `CIRCUITLOOP_ESP32_PORT` a
 * recoverable misconfiguration instead of a terminal one.
 *
 * Pure and exported for its own fixture test — no adapter, no timers.
 */
export function selectPort(
  ports: readonly PortInfo[],
  portConfig: Pick<HardwareConfig, "portOverride" | "vidPidAllowlist">,
): PortInfo | null {
  const override = portConfig.portOverride;
  if (override !== undefined && override.length > 0) {
    // Case-insensitive: Windows reports "COM5" while a user may configure "com5".
    return ports.find((port) => port.path.toLowerCase() === override.toLowerCase()) ?? null;
  }

  const allowlist = new Set(
    portConfig.vidPidAllowlist.map((pair) => pair.trim().replace(/^0x/i, "").toUpperCase()),
  );
  return (
    ports.find((port) => {
      const vendorId = normalizeUsbId(port.vendorId);
      const productId = normalizeUsbId(port.productId);
      if (vendorId === null || productId === null) {
        // Built-in/virtual ports (Bluetooth bridges, Intel AMT serial-over-LAN)
        // report no USB ids at all. Opening one at random would be an
        // unpleasant surprise, so no ids means no match.
        return false;
      }
      return allowlist.has(`${vendorId}:${productId}`);
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Starts the loop. Idempotent.
 *
 * The `started` guard is not paranoia: this is called fire-and-forget from
 * `src/index.ts`, and a double import, a dev-server hot reload, or a test
 * that forgets to `stop()` would otherwise leave two poll timers, two sets
 * of adapter listeners, and two heartbeats racing for one physical port.
 * Never rejects — a hardware peripheral must not be able to fail the
 * server's startup.
 */
export async function start(deps: HardwareServiceDeps = {}): Promise<void> {
  if (started) {
    log("INFO", { event: "start_ignored_already_running", entityType: "hardware_connection", state: getCurrentState() });
    return;
  }
  started = true;
  generation += 1;

  config = { ...configFromSettings(), ...deps.config };
  correlator = deps.correlator ?? new SimpleAckCorrelator();
  adapter = deps.adapter ?? new NodeSerialAdapter();

  if (!config.enabled) {
    // Not an error state — a deliberate configuration. `last_error` says so
    // plainly rather than leaving the frontend to guess why nothing is
    // happening.
    updateHardwareState({
      state: HardwareState.Disabled,
      lastError: "Hardware support is disabled (CIRCUITLOOP_ESP32_ENABLED=false).",
    });
    log("INFO", { event: "disabled_by_configuration", entityType: "hardware_connection", state: HardwareState.Disabled });
    return;
  }

  updateHardwareState({ state: HardwareState.Scanning, lastError: null });
  await scanTick(generation);
}

/**
 * Tears everything down: timers, listeners, the port itself, and any pending
 * command. Safe to call when already stopped.
 */
export async function stop(): Promise<void> {
  if (!started) {
    return;
  }
  started = false;
  // Invalidate every async continuation still in flight before awaiting
  // anything, so work that resolves during this teardown is inert.
  generation += 1;

  scanTimer = clearTimer(scanTimer);
  reconnectTimer = clearTimer(reconnectTimer);
  heartbeatTimer = clearTimer(heartbeatTimer);

  await settlePending("failure", "Hardware service stopped.", new UpstreamServiceError(503, "Hardware service is shutting down."));

  const current = adapter;
  adapter = null;
  if (current !== null) {
    try {
      await current.close();
    } catch (error) {
      log("WARN", {
        event: "close_failed_during_stop",
        entityType: "hardware_connection",
        error: describeError(error),
      });
    }
  }

  resetHardwareState();
}

/** Whether `start()` has run without a matching `stop()`. Exported for tests and for `stop()`'s own guard. */
export function isStarted(): boolean {
  return started;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One scan pass: enumerate ports, pick one, connect to it — or reschedule.
 *
 * A rejection from `listPorts()` is categorically different from "no board
 * plugged in": enumeration is the adapter's most basic capability, so its
 * failure means the serial layer itself is unusable here (module missing,
 * or the OS refusing to enumerate). Retrying that every three seconds
 * forever would log noise until the heat death of the universe, so it is
 * terminal `disabled` — the documented degraded mode, with the rest of the
 * app untouched.
 */
async function scanTick(myGeneration: number): Promise<void> {
  if (!started || myGeneration !== generation || adapter === null) {
    return;
  }

  let ports: PortInfo[];
  try {
    ports = await adapter.listPorts();
  } catch (error) {
    if (myGeneration !== generation) {
      return;
    }
    scanTimer = clearTimer(scanTimer);
    updateHardwareState({
      state: HardwareState.Disabled,
      portPath: null,
      lastError: `Serial port enumeration is unavailable: ${describeError(error)}`,
    });
    log("ERROR", {
      event: "adapter_unavailable",
      entityType: "hardware_connection",
      state: HardwareState.Disabled,
      error: describeError(error),
    });
    return;
  }

  if (myGeneration !== generation) {
    return;
  }

  const port = selectPort(ports, config);
  if (port === null) {
    updateHardwareState({ state: HardwareState.Scanning, portPath: null });
    scheduleScan(myGeneration, config.pollIntervalMs);
    return;
  }

  log("INFO", {
    event: "port_detected",
    entityType: "hardware_connection",
    entityId: port.path,
    state: HardwareState.Scanning,
  });
  await connect(port, myGeneration);
}

function scheduleScan(myGeneration: number, delayMs: number): void {
  scanTimer = clearTimer(scanTimer);
  scanTimer = setTimeout(() => {
    // Timer callbacks are the one place an unhandled rejection could still
    // escape, since nothing awaits them — hence the explicit catch.
    void scanTick(myGeneration).catch((error: unknown) => {
      log("ERROR", { event: "scan_tick_failed", entityType: "hardware_connection", error: describeError(error) });
    });
  }, delayMs);
}

/** Opens the chosen port and runs the first probe against it. */
async function connect(port: PortInfo, myGeneration: number): Promise<void> {
  const current = adapter;
  if (current === null) {
    return;
  }

  updateHardwareState({ state: HardwareState.Connecting, portPath: port.path, lastError: null });

  try {
    await current.open(port.path, { baudRate: config.baudRate });
  } catch (error) {
    if (myGeneration !== generation) {
      return;
    }
    // Busy port, denied permission, or a board unplugged between the scan
    // and the open. All recoverable, all handled the same way.
    log("WARN", {
      event: "port_open_failed",
      entityType: "hardware_connection",
      entityId: port.path,
      error: describeError(error),
    });
    teardownAndRetry(`Could not open ${port.path}: ${describeError(error)}`, myGeneration);
    return;
  }

  if (myGeneration !== generation) {
    return;
  }

  // Registered after each successful open, because adapters release their
  // handlers on close — see NodeSerialAdapter.close().
  current.onLine((line) => {
    handleLine(line, myGeneration);
  });
  current.onClose((error) => {
    handleClose(error, myGeneration);
  });

  // Best-effort, deliberately not fatal. On many ESP32 dev boards DTR/RTS are
  // wired to EN/BOOT through an auto-reset circuit, so leaving them asserted
  // reboots the board the instant the port opens — and the probe would then
  // race the bootloader. Platforms that can't set the lines reject here, and
  // that is fine: the board simply may reset once.
  try {
    await current.setSignals({ dtr: false, rts: false });
  } catch (error) {
    log("WARN", {
      event: "set_signals_unsupported",
      entityType: "hardware_connection",
      entityId: port.path,
      error: describeError(error),
    });
  }

  if (myGeneration !== generation) {
    return;
  }

  log("INFO", {
    event: "port_opened",
    entityType: "hardware_connection",
    entityId: port.path,
    state: HardwareState.Connecting,
  });

  try {
    await sendCommand(config.defaultAction, null, null, myGeneration, "probe_sent");
    if (myGeneration === generation) {
      log("INFO", { event: "reconnect_success", entityType: "hardware_connection", entityId: port.path, state: HardwareState.Connected });
      scheduleHeartbeat(myGeneration);
    }
  } catch (error) {
    // sendCommand has already transitioned the machine; the automatic path
    // has no caller to report to, so the error stops here.
    if (myGeneration === generation) {
      log("WARN", {
        event: "initial_probe_failed",
        entityType: "hardware_connection",
        entityId: port.path,
        error: describeError(error),
      });
    }
  }
}

function scheduleHeartbeat(myGeneration: number): void {
  heartbeatTimer = clearTimer(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    void (async () => {
      if (!started || myGeneration !== generation) {
        return;
      }
      // A user's own action may be in flight; single-in-flight applies to the
      // heartbeat too, so it simply yields and tries again next interval
      // rather than colliding with a command the user is waiting on.
      if (pending !== null || getCurrentState() !== HardwareState.Connected) {
        scheduleHeartbeat(myGeneration);
        return;
      }
      try {
        await sendCommand(config.defaultAction, null, null, myGeneration, "probe_sent");
        if (myGeneration === generation) {
          scheduleHeartbeat(myGeneration);
        }
      } catch {
        // Already logged and transitioned inside sendCommand; the reconnect
        // path takes over from here, so the heartbeat deliberately does not
        // reschedule itself.
      }
    })();
  }, config.heartbeatIntervalMs);
}

/**
 * The one place a command is written and awaited.
 *
 * Order matters: the `(:Command)` node is created and `pending` is armed
 * *before* the bytes go out, so a board that answers instantly cannot beat
 * its own handler into place.
 */
async function sendCommand(
  action: string,
  componentId: string | null,
  ownerId: string | null,
  myGeneration: number,
  sendEvent: "probe_sent" | "command_sent",
): Promise<Command> {
  const current = adapter;
  if (current === null || !started) {
    throw new UpstreamServiceError(503, "Hardware gateway is not available.");
  }

  let command: Command;
  try {
    if (componentId === null) {
      command = await commandRepository.createGatewayCommand(action);
    } else {
      if (ownerId === null) {
        throw new UpstreamServiceError(503, "A component-targeted command requires an authenticated owner.");
      }
      const created = await commandRepository.createComponentCommand(action, componentId, ownerId);
      if (created === null) {
        throw new NotFoundError("Component", componentId);
      }
      command = created;
    }
  } catch (error) {
    // An ownership/validation failure is the caller's answer and must reach
    // them unchanged. A genuine database failure, by contrast, means we
    // cannot honour the "every command is recorded" guarantee, so the
    // command is not written to the wire at all.
    if (error instanceof AppError) {
      throw error;
    }
    log("ERROR", {
      event: "command_persist_failed",
      entityType: "hardware_command",
      error: describeError(error),
    });
    throw new UpstreamServiceError(503, `Could not record the command before sending it: ${describeError(error)}`);
  }

  if (myGeneration !== generation) {
    await resolvePendingNode(command.id, "failure", false, "Hardware link was torn down before the command was sent.");
    throw new UpstreamServiceError(503, "Hardware gateway is not available.");
  }

  correlator.onCommandSent(command.id, action);

  const settled = new Promise<Command>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Claimed synchronously, before any await: an ACK landing in the same
      // tick as the timeout must find `pending` already taken, so exactly one
      // of the two paths resolves the command.
      const inFlight = pending;
      if (inFlight === null || inFlight.command.id !== command.id) {
        return;
      }
      pending = null;
      void (async () => {
        const resolvedCommand = await resolvePendingNode(command.id, "timeout", false, `No ACK within ${config.ackTimeoutMs}ms.`);
        log("WARN", {
          event: "ack_timeout",
          entityType: "hardware_command",
          entityId: command.id,
          state: getCurrentState(),
        });
        updateHardwareState({ lastCommand: resolvedCommand ?? command });
        reject(new UpstreamServiceError(503, `The hardware gateway did not acknowledge "${action}" within ${config.ackTimeoutMs}ms.`));
        teardownAndRetry(`No ACK for "${action}" within ${config.ackTimeoutMs}ms.`, myGeneration);
      })();
    }, config.ackTimeoutMs);

    pending = { command, timer, resolve, reject };
  });

  updateHardwareState({ state: HardwareState.Probing, lastCommand: command });

  try {
    // The trailing newline is the firmware's line terminator, and is added
    // here rather than by callers so no action string can accidentally omit
    // it and hang until the ACK timeout.
    await current.write(`${action}\n`);
  } catch (error) {
    // A write that fails means the link is already gone (cable pulled
    // between open and probe). Resolve the record and fold into the normal
    // reconnect path.
    const failure = new UpstreamServiceError(503, `Could not write to the hardware gateway: ${describeError(error)}`);
    // `failPending` rejects `settled`, but this function throws instead of
    // returning it, so nothing would ever observe that rejection — an
    // unhandled-rejection warning (and, under --unhandled-rejections=strict,
    // a process exit) over an ordinary unplugged cable. The caller still gets
    // the error via the throw below.
    settled.catch(() => undefined);
    await failPending(failure, `Write failed: ${describeError(error)}`, myGeneration);
    throw failure;
  }

  log("INFO", {
    event: sendEvent,
    entityType: "hardware_command",
    entityId: command.id,
    state: HardwareState.Probing,
  });

  return settled;
}

/** Writes a command's terminal status to Neo4j. Never throws — the link's health must not depend on the database. */
async function resolvePendingNode(
  commandId: string,
  status: "success" | "failure" | "timeout",
  ackReceived: boolean,
  detail: string | null,
): Promise<Command | null> {
  try {
    return await commandRepository.resolveCommand(commandId, { status, ackReceived, detail });
  } catch (error) {
    log("ERROR", {
      event: "command_resolve_failed",
      entityType: "hardware_command",
      entityId: commandId,
      error: describeError(error),
    });
    return null;
  }
}

/** Resolves the pending command as failed and drops the link. Used for write failures and unexpected closes. */
async function failPending(error: AppError, detail: string, myGeneration: number): Promise<void> {
  const inFlight = pending;
  pending = null;
  if (inFlight !== null) {
    clearTimeout(inFlight.timer);
    const resolved = await resolvePendingNode(inFlight.command.id, "failure", false, detail);
    updateHardwareState({ lastCommand: resolved ?? inFlight.command });
    inFlight.reject(error);
  }
  teardownAndRetry(detail, myGeneration);
}

/** Resolves any pending command without transitioning — used only by `stop()`. */
async function settlePending(
  status: "failure" | "timeout",
  detail: string,
  error: AppError,
): Promise<void> {
  const inFlight = pending;
  pending = null;
  if (inFlight === null) {
    return;
  }
  clearTimeout(inFlight.timer);
  await resolvePendingNode(inFlight.command.id, status, false, detail);
  inFlight.reject(error);
}

/**
 * A line arrived from the board.
 *
 * Unsolicited chatter (boot banners, debug prints, anything received while
 * no command is outstanding) is dropped rather than treated as an ACK —
 * without this, a board that prints on reset would "acknowledge" a command
 * that had not been sent yet.
 */
function handleLine(line: string, myGeneration: number): void {
  if (myGeneration !== generation || !started) {
    return;
  }
  const inFlight = pending;
  if (inFlight === null) {
    return;
  }
  if (line.trim().length === 0) {
    // A bare blank line carries no acknowledgement; boards emit them freely.
    return;
  }

  const parsed = correlator.parseLine(line);
  if (!correlator.matchesPending(parsed, inFlight.command.id)) {
    return;
  }

  // Claim the command synchronously: two lines arriving back to back must
  // not both try to resolve it.
  pending = null;
  clearTimeout(inFlight.timer);

  if (parsed.raw.length > MAX_RESPONSE_LINE_CHARS || parsed.raw.includes("\u0000")) {
    void (async () => {
      const resolved = await resolvePendingNode(
        inFlight.command.id,
        "failure",
        false,
        `Malformed response (${parsed.raw.length} chars). Check that CIRCUITLOOP_ESP32_BAUD matches the firmware.`,
      );
      log("ERROR", {
        event: "malformed_response",
        entityType: "hardware_command",
        entityId: inFlight.command.id,
        error: `Response line was ${parsed.raw.length} characters`,
      });
      updateHardwareState({ lastCommand: resolved ?? inFlight.command });
      inFlight.reject(
        new UpstreamServiceError(502, "The hardware gateway returned a malformed response line. Check the configured baud rate."),
      );
      teardownAndRetry("Malformed response line from the hardware gateway.", myGeneration);
    })();
    return;
  }

  void (async () => {
    const resolved = await resolvePendingNode(inFlight.command.id, "success", true, parsed.raw);
    const finalCommand = resolved ?? { ...inFlight.command, status: "success" as const, ackReceived: true, detail: parsed.raw };
    log("INFO", {
      event: "ack_received",
      entityType: "hardware_command",
      entityId: inFlight.command.id,
      state: HardwareState.Connected,
    });
    if (myGeneration === generation && started) {
      updateHardwareState({
        state: HardwareState.Connected,
        lastAckAt: new Date().toISOString(),
        lastCommand: finalCommand,
        lastError: null,
      });
    }
    inFlight.resolve(finalCommand);
  })();
}

/** The port closed — cleanly or because the cable went away. Either way the link is gone. */
function handleClose(error: Error | null, myGeneration: number): void {
  if (myGeneration !== generation || !started) {
    return;
  }
  log("WARN", {
    event: "disconnect",
    entityType: "hardware_connection",
    state: getCurrentState(),
    ...(error === null ? {} : { error: error.message }),
  });
  void failPending(
    new UpstreamServiceError(503, "The hardware gateway disconnected before acknowledging the command."),
    error === null ? "The hardware gateway disconnected." : `The hardware gateway disconnected: ${error.message}`,
    myGeneration,
  ).catch((failure: unknown) => {
    log("ERROR", { event: "disconnect_handling_failed", entityType: "hardware_connection", error: describeError(failure) });
  });
}

/**
 * Enters `error_retry`, closes the port, and schedules a fresh scan after
 * `reconnectDelayMs`.
 *
 * Bumping `generation` here is what makes reconnection safe: the old
 * connection's line/close handlers and any straggling async work all become
 * no-ops immediately, so the next connection starts from a clean slate
 * rather than inheriting callbacks from the previous one.
 */
function teardownAndRetry(reason: string, myGeneration: number): void {
  if (!started || myGeneration !== generation) {
    return;
  }
  const closing = adapter;
  generation += 1;
  const nextGeneration = generation;

  heartbeatTimer = clearTimer(heartbeatTimer);
  scanTimer = clearTimer(scanTimer);
  reconnectTimer = clearTimer(reconnectTimer);

  updateHardwareState({ state: HardwareState.ErrorRetry, lastError: reason });

  if (closing !== null) {
    void closing.close().catch((error: unknown) => {
      log("WARN", { event: "close_failed", entityType: "hardware_connection", error: describeError(error) });
    });
  }

  reconnectTimer = setTimeout(() => {
    if (!started || nextGeneration !== generation) {
      return;
    }
    log("INFO", { event: "reconnect_attempt", entityType: "hardware_connection", state: HardwareState.Scanning });
    updateHardwareState({ state: HardwareState.Scanning, portPath: null });
    void scanTick(nextGeneration).catch((error: unknown) => {
      log("ERROR", { event: "scan_tick_failed", entityType: "hardware_connection", error: describeError(error) });
    });
  }, config.reconnectDelayMs);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends a user-initiated action and waits for its ACK.
 *
 * The three refusals, in order, are the whole contract:
 *   - `disabled` → `503`, because there is no link and there will not be one.
 *   - anything other than `connected` → `503`, because there is no link *yet*.
 *   - a command already in flight → `409`, the single-in-flight gate. Note
 *     that this is `PROBING` — the state machine's own state — rather than a
 *     separate queue or mutex, so there is exactly one notion of "busy".
 */
export async function sendAction(action: string, componentId: string | null, ownerId: string): Promise<Command> {
  const state = getCurrentState();

  if (state === HardwareState.Disabled) {
    throw new UpstreamServiceError(
      503,
      "Hardware support is unavailable: no serial gateway is configured or the serial layer could not be loaded.",
    );
  }
  if (pending !== null || state === HardwareState.Probing) {
    throw new ConflictError("A hardware command is already in flight. Wait for it to complete before sending another.");
  }
  if (state !== HardwareState.Connected) {
    throw new UpstreamServiceError(503, `No hardware gateway is connected (current state: ${state}).`);
  }

  return sendCommand(action, componentId, ownerId, generation, "command_sent");
}
