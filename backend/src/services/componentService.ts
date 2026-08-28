import type { QueryRunner } from "../db/session.js";
import * as componentRepository from "../repositories/componentRepository.js";
import * as scanRepository from "../repositories/scanRepository.js";
import type { ComponentDetail } from "../types/entities.js";
import { NotFoundError } from "../utils/errors.js";

async function assertScanExistsIfGiven(scanId: string | null, runner: QueryRunner | undefined): Promise<void> {
  if (scanId !== null && !(await scanRepository.scanExists(scanId, runner))) {
    throw new NotFoundError("Scan", scanId);
  }
}

export async function createComponent(
  input: componentRepository.ComponentInput,
  runner?: QueryRunner,
): Promise<ComponentDetail> {
  await assertScanExistsIfGiven(input.scanId, runner);
  return componentRepository.createComponent(input, runner);
}

export async function createDetectionBatch(
  scanId: string,
  inputs: componentRepository.ComponentInput[],
  runner?: QueryRunner,
): Promise<ComponentDetail[]> {
  const components = await componentRepository.createDetectionBatch(scanId, inputs, runner);
  if (!components) {
    throw new NotFoundError("Scan", scanId);
  }
  return components;
}

export async function listComponents(
  filters: componentRepository.ComponentListFilters,
  runner?: QueryRunner,
): Promise<ComponentDetail[]> {
  return componentRepository.listComponents(filters, runner);
}

export async function getComponentById(id: string, runner?: QueryRunner): Promise<ComponentDetail> {
  const component = await componentRepository.getComponentById(id, runner);
  if (!component) {
    throw new NotFoundError("Component", id);
  }
  return component;
}

export async function updateComponent(
  id: string,
  input: componentRepository.ComponentInput,
  runner?: QueryRunner,
): Promise<ComponentDetail> {
  await assertScanExistsIfGiven(input.scanId, runner);
  const component = await componentRepository.updateComponent(id, input, runner);
  if (!component) {
    throw new NotFoundError("Component", id);
  }
  return component;
}

export async function deleteComponent(id: string, runner?: QueryRunner): Promise<void> {
  const deleted = await componentRepository.deleteComponent(id, runner);
  if (!deleted) {
    throw new NotFoundError("Component", id);
  }
}
