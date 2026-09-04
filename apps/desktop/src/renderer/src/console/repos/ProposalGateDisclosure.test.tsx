// The collapsed line, which is the only thing most participants ever read of a gate.
//
// Gates are collapsed by default and their read starts on mount, so this one sentence
// is a READING rather than an invitation to click — and it has to be true about every
// arm, about a root nobody can ask about, and about both states the wire's own
// preparation vocabulary admits. The cases live beside the module that composes the
// line rather than beside a row that mounts it: three rows mount this disclosure, and
// a sentence checked under one of them would be checked once for all three by
// accident.

import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { PROPOSAL_STATES, type ProposalState } from "./prepared-proposal.js";
import { gateSummaryLine } from "./ProposalGateDisclosure.js";
import { SUBJECT_NOT_ADDRESSABLE } from "./proposal-gate-model.js";
import type { ProposalGateReading } from "./proposal-gate-reader.js";
import type { ProposalGateState } from "./proposal-gate-state.js";
import type { BranchContextReading } from "./branch-context-model.js";

/** A reading on one arm, with nothing beside it. */
function reading(state: ProposalGateState): ProposalGateReading {
  return {
    state,
    refusal: undefined,
    actionRefusals: new Map(),
    inFlightAction: undefined,
    settlement: undefined,
  };
}

/** The context a prepared arm carries. Its contents decide nothing about the line. */
const CONTEXT: BranchContextReading = {
  branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2301",
  baseBranch: "develop",
  headBranch: "feat/rate-limit-wiring",
  executionMode: "worktree",
};

/** A prepared arm holding a proposal in one of the two states the wire serves. */
function preparedWithProposal(state: ProposalState): ProposalGateReading {
  return reading({
    kind: "prepared",
    context: CONTEXT,
    proposal: {
      baseBranch: CONTEXT.baseBranch,
      headBranch: CONTEXT.headBranch,
      state,
    },
  });
}

describe("gateSummaryLine", () => {
  it("gives every arm its own line, and none of them a number nothing read", () => {
    expect(gateSummaryLine(reading({ kind: "not-checked" }))).toBe("not checked");
    expect(gateSummaryLine(reading({ kind: "preparing" }))).toBe("reading");
    expect(gateSummaryLine(reading({ kind: "refused", message: "the daemon said no" }))).toBe(
      "refused",
    );
  });

  it("separates a root nobody can ask about from one nobody has asked about yet", () => {
    // Both are `not-checked`, and only one of them will ever become anything else — so
    // a shared line would invite a wait for an answer that is not coming.
    const unaddressable: ProposalGateReading = {
      ...reading({ kind: "not-checked" }),
      refusal: refuse("proposal-gate", SUBJECT_NOT_ADDRESSABLE, "no key for this root"),
    };
    expect(gateSummaryLine(unaddressable)).toBe("not addressable");
  });

  it("negative control: another refusal on the same arm still reads as not checked", () => {
    // Without this the case above would pass against a line that said "not addressable"
    // for every refusal, including the unregistered wire — which IS a question that
    // gets answered once the wire lands.
    const unregistered: ProposalGateReading = {
      ...reading({ kind: "not-checked" }),
      refusal: refuse("growth-port", "wire-unregistered", "not registered yet"),
    };
    expect(gateSummaryLine(unregistered)).toBe("not checked");
  });
});

describe("gateSummaryLine — a proposal that is not finished", () => {
  it("does not call a draft ready, which the open gate already refuses to do", () => {
    // The whole defect: the open gate withholds Push on a draft, and the collapsed
    // line — which is what a participant reads without opening anything — reported
    // every present proposal as ready.
    expect(gateSummaryLine(preparedWithProposal("draft"))).toBe("proposal in draft");
    expect(gateSummaryLine(preparedWithProposal("ready"))).toBe("proposal ready");
  });

  it("gives every state the wire serves a line of its own", () => {
    // Over the closed set rather than the two spelled above, so a third state cannot
    // arrive and quietly read as one of them.
    const lines = PROPOSAL_STATES.map((state) => gateSummaryLine(preparedWithProposal(state)));
    expect(new Set(lines).size).toBe(PROPOSAL_STATES.length);
    for (const line of lines) {
      expect(line).not.toBe("");
    }
  });

  it("negative control: a context with no proposal says so, and names no state", () => {
    // Without this a fix that stamped a state line onto the prepared arm would report
    // a proposal for a gate that has read a context and prepared nothing.
    expect(gateSummaryLine(reading({ kind: "prepared", context: CONTEXT }))).toBe(
      "context read, no proposal",
    );
  });
});
