import type { Request, Response } from "express";

import * as componentService from "../services/componentService.js";
import {
  fromCreateComponentRequest,
  toComponentResponse,
  type ComponentResponse,
  type CreateComponentRequest,
  type UpdateComponentRequest,
} from "../types/dto.js";
import type { ListComponentsQuery } from "../validation/componentSchemas.js";

export async function createComponent(
  req: Request<Record<string, never>, ComponentResponse, CreateComponentRequest>,
  res: Response<ComponentResponse>,
): Promise<void> {
  const component = await componentService.createComponent(fromCreateComponentRequest(req.body));
  res.status(201).json(toComponentResponse(component));
}

export async function listComponents(
  req: Request,
  res: Response<ComponentResponse[]>,
): Promise<void> {
  const query = req.query as unknown as ListComponentsQuery;
  const components = await componentService.listComponents({ type: query.type, status: query.status });
  res.status(200).json(components.map(toComponentResponse));
}

export async function getComponent(
  req: Request<{ id: string }>,
  res: Response<ComponentResponse>,
): Promise<void> {
  const component = await componentService.getComponentById(req.params.id);
  res.status(200).json(toComponentResponse(component));
}

export async function updateComponent(
  req: Request<{ id: string }, ComponentResponse, UpdateComponentRequest>,
  res: Response<ComponentResponse>,
): Promise<void> {
  const component = await componentService.updateComponent(req.params.id, fromCreateComponentRequest(req.body));
  res.status(200).json(toComponentResponse(component));
}

export async function deleteComponent(req: Request<{ id: string }>, res: Response): Promise<void> {
  await componentService.deleteComponent(req.params.id);
  res.status(204).send();
}
