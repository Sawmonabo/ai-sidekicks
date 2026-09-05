// What a prepared proposal is allowed to say, held against the rules it was written
// from.
//
// The cases drive the real function and the real tables rather than stand-ins, and each
// clean assertion is paired with the case that would pass if the module stopped doing
// the thing — a totality claim is only meaningful beside the key that must not be in
// the table, and "inert display data" is only meaningful beside the value that would
// have arrived as something other than a string.

import { describe, expect, it } from "vitest";

import { GROWTH_PR_PREPARATION_STATES } from "../../bridge/index.js";
import {
  PROPOSAL_BLOB_UNRENDERABLE,
  PROPOSAL_MEMBERS_NOT_ON_THE_WIRE,
  PROPOSAL_MEMBER_UNSUPPLIED_COPY,
  isProposalState,
  proposalBlobRows,
  proposalContextKeyOf,
  proposalContextKeysMatch,
  type ProposalContextKey,
} from "./prepared-proposal.js";

describe("the proposal vocabularies — declared once, and closed where the wire closes them", () => {
  it("admits the wire's own words and refuses a host verdict", () => {
    // The vocabulary itself is the BRIDGE's — this family aliases it rather than
    // declaring a twin — so what is asserted here is the guard the gate reads it
    // through. A host-side state passing would let the gate report a proposal as open
    // or merged before anything reached a host.
    for (const state of GROWTH_PR_PREPARATION_STATES) {
      expect(isProposalState(state)).toBe(true);
    }
    expect(isProposalState("open")).toBe(false);
    expect(isProposalState("merged")).toBe(false);
  });

  it("negative control: the guard is not a typeof-string check", () => {
    // Without this, a guard that answered `true` for every string would pass the case
    // above's positive half and let any word the wire sent through.
    expect(isProposalState("")).toBe(false);
    expect(isProposalState(undefined)).toBe(false);
    expect(isProposalState({ state: "ready" })).toBe(false);
  });

  it("gives every unsupplied proposal member a sentence, and no key beyond them", () => {
    expect(Object.keys(PROPOSAL_MEMBER_UNSUPPLIED_COPY).sort()).toStrictEqual(
      [...PROPOSAL_MEMBERS_NOT_ON_THE_WIRE].sort(),
    );
  });
});

describe("proposalBlobRows — inert display data, never instructions", () => {
  it("renders every value as a string, whatever the producer sent", () => {
    const rows = proposalBlobRows({
      draft: false,
      labels: ["needs-review"],
      reviewers: { requested: 2 },
      title: "Wire the rate limiter",
    });
    for (const row of rows) {
      expect(typeof row.text).toBe("string");
    }
    expect(rows.map((row) => row.key)).toStrictEqual(["draft", "labels", "reviewers", "title"]);
  });

  it("passes a string value through verbatim rather than re-encoding it", () => {
    const rows = proposalBlobRows({ title: "Wire the rate limiter" });
    expect(rows[0]?.text).toBe("Wire the rate limiter");
  });

  it("sorts keys so two reads of one proposal draw the same rows", () => {
    const forward = proposalBlobRows({ alpha: 1, beta: 2 });
    const reversed = proposalBlobRows({ beta: 2, alpha: 1 });
    expect(forward).toStrictEqual(reversed);
  });

  it("states the fallback for a value that will not stringify", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(proposalBlobRows({ handler: () => undefined, ...cyclic })).toStrictEqual([
      { key: "handler", text: PROPOSAL_BLOB_UNRENDERABLE },
      { key: "self", text: PROPOSAL_BLOB_UNRENDERABLE },
    ]);
  });

  it("negative control: a key the console might act on arrives as text like every other", () => {
    // The whole point of the stringification. A caller cannot branch on a blob's
    // shape, so a key named for an act reaches the screen as the text of its value.
    const rows = proposalBlobRows({ action: { merge: true }, __html: "<script>" });
    expect(rows).toStrictEqual([
      { key: "__html", text: "<script>" },
      { key: "action", text: '{"merge":true}' },
    ]);
    for (const row of rows) {
      expect(typeof row.text).toBe("string");
    }
  });

  it("negative control: an absent blob is no rows rather than a row saying so", () => {
    expect(proposalBlobRows(undefined)).toStrictEqual([]);
  });
});

describe("the proposal's pairing with the context it was prepared for", () => {
  const PREPARED_UNDER: ProposalContextKey = {
    branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2301",
    baseBranch: "develop",
    headBranch: "feat/rate-limit-wiring",
  };

  it("takes only the three deciding members off a wider context reading", () => {
    // The key is what a holder compares, so it carries the mode, the upstream ref, and
    // the worktree id through no path — a proposal is not stale because a tracking ref
    // was set on the branch it was prepared against.
    expect(
      proposalContextKeyOf({
        ...PREPARED_UNDER,
        upstreamRef: "origin/feat/rate-limit-wiring",
        executionMode: "worktree",
        worktreeId: "019b7b30-0280-7c11-8420-b1a5c0de2020",
      } as ProposalContextKey & Record<string, unknown>),
    ).toStrictEqual(PREPARED_UNDER);
  });

  it("negative control: the same id over a moved branch is not a match", () => {
    // The whole reason the key is three members. A repair re-establishes the row over a
    // moved head, and an id-only comparison would call the old proposal current.
    expect(proposalContextKeysMatch(PREPARED_UNDER, PREPARED_UNDER)).toBe(true);
    expect(
      proposalContextKeysMatch(PREPARED_UNDER, {
        ...PREPARED_UNDER,
        headBranch: "feat/something-else",
      }),
    ).toBe(false);
    expect(
      proposalContextKeysMatch(PREPARED_UNDER, { ...PREPARED_UNDER, baseBranch: "main" }),
    ).toBe(false);
  });
});
