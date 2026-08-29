import type { Session, Transaction } from "neo4j-driver";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { settings } from "../src/config/env.js";
import { closeDriver, getDriver } from "../src/db/neo4jDriver.js";
import * as componentRepository from "../src/repositories/componentRepository.js";
import * as scanRepository from "../src/repositories/scanRepository.js";
import * as testResultRepository from "../src/repositories/testResultRepository.js";
import type { ComponentInput } from "../src/repositories/componentRepository.js";
import { connectForTests } from "./helpers/testNeo4j.js";
import { createTestUser } from "./helpers/testUser.js";

const { reachable } = await connectForTests();

const baseInput: ComponentInput = {
  scanId: null,
  type: "resistor",
  label: "resistor",
  name: "R1",
  confidence: 0.9,
  condition: "unknown",
  salvagePriority: null,
  x1: 1,
  y1: 2,
  x2: 3,
  y2: 4,
};

describe.skipIf(!reachable)("componentRepository (integration)", () => {
  let session: Session;
  let tx: Transaction;

  /** Components and scans are both owned, so every test needs a user to attach them to. */
  let ownerId: string;

  beforeEach(async () => {
    session = getDriver().session({ database: settings.neo4j.database });
    tx = session.beginTransaction();
    ownerId = await createTestUser(tx);
  });

  afterEach(async () => {
    await tx.rollback();
    await session.close();
  });

  afterAll(async () => {
    await closeDriver();
  });

  it("creates a standalone component with no scan (scan_id null), owned by the user", async () => {
    const component = await componentRepository.createComponent(baseInput, ownerId, tx);

    expect(component.id).toBeTruthy();
    expect(component.scanId).toBeNull();
    expect(component.type).toBe("resistor");
    expect(component.status).toBe("not_tested");
    expect(component.condition).toBe("unknown");
    expect(component.testResults).toEqual([]);

    // Reachable by its owner, and only its owner.
    const otherUser = await createTestUser(tx);
    expect(await componentRepository.getComponentById(component.id, ownerId, tx)).not.toBeNull();
    expect(await componentRepository.getComponentById(component.id, otherUser, tx)).toBeNull();
  });

  it("creates a component linked to a scan via DETECTED", async () => {
    const scan = await scanRepository.createScan({ imagePath: null, ownerId }, tx);
    const component = await componentRepository.createComponent({ ...baseInput, scanId: scan.id }, ownerId, tx);

    expect(component.scanId).toBe(scan.id);
    const scanDetail = await scanRepository.getScanById(scan.id, ownerId, tx);
    expect(scanDetail?.components.map((c) => c.id)).toContain(component.id);
  });

  it("creates a batch of detections linked to a scan via DETECTED", async () => {
    const scan = await scanRepository.createScan({ imagePath: null, ownerId }, tx);
    const components = await componentRepository.createDetectionBatch(
      scan.id,
      [
        { ...baseInput, type: "resistor", name: "R1" },
        { ...baseInput, type: "led", name: "D1" },
      ],
      ownerId,
      tx,
    );

    expect(components).not.toBeNull();
    expect(components).toHaveLength(2);
    expect(components?.every((c) => c.scanId === scan.id)).toBe(true);
  });

  it("creates a batch containing one of the newly-added component types (relay) and preserves it exactly, not 'unknown'", async () => {
    // Verifies the ComponentType domain extension: a real YOLO class the
    // model actually detects must flow through detection ingestion as
    // itself, not get coerced into "unknown". See ML_SERVICE_INTEGRATION_PLAN.md.
    const scan = await scanRepository.createScan({ imagePath: null, ownerId }, tx);
    const components = await componentRepository.createDetectionBatch(
      scan.id,
      [{ ...baseInput, type: "relay", name: "K1" }],
      ownerId,
      tx,
    );

    expect(components).not.toBeNull();
    expect(components?.[0]?.type).toBe("relay");
    expect(components?.[0]?.type).not.toBe("unknown");

    const readBack = await componentRepository.getComponentById(components![0]!.id, ownerId, tx);
    expect(readBack?.type).toBe("relay");
  });

  it("returns null from createDetectionBatch when the scan doesn't exist / isn't the user's", async () => {
    const components = await componentRepository.createDetectionBatch(
      "does-not-exist",
      [{ ...baseInput, type: "resistor" }],
      ownerId,
      tx,
    );
    expect(components).toBeNull();
  });

  it("returns null when getting a component that doesn't exist", async () => {
    const component = await componentRepository.getComponentById("does-not-exist", ownerId, tx);
    expect(component).toBeNull();
  });

  it("reports componentExists correctly (scoped to the owner)", async () => {
    const component = await componentRepository.createComponent(baseInput, ownerId, tx);
    const otherUser = await createTestUser(tx);
    await expect(componentRepository.componentExists(component.id, ownerId, tx)).resolves.toBe(true);
    await expect(componentRepository.componentExists(component.id, otherUser, tx)).resolves.toBe(false);
    await expect(componentRepository.componentExists("does-not-exist", ownerId, tx)).resolves.toBe(false);
  });

  it("gets a component with its full test-result history attached", async () => {
    const component = await componentRepository.createComponent(baseInput, ownerId, tx);
    await testResultRepository.createTestResult(
      component.id,
      { expectedValue: 10, measuredValue: 9.9, unit: "kΩ", status: "pass" },
      ownerId,
      tx,
    );

    const detail = await componentRepository.getComponentById(component.id, ownerId, tx);
    expect(detail?.testResults).toHaveLength(1);
    expect(detail?.status).toBe("pass"); // parent status updated by createTestResult
  });

  it("lists components filtered by type and status", async () => {
    await componentRepository.createComponent({ ...baseInput, type: "resistor" }, ownerId, tx);
    await componentRepository.createComponent({ ...baseInput, type: "led" }, ownerId, tx);

    const resistors = await componentRepository.listComponents({ type: "resistor" }, ownerId, tx);
    expect(resistors.every((c) => c.type === "resistor")).toBe(true);

    const notTested = await componentRepository.listComponents({ status: "not_tested" }, ownerId, tx);
    expect(notTested.length).toBeGreaterThanOrEqual(2);
  });

  it("lists only the caller's own components", async () => {
    await componentRepository.createComponent({ ...baseInput, name: "mine" }, ownerId, tx);
    const otherUser = await createTestUser(tx);
    await componentRepository.createComponent({ ...baseInput, name: "theirs" }, otherUser, tx);

    const mine = await componentRepository.listComponents({}, ownerId, tx);
    expect(mine.map((c) => c.name)).toEqual(["mine"]);
  });

  it("updates a component's fields and re-parents it to a different scan", async () => {
    const scanA = await scanRepository.createScan({ imagePath: null, ownerId }, tx);
    const scanB = await scanRepository.createScan({ imagePath: null, ownerId }, tx);
    const component = await componentRepository.createComponent({ ...baseInput, scanId: scanA.id }, ownerId, tx);

    const updated = await componentRepository.updateComponent(
      component.id,
      { ...baseInput, scanId: scanB.id, condition: "good", salvagePriority: "high" },
      ownerId,
      tx,
    );

    expect(updated?.scanId).toBe(scanB.id);
    expect(updated?.condition).toBe("good");
    expect(updated?.salvagePriority).toBe("high");

    const scanADetail = await scanRepository.getScanById(scanA.id, ownerId, tx);
    const scanBDetail = await scanRepository.getScanById(scanB.id, ownerId, tx);
    expect(scanADetail?.components).toHaveLength(0);
    expect(scanBDetail?.components).toHaveLength(1);
  });

  it("returns null when updating a component that doesn't exist / isn't the user's", async () => {
    const updated = await componentRepository.updateComponent("does-not-exist", baseInput, ownerId, tx);
    expect(updated).toBeNull();
  });

  it("deletes a component and cascades its test results", async () => {
    const component = await componentRepository.createComponent(baseInput, ownerId, tx);
    await testResultRepository.createTestResult(
      component.id,
      { expectedValue: null, measuredValue: null, unit: null, status: "not_tested" },
      ownerId,
      tx,
    );

    const deleted = await componentRepository.deleteComponent(component.id, ownerId, tx);
    expect(deleted).toBe(true);

    const after = await componentRepository.getComponentById(component.id, ownerId, tx);
    expect(after).toBeNull();
  });

  it("returns false when deleting a component that doesn't exist / isn't the user's", async () => {
    const deleted = await componentRepository.deleteComponent("does-not-exist", ownerId, tx);
    expect(deleted).toBe(false);
  });

  it("rejects a duplicate Component.id, proving the uniqueness constraint is enforced", async () => {
    const duplicateId = "duplicate-component-id-for-constraint-test";
    const create = (): ReturnType<Transaction["run"]> =>
      tx.run(
        `CREATE (c:Component {id: $id, type: "resistor", confidence: 0.5, condition: "unknown",
                               status: "not_tested", createdAt: datetime()})`,
        { id: duplicateId },
      );

    await create();
    await expect(create()).rejects.toThrow();
  });
});
