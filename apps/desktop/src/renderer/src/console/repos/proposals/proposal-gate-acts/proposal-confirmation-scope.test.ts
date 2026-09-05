// What counts as the same thing to confirm, and what does not.
//
// Driven directly rather than through the gate, which is the point of the scope being
// a value: the component's job is to compare two of these, and a case that had to
// render a gate to find out whether two proposals are the same payload would be
// asserting about React rather than about the payload.

import { describe, expect, it } from "vitest";

import type { PreparedProposal } from "../prepared-proposal.js";
import { proposalConfirmationScope } from "./proposal-confirmation-scope.js";
import { PROPOSAL_ACTIONS } from "../proposal-actions.js";

const PROPOSAL: PreparedProposal = {
  baseBranch: "develop",
  headBranch: "sidekicks/abc123/rate-limit-wiring",
  state: "ready",
  blob: { summary: "the rate limiter" },
};

/** The offered set a `ready` proposal produces: every act, the send included. */
const EVERY_ACT = [...PROPOSAL_ACTIONS];

describe("proposalConfirmationScope", () => {
  it("is the same for a re-read that served the same arm", () => {
    // A refresh publishes a fresh object every time, so a scope that compared
    // identities would close an open confirmation on every read of the same thing.
    expect(proposalConfirmationScope(EVERY_ACT, { ...PROPOSAL })).toBe(
      proposalConfirmationScope(EVERY_ACT, { ...PROPOSAL, blob: { ...PROPOSAL.blob } }),
    );
  });

  it("changes when the offered acts change", () => {
    expect(proposalConfirmationScope(["commit", "prepare-proposal"], PROPOSAL)).not.toBe(
      proposalConfirmationScope(EVERY_ACT, PROPOSAL),
    );
  });

  it("changes when a different proposal reaches the same offered acts", () => {
    // The case the offered set cannot see: preparing again over the same context and
    // the same branches leaves every act offered and the payload replaced.
    expect(
      proposalConfirmationScope(EVERY_ACT, { ...PROPOSAL, blob: { summary: "something else" } }),
    ).not.toBe(proposalConfirmationScope(EVERY_ACT, PROPOSAL));
  });

  it("negative control: an absent proposal is not the same as a proposal", () => {
    // Without this, a scope that ignored the payload would satisfy the first case and
    // treat an arm with nothing prepared as the arm that has something to send.
    expect(proposalConfirmationScope(EVERY_ACT, undefined)).not.toBe(
      proposalConfirmationScope(EVERY_ACT, PROPOSAL),
    );
  });
});
