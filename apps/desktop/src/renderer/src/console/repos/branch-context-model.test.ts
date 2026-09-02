// What the branch-context reading decides, held against the rule it was written from.
//
// The cases drive the real function rather than a stand-in, and the clean readings are
// paired with the one that would pass if the function consulted the ids before the
// mode — which is the whole claim, since the ids are plain-optional on the wire and a
// stale one must not decide the answer.

import { describe, expect, it } from "vitest";

import {
  BRANCH_CONTEXT_ASSOCIATIONS,
  NO_BRANCH_CONTEXT_REASON,
  branchContextAssociationReading,
  type BranchContextReading,
} from "./branch-context-model.js";

function branchContext(overrides: Partial<BranchContextReading> = {}): BranchContextReading {
  return {
    branchContextId: "branch-context-01",
    baseBranch: "develop",
    headBranch: "sidekicks/abc123/rate-limit-wiring",
    executionMode: "worktree",
    worktreeId: "worktree-01",
    ...overrides,
  };
}

describe("BRANCH_CONTEXT_ASSOCIATIONS — closed at three", () => {
  it("names the three bindings and no fourth", () => {
    expect([...BRANCH_CONTEXT_ASSOCIATIONS]).toStrictEqual([
      "worktree",
      "ephemeral-clone",
      "in-place",
    ]);
  });

  it("negative control: `read-only` is a mode and never an association", () => {
    // A workspace with no writable context has no binding to name, so a member for it
    // would be the console asserting a root that does not exist.
    expect([...BRANCH_CONTEXT_ASSOCIATIONS]).not.toContain("read-only");
  });
});

describe("branchContextAssociationReading — the mode decides, never the id", () => {
  it("reads a worktree-mode context as its worktree", () => {
    const reading = branchContextAssociationReading(branchContext());
    expect(reading.association).toBe("worktree");
    expect(reading.boundId).toBe("worktree-01");
  });

  it("reads an ephemeral-clone-mode context as its clone", () => {
    const reading = branchContextAssociationReading(
      branchContext({
        executionMode: "ephemeral clone",
        worktreeId: undefined,
        ephemeralCloneId: "clone-07",
      }),
    );
    expect(reading.association).toBe("ephemeral-clone");
    expect(reading.boundId).toBe("clone-07");
  });

  it("reads a branch-mode context as bound in place, with no id at all", () => {
    const reading = branchContextAssociationReading(
      branchContext({ executionMode: "branch", worktreeId: undefined }),
    );
    expect(reading.association).toBe("in-place");
    expect(reading.boundId).toBeUndefined();
  });

  it("negative control: a stale id on a branch-mode context does not decide the reading", () => {
    // The ids are plain-optional on the wire because which set is lawful depends on
    // the mode, so a reading that consulted them first would report a re-selected
    // context as still bound to the root it left.
    const reading = branchContextAssociationReading(
      branchContext({ executionMode: "branch", worktreeId: "worktree-01" }),
    );
    expect(reading.association).toBe("in-place");
    expect(reading.boundId).toBeUndefined();
  });
});

describe("NO_BRANCH_CONTEXT_REASON — read-only is the only mode that produces none", () => {
  it("names read-only's own reason, and names the side effects it does not produce", () => {
    const reason = NO_BRANCH_CONTEXT_REASON["read-only"];
    expect(reason).toBeDefined();
    expect(reason).toContain("read-only");
    expect(reason).toContain("preparation side effects");
  });

  it("negative control: no writable mode carries a reason, because none produces none", () => {
    // A table over all four modes would have had to invent three sentences that are
    // never true. Their absence is what routes a writable mode to the unread copy.
    expect(NO_BRANCH_CONTEXT_REASON.branch).toBeUndefined();
    expect(NO_BRANCH_CONTEXT_REASON.worktree).toBeUndefined();
    expect(NO_BRANCH_CONTEXT_REASON["ephemeral clone"]).toBeUndefined();
  });
});

describe("NO_BRANCH_CONTEXT_REASON — read-only is the only mode that produces none", () => {
  it("names read-only's own reason, and names the side effects it does not produce", () => {
    const reason = NO_BRANCH_CONTEXT_REASON["read-only"];
    expect(reason).toBeDefined();
    expect(reason).toContain("read-only");
    expect(reason).toContain("preparation side effects");
  });

  it("negative control: no writable mode carries a reason, because none produces none", () => {
    // A table over all four modes would have had to invent three sentences that are
    // never true. Their absence is what routes a writable mode to the unread copy.
    expect(NO_BRANCH_CONTEXT_REASON.branch).toBeUndefined();
    expect(NO_BRANCH_CONTEXT_REASON.worktree).toBeUndefined();
    expect(NO_BRANCH_CONTEXT_REASON["ephemeral clone"]).toBeUndefined();
  });
});
