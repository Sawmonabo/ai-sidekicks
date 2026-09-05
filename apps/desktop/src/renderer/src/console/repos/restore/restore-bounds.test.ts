// The restore enumerations' bounds, held to what a count has to be and to each other.
//
// `core/constants.test.ts` asserted the relation cases while the three lived there, and
// its `COUNTING_BOUNDS` list asserted they were whole positive counts. Both move here
// with the bounds, so nothing that was checked stops being checked by the move — and
// the derived height, which that module could not see at all, is checked here too.

import { describe, expect, it } from "vitest";

import {
  RESTORE_PATH_ROW_HEIGHT_PX,
  RESTORE_PATH_VIRTUALIZATION_THRESHOLD,
  RESTORE_PATH_VISIBLE_ROW_CAP,
  RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX,
} from "./restore-bounds.js";

const COUNTING_BOUNDS: readonly (readonly [string, number])[] = [
  ["RESTORE_PATH_VIRTUALIZATION_THRESHOLD", RESTORE_PATH_VIRTUALIZATION_THRESHOLD],
  ["RESTORE_PATH_VISIBLE_ROW_CAP", RESTORE_PATH_VISIBLE_ROW_CAP],
  ["RESTORE_PATH_ROW_HEIGHT_PX", RESTORE_PATH_ROW_HEIGHT_PX],
  ["RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX", RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX],
];

describe("the restore enumerations' bounds — every one counts whole things", () => {
  for (const [name, value] of COUNTING_BOUNDS) {
    it(`${name} is a whole positive count`, () => {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    });
  }

  it("negative control: the same check fails on a fraction, a negative, and zero", () => {
    for (const candidate of [12.5, -12, 0]) {
      expect(Number.isInteger(candidate) && candidate > 0).toBe(false);
    }
  });
});

describe("the restore enumerations' bounds — the four describe one list", () => {
  it("windows only an enumeration longer than the window would show", () => {
    // Below the threshold the whole list is shorter than the container, so windowing
    // would add a scrollbar and a focus stop and remove no node. A threshold at or
    // under the visible-row cap would make the scroll container decorative.
    expect(RESTORE_PATH_VIRTUALIZATION_THRESHOLD).toBeGreaterThan(RESTORE_PATH_VISIBLE_ROW_CAP);
  });

  it("keeps the window shorter than the enumeration that opens it", () => {
    // The height cap is the row height times the visible-row cap, and the point of it
    // is that a threshold-length enumeration does not fit: if it did, the first
    // windowed list would render whole and the window would never be exercised.
    const thresholdListHeightPx =
      RESTORE_PATH_VIRTUALIZATION_THRESHOLD * RESTORE_PATH_ROW_HEIGHT_PX;
    expect(RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX).toBeLessThan(thresholdListHeightPx);
  });
});
