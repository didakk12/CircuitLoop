import type { Request, Response } from "express";

import { requireUser } from "../middleware/auth.js";
import * as assistantService from "../services/assistantService.js";
import type { AskAssistantBody } from "../validation/assistantSchemas.js";
import type { AssistantResponse, AssistantStreamEvent } from "../types/dto.js";

export async function askAssistant(
  req: Request<Record<string, never>, AssistantResponse, AskAssistantBody>,
  res: Response<AssistantResponse>,
): Promise<void> {
  const user = requireUser(req);
  const { component_id: componentId, question } = req.body;
  const response = await assistantService.askAssistant(user.id, componentId, question);
  res.status(200).json(response);
}

/**
 * Server-Sent Events counterpart of `askAssistant`. The first generator
 * event is pulled *before* any SSE headers are written, so a
 * `NotFoundError` (unknown component) still becomes a normal JSON 404 via
 * the shared error handler. Once streaming has started, a client disconnect
 * stops the pump; everything else is serialised one frame per event.
 */
export async function askAssistantStream(
  req: Request<Record<string, never>, unknown, AskAssistantBody>,
  res: Response,
): Promise<void> {
  const user = requireUser(req);
  const { component_id: componentId, question } = req.body;

  const stream = assistantService.streamAssistant(user.id, componentId, question);
  const first = await stream.next();

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Defeat proxy/response buffering so frames reach the browser as they are written.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });

  const send = (event: AssistantStreamEvent): void => {
    if (!clientGone && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  if (!first.done) {
    send(first.value);
  }
  for await (const event of stream) {
    if (clientGone) {
      break;
    }
    send(event);
  }

  if (!res.writableEnded) {
    res.end();
  }
}
