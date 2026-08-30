import type { Request, Response } from "express";

import { requireUser } from "../middleware/auth.js";
import { HARDWARE_CHANGE_EVENT, hardwareEvents } from "../services/hardwareEvents.js";
import * as hardwareService from "../services/hardwareService.js";
import { getHardwareStatus } from "../services/hardwareState.js";
import {
  toHardwareCommandResponse,
  type HardwareCommandResponse,
  type HardwareStatusResponse,
} from "../types/hardwareDto.js";
import type { HardwareActionBody } from "../validation/hardwareSchemas.js";

/**
 * `GET /api/hardware/status`.
 *
 * Always 200, never 404. "No board is connected" is a legitimate, fully
 * describable answer (`state: "scanning"`), not a missing resource — unlike
 * the telemetry endpoint, which genuinely has nothing to report before its
 * first payload arrives. A client polling this always gets a usable status
 * object and never has to special-case an error body.
 */
export function getStatus(_req: Request, res: Response<HardwareStatusResponse>): void {
  res.status(200).json(getHardwareStatus());
}

/**
 * `GET /api/hardware/stream` — the same status object as above, pushed on
 * every state change.
 *
 * Headers and framing mirror `assistantController.askAssistantStream`
 * exactly, so there is one SSE dialect in this backend rather than two.
 *
 * The listener lifecycle is the part that matters. `hardwareEvents` is a
 * long-lived module singleton, so a listener registered here outlives the
 * request unless it is explicitly removed — and every browser tab that ever
 * opened the dashboard would accumulate one, each holding its own closed
 * `res` and writing into a dead socket forever. `req.on("close")` removing
 * exactly the handler this connection added is what bounds that: listener
 * count returns to its baseline the moment the client goes away.
 */
export function streamStatus(req: Request, res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Defeat proxy/response buffering so frames reach the browser as they are written.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (status: HardwareStatusResponse): void => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(status)}\n\n`);
    }
  };

  // Snapshot first, so a client that connects during a long-stable period
  // renders the real state immediately instead of showing a placeholder
  // until the next transition — which, on a healthy idle link, may be a
  // heartbeat interval away.
  send(getHardwareStatus());

  const handler = (status: HardwareStatusResponse): void => {
    send(status);
  };
  hardwareEvents.on(HARDWARE_CHANGE_EVENT, handler);

  req.on("close", () => {
    hardwareEvents.off(HARDWARE_CHANGE_EVENT, handler);
    if (!res.writableEnded) {
      res.end();
    }
  });
}

/**
 * `POST /api/hardware/action`.
 *
 * Resolves only once the board has actually acknowledged, so the returned
 * `Command` is the *resolved* record rather than an optimistic receipt. The
 * error cases are the service's, surfaced unchanged by the shared error
 * handler: `409` when a command is already in flight, `503` when there is no
 * link or the ACK never arrived, `502` on a malformed response line, and
 * `404` for a `component_id` the caller doesn't own.
 */
export async function sendAction(
  req: Request<Record<string, never>, HardwareCommandResponse, HardwareActionBody>,
  res: Response<HardwareCommandResponse>,
): Promise<void> {
  const user = requireUser(req);
  const { action, component_id: componentId } = req.body;
  const command = await hardwareService.sendAction(action, componentId ?? null, user.id);
  res.status(200).json(toHardwareCommandResponse(command));
}
