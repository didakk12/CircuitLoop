import type { Session, Transaction } from "neo4j-driver";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { settings } from "../src/config/env.js";
import { closeDriver, getDriver } from "../src/db/neo4jDriver.js";
import * as componentRepository from "../src/repositories/componentRepository.js";
import type { ComponentInput } from "../src/repositories/componentRepository.js";
import * as testResultRepository from "../src/repositories/testResultRepository.js";
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


const baseComponent: ComponentInput = {
  scanId: null,
  type: "capacitor",
  name: "C1",
  confidence: 0.8,
  condition: "unknown",
  salvagePriority: null,
  x1: null,
  y1: null,
  x2: null,
  y2: null,
};

describe.skipIf(!reachable)("testResultRepository (integration)", () => {
  let session: Session;
  let tx: Transaction;
  /** Components are owned, so every test needs a user to attach them to. */
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

  it("creates a test result linked to its component via HAS_TEST_RESULT and updates the component's status", async () => {
    const component = await componentRepository.createComponent(baseComponent, ownerId, tx);

    const result = await testResultRepository.createTestResult(
      component.id,
      { expectedValue: 10, measuredValue: 9.8, unit: "uF", status: "pass" },
      ownerId,
      tx,
    );

    expect(result).not.toBeNull();
    expect(result?.status).toBe("pass");
    expect(result?.measuredValue).toBe(9.8);

    const updatedComponent = await componentRepository.getComponentById(component.id, ownerId, tx);
    expect(updatedComponent?.status).toBe("pass");
    expect(updatedComponent?.testResults).toHaveLength(1);
  });

  it("returns null when creating a test result for a component that doesn't exist", async () => {
    const result = await testResultRepository.createTestResult(
      "does-not-exist",
      { expectedValue: null, measuredValue: null, unit: null, status: "not_tested" },
      ownerId,
      tx,
    );
    expect(result).toBeNull();
  });

  it("returns null when creating a test result for another user's component", async () => {
    const component = await componentRepository.createComponent(baseComponent, ownerId, tx);
    const otherUser = await createTestUser(tx);
    const result = await testResultRepository.createTestResult(
      component.id,
      { expectedValue: 1, measuredValue: 1, unit: "uF", status: "pass" },
      otherUser,
      tx,
    );
    expect(result).toBeNull();
  });

  it("returns null from getLatestTestResult when the component has no test results", async () => {
    const component = await componentRepository.createComponent(baseComponent, ownerId, tx);
    const latest = await testResultRepository.getLatestTestResult(component.id, ownerId, tx);
    expect(latest).toBeNull();
  });

  it("getLatestTestResult returns the most recently created result", async () => {
    const component = await componentRepository.createComponent(baseComponent, ownerId, tx);
    await testResultRepository.createTestResult(
      component.id,
      { expectedValue: 10, measuredValue: 9, unit: "uF", status: "fail" },
      ownerId,
      tx,
    );
    await clockTick();
    const second = await testResultRepository.createTestResult(
      component.id,
      { expectedValue: 10, measuredValue: 10.1, unit: "uF", status: "pass" },
      ownerId,
      tx,
    );

    const latest = await testResultRepository.getLatestTestResult(component.id, ownerId, tx);
    expect(latest?.id).toBe(second?.id);
    expect(latest?.status).toBe("pass");
  });

  it("getLatestTestResult returns null for another user's component", async () => {
    const component = await componentRepository.createComponent(baseComponent, ownerId, tx);
    await testResultRepository.createTestResult(
      component.id,
      { expectedValue: 10, measuredValue: 10, unit: "uF", status: "pass" },
      ownerId,
      tx,
    );
    const otherUser = await createTestUser(tx);
    expect(await testResultRepository.getLatestTestResult(component.id, otherUser, tx)).toBeNull();
  });

  it("getTestHistory returns an empty array for a component with no tests (not an error)", async () => {
    const component = await componentRepository.createComponent(baseComponent, ownerId, tx);
    const history = await testResultRepository.getTestHistory(component.id, ownerId, tx);
    expect(history).toEqual([]);
  });

  it("getTestHistory returns every result, oldest first", async () => {
    const component = await componentRepository.createComponent(baseComponent, ownerId, tx);
    const first = await testResultRepository.createTestResult(
      component.id,
      { expectedValue: 10, measuredValue: 9, unit: "uF", status: "fail" },
      ownerId,
      tx,
    );
    await clockTick();
    const second = await testResultRepository.createTestResult(
      component.id,
      { expectedValue: 10, measuredValue: 10.1, unit: "uF", status: "pass" },
      ownerId,
      tx,
    );

    const history = await testResultRepository.getTestHistory(component.id, ownerId, tx);
    expect(history.map((r) => r.id)).toEqual([first?.id, second?.id]);
  });
});
