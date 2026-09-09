// The fold every sidebar section body shares: what it keeps, how it groups, how it orders.
//
// Driven over a plain row shape rather than over a `ConsoleEntity`, because the module
// is generic on purpose — two of its three callers read projected store rows and the
// third reads wire rows off a growth reply, and a test written against one of those
// shapes would quietly stop covering the other.

import { describe, expect, it } from "vitest";

import { groupSectionRows, groupedRowCount, normaliseFilterQuery } from "./section-grouping.js";

interface Row {
  readonly id: string;
  readonly group: "first" | "second";
  readonly at?: string;
}

function fold(
  rows: readonly Row[],
  options: { readonly matches?: (row: Row) => boolean } = {},
): ReadonlyMap<"first" | "second", readonly Row[]> {
  return groupSectionRows(rows, {
    groupOf: (row) => row.group,
    matches: options.matches ?? (() => true),
    orderedBy: (row) => row.at,
  });
}

describe("groupSectionRows — absent rather than empty entries", () => {
  it("holds no entry for a group nothing landed in", () => {
    const grouped = fold([{ id: "a", group: "first" }]);
    expect([...grouped.keys()]).toEqual(["first"]);
    // The negative control for the density rule: a caller drawing a heading per entry
    // must not be handed a heading with nothing under it.
    expect(grouped.get("second")).toBeUndefined();
  });

  it("holds no entry for a group the filter emptied", () => {
    const grouped = fold(
      [
        { id: "a", group: "first" },
        { id: "b", group: "second" },
      ],
      { matches: (row) => row.group === "first" },
    );
    expect([...grouped.keys()]).toEqual(["first"]);
  });
});

describe("groupSectionRows — ordering is over moments, never over strings", () => {
  it("puts the later instant first even where it is lexically smaller", () => {
    const grouped = fold([
      { id: "earlier", group: "first", at: "2026-09-01T09:00:00.000Z" },
      // An hour later than the row above, and a smaller string than it.
      { id: "later", group: "first", at: "2026-09-01T08:00:00.000-02:00" },
    ]);
    expect((grouped.get("first") ?? []).map((row) => row.id)).toEqual(["later", "earlier"]);
  });

  it("keeps a row the wire stamped with nothing, after the rows it stamped", () => {
    const grouped = fold([
      { id: "unstamped", group: "first" },
      { id: "stamped", group: "first", at: "2026-09-01T09:00:00.000Z" },
    ]);
    // A row is a row whether or not it carries an instant; dropping it would hide work.
    expect((grouped.get("first") ?? []).map((row) => row.id)).toEqual(["stamped", "unstamped"]);
  });
});

describe("groupedRowCount", () => {
  it("counts across every group rather than the largest one", () => {
    expect(
      groupedRowCount(
        fold([
          { id: "a", group: "first" },
          { id: "b", group: "second" },
          { id: "c", group: "second" },
        ]),
      ),
    ).toBe(3);
  });

  it("is zero for a fold the filter emptied", () => {
    expect(groupedRowCount(fold([{ id: "a", group: "first" }], { matches: () => false }))).toBe(0);
  });
});

describe("normaliseFilterQuery", () => {
  it("reads an absent field and a blank one as no filter at all", () => {
    expect(normaliseFilterQuery(undefined)).toBe("");
    expect(normaliseFilterQuery("   ")).toBe("");
  });

  it("lowercases by locale rather than by the invariant rule", () => {
    // `toLocaleLowerCase` and `toLowerCase` disagree on more alphabets than they
    // agree on, and the field takes whatever a person types.
    expect(normaliseFilterQuery("  İstanbul ")).toBe("İstanbul".toLocaleLowerCase());
  });
});
