import type { Session, Transaction } from "neo4j-driver";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { settings } from "../src/config/env.js";
import { closeDriver, getDriver } from "../src/db/neo4jDriver.js";
import * as componentRepository from "../src/repositories/componentRepository.js";
import * as scanRepository from "../src/repositories/scanRepository.js";
import { connectForTests } from "./helpers/testNeo4j.js";
import { createTestUser } from "./helpers/testUser.js";

const { reachable } = await connectForTests();

/**
 * Waits long enough for two records to receive distinguishable timestamps.
 *
 * `datetime()` is written at the host clock's granularity, which on some
 * platforms is coarser than the time it takes to run two consecutive creates —
 * measured here: four creates in one transaction produced only two distinct
 * timestamps. Ordering assertions then tie and resolve arbitrarily.
 *
 * Real usage never records two of these within the same clock tick, so this
 * gap reflects reality rather than hiding a defect.
 */
async function clockTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}


describe.skipIf(!reachable)("scanRepository (integration)", () => {
  let session: Session;
  let tx: Transaction;
  /** Scans are owned, so every test needs a user to attach them to. */
  let ownerId: string;

  beforeEach(async () => {
    session = getDriver().session({ database: settings.neo4j.database });
    tx = session.beginTransaction();
    ownerId = await createTestUser(tx);
  });

  afterEach(async () => {
    // Never committed — the real database is left exactly as it was.
    await tx.rollback();
    await session.close();
  });

  afterAll(async () => {
    await closeDriver();
  });

  it("creates a scan with the given image path and defaults", async () => {
    const scan = await scanRepository.createScan({ imagePath: "uploads/board.jpg", ownerId }, tx);

    expect(scan.id).toBeTruthy();
    expect(scan.imagePath).toBe("uploads/board.jpg");
    expect(scan.totalComponents).toBe(0);
    expect(scan.components).toEqual([]);
    expect(Number.isNaN(Date.parse(scan.timestamp))).toBe(false);
  });

  it("creates a scan with a null image path", async () => {
    const scan = await scanRepository.createScan({ imagePath: null, ownerId }, tx);
    expect(scan.imagePath).toBeNull();
  });

  it("returns null when getting a scan that doesn't exist", async () => {
    const scan = await scanRepository.getScanById("does-not-exist", ownerId, tx);
    expect(scan).toBeNull();
  });

  it("reports false from scanExists for a missing scan and true for one the user owns", async () => {
    const scan = await scanRepository.createScan({ imagePath: null, ownerId }, tx);
    const otherUser = await createTestUser(tx);
    await expect(scanRepository.scanExists(scan.id, ownerId, tx)).resolves.toBe(true);
    await expect(scanRepository.scanExists(scan.id, otherUser, tx)).resolves.toBe(false);
    await expect(scanRepository.scanExists("does-not-exist", ownerId, tx)).resolves.toBe(false);
  });

  it("retrieves a scan with its DETECTED components and their test results nested", async () => {
    const scan = await scanRepository.createScan({ imagePath: null, ownerId }, tx);
    await componentRepository.createComponent(
      {
        scanId: scan.id,
        type: "resistor",
        name: "R1",
        confidence: 0.9,
        condition: "unknown",
        salvagePriority: null,
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
      },
      ownerId,
      tx,
    );

    const detail = await scanRepository.getScanById(scan.id, ownerId, tx);

    expect(detail).not.toBeNull();
    expect(detail?.totalComponents).toBe(1);
    expect(detail?.components).toHaveLength(1);
    expect(detail?.components[0]?.name).toBe("R1");
    expect(detail?.components[0]?.scanId).toBe(scan.id);
    expect(detail?.components[0]?.testResults).toEqual([]);
  });

  it("lists scans ordered most-recent-first with a computed totalComponents (no denormalized counter)", async () => {
    const first = await scanRepository.createScan({ imagePath: "a.jpg", ownerId }, tx);
    await clockTick();
    const second = await scanRepository.createScan({ imagePath: "b.jpg", ownerId }, tx);
    await componentRepository.createComponent(
      {
        scanId: second.id,
        type: "led",
        name: null,
        confidence: 0.5,
        condition: "unknown",
        salvagePriority: null,
        x1: null,
        y1: null,
        x2: null,
        y2: null,
      },
      ownerId,
      tx,
    );

    const scans = await scanRepository.listScans(ownerId, tx);
    const ids = scans.map((s) => s.id);

    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(scans.find((s) => s.id === second.id)?.totalComponents).toBe(1);
    expect(scans.find((s) => s.id === first.id)?.totalComponents).toBe(0);
  });

  it("rejects a duplicate Scan.id, proving the uniqueness constraint from db/schema.ts is enforced", async () => {
    const duplicateId = "duplicate-scan-id-for-constraint-test";
    await tx.run("CREATE (s:Scan {id: $id, imagePath: null, timestamp: datetime()})", { id: duplicateId });

    await expect(
      tx.run("CREATE (s:Scan {id: $id, imagePath: null, timestamp: datetime()})", { id: duplicateId }),
    ).rejects.toThrow();
  });
});
