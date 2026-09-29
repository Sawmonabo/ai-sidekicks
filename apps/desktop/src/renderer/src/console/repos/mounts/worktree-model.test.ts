// The execution-root model, driven directly.
//
// Two claims here are the ones a card cannot make for itself, and both are about
// what the surface would silently get wrong:
//
//   • NO COLUMN IS SILENTLY DROPPED. The design lists the record's columns
//     verbatim, and the model splits them into a summary and a disclosure. If those
//     two tuples ever stop covering the labels table exactly once each, a column
//     vanishes from the card with nothing failing — so the coverage predicate is
//     asserted here and then driven with a known-bad tuple to prove it bites.
//   • A RETIRED ROW WITH FILES ON DISK IS ITS OWN SUB-STATE. Reading `state` alone
//     answers "is this disk free" wrongly, which is the question the surface exists
//     to answer.

import { describe, expect, it } from "vitest";

import {
  WORKTREE_DISK_DISPOSITIONS,
  WORKTREE_DISK_DISPOSITION_COPY,
  WORKTREE_STATE_PRESENTATION,
  worktreeDiskDisposition,
  type WorktreeStatusRecord,
} from "@renderer/features/repos/mounts/execution-root-model.js";
import {
  COLUMN_ABSENT_FALLBACK,
  WORKTREE_ABSENT_COLUMN_COPY,
  WORKTREE_COLUMN_LABELS,
  WORKTREE_DETAIL_COLUMNS,
  WORKTREE_SUMMARY_COLUMNS,
  worktreeColumnCell,
} from "@renderer/features/repos/mounts/execution-root-columns.js";
import { worktreeRecord } from "@renderer/features/repos/mounts/repo-mounts.test-support.js";

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

describe("worktree-model — the disk disposition", () => {
  it("reads a live row, a retired row with files, and a swept row apart", () => {
    expect(worktreeDiskDisposition(worktreeRecord())).toBe("live");
    expect(worktreeDiskDisposition(worktreeRecord({ state: "retired" }))).toBe("retired-on-disk");
    expect(
      worktreeDiskDisposition(
        worktreeRecord({ state: "retired", cleanedAt: "2026-01-01T10:00:00.000Z" }),
      ),
    ).toBe("reclaimed");
  });

  it("reads the sweep stamp before the state, so a swept failed row is not reported as occupying disk", () => {
    // The ordering is the claim. Reading `state` first would answer `live` here,
    // which tells an operator to reclaim a root that is already gone.
    expect(
      worktreeDiskDisposition(
        worktreeRecord({ state: "failed", cleanedAt: "2026-01-01T10:00:00.000Z" }),
      ),
    ).toBe("reclaimed");
  });

  it("negative control: the three dispositions say three different things", () => {
    const sentences = WORKTREE_DISK_DISPOSITIONS.map(
      (disposition) => WORKTREE_DISK_DISPOSITION_COPY[disposition],
    );
    expect(new Set(sentences).size).toBe(WORKTREE_DISK_DISPOSITIONS.length);
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

describe("worktree-model — the state vocabularies are the contract's", () => {
  it("presents six worktree states", () => {
    expect(Object.keys(WORKTREE_STATE_PRESENTATION)).toHaveLength(6);
  });

  it("says where a failed row comes from", () => {
    // The one rule this surface is most likely to get wrong: there is no sixth
    // worktree event, so `failed` arrives on a re-read.
    expect(WORKTREE_STATE_PRESENTATION.failed.meaning).toContain("status re-read");
  });

  it("spends amber and red on exactly the states that earn them", () => {
    expect(WORKTREE_STATE_PRESENTATION.dirty.tone).toBe("attention");
    expect(WORKTREE_STATE_PRESENTATION.failed.tone).toBe("failure");
    // Negative control: a state that is merely uninteresting stays neutral, so the
    // two-hue vocabulary keeps meaning what it says.
    expect(WORKTREE_STATE_PRESENTATION.ready.tone).toBe("neutral");
    expect(WORKTREE_STATE_PRESENTATION.merged.tone).toBe("neutral");
  });
});
