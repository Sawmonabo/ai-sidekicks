// The mapping, the vocabulary, and the one absence rule they share.
//
// The mapper's whole job is that an ABSENT wire member stays absent rather than
// becoming an explicit `undefined` or a default, so every case here reads the key
// set and not just the values: `"upstreamRef" in reading` is the assertion, because
// a shape carrying `upstreamRef: undefined` type-checks identically and renders as a
// context whose upstream was read and found empty.

import { describe, expect, it } from "vitest";

import {
  ANNOUNCED_GATE_SETTLEMENTS,
  BRANCH_ROOT_UNADDRESSABLE_COPY,
  EPHEMERAL_CLONE_UNADDRESSABLE_COPY,
  GATE_SETTLEMENT_COPY,
  PROPOSAL_GATE_REFUSAL_CODES,
  PROPOSAL_GATE_SUBJECT_KINDS,
  branchContextReadPlanFor,
  branchContextReadingFrom,
  branchRootGateSubject,
  ephemeralCloneGateSubject,
} from "./proposal-gate-model.js";

const WIRE_CONTEXT = {
  branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2301",
  workspaceId: "019b7b30-0280-7c11-8420-b1a5c0de2005",
  baseBranch: "develop",
  headBranch: "feat/rate-limit-wiring",
};

describe("branchContextReadingFrom", () => {
  it("carries the four branch values verbatim and takes the mode from the caller", () => {
    const reading = branchContextReadingFrom(
      { ...WIRE_CONTEXT, upstreamRef: "origin/feat/rate-limit-wiring" },
      "worktree",
    );
    expect(reading.baseBranch).toBe("develop");
    expect(reading.headBranch).toBe("feat/rate-limit-wiring");
    expect(reading.upstreamRef).toBe("origin/feat/rate-limit-wiring");
    expect(reading.executionMode).toBe("worktree");
  });

  it("drops the workspace id rather than carrying a second copy of the row it sits in", () => {
    expect("workspaceId" in branchContextReadingFrom(WIRE_CONTEXT, "branch")).toBe(false);
  });

  it("leaves an absent association absent rather than present-and-undefined", () => {
    const reading = branchContextReadingFrom(WIRE_CONTEXT, "branch");
    // `branch` mode binds neither root, and an explicit `undefined` here would draw
    // an empty association slot — a missing value rather than the mode's own answer.
    expect("worktreeId" in reading).toBe(false);
    expect("ephemeralCloneId" in reading).toBe(false);
    expect("upstreamRef" in reading).toBe(false);
  });

  it("negative control: a supplied association IS present", () => {
    // Without this, the case above would pass against a mapper that dropped the
    // optional members entirely.
    const reading = branchContextReadingFrom(
      { ...WIRE_CONTEXT, worktreeId: "019b7b30-0280-7c11-8420-b1a5c0de2020" },
      "worktree",
    );
    expect("worktreeId" in reading).toBe(true);
    expect(reading.worktreeId).toBe("019b7b30-0280-7c11-8420-b1a5c0de2020");
  });
});

