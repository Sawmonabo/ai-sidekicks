// The execution-root columns, driven directly.
//
// NO COLUMN IS SILENTLY DROPPED. The design lists the record's columns verbatim, and the
// model splits them into a summary and a disclosure. If those two tuples ever stop
// covering the labels table exactly once each, a column vanishes from the card with
// nothing failing — so the coverage predicate is asserted here and then driven with a
// known-bad tuple to prove it bites.

import { describe, expect, it } from "vitest";

import { type WorktreeStatusRecord } from "./execution-root-model.js";
import {
  COLUMN_ABSENT_FALLBACK,
  WORKTREE_ABSENT_COLUMN_COPY,
  WORKTREE_COLUMN_LABELS,
  WORKTREE_DETAIL_COLUMNS,
  WORKTREE_SUMMARY_COLUMNS,
  worktreeColumnCell,
} from "./execution-root-columns.js";
import { worktreeRecord } from "./repo-mounts.test-support.js";

/**
 * Does a summary/detail split cover a labels table exactly once each?
 *
 * A pure predicate rather than a loop inside one case, so the negative controls can
 * drive it with a split whose verdict is known — proving the clean results below
 * mean something.
 */
function splitCoverage(
  labeled: readonly string[],
  summary: readonly string[],
  detail: readonly string[],
): { readonly missing: readonly string[]; readonly duplicated: readonly string[] } {
  const placed = [...summary, ...detail];
  return {
    missing: labeled.filter((column) => !placed.includes(column)),
    duplicated: placed.filter((column, index) => placed.indexOf(column) !== index),
  };
}

describe("worktree-columns — every column has a home", () => {
  it("splits the ten worktree columns across the summary and the disclosure", () => {
    const coverage = splitCoverage(
      Object.keys(WORKTREE_COLUMN_LABELS),
      WORKTREE_SUMMARY_COLUMNS,
      WORKTREE_DETAIL_COLUMNS,
    );
    expect(coverage).toStrictEqual({ missing: [], duplicated: [] });
    expect(Object.keys(WORKTREE_COLUMN_LABELS)).toHaveLength(10);
  });

  it("negative control: the coverage predicate reports a dropped and a doubled column", () => {
    expect(splitCoverage(["a", "b"], ["a"], [])).toStrictEqual({
      missing: ["b"],
      duplicated: [],
    });
    expect(splitCoverage(["a"], ["a"], ["a"])).toStrictEqual({ missing: [], duplicated: ["a"] });
  });
});

describe("worktree-columns — column cells", () => {
  it("hands back the wire's own string", () => {
    expect(worktreeColumnCell(worktreeRecord(), "branchName")).toStrictEqual({
      kind: "value",
      value: "sidekicks/abc123/rate-limit-wiring",
    });
  });

  it("names what an omitted optional column means, per column", () => {
    expect(
      worktreeColumnCell(worktreeRecord({ createdByRunId: undefined }), "createdByRunId"),
    ).toStrictEqual({ kind: "absent", copy: WORKTREE_ABSENT_COLUMN_COPY.createdByRunId });
    expect(worktreeColumnCell(worktreeRecord(), "cleanedAt")).toStrictEqual({
      kind: "absent",
      copy: WORKTREE_ABSENT_COLUMN_COPY.cleanedAt,
    });
    // Two different sentences, because they are two different facts about the world.
    expect(WORKTREE_ABSENT_COLUMN_COPY.createdByRunId).not.toBe(
      WORKTREE_ABSENT_COLUMN_COPY.cleanedAt,
    );
  });

  it("says so when a column the wire declares required arrives empty", () => {
    // Reachable: these rows are held as typed values, and a payload that never met
    // the response schema can carry a hole the type says cannot exist.
    const holed = { ...worktreeRecord(), fsRoot: undefined } as unknown as WorktreeStatusRecord;
    expect(worktreeColumnCell(holed, "fsRoot")).toStrictEqual({
      kind: "absent",
      copy: COLUMN_ABSENT_FALLBACK,
    });
  });
});
