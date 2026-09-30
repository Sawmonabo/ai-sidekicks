// What a reuse reply means, and what a prepare form admits. A dirty and incompatible candidate
// must read as incompatible, since consenting to one that cannot be bound is a press already
// decided. The three guards that keep a prepare off the wire (length bound, unanswered check,
// stale consent) are asserted separately because each fails differently.

import { describe, expect, it } from "vitest";

import { WORKTREE_GIT_REF_MAX_LEN, type WorktreeReuseCheckResponse } from "@ai-sidekicks/contracts";

import {
  EMPTY_PREPARE_FORM,
  REUSE_UNANSWERED_COPY,
  REUSE_VERDICT_COPY,
  isDirtyReuseAcknowledged,
  resolvePrepareForm,
  readReuseCheckState,
  reuseConsentRequired,
  reusePreparable,
  reuseVerdictFor,
  type PrepareFormState,
  type ReuseVerdict,
} from "./prepare-form.js";

const WORKTREE_ID = "9f2c4a10-0000-4000-8000-000000000020";

const REPLACEMENT_WORKTREE_ID = "9f2c4a10-0000-4000-8000-000000000021";

const DIRTY_CANDIDATE: ReuseVerdict = {
  kind: "dirty",
  worktreeId: WORKTREE_ID,
  reason: undefined,
};

const REPLACEMENT_DIRTY_CANDIDATE: ReuseVerdict = {
  kind: "dirty",
  worktreeId: REPLACEMENT_WORKTREE_ID,
  reason: undefined,
};

function reply(overrides: Partial<WorktreeReuseCheckResponse> = {}): WorktreeReuseCheckResponse {
  return { available: true, worktreeId: WORKTREE_ID, ...overrides } as WorktreeReuseCheckResponse;
}

function form(acknowledgedCandidateId?: string): PrepareFormState {
  return { branchName: "feat/x", acknowledgedCandidateId };
}

function answered(verdict: ReuseVerdict): ReturnType<typeof readReuseCheckState> {
  return readReuseCheckState({ status: "read", value: verdict });
}

describe("reuseVerdictFor", () => {
  it("reads no candidate as none", () => {
    expect(reuseVerdictFor({ available: false } as WorktreeReuseCheckResponse).kind).toBe("none");
  });

  it("reads a clean, compatible candidate as reusable", () => {
    expect(reuseVerdictFor(reply({ compatible: true, isClean: true })).kind).toBe("reusable");
  });

  it("reads a dirty, compatible candidate as dirty and carries its reason", () => {
    const verdict = reuseVerdictFor(reply({ compatible: true, isClean: false, reason: "3 files" }));
    expect(verdict.kind).toBe("dirty");
    expect(verdict.kind === "dirty" && verdict.reason).toBe("3 files");
  });

  it("reads a candidate that is both dirty and incompatible as incompatible", () => {
    // The reverse order would put a consent control in front of an unbindable candidate.
    expect(reuseVerdictFor(reply({ compatible: false, isClean: false })).kind).toBe("incompatible");
  });

  it("negative control: an absent `compatible` is not read as permission", () => {
    // The verdict members are optional on the wire; reading absence as yes would consent for it.
    expect(reuseVerdictFor(reply({ isClean: true })).kind).toBe("incompatible");
  });

  it("negative control: an available reply with no id is no candidate", () => {
    expect(
      reuseVerdictFor({
        available: true,
        compatible: true,
        isClean: true,
      } as WorktreeReuseCheckResponse).kind,
    ).toBe("none");
  });
});

describe("reuseConsentRequired / reusePreparable", () => {
  it("asks for consent on the dirty arm alone", () => {
    expect(reuseConsentRequired(DIRTY_CANDIDATE)).toBe(true);
    expect(reuseConsentRequired({ kind: "reusable", worktreeId: WORKTREE_ID })).toBe(false);
    expect(reuseConsentRequired({ kind: "none" })).toBe(false);
  });

  it("refuses to prepare against an incompatible candidate and nothing else", () => {
    expect(
      reusePreparable({ kind: "incompatible", worktreeId: WORKTREE_ID, reason: undefined }),
    ).toBe(false);
    expect(reusePreparable({ kind: "none" })).toBe(true);
  });
});

describe("readReuseCheckState", () => {
  it("carries the answer a settled check gave", () => {
    const standing = answered(DIRTY_CANDIDATE);
    expect(standing.answered).toBe(true);
    expect(standing.verdict).toStrictEqual(DIRTY_CANDIDATE);
  });

  it("holds an unasked and an in-flight check apart from a decided negative", () => {
    // All three leave the verdict at `none`; only `answered` separates them from a real negative.
    for (const reading of [{ status: "not-read" }, { status: "reading" }] as const) {
      const standing = readReuseCheckState(reading);
      expect(standing.answered).toBe(false);
      expect(standing.verdict.kind).toBe("none");
    }
    expect(readReuseCheckState({ status: "read", value: { kind: "none" } }).answered).toBe(true);
  });
});

