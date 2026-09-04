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
//
// The browser's bounds block is here for the same reason its numbers are: 12.10's
// claims about it are claims about the DECLARATION — that it is total over the
// declared set, that the payload ceilings are the contract's own constant rather
// than a copy of its digits, and that a ceiling this console does not set names its
// owner — and none of them is about what `browser/BudgetMeter.tsx` puts on screen.

import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  APPLY_COALESCE_MS,
  BROWSER_BOUNDS,
  BROWSER_BOUND_NAMES,
  CAST_BAR_CHIP_CAP,
  LIVE_ANNOUNCEMENT_HOLD_MS,
  LIVE_ANNOUNCEMENT_QUEUE_CAP,
  MAX_REPAIRABLE_SEQUENCE_GAP,
  PALETTE_RECENTS_CAP,
  PALETTE_RESULT_CAP,
  PERSISTENCE_QUOTA_PRESSURE_RATIO,
  PERSISTENCE_RECORD_BYTE_CAP,
  PERSISTENCE_SESSION_PARTITION_CAP,
  PRE_INITIALISATION_BUFFER_CAP,
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
  ["PERSISTENCE_RECORD_BYTE_CAP", PERSISTENCE_RECORD_BYTE_CAP],
  ["PALETTE_RECENTS_CAP", PALETTE_RECENTS_CAP],
  ["PALETTE_RESULT_CAP", PALETTE_RESULT_CAP],
  ["WHEN_CLAUSE_MAX_DEPTH", WHEN_CLAUSE_MAX_DEPTH],
  ["CAST_BAR_CHIP_CAP", CAST_BAR_CHIP_CAP],
  ["TRIPWIRE_REPORT_CAP", TRIPWIRE_REPORT_CAP],
  ["SCENARIO_PENDING_REPLY_CAP", SCENARIO_PENDING_REPLY_CAP],
  ["PRE_INITIALISATION_BUFFER_CAP", PRE_INITIALISATION_BUFFER_CAP],
  ["MAX_REPAIRABLE_SEQUENCE_GAP", MAX_REPAIRABLE_SEQUENCE_GAP],
  ["LIVE_ANNOUNCEMENT_QUEUE_CAP", LIVE_ANNOUNCEMENT_QUEUE_CAP],
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

describe("console bounds — the live announcer's hold window", () => {
  it("holds a message for longer than the console calls one frame", () => {
    // A live region whose text is set and reverted inside a frame announces
    // nothing: the observer never sees a settled string. `APPLY_COALESCE_MS` is
    // this console's own name for one frame, so the hold has to sit above it, and
    // the relation is what says so rather than 500 happening to be bigger than 16.
    expect(LIVE_ANNOUNCEMENT_HOLD_MS).toBeGreaterThan(APPLY_COALESCE_MS);
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

describe("console bounds — the two sequence bounds describe one store", () => {
  it("repairs a gap at least as wide as the pre-initialisation buffer can shed", () => {
    // A store whose read never lands sheds its oldest buffered events, and the
    // drain re-derives that loss as one gap. At or below the buffer's own cap the
    // ordinary overflow path would report the stream DIVERGED — refusing the very
    // events the buffer kept — so the repairable bound has to sit above it, and
    // the relation is what says so rather than the two numbers happening to.
    expect(MAX_REPAIRABLE_SEQUENCE_GAP).toBeGreaterThan(PRE_INITIALISATION_BUFFER_CAP);
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

describe("BROWSER_BOUNDS", () => {
  it("carries every declared bound, exactly once, with a derivation for each", () => {
    expect(new Set(BROWSER_BOUND_NAMES).size).toBe(BROWSER_BOUND_NAMES.length);
    for (const name of BROWSER_BOUND_NAMES) {
      expect(BROWSER_BOUNDS[name].derivation.length).toBeGreaterThan(0);
    }
    expect(Object.keys(BROWSER_BOUNDS)).toHaveLength(BROWSER_BOUND_NAMES.length);
  });

  it("takes the three payload ceilings from the contract rather than restating them", () => {
    // A locally typed 262144 would be a second copy of a number the daemon enforces,
    // and it would still read as correct on the day the contract moved.
    for (const name of [
      "SNAPSHOT_TEXT_MAX",
      "EVALUATE_RESULT_MAX",
      "LOCATOR_RESULT_MAX",
    ] as const) {
      const measure = BROWSER_BOUNDS[name].measure;
      expect(measure.kind).toBe("scalar");
      if (measure.kind !== "scalar") {
        throw new Error("unreachable");
      }
      expect(measure.value).toBe(CONTENT_PAYLOAD_PLAINTEXT_MAX);
    }
  });

  it("names an owner for every ceiling it does not itself set", () => {
    for (const name of BROWSER_BOUND_NAMES) {
      const measure = BROWSER_BOUNDS[name].measure;
      if (measure.kind === "deferred") {
        expect(measure.owner.length).toBeGreaterThan(0);
      }
    }
  });
});
