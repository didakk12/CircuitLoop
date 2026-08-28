import type { QueryRunner } from "../db/session.js";
import * as componentRepository from "../repositories/componentRepository.js";
import * as scanRepository from "../repositories/scanRepository.js";
import type { ComponentDetail } from "../types/entities.js";
import { NotFoundError } from "../utils/errors.js";

/**
 * A `scan_id` supplied on create/update must reference a scan the *same*
 * user owns — otherwise a caller could file their component under another
 * user's scan. An unowned/non-existent scan id is reported as "Scan not
 * found", identical to how scanRepository hides other users' scans.
 */
async function assertScanOwnedIfGiven(
  scanId: string | null,
  ownerId: string,
  runner: QueryRunner | undefined,
): Promise<void> {
  if (scanId !== null && !(await scanRepository.scanExists(scanId, ownerId, runner))) {
    throw new NotFoundError("Scan", scanId);
  }
}

export async function createComponent(
  input: componentRepository.ComponentInput,
  ownerId: string,
  runner?: QueryRunner,
): Promise<ComponentDetail> {
  await assertScanOwnedIfGiven(input.scanId, ownerId, runner);
  return componentRepository.createComponent(input, ownerId, runner);
}

export async function createDetectionBatch(
  scanId: string,
  inputs: componentRepository.ComponentInput[],
  ownerId: string,
  runner?: QueryRunner,
): Promise<ComponentDetail[]> {
  const components = await componentRepository.createDetectionBatch(scanId, inputs, ownerId, runner);
  if (!components) {
    throw new NotFoundError("Scan", scanId);
  }
  return components;
}

export async function listComponents(
  filters: componentRepository.ComponentListFilters,
  ownerId: string,
  runner?: QueryRunner,
): Promise<ComponentDetail[]> {
  return componentRepository.listComponents(filters, ownerId, runner);
}

export async function getComponentById(
  id: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<ComponentDetail> {
  const component = await componentRepository.getComponentById(id, ownerId, runner);
  if (!component) {
    throw new NotFoundError("Component", id);
  }
  return component;
}

export async function updateComponent(
  id: string,
  input: componentRepository.ComponentInput,
  ownerId: string,
  runner?: QueryRunner,
): Promise<ComponentDetail> {
  await assertScanOwnedIfGiven(input.scanId, ownerId, runner);
  const component = await componentRepository.updateComponent(id, input, ownerId, runner);
  if (!component) {
    throw new NotFoundError("Component", id);
  }
  return component;
}

export async function deleteComponent(id: string, ownerId: string, runner?: QueryRunner): Promise<void> {
  const deleted = await componentRepository.deleteComponent(id, ownerId, runner);
  if (!deleted) {
    throw new NotFoundError("Component", id);
  }
}