describe("the gate's own vocabularies", () => {
  it("announces every settlement it declares, and declares no sentence twice", () => {
    expect(Object.keys(GATE_SETTLEMENT_COPY).sort()).toStrictEqual(
      [...ANNOUNCED_GATE_SETTLEMENTS].sort(),
    );
    const sentences = Object.values(GATE_SETTLEMENT_COPY);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("announces nothing for the unregistered-wire arm, whose sentence is the port's", () => {
    // The one arm deliberately absent from the table: rule 9 forbids paraphrasing a
    // refusal the console did not author, so that arm announces the refusal verbatim.
    expect(ANNOUNCED_GATE_SETTLEMENTS).not.toContain("not-checked");
  });

  it("owns the codes the gate authors, and none collides with another author's", () => {
    expect([...PROPOSAL_GATE_REFUSAL_CODES]).toStrictEqual([
      "no-served-context",
      "action-not-accepted",
      "action-in-flight",
      "subject-not-addressable",
      "context-superseded",
      "prepared-state-unreadable",
      "read-threw",
    ]);
    // The growth port's own vocabulary reaches this gate on every refused call and on
    // every REJECTED one — both come through `repos/growth-call.ts` — and the family's
    // daemon reads have a third. A set that admitted either would claim authorship of a
    // refusal this sub-module never mints.
    expect(PROPOSAL_GATE_REFUSAL_CODES).not.toContain("wire-unregistered");
    expect(PROPOSAL_GATE_REFUSAL_CODES).not.toContain("call-rejected");
  });
});

describe("branchContextReadPlanFor", () => {
  it("asks about a worktree root under the two keys the registered request takes", () => {
    const plan = branchContextReadPlanFor({
      kind: "worktree",
      workspaceId: "019b7b30-0280-7c11-8420-b1a5c0de2005",
      repoMountId: "019b7b30-0280-7c11-8420-b1a5c0de2003",
      worktreeId: "019b7b30-0280-7c11-8420-b1a5c0de2020",
      executionMode: "worktree",
    });
    expect(plan).toStrictEqual({
      kind: "askable",
      request: {
        workspaceId: "019b7b30-0280-7c11-8420-b1a5c0de2005",
        worktreeId: "019b7b30-0280-7c11-8420-b1a5c0de2020",
      },
    });
  });

  it("refuses to ask about the two roots the registered request has no arm for", () => {
    // The whole point of the plan: an in-place root and a clone root are drawn, and
    // the question about them is NOT PUT — rather than put under the workspace id
    // alone, which is a request shape no producer accepts.
    const branchRoot = branchContextReadPlanFor({
      kind: "branch-root",
      workspaceId: "019b7b30-0280-7c11-8420-b1a5c0de2005",
      repoMountId: "019b7b30-0280-7c11-8420-b1a5c0de2003",
      executionMode: "branch",
    });
    const cloneRoot = branchContextReadPlanFor({
      kind: "ephemeral-clone",
      workspaceId: "019b7b30-0280-7c11-8420-b1a5c0de2005",
      repoMountId: "019b7b30-0280-7c11-8420-b1a5c0de2003",
      cloneId: "019b7b30-0280-7c11-8420-b1a5c0de2040",
      executionMode: "ephemeral clone",
    });
    expect(branchRoot).toStrictEqual({
      kind: "unaddressable",
      reason: BRANCH_ROOT_UNADDRESSABLE_COPY,
    });
    expect(cloneRoot).toStrictEqual({
      kind: "unaddressable",
      reason: EPHEMERAL_CLONE_UNADDRESSABLE_COPY,
    });
    // Two roots, two reasons: a clone HAS an identifier and it is on the wrong side
    // of the call, which is a different fact from a root that has none at all.
    expect(BRANCH_ROOT_UNADDRESSABLE_COPY).not.toBe(EPHEMERAL_CLONE_UNADDRESSABLE_COPY);
  });

  it("negative control: no plan carries a key the registered request does not take", () => {
    // Without this, the two cases above would pass against a builder that quietly put
    // `cloneId` or a bare `workspaceId` on the request and called it askable.
    const plans = PROPOSAL_GATE_SUBJECT_KINDS.map((kind) =>
      branchContextReadPlanFor(
        kind === "worktree"
          ? {
              kind,
              workspaceId: "workspace-1",
              repoMountId: "mount-1",
              worktreeId: "root-a",
              executionMode: "worktree",
            }
          : kind === "branch-root"
            ? { kind, workspaceId: "workspace-1", repoMountId: "mount-1", executionMode: "branch" }
            : {
                kind,
                workspaceId: "workspace-1",
                repoMountId: "mount-1",
                cloneId: "clone-a",
                executionMode: "ephemeral clone",
              },
      ),
    );
    const askable = plans.filter((plan) => plan.kind === "askable");
    expect(askable).toHaveLength(1);
    expect(Object.keys(askable[0]?.request ?? {}).sort()).toStrictEqual([
      "workspaceId",
      "worktreeId",
    ]);
  });
});

describe("the two subjects built straight from the row they belong to", () => {
  it("builds an in-place root from the workspace alone, mode wire-verbatim", () => {
    expect(
      branchRootGateSubject({
        id: "workspace-1",
        repoMountId: "mount-1",
        executionMode: "branch",
      }),
    ).toStrictEqual({
      kind: "branch-root",
      workspaceId: "workspace-1",
      // The mount an act names on the wire, straight off the row this subject IS.
      repoMountId: "mount-1",
      executionMode: "branch",
    });
  });

  it("takes a clone's mode from the roster row the clone itself names", () => {
    const subject = ephemeralCloneGateSubject({ cloneId: "clone-a", workspaceId: "workspace-2" }, [
      { id: "workspace-1", repoMountId: "mount-1", executionMode: "branch" },
      { id: "workspace-2", repoMountId: "mount-2", executionMode: "ephemeral clone" },
    ]);
    expect(subject).toStrictEqual({
      kind: "ephemeral-clone",
      workspaceId: "workspace-2",
      // The clone row names no mount at all, so both the mode and the mount come from
      // the roster row it names — one lookup, and never the first row in the list.
      repoMountId: "mount-2",
      cloneId: "clone-a",
      executionMode: "ephemeral clone",
    });
  });

  it("has no subject where the roster names no such workspace", () => {
    // A mode chosen here would be a guess rendered as a reading — the pairing
    // module's rule, applied to the one relation a clone list can be missing.
    expect(
      ephemeralCloneGateSubject({ cloneId: "clone-a", workspaceId: "workspace-2" }, [
        { id: "workspace-1", repoMountId: "mount-1", executionMode: "branch" },
      ]),
    ).toBeUndefined();
  });
});
