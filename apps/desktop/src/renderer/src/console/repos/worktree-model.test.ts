// The execution-root model, driven directly.
//
// Two claims here are the ones a card cannot make for itself, and both are about
// what the surface would silently get wrong:
//
//   • NO COLUMN IS SILENTLY DROPPED. The design lists both records' columns
//     verbatim, and the model splits them into a summary and a disclosure. If those
//     two tuples ever stop covering the labels table exactly once each, a column
//     vanishes from the card with nothing failing — so the coverage predicate is
//     asserted here and then driven with a known-bad tuple to prove it bites.
//   • A RETIRED ROW WITH FILES ON DISK IS ITS OWN SUB-STATE. Reading `state` alone
//     answers "is this disk free" wrongly, which is the question the surface exists
//     to answer.

import { describe, expect, it } from "vitest";

import {
  CLONE_EXPIRY_COPY,
  CLONE_EXPIRY_READINGS,
  COLUMN_ABSENT_FALLBACK,
  EPHEMERAL_CLONE_ABSENT_COLUMN_COPY,
  EPHEMERAL_CLONE_COLUMN_LABELS,
  EPHEMERAL_CLONE_DETAIL_COLUMNS,
  EPHEMERAL_CLONE_STATE_PRESENTATION,
  EPHEMERAL_CLONE_SUMMARY_COLUMNS,
  WORKTREE_ABSENT_COLUMN_COPY,
  WORKTREE_COLUMN_LABELS,
  WORKTREE_DETAIL_COLUMNS,
  WORKTREE_DISK_DISPOSITIONS,
  WORKTREE_DISK_DISPOSITION_COPY,
  WORKTREE_STATE_PRESENTATION,
  WORKTREE_SUMMARY_COLUMNS,
  cloneExpiryReading,
  ephemeralCloneColumnCell,
  worktreeColumnCell,
  worktreeDiskDisposition,
  type EphemeralCloneStatusRecord,
  type WorktreeStatusRecord,
} from "./worktree-model.js";

/**
 * A worktree row. Ids are readable rather than UUID-shaped, which is the repos
 * scenario's convention and safe for its reason: no console module parses one.
 */
function worktreeRecord(overrides: Partial<WorktreeStatusRecord> = {}): WorktreeStatusRecord {
  return {
    worktreeId: "worktree-01",
    repoMountId: "mount-sidekicks",
    branchName: "sidekicks/abc123/rate-limit-wiring",
    fsRoot: "/Users/dev/.sidekicks/roots/worktree-01",
    state: "ready",
    createdBySessionId: "session-repos",
    createdByRunId: "run-01",
    createdAt: "2026-01-01T09:00:00.000Z",
    updatedAt: "2026-01-01T09:04:00.000Z",
    ...overrides,
  } as WorktreeStatusRecord;
}

function cloneRecord(
  overrides: Partial<EphemeralCloneStatusRecord> = {},
): EphemeralCloneStatusRecord {
  return {
    cloneId: "clone-01",
    workspaceId: "workspace-sidekicks",
    cloneRoot: "/Users/dev/.sidekicks/clones/clone-01",
    branchName: "run-9f2c1a",
    state: "ready",
    cleanupPolicy: "on_run_complete",
    expiresAt: "2026-01-01T12:00:00.000Z",
    createdAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  } as EphemeralCloneStatusRecord;
}

/**
 * Does a summary/detail split cover a labels table exactly once each?
 *
 * A pure predicate rather than a loop inside one case, so the negative controls can
 * drive it with a split whose verdict is known — proving the clean results below
 * mean something.
 */
function splitCoverage(
  labelled: readonly string[],
  summary: readonly string[],
  detail: readonly string[],
): { readonly missing: readonly string[]; readonly duplicated: readonly string[] } {
  const placed = [...summary, ...detail];
  return {
    missing: labelled.filter((column) => !placed.includes(column)),
    duplicated: placed.filter((column, index) => placed.indexOf(column) !== index),
  };
}

describe("worktree-model — every column has a home", () => {
  it("splits the ten worktree columns across the summary and the disclosure", () => {
    const coverage = splitCoverage(
      Object.keys(WORKTREE_COLUMN_LABELS),
      WORKTREE_SUMMARY_COLUMNS,
      WORKTREE_DETAIL_COLUMNS,
    );
    expect(coverage).toStrictEqual({ missing: [], duplicated: [] });
    expect(Object.keys(WORKTREE_COLUMN_LABELS)).toHaveLength(10);
  });

  it("splits the nine clone columns the same way", () => {
    const coverage = splitCoverage(
      Object.keys(EPHEMERAL_CLONE_COLUMN_LABELS),
      EPHEMERAL_CLONE_SUMMARY_COLUMNS,
      EPHEMERAL_CLONE_DETAIL_COLUMNS,
    );
    expect(coverage).toStrictEqual({ missing: [], duplicated: [] });
    // Nine, not ten: the clone record carries no `updatedAt`, and a labels table
    // that grew one would be describing a column the wire does not send.
    expect(Object.keys(EPHEMERAL_CLONE_COLUMN_LABELS)).toHaveLength(9);
    expect(Object.keys(EPHEMERAL_CLONE_COLUMN_LABELS)).not.toContain("updatedAt");
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

describe("worktree-model — clone expiry", () => {
  // One instant written twice — the stamp the record carries and the parts the
  // arithmetic reads — rather than one derived from the other through the reader this
  // suite is driving.
  const expiresAt = "2026-01-01T12:00:00.000Z";
  const expiryMilliseconds = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("classifies against the caller's instant and nothing else", () => {
    expect(cloneExpiryReading(cloneRecord({ expiresAt }), expiryMilliseconds - 1)).toBe(
      "scheduled",
    );
    expect(cloneExpiryReading(cloneRecord({ expiresAt }), expiryMilliseconds + 1)).toBe("elapsed");
  });

  it("treats the boundary itself as elapsed", () => {
    expect(cloneExpiryReading(cloneRecord({ expiresAt }), expiryMilliseconds)).toBe("elapsed");
  });

  it("falls back to scheduled on a stamp it cannot read", () => {
    // The fail-safe direction: the loud arm asserts the snapshot refs may already be
    // gone, and asserting that off a timestamp the console could not parse would be
    // the console inventing the fact.
    expect(cloneExpiryReading(cloneRecord({ expiresAt: "not-a-timestamp" }), 0)).toBe("scheduled");
  });

  it("names the consequence on both readings", () => {
    for (const reading of CLONE_EXPIRY_READINGS) {
      expect(CLONE_EXPIRY_COPY[reading]).toContain("snapshot refs");
    }
  });
});

describe("worktree-model — column cells", () => {
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
    expect(ephemeralCloneColumnCell(cloneRecord(), "cleanedAt")).toStrictEqual({
      kind: "absent",
      copy: EPHEMERAL_CLONE_ABSENT_COLUMN_COPY.cleanedAt,
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
  it("presents six worktree states and four clone states", () => {
    expect(Object.keys(WORKTREE_STATE_PRESENTATION)).toHaveLength(6);
    expect(Object.keys(EPHEMERAL_CLONE_STATE_PRESENTATION)).toHaveLength(4);
  });

  it("says where a failed row comes from, on both records", () => {
    // The one rule this surface is most likely to get wrong: there is no sixth
    // worktree event and no clone event at all, so `failed` arrives on a re-read.
    expect(WORKTREE_STATE_PRESENTATION.failed.meaning).toContain("status re-read");
    expect(EPHEMERAL_CLONE_STATE_PRESENTATION.failed.meaning).toContain("status re-read");
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
