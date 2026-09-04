// The durable seam, driven from both ends.
//
// The model's own tests round-trip these through a real `UiStateStore`, which is
// what proves the value classes accept what is written. What they cannot reach is
// the arm that matters most here: a record written by a DIFFERENT build of this
// console. That record is ordinary input — the store validated its value class,
// not its meaning — so every case below hands the decoder something a past or
// future build could plausibly have left behind.

import { describe, expect, it } from "vitest";

import { SIDEBAR_SECTION_IDS } from "../../seats/index.js";
import {
  decodeCollapsedSectionIds,
  decodeSidebarWidth,
  encodeCollapsedSectionIds,
  encodeSidebarWidth,
} from "./sidebar-persistence.js";

describe("the collapsed set", () => {
  it("round-trips what this build wrote", () => {
    const written = new Set(["runs", "members"] as const);
    expect(decodeCollapsedSectionIds(encodeCollapsedSectionIds(written))).toStrictEqual(written);
  });

  it("writes the same bytes for the same set whatever order it was built in", () => {
    // A store that compares bytes must not record a change nobody made.
    expect(encodeCollapsedSectionIds(new Set(["runs", "agents"] as const))).toStrictEqual(
      encodeCollapsedSectionIds(new Set(["agents", "runs"] as const)),
    );
  });

  it("drops an id this build does not know", () => {
    // A section retired since the record was written. Keeping it would hold a
    // section shut that no disclosure in this build can re-open.
    expect(decodeCollapsedSectionIds(["runs", "telemetry"])).toStrictEqual(new Set(["runs"]));
  });

  it("answers `undefined` for a value that is not a stored set at all", () => {
    // `undefined` rather than an empty set, which would be the false claim that
    // the person shut nothing — the model reads the two differently.
    expect(decodeCollapsedSectionIds(undefined)).toBeUndefined();
    expect(decodeCollapsedSectionIds({ collapsed: [...SIDEBAR_SECTION_IDS] })).toBeUndefined();
  });

  it("negative control: an empty stored array is a set, not an absence", () => {
    // Without this the case above would pass over a decoder that answered
    // `undefined` for everything falsy, losing "the person opened all six".
    expect(decodeCollapsedSectionIds([])).toStrictEqual(new Set());
  });
});

describe("the width", () => {
  it("round-trips what this build wrote", () => {
    expect(decodeSidebarWidth(encodeSidebarWidth(321))).toBe(321);
  });

  it("answers `undefined` rather than a bound for a value it cannot read", () => {
    // The bounds are the model's; a decoder that substituted one would be a
    // second place they live, and a stored width outside them would come back
    // silently changed rather than clamped where the rule is stated.
    expect(decodeSidebarWidth({ sidebar: { widthPx: "wide" } })).toBeUndefined();
    expect(decodeSidebarWidth({ sidebar: {} })).toBeUndefined();
    expect(decodeSidebarWidth({ deck: { widthPx: 300 } })).toBeUndefined();
    expect(decodeSidebarWidth(null)).toBeUndefined();
    expect(decodeSidebarWidth(Number.NaN)).toBeUndefined();
  });

  it("passes an out-of-bounds stored width through untouched", () => {
    // Stated rather than implied: this is what "nothing here applies a bound"
    // means, and the model's own restore case is what proves it gets clamped.
    expect(decodeSidebarWidth({ sidebar: { widthPx: 100_000 } })).toBe(100_000);
  });
});
