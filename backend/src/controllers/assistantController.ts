import type { Request, Response } from "express";

import * as assistantService from "../services/assistantService.js";
import type { AskAssistantBody } from "../validation/assistantSchemas.js";
import type { AssistantResponse } from "../types/dto.js";

export async function askAssistant(
  req: Request<Record<string, never>, AssistantResponse, AskAssistantBody>,
  res: Response<AssistantResponse>,
): Promise<void> {
  const { component_id: componentId, question } = req.body;
  const response = await assistantService.askAssistant(componentId, question);
  res.status(200).json(response);
}
