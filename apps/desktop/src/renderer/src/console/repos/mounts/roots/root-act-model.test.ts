// What a reuse reply means, what a prepare form admits, and what a disposal states.
//
// THE ORDERING CLAIM IS THE ONE THAT MATTERS. A candidate that is both dirty and
// incompatible must read as incompatible, because the dirty arm carries a consent
// control and consenting to a candidate that cannot be bound is a press already decided.
//
// AND THE THREE GUARDS THAT KEEP A PREPARE OFF THE WIRE ARE ASSERTED SEPARATELY: the
// contract's own length bound, the reuse check that has not answered, and a consent read
// for a candidate the daemon is no longer serving. Each of the three admits a prepare
// that omits or misstates `reuseWorktreeId`, and each fails differently.

import { describe, expect, it } from "vitest";

import { WORKTREE_GIT_REF_MAX_LEN, type WorktreeReuseCheckResponse } from "@ai-sidekicks/contracts";

import type { ActPrerequisiteReading } from "../../../store/index.js";
import {
  DISPOSAL_CONSEQUENCE,
  EMPTY_PREPARE_FORM,
  REUSE_UNANSWERED_COPY,
  REUSE_VERDICT_COPY,
  disposalSubjectFor,
  prepareAcknowledgement,
  prepareFormVerdict,
  prepareReuseStanding,
  reuseConsentRequired,
  reusePreparable,
  reuseVerdictFor,
  type PrepareFormState,
  type ReuseVerdict,
} from "./root-act-model.js";

const WORKTREE_ID = "9f2c4a10-0000-4000-8000-000000000020";

/** A second live checkout of the SAME branch — what a lifecycle refresh can serve. */
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

/** A form naming a branch, with whatever consent the case is about. */
function form(acknowledgedCandidateId?: string): PrepareFormState {
  return { branchName: "feat/x", acknowledgedCandidateId };
}

/** The answered standing for one verdict, which is what a settled check produces. */
function answered(verdict: ReuseVerdict): ReturnType<typeof prepareReuseStanding> {
  return prepareReuseStanding({ status: "read", value: verdict }, true);
}

