// The execution-root model, driven directly.
//
// A RETIRED ROW WITH FILES ON DISK IS ITS OWN SUB-STATE. Reading `state` alone answers
// "is this disk free" wrongly, which is the question the execution-root view exists to answer.

import { describe, expect, it } from "vitest";

import {
  WORKTREE_DISK_DISPOSITIONS,
  WORKTREE_DISK_DISPOSITION_COPY,
  WORKTREE_STATE_PRESENTATION,
  worktreeDiskDisposition,
} from "./execution-root-model.js";
import { worktreeRecord } from "./repo-mounts.test-support.js";

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

describe("worktree-model — the state vocabularies are the contract's", () => {
  it("presents six worktree states", () => {
    expect(Object.keys(WORKTREE_STATE_PRESENTATION)).toHaveLength(6);
  });

  it("says where a failed row comes from", () => {
    // The one rule this view is most likely to get wrong: there is no sixth
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
