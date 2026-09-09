// The two halves of the growth slate, held against each other.
//
// The rows and the surfaces waiting on them live in two modules now, so that the half
// no running console reads stays off the initial import graph. The compiler already
// pairs them — the surface table is a `Record` over the same closed id union the rows
// are keyed by — and what a compile error cannot say is what a reader of the plan
// needs: that every row's sentence is actually there. So the checks below read both
// tables and compare them, with a holed copy as the control that they can fail.

import { describe, expect, it } from "vitest";

import { GROWTH_SLATE_CONSUMING_SURFACES } from "./growth-slate-consumers.js";
import { GROWTH_SLATE_ROWS } from "./growth-slate.js";
import type { GrowthSlateRowId } from "./growth-slate-row.js";

/**
 * Which row ids the surface table does not answer for, over any candidate table.
 *
 * Takes the table as an argument rather than reading the module one, so the same
 * reading answers for the real table and for the holed copy the control builds — a
 * check written against the import directly would have no failing input to offer.
 */
function slateRowIdsWithNoSurface(
  surfaces: Readonly<Partial<Record<GrowthSlateRowId, string>>>,
): readonly GrowthSlateRowId[] {
  return GROWTH_SLATE_ROWS.map((row) => row.id).filter((id) => {
    const surface = surfaces[id];
    return surface === undefined || surface.trim().length === 0;
  });
}

describe("the growth slate's consuming surfaces", () => {
  it("answers for every row on the slate", () => {
    expect(slateRowIdsWithNoSurface(GROWTH_SLATE_CONSUMING_SURFACES)).toEqual([]);
  });

  it("negative control: a row whose surface is missing is reported", () => {
    const firstRow = GROWTH_SLATE_ROWS.at(0);
    if (firstRow === undefined) {
      throw new Error("The growth slate is empty, so this control has nothing to hole.");
    }
    const holed: Partial<Record<GrowthSlateRowId, string>> = {
      ...GROWTH_SLATE_CONSUMING_SURFACES,
    };
    delete holed[firstRow.id];

    expect(slateRowIdsWithNoSurface(holed)).toEqual([firstRow.id]);
  });

  it("names no surface for an id the slate does not carry", () => {
    // The other direction, which the record's own key type also holds statically. Read
    // at run time as well because the two tables are edited in different diffs: a row
    // deleted from the ledger leaves a surface sentence behind it, and a stale entry is
    // a promise about a wire nothing is waiting for any more.
    const slateRowIds = new Set<string>(GROWTH_SLATE_ROWS.map((row) => row.id));
    const unknownKeys = Object.keys(GROWTH_SLATE_CONSUMING_SURFACES).filter(
      (key) => !slateRowIds.has(key),
    );

    expect(unknownKeys).toEqual([]);
  });
});
