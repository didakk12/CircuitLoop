import type { QueryRunner } from "../db/session.js";
import * as scanRepository from "../repositories/scanRepository.js";
import type { ScanDetail, ScanSummary } from "../types/entities.js";
import { NotFoundError } from "../utils/errors.js";

export async function createScan(
  input: scanRepository.CreateScanInput,
  runner?: QueryRunner,
): Promise<ScanDetail> {
  return scanRepository.createScan(input, runner);
}

/** The caller's scan history, newest first. */
export async function listScans(ownerId: string, runner?: QueryRunner): Promise<ScanSummary[]> {
  return scanRepository.listScans(ownerId, runner);
}

/**
 * Fetches a scan the caller owns.
 *
 * A scan owned by someone else raises `NotFoundError`, identically to one that
 * does not exist — returning 403 here would confirm the id is real and let a
 * user enumerate other people's scans.
 */
export async function getScanById(
  id: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<ScanDetail> {
  const scan = await scanRepository.getScanById(id, ownerId, runner);
  if (!scan) {
    throw new NotFoundError("Scan", id);
  }
  return scan;
}

/** Records the persisted image filename against a scan. */
export async function setImagePath(
  id: string,
  imagePath: string,
  runner?: QueryRunner,
): Promise<void> {
  await scanRepository.setImagePath(id, imagePath, runner);
}

/** Stored image filename for a scan the caller owns, or `null`. */
export async function getOwnedImagePath(
  id: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<string | null> {
  return scanRepository.getOwnedImagePath(id, ownerId, runner);
}
