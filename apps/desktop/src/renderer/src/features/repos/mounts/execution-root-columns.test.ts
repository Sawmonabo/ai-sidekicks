// The execution-root columns: if the summary and detail tuples ever stop covering the labels
// table exactly once each, a column vanishes from the card with nothing failing.

import { describe, expect, it } from "vitest";
import {
  WORKTREE_COLUMN_LABELS,
  WORKTREE_DETAIL_COLUMNS,
  WORKTREE_SUMMARY_COLUMNS,
} from "./execution-root-columns.js";

/** Does a summary/detail split cover a labels table exactly once each? */
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
  it("splits the worktree's text columns across the summary and the disclosure", () => {
    const coverage = splitCoverage(
      Object.keys(WORKTREE_COLUMN_LABELS),
      WORKTREE_SUMMARY_COLUMNS,
      WORKTREE_DETAIL_COLUMNS,
    );
    expect(coverage).toStrictEqual({ missing: [], duplicated: [] });
  });
});
