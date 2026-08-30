/**
 * The pricing heuristic is pure — no database, no settings, no clock — so it
 * can be swept exhaustively over its entire input domain rather than spot
 * checked. That exhaustiveness is the point of the test: the invariants below
 * (always finite, always above the floor, damaged always cheaper than good)
 * must hold for *every* ComponentType x ComponentCondition pair, including
 * types added to the union later.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CURRENCY, estimatePrice } from "../src/services/pricingHeuristic.js";
import type { ComponentCondition, ComponentType } from "../src/types/entities.js";

const ALL_TYPES: ComponentType[] = [
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
];

const ALL_CONDITIONS: ComponentCondition[] = ["good", "damaged", "uncertain", "unknown"];

describe("estimatePrice", () => {
  it("returns a finite, positive, cent-rounded price for every type x condition pair", () => {
    for (const type of ALL_TYPES) {
      for (const condition of ALL_CONDITIONS) {
        const price = estimatePrice(type, condition);

        expect(Number.isFinite(price), `${type}/${condition} must be finite`).toBe(true);
        expect(price, `${type}/${condition} must be above zero`).toBeGreaterThan(0);
        // No listing may ever render as free — that reads as broken software
        // rather than as a cheap part.
        expect(price, `${type}/${condition} must respect the price floor`).toBeGreaterThanOrEqual(0.25);
        // Whole cents only: a price like 0.30000000000000004 would reach the UI.
        expect(Math.round(price * 100), `${type}/${condition} must be cent-rounded`).toBeCloseTo(price * 100, 9);
      }
    }
  });

  it("is deterministic — the same inputs always produce the same price", () => {
    for (const type of ALL_TYPES) {
      for (const condition of ALL_CONDITIONS) {
        expect(estimatePrice(type, condition)).toBe(estimatePrice(type, condition));
      }
    }
  });

  it("never prices a damaged part above the same part in good condition", () => {
    for (const type of ALL_TYPES) {
      expect(estimatePrice(type, "damaged")).toBeLessThanOrEqual(estimatePrice(type, "good"));
    }
  });

  it("treats uncertain and unknown identically — neither has been verified", () => {
    for (const type of ALL_TYPES) {
      expect(estimatePrice(type, "uncertain")).toBe(estimatePrice(type, "unknown"));
    }
  });

  it("prices board-level parts above passives", () => {
    // Not an arbitrary assertion: the whole reason for a per-type table rather
    // than a flat price is that a salvaged microcontroller and a salvaged
    // resistor are not worth the same, and a regression flattening the table
    // would otherwise pass every test above.
    expect(estimatePrice("microcontroller", "good")).toBeGreaterThan(estimatePrice("resistor", "good"));
    expect(estimatePrice("display", "good")).toBeGreaterThan(estimatePrice("capacitor", "good"));
  });

  it("prices an unidentified part at the floor of what it might turn out to be", () => {
    expect(estimatePrice("unknown", "good")).toBeLessThan(estimatePrice("ic", "good"));
  });

  it("denominates estimates in a 3-letter currency code", () => {
    expect(DEFAULT_CURRENCY).toMatch(/^[A-Z]{3}$/);
  });
});
