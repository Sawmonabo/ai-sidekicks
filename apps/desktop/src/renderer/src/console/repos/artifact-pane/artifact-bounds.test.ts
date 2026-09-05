// The artifact pane's bounds, held to what a count has to be.
//
// `core/constants.test.ts` asserts this over every bound that module holds, through
// its `COUNTING_BOUNDS` list. This bound was in neither that list nor a relation case
// while it lived there, so nothing asserted it was a whole positive count at all —
// the gap this file closes as the bound moves to the family that spends it.

import { describe, expect, it } from "vitest";

import { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP } from "./artifact-bounds.js";

describe("the artifact pane's bounds", () => {
  it("counts characters, so it is a whole positive number", () => {
    // Spent as `text.slice(0, cap)` and compared against `text.length`, both of which
    // silently do something else for a fraction or a negative: a fractional cap slices
    // at a rounded index the disclosure never names, and a negative one counts back
    // from the end and previews the payload's TAIL while reporting its head.
    expect(Number.isInteger(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP)).toBe(true);
    expect(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP).toBeGreaterThan(0);
  });

  it("negative control: the same check fails on a fraction and on a negative", () => {
    for (const candidate of [2_000.5, -2_000, 0]) {
      expect(Number.isInteger(candidate) && candidate > 0).toBe(false);
    }
  });
});
