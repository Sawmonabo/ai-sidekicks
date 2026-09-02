// The wrap over the panel library's crossed separator range.
//
// The assertion that matters is the NEGATIVE one: a predicate that answered "these
// are in order" over a document where they are not would make the whole patch
// decorative, and the swap is invisible on screen — a screen reader announces a
// range nobody looking at the deck can see is wrong. So every case below drives the
// real predicate over a document it can be shown to reject.

import { describe, expect, it } from "vitest";

import {
  correctSeparatorValueBounds,
  readSeparatorValueBounds,
  separatorValueBoundsAreOrdered,
} from "./separator-aria.js";

/** A group holding `ranges.length` separators, each announcing one min/max pair. */
function groupWithSeparators(ranges: readonly (readonly [number, number])[]): HTMLElement {
  const group = document.createElement("div");
  for (const [valueMin, valueMax] of ranges) {
    const separator = document.createElement("div");
    separator.setAttribute("data-separator", "default");
    separator.setAttribute("role", "separator");
    separator.setAttribute("aria-valuemin", String(valueMin));
    separator.setAttribute("aria-valuemax", String(valueMax));
    group.append(separator);
  }
  return group;
}

describe("reading a separator's announced range", () => {
  it("reads the two numbers off the element", () => {
    const group = groupWithSeparators([[10, 90]]);
    const separator = group.firstElementChild;
    expect(separator).not.toBeNull();
    expect(readSeparatorValueBounds(separator as Element)).toStrictEqual({
      valueMin: 10,
      valueMax: 90,
    });
  });

  it("negative control: a separator that announces no range reads as absent", () => {
    // Without this, a missing attribute would read as 0 and every ordering check
    // would pass on a separator that announces nothing at all.
    const separator = document.createElement("div");
    expect(readSeparatorValueBounds(separator)).toBeUndefined();
  });
});

describe("the ordering predicate", () => {
  it("holds over a group whose separators announce ranges the right way round", () => {
    expect(
      separatorValueBoundsAreOrdered(
        groupWithSeparators([
          [10, 90],
          [20, 80],
        ]),
      ),
    ).toBe(true);
  });

  it("FAILS when the swap is simulated — the whole reason the wrap exists", () => {
    // This is upstream issue #740 reproduced by hand: at the pinned 4.12.3 every
    // separator after the first announces its minimum above its maximum. If this
    // case ever passes, the predicate has stopped being able to see the defect and
    // the clean assertion above means nothing.
    const swapped = groupWithSeparators([
      [10, 90],
      [80, 20],
    ]);
    expect(separatorValueBoundsAreOrdered(swapped)).toBe(false);
  });
});

describe("the correction", () => {
  it("puts a crossed range back the right way round and counts what it touched", () => {
    const swapped = groupWithSeparators([
      [10, 90],
      [80, 20],
    ]);
    expect(correctSeparatorValueBounds(swapped)).toBe(1);
    expect(separatorValueBoundsAreOrdered(swapped)).toBe(true);
    const corrected = swapped.lastElementChild;
    expect(corrected?.getAttribute("aria-valuemin")).toBe("20");
    expect(corrected?.getAttribute("aria-valuemax")).toBe("80");
  });

  it("negative control: a group with nothing crossed is left alone entirely", () => {
    // Without this the correction could be swapping every separator it sees, which
    // would introduce the defect on the one separator that never had it.
    const ordered = groupWithSeparators([
      [10, 90],
      [20, 80],
    ]);
    expect(correctSeparatorValueBounds(ordered)).toBe(0);
    expect(ordered.firstElementChild?.getAttribute("aria-valuemin")).toBe("10");
  });
});
