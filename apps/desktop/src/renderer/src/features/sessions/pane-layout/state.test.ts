// The pane layout's width arithmetic and address identity, without constructing a layout.
// Whatever was on disk, `normalize` returns a row summing to the whole. Rounding alone gives
// 333 + 333 + 333 = 999, so the cases assert the exact sum.

import { describe, expect, it } from "vitest";

import {
  carveSplitFrom,
  PANE_LAYOUT_TOTAL_PERMILLE,
  normalize,
  paneAddressKey,
  type SessionPane,
} from "./state.js";

/** Panes carrying only their widths. */
function panesWithWidths(widths: readonly number[]): readonly SessionPane[] {
  return widths.map((sizePermille, position) => ({
    paneId: `pane-${String(position + 1)}`,
    kind: "transcript" as const,
    entity: undefined,
    sizePermille,
    isEphemeral: false,
    sourcePaneId: undefined,
  }));
}

function widthsOf(panes: readonly SessionPane[]): readonly number[] {
  return panes.map((pane) => pane.sizePermille);
}

function sumOf(panes: readonly SessionPane[]): number {
  return panes.reduce((total, pane) => total + pane.sizePermille, 0);
}

describe("normalize", () => {
  it.each([
    { what: "three equal saved widths", saved: [333, 333, 333] },
    { what: "seven equal saved widths", saved: [10, 10, 10, 10, 10, 10, 10] },
    { what: "one dominant pane beside two slivers", saved: [980, 11, 9] },
    { what: "widths that do not add up to a layout at all", saved: [1, 1, 1] },
    { what: "widths far larger than a layout", saved: [4000, 4000, 4001] },
  ])("makes $what sum to exactly one layout", ({ saved }) => {
    const normalized = normalize(panesWithWidths(saved));
    expect(sumOf(normalized)).toBe(PANE_LAYOUT_TOTAL_PERMILLE);
    expect(normalized).toHaveLength(saved.length);
  });

  it("gives the remainder to the widest pane, and to the first of equals", () => {
    // Drift settles on the pane with the most headroom, and a tie keeps the panes' own order.
    expect(widthsOf(normalize(panesWithWidths([333, 333, 333])))).toStrictEqual([334, 333, 333]);
    // The widest is not first here and still takes the shortfall.
    expect(widthsOf(normalize(panesWithWidths([7, 10, 10])))).toStrictEqual([259, 371, 370]);
    // An excess comes back off the widest by the same rule.
    expect(widthsOf(normalize(panesWithWidths([10, 10, 10, 10, 10, 10, 10])))).toStrictEqual([
      142, 143, 143, 143, 143, 143, 143,
    ]);
  });

  it("keeps every pane at a permille or more", () => {
    // A pane rounding to nothing would be a column with no width to grab.
    const normalized = normalize(panesWithWidths([100_000, 1, 1]));
    expect(Math.min(...widthsOf(normalized))).toBeGreaterThanOrEqual(1);
    expect(sumOf(normalized)).toBe(PANE_LAYOUT_TOTAL_PERMILLE);
  });

  // A row whose rounding already lands on the total is returned untouched; the cases above
  // would also pass over a settle pass that redistributed every layout.
  it("negative control: leaves an already-exact row alone", () => {
    expect(widthsOf(normalize(panesWithWidths([500, 500])))).toStrictEqual([500, 500]);
    expect(widthsOf(normalize(panesWithWidths([250, 250, 250, 250])))).toStrictEqual([
      250, 250, 250, 250,
    ]);
  });

  it("falls back to an even spread when there is no width to rescale", () => {
    expect(normalize(panesWithWidths([]))).toHaveLength(0);
    expect(sumOf(normalize(panesWithWidths([0, 0, 0])))).toBe(PANE_LAYOUT_TOTAL_PERMILLE);
  });
});