/** A read that came back refused, which is an answer and not an unanswered question. */
const REFUSED_READING: ActPrerequisiteReading<ReuseVerdict> = {
  status: "refused",
  refusal: { code: "repo.unavailable", detail: "The mount did not answer.", origin: "repo reads" },
};

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
    // The precedence is the claim: the reverse order would put a consent control in
    // front of a candidate no consent can make bindable.
    expect(reuseVerdictFor(reply({ compatible: false, isClean: false })).kind).toBe("incompatible");
  });

  it("negative control: an absent `compatible` is not read as permission", () => {
    // The three verdict members are optional on the wire because they are meaningless
    // when nothing is available. Reading absence as yes consents for the daemon.
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

describe("prepareReuseStanding", () => {
  it("carries the answer a settled check gave", () => {
    const standing = answered(DIRTY_CANDIDATE);
    expect(standing.answered).toBe(true);
    expect(standing.verdict).toStrictEqual(DIRTY_CANDIDATE);
  });

  it("holds an unasked and an in-flight check apart from a decided negative", () => {
    // All three leave the verdict at `none` because there is no candidate to name — and
    // `answered` is the whole of what separates them from a check that came back empty.
    for (const reading of [{ status: "not-read" }, { status: "reading" }] as const) {
      const standing = prepareReuseStanding(reading, true);
      expect(standing.answered).toBe(false);
      expect(standing.verdict.kind).toBe("none");
    }
    expect(prepareReuseStanding({ status: "read", value: { kind: "none" } }, true).answered).toBe(
      true,
    );
  });

  it("answers for a mode that reuses nothing, whose check is never asked", () => {
    // A clone's reading sits at `not-read` for the life of the surface, so reading it
    // as a question in flight would close the clone control permanently.
    const standing = prepareReuseStanding({ status: "not-read" }, false);
    expect(standing.answered).toBe(true);
    expect(standing.verdict.kind).toBe("none");
  });

  it("negative control: a refused check answers rather than holding the form shut", () => {
    // The refusal is drawn under the field with its own recovery and the check cannot be
    // forced from here; the prepare's own typed refusal is the backstop.
    const standing = prepareReuseStanding(REFUSED_READING, true);
    expect(standing.answered).toBe(true);
    expect(standing.verdict.kind).toBe("none");
  });
});

describe("prepareFormVerdict", () => {
  it("asks for a branch first", () => {
    const verdict = prepareFormVerdict(EMPTY_PREPARE_FORM, answered({ kind: "none" }));
    expect(verdict.status === "incomplete" && verdict.because).toContain("branch");
  });

  it("sends an ordinary prepare with a branch and no candidate", () => {
    expect(prepareFormVerdict(form(), answered({ kind: "none" })).status).toBe("sendable");
  });

  it("holds a branch name past the contract's own bound, in the wire's units", () => {
    // Both prepare requests bound `branchName` at `WORKTREE_GIT_REF_MAX_LEN`, so without
    // this the control is open onto a schema failure naming a member path.
    const overCap = "b".repeat(WORKTREE_GIT_REF_MAX_LEN + 1);
    const verdict = prepareFormVerdict(
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
      prepareFormVerdict(
        { branchName: "b".repeat(WORKTREE_GIT_REF_MAX_LEN), acknowledgedCandidateId: undefined },
        answered({ kind: "none" }),
      ).status,
    ).toBe("sendable");
  });

  it("holds the act until the reuse check for that branch has answered", () => {
    // The defect this closes: `reading` folded into a no-candidate verdict, so a prepare
    // sent inside the debounce window omitted `reuseWorktreeId` for a branch that had a
    // candidate — an implicit collision the daemon refuses.
    const verdict = prepareFormVerdict(form(), prepareReuseStanding({ status: "reading" }, true));
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toBe(REUSE_UNANSWERED_COPY);
  });

  it("holds the act before any check has been asked at all", () => {
    expect(
      prepareFormVerdict(form(), prepareReuseStanding({ status: "not-read" }, true)).status,
    ).toBe("incomplete");
  });

  it("negative control: a mode that reuses nothing is not held by its unasked check", () => {
    expect(
      prepareFormVerdict(form(), prepareReuseStanding({ status: "not-read" }, false)).status,
    ).toBe("sendable");
  });

  it("holds a dirty candidate until the consent is given", () => {
    expect(prepareFormVerdict(form(), answered(DIRTY_CANDIDATE)).status).toBe("incomplete");
    expect(prepareFormVerdict(form(WORKTREE_ID), answered(DIRTY_CANDIDATE)).status).toBe(
      "sendable",
    );
  });

  it("holds a candidate the consent was not given for, though the branch never changed", () => {
    // A lifecycle refresh can retire one dirty checkout and serve another for the same
    // branch. Nothing a person typed changed, so a consent keyed on the branch text
    // would survive — and the prepare would send the NEW worktree's id under it.
    const verdict = prepareFormVerdict(form(WORKTREE_ID), answered(REPLACEMENT_DIRTY_CANDIDATE));
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain("uncommitted changes");
  });

  it("negative control: consent does not make an incompatible candidate sendable", () => {
    const verdict = prepareFormVerdict(
      form(WORKTREE_ID),
      answered({ kind: "incompatible", worktreeId: WORKTREE_ID, reason: undefined }),
    );
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toBe(
      REUSE_VERDICT_COPY.incompatible,
    );
  });
});

describe("prepareAcknowledgement", () => {
  it("carries the consent on the candidate that asked for it", () => {
    expect(prepareAcknowledgement(form(WORKTREE_ID), DIRTY_CANDIDATE)).toBe(true);
  });

  it("drops a consent the verdict no longer calls for, which a refresh can leave set", () => {
    // The checkbox is ticked under a `dirty` verdict, another participant commits, the
    // re-check settles `reusable`, and the checkbox unmounts with the consent recorded.
    expect(
      prepareAcknowledgement(form(WORKTREE_ID), { kind: "reusable", worktreeId: WORKTREE_ID }),
    ).toBe(false);
  });

  it("drops a consent given for a different tree, on a verdict that is still dirty", () => {
    // The half a `kind`-only test cannot see: the arm has not changed, the branch has
    // not changed, and the tree the person read about is gone.
    expect(prepareAcknowledgement(form(WORKTREE_ID), REPLACEMENT_DIRTY_CANDIDATE)).toBe(false);
  });

  it("negative control: no verdict but `dirty` carries one, consented or not", () => {
    expect(prepareAcknowledgement(form(WORKTREE_ID), { kind: "none" })).toBe(false);
    expect(
      prepareAcknowledgement(form(WORKTREE_ID), {
        kind: "incompatible",
        worktreeId: WORKTREE_ID,
        reason: undefined,
      }),
    ).toBe(false);
    expect(prepareAcknowledgement(form(), DIRTY_CANDIDATE)).toBe(false);
  });
});

describe("disposalSubjectFor", () => {
  it("keeps the two consequences apart", () => {
    // Retiring RECORDS a transition and the sweep removes the files afterwards;
    // disposing a clone brings forward a terminal it would have reached anyway. A
    // shared sentence would be wrong for one of them — and the wrong half is what a
    // person is consenting to.
    expect(DISPOSAL_CONSEQUENCE.worktree).not.toBe(DISPOSAL_CONSEQUENCE["ephemeral-clone"]);
    expect(DISPOSAL_CONSEQUENCE.worktree.trim().length).toBeGreaterThan(0);
    expect(DISPOSAL_CONSEQUENCE["ephemeral-clone"].trim().length).toBeGreaterThan(0);
  });

  it("states both disposals as recorded now and cleaned afterwards", () => {
    // `EphemeralCloneDisposeResponse.state` is the single literal `retired` and carries
    // no cleanup instant: dispose records the transition and the sweep removes the disk
    // afterwards, exactly as retire does. The clone's sentence used to say the files
    // were already gone, which made the ordinary post-dispose state read as a failure.
    for (const consequence of Object.values(DISPOSAL_CONSEQUENCE)) {
      expect(consequence).toContain("cleanup sweep afterwards");
      expect(consequence).toContain("ordinary state");
    }
  });

  it("negative control: neither consequence claims the bytes are already gone", () => {
    for (const consequence of Object.values(DISPOSAL_CONSEQUENCE)) {
      expect(consequence).not.toMatch(/are gone/);
    }
  });

  it("carries the kind and the id the act will send", () => {
    const subject = disposalSubjectFor("worktree", WORKTREE_ID);
    expect(subject.kind).toBe("worktree");
    expect(subject.rootId).toBe(WORKTREE_ID);
  });
});
