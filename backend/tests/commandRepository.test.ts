/**
 * Integration tests for `commandRepository`, using the project's
 * transaction-rollback pattern: one transaction per test, rolled back in
 * `afterEach`, so these run against a real Neo4j without leaving anything
 * behind. Skips gracefully when no database is reachable.
 */

import type { Session, Transaction } from "neo4j-driver";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { settings } from "../src/config/env.js";
import { closeDriver, getDriver } from "../src/db/neo4jDriver.js";
import * as commandRepository from "../src/repositories/commandRepository.js";
import * as componentRepository from "../src/repositories/componentRepository.js";
import type { ComponentInput } from "../src/repositories/componentRepository.js";
import { connectForTests } from "./helpers/testNeo4j.js";
import { createTestUser } from "./helpers/testUser.js";

const { reachable } = await connectForTests();

/** See testResultRepository.test.ts — `datetime()` granularity can tie across back-to-back writes. */
async function clockTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const baseComponent: ComponentInput = {
  scanId: null,
  type: "ic",
  label: "ic",
  name: "PCF8574",
  confidence: 0.9,
  condition: "unknown",
  salvagePriority: null,
  x1: null,
  y1: null,
  x2: null,
  y2: null,
};

describe.skipIf(!reachable)("commandRepository (integration)", () => {
  let session: Session;
  let tx: Transaction;
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

  describe("gateway commands", () => {
    it("creates a standalone pending command with no component and no owner", async () => {
      const command = await commandRepository.createGatewayCommand("I2C_PROBE:0x27", tx);

      expect(command.action).toBe("I2C_PROBE:0x27");
      expect(command.status).toBe("pending");
      expect(command.componentId).toBeNull();
      expect(command.ackReceived).toBe(false);
      expect(command.resolvedAt).toBeNull();
      expect(command.detail).toBeNull();
      expect(command.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("creates no HAS_COMMAND relationship for a gateway probe", async () => {
      const command = await commandRepository.createGatewayCommand("I2C_PROBE:0x27", tx);

      const result = await tx.run(
        "MATCH (cmd:Command {id: $id}) RETURN size([(c:Component)-[:HAS_COMMAND]->(cmd) | c]) AS parents",
        { id: command.id },
      );
      expect(result.records[0]?.get("parents")).toBe(0);
    });

    it("lists recent gateway commands newest first, excluding component-attached ones", async () => {
      const component = await componentRepository.createComponent(baseComponent, ownerId, tx);
      const first = await commandRepository.createGatewayCommand("PROBE_ONE", tx);
      await clockTick();
      const second = await commandRepository.createGatewayCommand("PROBE_TWO", tx);
      await commandRepository.createComponentCommand("COMPONENT_TEST", component.id, ownerId, tx);

      const listed = await commandRepository.listRecentGatewayCommands(10, tx);
      const ids = listed.map((command) => command.id);

      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
      expect(listed.every((command) => command.componentId === null)).toBe(true);
    });

    it("honours the limit on the gateway command listing", async () => {
      await commandRepository.createGatewayCommand("PROBE_ONE", tx);
      await clockTick();
      await commandRepository.createGatewayCommand("PROBE_TWO", tx);

      const listed = await commandRepository.listRecentGatewayCommands(1, tx);
      expect(listed).toHaveLength(1);
    });
  });

  describe("component commands", () => {
    it("creates a command linked to its component by HAS_COMMAND", async () => {
      const component = await componentRepository.createComponent(baseComponent, ownerId, tx);

      const command = await commandRepository.createComponentCommand(
        "COMPONENT_TEST",
        component.id,
        ownerId,
        tx,
      );

      expect(command?.componentId).toBe(component.id);
      const result = await tx.run(
        "MATCH (c:Component {id: $componentId})-[:HAS_COMMAND]->(cmd:Command {id: $id}) RETURN cmd.id AS id",
        { componentId: component.id, id: command?.id },
      );
      expect(result.records).toHaveLength(1);
    });

    it("returns null for a component that does not exist", async () => {
      const command = await commandRepository.createComponentCommand(
        "COMPONENT_TEST",
        "does-not-exist",
        ownerId,
        tx,
      );
      expect(command).toBeNull();
    });

    it("returns null for another user's component, never leaking that it exists", async () => {
      const component = await componentRepository.createComponent(baseComponent, ownerId, tx);
      const otherUser = await createTestUser(tx);

      const command = await commandRepository.createComponentCommand(
        "COMPONENT_TEST",
        component.id,
        otherUser,
        tx,
      );
      expect(command).toBeNull();
    });

    it("lists a component's commands newest first", async () => {
      const component = await componentRepository.createComponent(baseComponent, ownerId, tx);
      const first = await commandRepository.createComponentCommand("FIRST", component.id, ownerId, tx);
      await clockTick();
      const second = await commandRepository.createComponentCommand("SECOND", component.id, ownerId, tx);

      const listed = await commandRepository.listCommandsForComponent(component.id, ownerId, tx);
      expect(listed.map((command) => command.id)).toEqual([second?.id, first?.id]);
    });

    it("returns an empty list for another user's component", async () => {
      const component = await componentRepository.createComponent(baseComponent, ownerId, tx);
      await commandRepository.createComponentCommand("COMPONENT_TEST", component.id, ownerId, tx);
      const otherUser = await createTestUser(tx);

      expect(await commandRepository.listCommandsForComponent(component.id, otherUser, tx)).toEqual([]);
    });
  });

  describe("resolution", () => {
    it("resolves a pending command as a success, stamping the ACK detail and time", async () => {
      const command = await commandRepository.createGatewayCommand("I2C_PROBE:0x27", tx);

      const resolved = await commandRepository.resolveCommand(
        command.id,
        { status: "success", ackReceived: true, detail: "ACK" },
        tx,
      );

      expect(resolved?.status).toBe("success");
      expect(resolved?.ackReceived).toBe(true);
      expect(resolved?.detail).toBe("ACK");
      expect(resolved?.resolvedAt).not.toBeNull();
    });

    it("resolves a pending command as a timeout", async () => {
      const command = await commandRepository.createGatewayCommand("I2C_PROBE:0x27", tx);

      const resolved = await commandRepository.resolveCommand(
        command.id,
        { status: "timeout", ackReceived: false, detail: "No ACK within 5000ms." },
        tx,
      );

      expect(resolved?.status).toBe("timeout");
      expect(resolved?.ackReceived).toBe(false);
    });

    it("refuses to resolve an already-resolved command, so a late ACK cannot overwrite a timeout", async () => {
      // The exact race the `status = 'pending'` guard exists for: both the
      // timeout timer and the line handler can reach here, and whichever
      // loses must not rewrite the winner's record.
      const command = await commandRepository.createGatewayCommand("I2C_PROBE:0x27", tx);
      await commandRepository.resolveCommand(
        command.id,
        { status: "timeout", ackReceived: false, detail: "No ACK within 5000ms." },
        tx,
      );

      const lateAck = await commandRepository.resolveCommand(
        command.id,
        { status: "success", ackReceived: true, detail: "ACK" },
        tx,
      );

      expect(lateAck).toBeNull();
      const stored = await commandRepository.getCommandById(command.id, tx);
      expect(stored?.status).toBe("timeout");
      expect(stored?.ackReceived).toBe(false);
    });

    it("returns null when resolving a command that does not exist", async () => {
      const resolved = await commandRepository.resolveCommand(
        "does-not-exist",
        { status: "failure", ackReceived: false, detail: null },
        tx,
      );
      expect(resolved).toBeNull();
    });

    it("round-trips a command through getCommandById unchanged", async () => {
      const created = await commandRepository.createGatewayCommand("LCD_SCAN", tx);
      const fetched = await commandRepository.getCommandById(created.id, tx);
      expect(fetched).toEqual(created);
    });

    it("returns null from getCommandById for an unknown id", async () => {
      expect(await commandRepository.getCommandById("does-not-exist", tx)).toBeNull();
    });
  });
});
