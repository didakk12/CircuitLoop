import { randomUUID } from "node:crypto";

import type { Express } from "express";
import request from "supertest";

import { settings } from "../../src/config/env.js";
import { getDriver } from "../../src/db/neo4jDriver.js";
import { deleteStoredImage } from "../../src/services/imageStorageService.js";

export interface AuthedAgent {
  /** supertest agent carrying the session cookie — use it exactly like `request(app)`. */
  agent: ReturnType<typeof request.agent>;
  userId: string;
  email: string;
}

/**
 * Registers a fresh account and returns an agent that carries its session
 * cookie.
 *
 * Every data route now sits behind `requireAuth`, so HTTP-level tests need a
 * real session. `request.agent` persists cookies across calls, which is exactly
 * how the browser uses the httpOnly session cookie.
 */
export async function registerAndLogin(app: Express): Promise<AuthedAgent> {
  // randomUUID, not a timestamp+counter: Vitest runs test files in separate
  // workers with separate module state, so two files could otherwise generate
  // the same email in the same millisecond and collide on the unique
  // constraint.
  const email = `api-test-${randomUUID()}@example.test`;
  const agent = request.agent(app);

  const response = await agent
    .post("/api/auth/register")
    .send({ email, password: "test-password-123" })
    .expect(201);

  return { agent, userId: response.body.id as string, email };
}

/**
 * Removes accounts created by {@link registerAndLogin}, along with any scans
 * they own and the image files those scans stored.
 *
 * Deleting the nodes alone would leave orphaned files accumulating in the
 * upload directory on every test run, since nothing else ever references them.
 */
export async function deleteTestUsers(userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  const session = getDriver().session({ database: settings.neo4j.database });
  try {
    const owned = await session.run(
      `MATCH (u:User) WHERE u.id IN $ids
       OPTIONAL MATCH (u)-[:OWNS]->(s:Scan)
       RETURN collect(s.imagePath) AS imagePaths`,
      { ids: userIds },
    );

    const imagePaths = (owned.records[0]?.get("imagePaths") ?? []) as (string | null)[];
    await Promise.all(
      imagePaths
        .filter((name): name is string => typeof name === "string" && name.length > 0)
        .map((name) => deleteStoredImage(name).catch(() => undefined)),
    );

    await session.run(
      `MATCH (u:User) WHERE u.id IN $ids
       OPTIONAL MATCH (u)-[:OWNS]->(s:Scan)
       DETACH DELETE u, s`,
      { ids: userIds },
    );
  } finally {
    await session.close();
  }
}

/**
 * Deletes stored images for the given scan ids.
 *
 * Tests that remove scans by id in `afterEach` do so before the node's
 * `imagePath` can be read back, so the filename is reconstructed from the scan
 * id — which is exactly how imageStorageService names it. Both extensions are
 * attempted since the test may have uploaded either type.
 */
export async function deleteScanImages(scanIds: string[]): Promise<void> {
  await Promise.all(
    scanIds.flatMap((id) =>
      [".png", ".jpg"].map((ext) => deleteStoredImage(`${id}${ext}`).catch(() => undefined)),
    ),
  );
}
