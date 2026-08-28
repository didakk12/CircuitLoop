import { randomUUID } from "node:crypto";

import type { QueryRunner } from "../../src/db/session.js";
import * as userRepository from "../../src/repositories/userRepository.js";

/**
 * Creates a throwaway user inside the caller's transaction.
 *
 * Scans are owned, so `createScan` needs a real (:User) to attach to. Emails
 * are unique per call because the email uniqueness constraint is enforced by
 * the database even inside an uncommitted transaction.
 */
export async function createTestUser(runner: QueryRunner): Promise<string> {
  const user = await userRepository.create(
    { email: `test-user-${randomUUID()}@example.test`, passwordHash: "not-a-real-hash" },
    runner,
  );
  return user.id;
}
