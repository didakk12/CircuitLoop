import type { Request, Response } from "express";

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
  const componentId = req.params.id;
  const result = await testResultService.createTestResult(componentId, fromCreateTestResultRequest(req.body));
  res.status(201).json(toTestResultResponse(result, componentId));
}

export async function getLatestTestResult(
  req: Request<{ id: string }>,
  res: Response<TestResultResponse>,
): Promise<void> {
  const componentId = req.params.id;
  const result = await testResultService.getLatestTestResult(componentId);
  res.status(200).json(toTestResultResponse(result, componentId));
}

export async function getTestHistory(
  req: Request<{ id: string }>,
  res: Response<TestResultResponse[]>,
): Promise<void> {
  const componentId = req.params.id;
  const results = await testResultService.getTestHistory(componentId);
  res.status(200).json(results.map((result) => toTestResultResponse(result, componentId)));
}
