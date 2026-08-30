/**
 * Data access for (:Command) nodes — the durable record of what was sent to
 * the ESP32 gateway and what came back.
 *
 * Commands come in two kinds, which is why creation is two functions rather
 * than one with a nullable argument:
 *
 *   - **Gateway probes** (`componentId: null`) — the automatic connect probe
 *     and heartbeat. They are about the link itself, belong to no component
 *     and therefore to no user, and are created as standalone nodes with no
 *     `HAS_COMMAND` edge. There is nothing to scope them by, and inventing an
 *     owner for them would be a lie.
 *   - **Component actions** (`componentId` set) — created only through
 *     `POST /api/hardware/action` with a `component_id`, and scoped through
 *     `(:User)-[:OWNS]->(:Component)` exactly like every other component-
 *     attached write in this codebase, so a user can never aim a command at
 *     someone else's component.
 *
 * `componentId` is stored on the node as well as being implied by the edge —
 * see the `command_component_id_index` in `db/schema.ts` for why.
 */

import neo4j, { type Node } from "neo4j-driver";

import { toIsoString, toNullableIsoString } from "../db/mappers.js";
import { readQuery, writeQuery, type QueryRunner } from "../db/session.js";
import type { Command, CommandStatus } from "../types/entities.js";
import { newId } from "../utils/ids.js";

/** How a pending command is resolved once the board answers, stays silent, or the link drops. */
export interface CommandResolution {
  status: Exclude<CommandStatus, "pending">;
  ackReceived: boolean;
  /** The board's raw response line, or the reason it never arrived. */
  detail: string | null;
}

function mapCommandNode(node: Node): Command {
  const p = node.properties;
  return {
    id: String(p["id"]),
    action: String(p["action"]),
    status: p["status"] as CommandStatus,
    sentAt: toIsoString(p["sentAt"]),
    resolvedAt: toNullableIsoString(p["resolvedAt"]),
    ackReceived: p["ackReceived"] === true,
    detail: p["detail"] === null || p["detail"] === undefined ? null : String(p["detail"]),
    componentId: p["componentId"] === null || p["componentId"] === undefined ? null : String(p["componentId"]),
  };
}

/**
 * Records a gateway-level probe as `pending`. Never fails on ownership —
 * there is none.
 *
 * Properties that are conceptually "not set yet" (`resolvedAt`, `detail`) are
 * written as explicit nulls, which Neo4j stores as absent properties; the
 * mapper reads absent and null identically, so a command's shape is the same
 * before and after resolution.
 */
export async function createGatewayCommand(action: string, runner?: QueryRunner): Promise<Command> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ cmd: Node }>(
      `CREATE (cmd:Command {
         id: $id, action: $action, status: 'pending', sentAt: datetime(),
         resolvedAt: null, ackReceived: false, detail: null, componentId: null
       })
       RETURN cmd`,
      { id: newId(), action },
    );
    const record = result.records[0];
    if (record === undefined) {
      // A bare CREATE with no preceding MATCH always produces a row; if it
      // somehow didn't, silently returning null would strand the state
      // machine waiting on a command that was never recorded.
      throw new Error("Failed to create gateway command node.");
    }
    return mapCommandNode(record.get("cmd"));
  });
}

/**
 * Records a component-targeted command as `pending`, linked to its component
 * by `HAS_COMMAND`.
 *
 * Returns `null` if `componentId` doesn't reference a component owned by
 * `ownerId` — the same "repositories return null, services translate to
 * NotFoundError" split the rest of the repository layer uses, and the same
 * reason ownership failures are indistinguishable from missing rows.
 */
export async function createComponentCommand(
  action: string,
  componentId: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<Command | null> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ cmd: Node }>(
      `MATCH (:User {id: $ownerId})-[:OWNS]->(c:Component {id: $componentId})
       CREATE (cmd:Command {
         id: $id, action: $action, status: 'pending', sentAt: datetime(),
         resolvedAt: null, ackReceived: false, detail: null, componentId: $componentId
       })
       CREATE (c)-[:HAS_COMMAND]->(cmd)
       RETURN cmd`,
      { id: newId(), action, componentId, ownerId },
    );
    const record = result.records[0];
    return record ? mapCommandNode(record.get("cmd")) : null;
  });
}

/**
 * Resolves a still-pending command.
 *
 * The `status = 'pending'` guard is load-bearing, not defensive noise: an ACK
 * arriving in the same tick its timeout fires is a genuine race, and both
 * paths call this. Whichever lands first wins and the loser gets `null`,
 * so a late ACK can never rewrite a command already recorded as a timeout
 * (nor the reverse). Callers treat `null` as "someone else already resolved
 * this", not as an error.
 */
export async function resolveCommand(
  commandId: string,
  resolution: CommandResolution,
  runner?: QueryRunner,
): Promise<Command | null> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ cmd: Node }>(
      `MATCH (cmd:Command {id: $commandId})
       WHERE cmd.status = 'pending'
       SET cmd.status = $status,
           cmd.ackReceived = $ackReceived,
           cmd.detail = $detail,
           cmd.resolvedAt = datetime()
       RETURN cmd`,
      { commandId, ...resolution },
    );
    const record = result.records[0];
    return record ? mapCommandNode(record.get("cmd")) : null;
  });
}

/** One command by id, regardless of kind. `null` if it doesn't exist. */
export async function getCommandById(commandId: string, runner?: QueryRunner): Promise<Command | null> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ cmd: Node }>(
      `MATCH (cmd:Command {id: $commandId}) RETURN cmd`,
      { commandId },
    );
    const record = result.records[0];
    return record ? mapCommandNode(record.get("cmd")) : null;
  });
}

/**
 * Every command aimed at a component the user owns, newest first. Empty
 * array if the component exists but has no commands — and also if it isn't
 * theirs, which is the intended indistinguishability.
 */
export async function listCommandsForComponent(
  componentId: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<Command[]> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ cmd: Node }>(
      `MATCH (:User {id: $ownerId})-[:OWNS]->(:Component {id: $componentId})-[:HAS_COMMAND]->(cmd:Command)
       RETURN cmd
       ORDER BY cmd.sentAt DESC`,
      { componentId, ownerId },
    );
    return result.records.map((record) => mapCommandNode(record.get("cmd")));
  });
}

/**
 * The most recent gateway-level probes, newest first — the link's own
 * history, independent of any component. Backed by
 * `command_component_id_index`.
 */
export async function listRecentGatewayCommands(
  limit: number,
  runner?: QueryRunner,
): Promise<Command[]> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ cmd: Node }>(
      `MATCH (cmd:Command)
       WHERE cmd.componentId IS NULL
       RETURN cmd
       ORDER BY cmd.sentAt DESC
       LIMIT $limit`,
      // `neo4j.int`, not a bare JS number: the driver maps every JS `number`
      // to a Cypher Float, and LIMIT requires an Integer — so an unwrapped
      // value is rejected at plan time even when it holds a whole number.
      { limit: neo4j.int(Math.trunc(limit)) },
    );
    return result.records.map((record) => mapCommandNode(record.get("cmd")));
  });
}