describe("resolvePrepareForm", () => {
  it("asks for a branch first", () => {
    const verdict = resolvePrepareForm(EMPTY_PREPARE_FORM, answered({ kind: "none" }));
    expect(verdict.status === "incomplete" && verdict.because).toContain("branch");
  });

  it("sends an ordinary prepare with a branch and no candidate", () => {
    expect(resolvePrepareForm(form(), answered({ kind: "none" })).status).toBe("sendable");
  });

  it("holds a branch name past the contract's own bound, in the wire's units", () => {
    // Both prepare requests bound `branchName`; without this the control opens onto a schema error.
    const overCap = "b".repeat(WORKTREE_GIT_REF_MAX_LEN + 1);
    const verdict = resolvePrepareForm(
      { branchName: overCap, acknowledgedCandidateId: undefined },
      answered({ kind: "none" }),
    );
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain(
      String(WORKTREE_GIT_REF_MAX_LEN + 1),
    );
  });

  it("negative control: a branch name AT the bound is sendable", () => {
    expect(
      resolvePrepareForm(
        { branchName: "b".repeat(WORKTREE_GIT_REF_MAX_LEN), acknowledgedCandidateId: undefined },
        answered({ kind: "none" }),
      ).status,
    ).toBe("sendable");
  });

  it("holds the act until the reuse check for that branch has answered", () => {
    // The defect this closes: a prepare sent inside the debounce window omitted
    // `reuseWorktreeId` for a branch that had a candidate.
    const verdict = resolvePrepareForm(form(), readReuseCheckState({ status: "reading" }));
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toBe(REUSE_UNANSWERED_COPY);
  });

  it("holds the act before any check has been asked at all", () => {
    expect(resolvePrepareForm(form(), readReuseCheckState({ status: "not-read" })).status).toBe(
      "incomplete",
    );
  });

  it("holds a dirty candidate until the consent is given", () => {
    expect(resolvePrepareForm(form(), answered(DIRTY_CANDIDATE)).status).toBe("incomplete");
    expect(resolvePrepareForm(form(WORKTREE_ID), answered(DIRTY_CANDIDATE)).status).toBe(
      "sendable",
    );
  });

  it("holds a candidate the consent was not given for, though the branch never changed", () => {
    // A refresh can retire one dirty checkout and serve another for the same branch; a consent
    // keyed on the branch text would survive and be sent under the new worktree's id.
    const verdict = resolvePrepareForm(form(WORKTREE_ID), answered(REPLACEMENT_DIRTY_CANDIDATE));
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain("uncommitted changes");
  });

  it("negative control: consent does not make an incompatible candidate sendable", () => {
    const verdict = resolvePrepareForm(
      form(WORKTREE_ID),
      answered({ kind: "incompatible", worktreeId: WORKTREE_ID, reason: undefined }),
    );
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toBe(
      REUSE_VERDICT_COPY.incompatible,
    );
  });
});

describe("isDirtyReuseAcknowledged", () => {
  it("carries the consent on the candidate that asked for it", () => {
    expect(isDirtyReuseAcknowledged(form(WORKTREE_ID), DIRTY_CANDIDATE)).toBe(true);
  });

  it("drops a consent the verdict no longer calls for, which a refresh can leave set", () => {
    // The checkbox is ticked under `dirty`, then the re-check settles `reusable` and the
    // checkbox unmounts with the consent still recorded.
    expect(
      isDirtyReuseAcknowledged(form(WORKTREE_ID), { kind: "reusable", worktreeId: WORKTREE_ID }),
    ).toBe(false);
  });

  it("drops a consent given for a different tree, on a verdict that is still dirty", () => {
    // The arm and branch are unchanged but the tree the person read about is gone.
    expect(isDirtyReuseAcknowledged(form(WORKTREE_ID), REPLACEMENT_DIRTY_CANDIDATE)).toBe(false);
  });

  it("negative control: no verdict but `dirty` carries one, consented or not", () => {
    expect(isDirtyReuseAcknowledged(form(WORKTREE_ID), { kind: "none" })).toBe(false);
    expect(
      isDirtyReuseAcknowledged(form(WORKTREE_ID), {
        kind: "incompatible",
        worktreeId: WORKTREE_ID,
        reason: undefined,
      }),
    ).toBe(false);
    expect(isDirtyReuseAcknowledged(form(), DIRTY_CANDIDATE)).toBe(false);
  });
});
