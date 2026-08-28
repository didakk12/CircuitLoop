import type { QueryRunner } from "../db/session.js";
import * as componentRepository from "../repositories/componentRepository.js";
import * as testResultRepository from "../repositories/testResultRepository.js";
import type { TestResult } from "../types/entities.js";
import { NotFoundError } from "../utils/errors.js";

export async function createTestResult(
  componentId: string,
  input: testResultRepository.TestResultInput,
  ownerId: string,
  runner?: QueryRunner,
): Promise<TestResult> {
  const result = await testResultRepository.createTestResult(componentId, input, ownerId, runner);
  if (!result) {
    throw new NotFoundError("Component", componentId);
  }
  return result;
}

export async function getLatestTestResult(
  componentId: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<TestResult> {
  if (!(await componentRepository.componentExists(componentId, ownerId, runner))) {
    throw new NotFoundError("Component", componentId);
  }
  const result = await testResultRepository.getLatestTestResult(componentId, ownerId, runner);
  if (!result) {
    throw new NotFoundError("TestResult", componentId);
  }
  return result;
}

export async function getTestHistory(
  componentId: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<TestResult[]> {
  if (!(await componentRepository.componentExists(componentId, ownerId, runner))) {
    throw new NotFoundError("Component", componentId);
  }
  return testResultRepository.getTestHistory(componentId, ownerId, runner);
}
