/**
 * In-memory singleton holding the hardware gateway's current status —
 * modelled on `telemetryState.ts`, which plays the same role for the
 * monitoring agent's latest report.
 *
 * Two deliberate choices:
 *
 * 1. **Not persisted.** This is live connection status, meaningful only for
 *    the process that owns the serial port. The durable record of what was
 *    sent and what came back is the `(:Command)` node written by
 *    `commandRepository`; this object is the volatile view on top of it, and
 *    a restart legitimately starts from `disabled` again.
 *
 * 2. **Emission lives here, not in the service.** Every mutation goes
 *    through {@link updateHardwareState}, which publishes the new snapshot on
 *    `hardwareEvents`. Putting it here rather than at each call site makes
 *    "no state change reaches the client" unrepresentable, instead of a rule
 *    the state machine has to remember at a dozen transitions. The dependency
 *    points one way only (state → events), so the two stay decoupled.
 */

import { HARDWARE_CHANGE_EVENT, hardwareEvents } from "./hardwareEvents.js";
import type { Command } from "../types/entities.js";
import {
  HardwareState,
  toHardwareCommandResponse,
  type HardwareStatusResponse,
} from "../types/hardwareDto.js";

interface HardwareStatus {
  state: HardwareState;
  portPath: string | null;
  lastAckAt: string | null;
  lastError: string | null;
  lastCommand: Command | null;
}

/**
 * Starts `disabled`, not `scanning`: until `hardwareService.start()` has
 * actually run, nothing is looking for a board, and reporting `scanning`
 * would be a claim about work that isn't happening.
 */
function initialStatus(): HardwareStatus {
  return {
    state: HardwareState.Disabled,
    portPath: null,
    lastAckAt: null,
    lastError: null,
    lastCommand: null,
  };
}

let status: HardwareStatus = initialStatus();

/** The current status in wire format. Always available — this endpoint never 404s. */
export function getHardwareStatus(): HardwareStatusResponse {
  return {
    state: status.state,
    // Derived here, in the single place the snapshot is built, so it cannot
    // drift from `state` — see HardwareStatusResponse.connected.
    connected: status.state === HardwareState.Connected,
    port_path: status.portPath,
    last_ack_at: status.lastAckAt,
    last_error: status.lastError,
    last_command: status.lastCommand === null ? null : toHardwareCommandResponse(status.lastCommand),
  };
}

/** The raw current state, for the service's own transition logic. */
export function getCurrentState(): HardwareState {
  return status.state;
}

/**
 * Applies a partial update and, if anything actually changed, publishes the
 * new snapshot to every open SSE connection.
 *
 * The equality check matters: the state machine re-asserts its state on
 * every poll tick (three times a second while scanning), and forwarding
 * those as SSE frames would make an idle backend look like a busy one and
 * wake every connected browser for nothing.
 */
export function updateHardwareState(patch: Partial<HardwareStatus>): void {
  const next: HardwareStatus = { ...status, ...patch };
  if (
    next.state === status.state &&
    next.portPath === status.portPath &&
    next.lastAckAt === status.lastAckAt &&
    next.lastError === status.lastError &&
    next.lastCommand === status.lastCommand
  ) {
    return;
  }
  status = next;
  hardwareEvents.emit(HARDWARE_CHANGE_EVENT, getHardwareStatus());
}

/**
 * Returns the singleton to its initial state.
 *
 * Used by `hardwareService.stop()` and by tests, which share a module
 * instance across cases within a file and would otherwise inherit the
 * previous test's connection status.
 */
export function resetHardwareState(): void {
  status = initialStatus();
}
