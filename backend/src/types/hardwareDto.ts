/**
 * Wire-format DTOs for the hardware-ACK endpoints, and their mappings from
 * the domain types.
 *
 * `snake_case` field names, and a `to<X>Response` mapper per shape, matching
 * the convention already established in `types/dto.ts` — the frontend mirrors
 * the backend's contract verbatim rather than reshaping at each hop.
 */

import type { Command } from "./entities.js";

/**
 * The hardware state machine's states — the authoritative status.
 *
 * Ordered as the happy path runs: nothing configured, looking for a board,
 * opening it, waiting for its first ACK, alive, and backing off after a
 * failure before scanning again.
 */
export const HardwareState = {
  /** Switched off, or the serial layer is unusable on this machine. Terminal. */
  Disabled: "disabled",
  /** Polling the host's serial ports for a board that matches the allowlist. */
  Scanning: "scanning",
  /** A candidate port was found; opening it. */
  Connecting: "connecting",
  /** A command has been written and its ACK is outstanding. Also the single-in-flight gate. */
  Probing: "probing",
  /** The board answered and is being re-probed on a heartbeat. */
  Connected: "connected",
  /** A failure occurred; waiting out the reconnect delay before scanning again. */
  ErrorRetry: "error_retry",
} as const;

export type HardwareState = (typeof HardwareState)[keyof typeof HardwareState];

/** One `(:Command)` as sent to a client. */
export interface HardwareCommandResponse {
  id: string;
  action: string;
  status: Command["status"];
  sent_at: string;
  resolved_at: string | null;
  ack_received: boolean;
  detail: string | null;
  component_id: string | null;
}

/**
 * `GET /api/hardware/status`, and the payload of every SSE frame on
 * `GET /api/hardware/stream` — deliberately the same shape, so the polling
 * fallback in the frontend hook consumes identical data to the live stream
 * and no view can drift between the two.
 */
export interface HardwareStatusResponse {
  /** The authoritative status. Clients render off this. */
  state: HardwareState;
  /**
   * Derived convenience only: exactly `state === "connected"`, never an
   * independent source of truth. It exists so a caller that genuinely only
   * needs a yes/no doesn't have to know the state names — a client must not
   * infer transitions from it, because intermediate states (`probing` during
   * a heartbeat) would read as a disconnect.
   */
  connected: boolean;
  port_path: string | null;
  last_ack_at: string | null;
  last_error: string | null;
  last_command: HardwareCommandResponse | null;
}

/** `POST /api/hardware/action` request body (validated by `validation/hardwareSchemas.ts`). */
export interface HardwareActionRequest {
  action: string;
  component_id?: string | null;
}

export function toHardwareCommandResponse(command: Command): HardwareCommandResponse {
  return {
    id: command.id,
    action: command.action,
    status: command.status,
    sent_at: command.sentAt,
    resolved_at: command.resolvedAt,
    ack_received: command.ackReceived,
    detail: command.detail,
    component_id: command.componentId,
  };
}
