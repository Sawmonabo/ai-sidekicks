// The deck's width arithmetic, checked without constructing a layout.
//
// The claim under test is the one `normalise` makes in its own name: whatever was on
// disk, the row it returns sums to a whole deck. Rounding each pane independently
// does not give that — three equal saved widths round to `333 + 333 + 333 = 999` —
// and the widths come from the explicitly untrusted persisted snapshot, so the
// shortfall reaches the panel group as an incomplete layout rather than staying
// theoretical. Every case below asserts the exact sum, which is what fails on the
// arithmetic that only rounds.

import { describe, expect, it } from "vitest";

import { DECK_TOTAL_PERMILLE, normalise, type DeckPane } from "./deck-model.js";

/** Panes carrying only the axis these cases are about: their widths. */
function panesWithWidths(widths: readonly number[]): readonly DeckPane[] {
  return widths.map((sizePermille, position) => ({
    paneId: `pane-${String(position + 1)}`,
    kind: "timeline" as const,
    entity: undefined,
    sizePermille,
    isEphemeral: false,
    sourcePaneId: undefined,
  }));
}

function widthsOf(panes: readonly DeckPane[]): readonly number[] {
  return panes.map((pane) => pane.sizePermille);
}

function sumOf(panes: readonly DeckPane[]): number {
  return panes.reduce((total, pane) => total + pane.sizePermille, 0);
}

describe("normalise", () => {
  it.each([
    { what: "three equal saved widths", saved: [333, 333, 333] },
    { what: "seven equal saved widths", saved: [10, 10, 10, 10, 10, 10, 10] },
    { what: "one dominant pane beside two slivers", saved: [980, 11, 9] },
    { what: "widths that do not add up to a deck at all", saved: [1, 1, 1] },
    { what: "widths far larger than a deck", saved: [4000, 4000, 4001] },
  ])("makes $what sum to exactly one deck", ({ saved }) => {
    const normalised = normalise(panesWithWidths(saved));
    expect(sumOf(normalised)).toBe(DECK_TOTAL_PERMILLE);
    expect(normalised).toHaveLength(saved.length);
  });

  it("gives the remainder to the widest pane, and to the first of equals", () => {
    // The rule stated rather than implied: the drift settles on the pane with the
    // most headroom, and a tie keeps the panes' own order. A snapshot therefore
    // restores to one arrangement rather than to whichever the sort happened on.
    expect(widthsOf(normalise(panesWithWidths([333, 333, 333])))).toStrictEqual([334, 333, 333]);
    // The widest is not first here, and it is still the pane the shortfall lands on.
    expect(widthsOf(normalise(panesWithWidths([7, 10, 10])))).toStrictEqual([259, 371, 370]);
    // An EXCESS comes back off the widest by the same rule.
    expect(widthsOf(normalise(panesWithWidths([10, 10, 10, 10, 10, 10, 10])))).toStrictEqual([
      142, 143, 143, 143, 143, 143, 143,
    ]);
  });

  it("keeps every pane at a permille or more", () => {
    // A pane that rounds to nothing would come back as a column with no width for a
    // person to grab, which is a pane lost rather than a pane restored.
    const normalised = normalise(panesWithWidths([100_000, 1, 1]));
    expect(Math.min(...widthsOf(normalised))).toBeGreaterThanOrEqual(1);
    expect(sumOf(normalised)).toBe(DECK_TOTAL_PERMILLE);
  });

  // The negative control: a row whose rounding already lands on the total is
  // returned untouched. Without it the cases above would pass over a settle pass
  // that redistributed every deck it saw, which would move panes a person had
  // arranged deliberately.
  it("negative control: leaves an already-exact row alone", () => {
    expect(widthsOf(normalise(panesWithWidths([500, 500])))).toStrictEqual([500, 500]);
    expect(widthsOf(normalise(panesWithWidths([250, 250, 250, 250])))).toStrictEqual([
      250, 250, 250, 250,
    ]);
  });

  it("falls back to an even spread when there is no width to rescale", () => {
    expect(normalise(panesWithWidths([]))).toHaveLength(0);
    expect(sumOf(normalise(panesWithWidths([0, 0, 0])))).toBe(DECK_TOTAL_PERMILLE);
  });
});
