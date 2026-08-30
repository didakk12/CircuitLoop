/**
 * Price estimation for a salvaged component — a lookup table, not a valuation.
 *
 * Pure and dependency-free on purpose: no database, no `settings`, no clock, no
 * network. It is a base price per `ComponentType` scaled by a `ComponentCondition`
 * multiplier, so every input pair has one deterministic answer that can be
 * exhaustively tested.
 *
 * The number this produces is a *starting point the seller edits*, and the
 * generated description says so in as many words. It is never presented as a
 * quote, an appraisal, or a market rate — nothing here has seen a real
 * marketplace, and the price stays editable right up until publish.
 */

import type { ComponentCondition, ComponentType } from "../types/entities.js";

/** Currency the base prices below are denominated in. */
export const DEFAULT_CURRENCY = "USD";

/**
 * Base price for a working, salvaged unit, by type.
 *
 * The ordering reflects salvage reality rather than retail price: passives are
 * worth pennies individually, while a board-level part (microcontroller,
 * display, relay) carries most of the value. `unknown` is deliberately the
 * floor — an unidentified part cannot be advertised as worth more than the
 * cheapest thing it might turn out to be.
 *
 * `Record<ComponentType, number>` (not a partial) so adding a member to the
 * `ComponentType` union is a compile error here rather than a silent
 * fallthrough to some default.
 */
const BASE_PRICE_BY_TYPE: Record<ComponentType, number> = {
  resistor: 0.25,
  capacitor: 0.5,
  led: 0.35,
  diode: 0.3,
  transistor: 0.6,
  ic: 2.5,
  microcontroller: 6,
  battery: 3,
  buzzer: 1.5,
  display: 8,
  relay: 2,
  switch: 1.25,
  unknown: 0.5,
};

/**
 * Condition multiplier.
 *
 * `damaged` is 0.1 rather than 0: a damaged part still has salvage value (a
 * donor for pins, a housing, a case study), and pricing it at zero would render
 * a $0.00 listing, which reads as broken software rather than as a cheap part.
 * `uncertain` and `unknown` sit at the same 0.5: neither has been verified, and
 * distinguishing "we looked and weren't sure" from "we never looked" would be a
 * confidence the detector has not earned.
 */
const CONDITION_MULTIPLIER: Record<ComponentCondition, number> = {
  good: 1,
  damaged: 0.1,
  uncertain: 0.5,
  unknown: 0.5,
};

/** The lowest price any listing may carry, so no estimate ever renders as free. */
const MINIMUM_PRICE = 0.25;

/**
 * Estimated asking price for one component, rounded to whole cents.
 *
 * Always at least {@link MINIMUM_PRICE}, and always a finite positive number —
 * a listing showing `0` or `NaN` would be a bug the user sees.
 */
export function estimatePrice(type: ComponentType, condition: ComponentCondition): number {
  const base = BASE_PRICE_BY_TYPE[type];
  const multiplier = CONDITION_MULTIPLIER[condition];
  const raw = base * multiplier;
  return Math.max(MINIMUM_PRICE, Math.round(raw * 100) / 100);
}
