/**
 * Persistent storage for uploaded scan images.
 *
 * Images are written to the filesystem and only a bare filename is recorded on
 * the `(:Scan)` node, per the project's storage rule — Neo4j holds the
 * reference, not multi-megabyte binaries.
 *
 * Two properties matter for portability and safety:
 *
 * - The directory comes from `CIRCUITLOOP_UPLOAD_DIR` and resolves relative to
 *   the backend package root, so no absolute machine-specific path is ever
 *   committed or written to the database. Moving the repo to another machine
 *   needs no configuration change.
 * - Filenames are generated from the scan's own id, never from the client's
 *   `originalname`. An uploaded name is attacker-controlled and could contain
 *   path separators or `..`; deriving the name from a server-generated UUID
 *   removes that entire class of traversal bug rather than trying to sanitise
 *   it.
 */

import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { settings } from "../config/env.js";
import { ValidationError } from "../utils/errors.js";

/** Backend package root — `src/services/` is two levels below it. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Accepted upload types mapped to the extension used on disk.
 *
 * The extension is chosen from the validated MIME type rather than copied from
 * the upload, so the stored name can never carry an unexpected suffix.
 */
const MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
};

export function resolveUploadDir(): string {
  return path.isAbsolute(settings.uploadDir)
    ? settings.uploadDir
    : path.join(PACKAGE_ROOT, settings.uploadDir);
}

/** Creates the upload directory if absent. Called once at startup; idempotent. */
export async function ensureUploadDir(): Promise<string> {
  const dir = resolveUploadDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export function isSupportedImageType(mimeType: string): boolean {
  return mimeType in MIME_TO_EXTENSION;
}

/**
 * Writes an uploaded image for `scanId` and returns the bare filename to store
 * on the Scan node.
 *
 * One image per scan: the filename is deterministic, so re-uploading to the
 * same scan replaces the previous file instead of orphaning it.
 */
export async function saveScanImage(
  scanId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const extension = MIME_TO_EXTENSION[mimeType];
  if (extension === undefined) {
    throw new ValidationError(`Unsupported image type '${mimeType}' — expected PNG or JPEG`);
  }

  const dir = await ensureUploadDir();
  const filename = `${scanId}${extension}`;
  await writeFile(path.join(dir, filename), buffer);
  return filename;
}

/**
 * Resolves a stored filename to an absolute path, refusing anything that
 * escapes the upload directory.
 *
 * Filenames are server-generated, so this should never trigger — it is a
 * backstop in case a hand-edited or legacy `imagePath` value reaches here, so
 * a malformed database row cannot become an arbitrary file read.
 */
export function resolveStoredImagePath(filename: string): string {
  const dir = resolveUploadDir();
  const resolved = path.resolve(dir, filename);

  const relative = path.relative(dir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ValidationError("Invalid stored image reference");
  }
  return resolved;
}

export function contentTypeForStoredImage(filename: string): string {
  return path.extname(filename).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
}

export function openStoredImage(filename: string): NodeJS.ReadableStream {
  return createReadStream(resolveStoredImagePath(filename));
}

/** Deletes a stored image; a missing file is not an error. */
export async function deleteStoredImage(filename: string): Promise<void> {
  await rm(resolveStoredImagePath(filename), { force: true });
}
