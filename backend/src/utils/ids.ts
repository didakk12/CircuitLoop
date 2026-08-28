/**
 * Node's built-in UUID generator, used for every node's `id` property
 * (BACKEND_IMPLEMENTATION_PLAN.md §5.5). No extra dependency needed —
 * `crypto.randomUUID()` has been available in Node since 14.17.
 */

import { randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}
