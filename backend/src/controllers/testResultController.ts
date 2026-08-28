import type { Request, Response } from "express";

import { requireUser } from "../middleware/auth.js";
import * as testResultService from "../services/testResultService.js";
import {
  fromCreateTestResultRequest,
  toTestResultResponse,
  type CreateTestResultRequest,
  type TestResultResponse,
} from "../types/dto.js";

export async function createTestResult(
  req: Request<{ id: string }, TestResultResponse, CreateTestResultRequest>,
  res: Response<TestResultResponse>,
): Promise<void> {
  const user = requireUser(req);
  const componentId = req.params.id;
  const result = await testResultService.createTestResult(
    componentId,
    fromCreateTestResultRequest(req.body),
    user.id,
  );
  res.status(201).json(toTestResultResponse(result, componentId));
}

export async function getLatestTestResult(
  req: Request<{ id: string }>,
  res: Response<TestResultResponse>,
): Promise<void> {
  const user = requireUser(req);
  const componentId = req.params.id;
  const result = await testResultService.getLatestTestResult(componentId, user.id);
  res.status(200).json(toTestResultResponse(result, componentId));
}

export async function getTestHistory(
  req: Request<{ id: string }>,
  res: Response<TestResultResponse[]>,
): Promise<void> {
  const user = requireUser(req);
  const componentId = req.params.id;
  const results = await testResultService.getTestHistory(componentId, user.id);
  res.status(200).json(results.map((result) => toTestResultResponse(result, componentId)));
}
