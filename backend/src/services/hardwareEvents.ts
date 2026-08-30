/**
 * The change-notification bus between the hardware state machine and every
 * open SSE connection.
 *
 * A module singleton, and deliberately **independent of
 * `hardwareService.start()`/`stop()`**: its lifecycle is per-HTTP-connection,
 * not per-service-lifecycle. `GET /api/hardware/stream` attaches one listener
 * when a client connects and removes it when that connection closes, so
 * restarting the service (or never starting it at all) neither drops a
 * subscriber nor leaves a stale one behind.
 *
 * `setMaxListeners` is raised above Node's default of 10 because the default
 * exists to catch listener leaks, and here a high count is legitimate — it is
 * simply the number of browser tabs currently watching the badge. The SSE
 * controller's `req.on("close")` cleanup is what actually prevents a leak;
 * this only stops a correct 11th tab from printing a scary warning.
 */

import { EventEmitter } from "node:events";

import type { HardwareStatusResponse } from "../types/hardwareDto.js";

/** Emitted with the full current status whenever any field of it changes. */
export const HARDWARE_CHANGE_EVENT = "change";

export interface HardwareEvents {
  on(event: typeof HARDWARE_CHANGE_EVENT, listener: (status: HardwareStatusResponse) => void): this;
  off(event: typeof HARDWARE_CHANGE_EVENT, listener: (status: HardwareStatusResponse) => void): this;
  emit(event: typeof HARDWARE_CHANGE_EVENT, status: HardwareStatusResponse): boolean;
  listenerCount(event: typeof HARDWARE_CHANGE_EVENT): number;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export const hardwareEvents: HardwareEvents = emitter;
