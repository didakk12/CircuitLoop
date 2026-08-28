/**
 * (:User) persistence. Mirrors the existing repository conventions in this
 * directory: thin Cypher, `newId()` for ids, `datetime()` for timestamps,
 * mapping via db/mappers.ts, and an optional `QueryRunner` so callers can
 * enlist these in a wider transaction.
 *
 * Emails are stored lower-cased so uniqueness is genuinely case-insensitive —
 * the unique constraint in db/schema.ts compares raw strings, so without
 * normalising here "A@b.com" and "a@b.com" would be two separate accounts.
 */

import type { Node } from "neo4j-driver";

import { mapUserNode } from "../db/mappers.js";
import { readQuery, writeQuery, type QueryRunner } from "../db/session.js";
import type { User } from "../types/entities.js";
import { newId } from "../utils/ids.js";

export interface CreateUserInput {
  email: string;
  passwordHash: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function create(input: CreateUserInput, runner?: QueryRunner): Promise<User> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ u: Node }>(
      `CREATE (u:User {
         id: $id,
         email: $email,
         passwordHash: $passwordHash,
         createdAt: datetime()
       })
       RETURN u`,
      { id: newId(), email: normalizeEmail(input.email), passwordHash: input.passwordHash },
    );
    const record = result.records[0];
    if (!record) {
      throw new Error("Failed to create user: no record returned");
    }
    return mapUserNode(record.get("u"));
  });
}

export async function findByEmail(email: string, runner?: QueryRunner): Promise<User | null> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ u: Node }>("MATCH (u:User {email: $email}) RETURN u", {
      email: normalizeEmail(email),
    });
    const record = result.records[0];
    return record ? mapUserNode(record.get("u")) : null;
  });
}

export async function findById(id: string, runner?: QueryRunner): Promise<User | null> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ u: Node }>("MATCH (u:User {id: $id}) RETURN u", { id });
    const record = result.records[0];
    return record ? mapUserNode(record.get("u")) : null;
  });
}
