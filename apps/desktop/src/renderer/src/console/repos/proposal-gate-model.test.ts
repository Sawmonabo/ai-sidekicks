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
  GATE_SETTLEMENT_COPY,
  PROPOSAL_GATE_REFUSAL_CODES,
  branchContextReadingFrom,
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

  it("owns three refusal codes and none collides with the port's own", () => {
    expect([...PROPOSAL_GATE_REFUSAL_CODES]).toStrictEqual([
      "no-served-context",
      "action-not-accepted",
      "action-in-flight",
    ]);
    expect(PROPOSAL_GATE_REFUSAL_CODES).not.toContain("wire-unregistered");
  });
});