// The address key is the one definition of "the same pane", shared by the store's open and the
// snapshot decoder's dedupe.
describe("paneAddressKey", () => {
  function paneAt(
    kind: SessionPane["kind"],
    entity: SessionPane["entity"],
    paneId = "pane-1",
  ): SessionPane {
    return {
      paneId,
      kind,
      entity,
      sizePermille: PANE_LAYOUT_TOTAL_PERMILLE,
      isEphemeral: false,
      sourcePaneId: undefined,
    };
  }

  it("keys two different pane ids at one address identically", () => {
    // The pane id is not part of the address, or a corrupted snapshot's duplicate would mount
    // twice.
    expect(paneAddressKey(paneAt("inspector", { kind: "run", id: "run-01" }, "pane-a"))).toBe(
      paneAddressKey(paneAt("inspector", { kind: "run", id: "run-01" }, "pane-b")),
    );
  });

  it("separates the same entity in two kinds of pane, and two entities in one kind", () => {
    // A worktree appears in both an `inspector` and a `diff` pane, so kind is part of the
    // address...
    expect(paneAddressKey(paneAt("inspector", { kind: "worktree", id: "worktree-01" }))).not.toBe(
      paneAddressKey(paneAt("diff", { kind: "worktree", id: "worktree-01" })),
    );
    // ...and so is the entity.
    expect(paneAddressKey(paneAt("inspector", { kind: "run", id: "run-01" }))).not.toBe(
      paneAddressKey(paneAt("inspector", { kind: "run", id: "run-02" })),
    );
    // A session-scoped pane is its own address, not the entity-scoped one emptied.
    expect(paneAddressKey(paneAt("transcript", undefined))).not.toBe(
      paneAddressKey(paneAt("transcript", { kind: "run", id: "run-01" })),
    );
  });

  it("cannot be collided by an entity id carrying the key's own separator", () => {
    // The free-form field is last, so a crafted id cannot be re-read as another address.
    expect(paneAddressKey(paneAt("inspector", { kind: "run", id: "run\u001f01" }))).not.toBe(
      paneAddressKey(paneAt("inspector", { kind: "run", id: "run" })),
    );
  });
});

describe("carveSplitFrom", () => {
  /** A pane with no width of its own yet: the arriving half of a split. */
  const arriving: SessionPane = {
    paneId: "pane-arriving",
    kind: "browser",
    entity: undefined,
    sizePermille: PANE_LAYOUT_TOTAL_PERMILLE,
    isEphemeral: true,
    sourcePaneId: "pane-2",
  };

  it("takes the arriving pane's width from the source alone and places it beside it", () => {
    // Splitting the middle of an arranged layout leaves the panes either side unchanged.
    // `distributeEvenly` would answer [333,333,333,333] with the sum still right, so the widths
    // are asserted, not just the sum.
    const split = carveSplitFrom(panesWithWidths([200, 500, 300]), 1, arriving);
    expect(widthsOf(split ?? [])).toStrictEqual([200, 250, 250, 300]);
    expect(sumOf(split ?? [])).toBe(PANE_LAYOUT_TOTAL_PERMILLE);
    // The arriving pane sits immediately right of its source.
    expect((split ?? []).map((pane) => pane.paneId)).toStrictEqual([
      "pane-1",
      "pane-2",
      "pane-arriving",
      "pane-3",
    ]);
  });

  it("leaves an odd remainder with the pane that was already there", () => {
    const split = carveSplitFrom(panesWithWidths([501, 499]), 0, arriving);
    expect(widthsOf(split ?? [])).toStrictEqual([251, 250, 499]);
    expect(sumOf(split ?? [])).toBe(PANE_LAYOUT_TOTAL_PERMILLE);
  });

  it("refuses a source too narrow to halve, and an index the pane layout does not hold", () => {
    // Both answer `undefined`: half of nothing cannot be grabbed, and an outside position names
    // no source.
    expect(carveSplitFrom(panesWithWidths([1, 999]), 0, arriving)).toBeUndefined();
    expect(carveSplitFrom(panesWithWidths([500, 500]), 5, arriving)).toBeUndefined();
  });

  it("negative control: a source of two permille is wide enough and does split", () => {
    // The refusal above would also pass over an implementation that refused every split.
    const split = carveSplitFrom(panesWithWidths([2, 998]), 0, arriving);
    expect(widthsOf(split ?? [])).toStrictEqual([1, 1, 998]);
  });
});
