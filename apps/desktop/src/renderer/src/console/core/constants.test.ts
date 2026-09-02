// The named bounds, held to what their own rationales claim.
//
// A constants module looks untestable — the value IS the assertion — and that
// reading is what lets a bound drift into a value its comment no longer describes.
// The checkable content is not the numbers but the RELATIONS between them: several
// of these bounds are only meaningful relative to another, and when the relation
// inverts the mechanism does not fail loudly, it quietly stops existing. A debounce
// at or above its own absolute deadline makes the deadline unreachable; a
// coalescing window wider than the debounce coalesces across the read it feeds; a
// recents cap above the result cap promises rows the list will never render.
//
// So this file states each relation once, next to the reason it holds.

import { describe, expect, it } from "vitest";
import {
  APPLY_COALESCE_MS,
  CAST_BAR_CHIP_CAP,
  PALETTE_RECENTS_CAP,
  PALETTE_RESULT_CAP,
  PERSISTENCE_QUOTA_PRESSURE_RATIO,
  PERSISTENCE_SESSION_PARTITION_CAP,
  PERSISTENCE_VALUE_BYTE_CAP,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
  SCENARIO_PENDING_REPLY_CAP,
  SCENARIO_TICK_MS,
  TRIPWIRE_REPORT_CAP,
  WHEN_CLAUSE_MAX_DEPTH,
} from "./constants.js";

/** Every bound that counts whole things. A fractional or zero cap counts nothing. */
const COUNTING_BOUNDS: readonly (readonly [string, number])[] = [
  ["PERSISTENCE_SESSION_PARTITION_CAP", PERSISTENCE_SESSION_PARTITION_CAP],
  ["PERSISTENCE_VALUE_BYTE_CAP", PERSISTENCE_VALUE_BYTE_CAP],
  ["PALETTE_RECENTS_CAP", PALETTE_RECENTS_CAP],
  ["PALETTE_RESULT_CAP", PALETTE_RESULT_CAP],
  ["WHEN_CLAUSE_MAX_DEPTH", WHEN_CLAUSE_MAX_DEPTH],
  ["CAST_BAR_CHIP_CAP", CAST_BAR_CHIP_CAP],
  ["TRIPWIRE_REPORT_CAP", TRIPWIRE_REPORT_CAP],
  ["SCENARIO_PENDING_REPLY_CAP", SCENARIO_PENDING_REPLY_CAP],
];

function isWholeCount(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

describe("console bounds — every cap counts whole things", () => {
  for (const [name, value] of COUNTING_BOUNDS) {
    it(`${name} is a positive integer`, () => {
      // Zero disables the mechanism the cap names; a fraction makes "the 8th chip"
      // a comparison no renderer can act on.
      expect(isWholeCount(value), `${name} is ${String(value)}`).toBe(true);
    });
  }

  it("negative control: the predicate rejects the values it is meant to catch", () => {
    // Without this, a predicate that returned true unconditionally would pass every
    // case above over any value at all.
    expect(isWholeCount(0)).toBe(false);
    expect(isWholeCount(-1)).toBe(false);
    expect(isWholeCount(8.5)).toBe(false);
    expect(isWholeCount(Number.NaN)).toBe(false);
  });
});

describe("console bounds — the refresh scheduler's two windows", () => {
  it("keeps the trailing debounce strictly inside the absolute deadline", () => {
    // The scheduler fires at `min(lastEvent + DEBOUNCE, firstEvent + MAX_WAIT)`. At
    // or above the deadline the debounce always wins that `min`, and the starvation
    // guard the deadline exists to be stops existing without any code changing.
    expect(REFRESH_DEBOUNCE_MS).toBeLessThan(REFRESH_MAX_WAIT_MS);
  });

  it("keeps the apply-coalescing window no wider than the debounce", () => {
    // Coalescing folds a burst into one notification for the read the debounce then
    // schedules. A window wider than the debounce would fold across that read, so
    // the render the burst caused would show the state before it.
    expect(APPLY_COALESCE_MS).toBeLessThanOrEqual(REFRESH_DEBOUNCE_MS);
  });

  it("keeps every millisecond bound positive", () => {
    expect(REFRESH_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(REFRESH_MAX_WAIT_MS).toBeGreaterThan(0);
    expect(APPLY_COALESCE_MS).toBeGreaterThan(0);
  });
});

describe("console bounds — the palette's two caps describe one list", () => {
  it("does not remember more commands than the list can show", () => {
    // Recents are rendered inside the ranked result list. A recents cap above the
    // result cap would remember rows that are unreachable by construction.
    expect(PALETTE_RECENTS_CAP).toBeLessThanOrEqual(PALETTE_RESULT_CAP);
  });
});

describe("console bounds — the fixture tick names one frame", () => {
  it("is longer than the coalescing window", () => {
    // A tick inside the coalescing window would fold two scenario ticks into one
    // notification, and a frozen tick would stop naming one exact frame — which is
    // the whole property the screenshot target's byte-stability rests on.
    expect(SCENARIO_TICK_MS).toBeGreaterThan(APPLY_COALESCE_MS);
  });

  it("is a whole number of milliseconds, because scripts are expressed in whole ticks", () => {
    expect(Number.isInteger(SCENARIO_TICK_MS)).toBe(true);
  });
});

describe("console bounds — the storage pressure gauge", () => {
  it("reports pressure before the quota is gone rather than at the moment it is", () => {
    // At 1 the gauge fires only once writing has already failed, which is a report
    // with nothing left to report about; at 0 it is always in pressure and the
    // operator learns to ignore it.
    expect(PERSISTENCE_QUOTA_PRESSURE_RATIO).toBeGreaterThan(0);
    expect(PERSISTENCE_QUOTA_PRESSURE_RATIO).toBeLessThan(1);
  });
});
