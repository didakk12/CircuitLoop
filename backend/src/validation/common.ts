/**
 * Shared zod enum schemas for the domain value types in `types/entities.ts`.
 * Single source of truth so every request schema validates against the same
 * literal lists instead of repeating them.
 */

import { z } from "zod";

// Kept in sync with types/entities.ts's ComponentType union — see that
// file's comment for why battery/buzzer/display/relay/switch were added.
export const componentTypeSchema = z.enum([
  "resistor",
  "capacitor",
  "led",
  "diode",
  "transistor",
  "ic",
  "microcontroller",
  "battery",
  "buzzer",
  "display",
  "relay",
  "switch",
  "unknown",
]);

export const componentConditionSchema = z.enum(["good", "damaged", "uncertain", "unknown"]);

export const salvagePrioritySchema = z.enum(["high", "medium", "low"]);

export const componentStatusSchema = z.enum(["not_tested", "pass", "fail"]);

/** A non-empty UUID-shaped string identifier (Neo4j node `id` property). */
export const idParamSchema = z.string().min(1, "id must not be empty");
