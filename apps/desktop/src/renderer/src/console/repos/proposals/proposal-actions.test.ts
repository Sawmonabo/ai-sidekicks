// What the gate may offer, held against the rules the offers were written from.
//
// The cases drive the real tuple, the real tables, and the real rule rather than
// stand-ins, and each clean assertion is paired with the case that would pass if the
// module stopped doing the thing — a totality claim is only meaningful beside the key
// that must not be in the table, and "the remote act is withheld" is only meaningful
// beside the arm that must offer it.

import { describe, expect, it } from "vitest";

import type { BranchContextReading } from "../mounts/branch-context-model.js";
import type { PreparedProposal } from "./prepared-proposal.js";
import {
  GIT_ACTION_PROPOSAL_ACTIONS,
  PROPOSAL_ACTIONS,
  PROPOSAL_ACTION_HEAD_EFFECT,
  PROPOSAL_ACTION_PRESENTATION,
  PROPOSAL_ACTION_REACH,
  PROPOSAL_NOT_SENDABLE_COPY,
  offeredProposalActions,
  reachesGitAction,
  withheldRemoteActionCopy,
} from "./proposal-actions.js";
import type { ProposalGateState } from "./proposal-gate-state.js";

const BRANCH_CONTEXT: BranchContextReading = {
  branchContextId: "branch-context-01",
  baseBranch: "develop",
  headBranch: "sidekicks/abc123/rate-limit-wiring",
  executionMode: "worktree",
  worktreeId: "worktree-01",
};

/** A proposal a person may send. The one state that admits the remote act. */
const READY_PROPOSAL: PreparedProposal = {
  baseBranch: "develop",
  headBranch: "sidekicks/abc123/rate-limit-wiring",
  state: "ready",
};

/** The same proposal still being assembled, which is the state that must not send. */
const DRAFT_PROPOSAL: PreparedProposal = { ...READY_PROPOSAL, state: "draft" };

/**
 * One state per arm, total by construction — a sixth arm does not compile until it has
 * a sample here, which is what makes the sweep below a claim about every arm rather than
 * about the four somebody remembered.
 */
const STATE_PER_ARM: Readonly<Record<ProposalGateState["kind"], ProposalGateState>> = {
  "not-checked": { kind: "not-checked" },
  preparing: { kind: "preparing" },
  prepared: { kind: "prepared", context: BRANCH_CONTEXT, proposal: READY_PROPOSAL },
  "hosting-unavailable": {
    kind: "hosting-unavailable",
    context: BRANCH_CONTEXT,
    proposal: READY_PROPOSAL,
    bundlePath: "/tmp/sidekicks/proposal-01.bundle",
  },
  refused: { kind: "refused", message: "gh: not authenticated" },
};

const PREPARED_WITHOUT_PROPOSAL: ProposalGateState = {
  kind: "prepared",
  context: BRANCH_CONTEXT,
};

const PREPARED_WITH_DRAFT: ProposalGateState = {
  kind: "prepared",
  context: BRANCH_CONTEXT,
  proposal: DRAFT_PROPOSAL,
};

describe("the modelled actions — declared once, and closed where the spec closes them", () => {
  it("offers three modelled actions and no fourth", () => {
    expect([...PROPOSAL_ACTIONS].sort()).toStrictEqual(["commit", "prepare-proposal", "push"]);
  });

  it("puts preparation before the act that reaches the host", () => {
    // `Spec-011 §Interfaces And Contracts`: a reviewable proposal exists before any
    // remote mutation. The tuple is the gate's own order, so the pipeline reads down it.
    expect(PROPOSAL_ACTIONS.indexOf("prepare-proposal")).toBeLessThan(
      PROPOSAL_ACTIONS.indexOf("push"),
    );
  });

  it("negative control: no act that reaches the host precedes a local one", () => {
    // Without this, the ordering above could hold while some later remote act sat first.
    // The old order put `push` second and `prepare-proposal` last, and fails here.
    const firstRemote = PROPOSAL_ACTIONS.findIndex(
      (action) => PROPOSAL_ACTION_REACH[action] === "remote",
    );
    const lastLocal = PROPOSAL_ACTIONS.map((action) => PROPOSAL_ACTION_REACH[action]).lastIndexOf(
      "local",
    );
    expect(firstRemote).toBeGreaterThan(lastLocal);
  });

  it("gives every action a presentation and a reach, and no key beyond them", () => {
    expect(Object.keys(PROPOSAL_ACTION_PRESENTATION).sort()).toStrictEqual(
      [...PROPOSAL_ACTIONS].sort(),
    );
    expect(Object.keys(PROPOSAL_ACTION_REACH).sort()).toStrictEqual([...PROPOSAL_ACTIONS].sort());
  });

  it("negative control: exactly one act is classified as reaching the host", () => {
    // A table that called everything `local` would satisfy the totality claim above and
    // would offer the send on every arm.
    const remoteActions = PROPOSAL_ACTIONS.filter(
      (action) => PROPOSAL_ACTION_REACH[action] === "remote",
    );
    expect(remoteActions).toStrictEqual(["push"]);
  });
});

describe("offeredProposalActions — the remote act waits for a reviewable proposal", () => {
  it("offers only the local acts on a prepared arm carrying no proposal", () => {
    expect(offeredProposalActions(PREPARED_WITHOUT_PROPOSAL)).toStrictEqual([
      "commit",
      "prepare-proposal",
    ]);
  });

  it("offers the remote act once a proposal is prepared, and after preparation", () => {
    const offered = offeredProposalActions(STATE_PER_ARM.prepared);
    expect(offered).toStrictEqual(["commit", "prepare-proposal", "push"]);
    expect(offered.indexOf("prepare-proposal")).toBeLessThan(offered.indexOf("push"));
  });

  it("negative control: the arm with no proposal offers no act that reaches the host", () => {
    // The counterpart to the case above, stated on the reach rather than on the name, so
    // a second remote act added to the tuple is covered by this case as it stands.
    const offered = offeredProposalActions(PREPARED_WITHOUT_PROPOSAL);
    expect(offered.filter((action) => PROPOSAL_ACTION_REACH[action] === "remote")).toStrictEqual(
      [],
    );
  });

  it("offers nothing at all on every arm that is not prepared", () => {
    for (const [kind, state] of Object.entries(STATE_PER_ARM)) {
      if (kind === "prepared") {
        continue;
      }
      expect(offeredProposalActions(state)).toStrictEqual([]);
    }
  });

  it("negative control: the sweep above is not a rule that offers nothing anywhere", () => {
    // Without this, a function that returned the empty list unconditionally would pass
    // every case in the sweep and leave the gate with no acts at all.
    expect(offeredProposalActions(STATE_PER_ARM.prepared).length).toBeGreaterThan(0);
  });
});

describe("offeredProposalActions — a draft is a proposal that cannot be sent", () => {
  it("offers only the local acts while the proposal is still being assembled", () => {
    // Presence is not reviewability: the wire tells `draft` from `ready`, and a rule
    // that read presence alone sent a payload the daemon had not finished building.
    expect(offeredProposalActions(PREPARED_WITH_DRAFT)).toStrictEqual([
      "commit",
      "prepare-proposal",
    ]);
  });

  it("negative control: the same proposal marked ready offers the act that reaches the host", () => {
    // Without this the case above would pass against a rule that never offered the
    // send at all, which would make the whole gate local-only.
    expect(offeredProposalActions(STATE_PER_ARM.prepared)).toContain("push");
  });

  it("says why the send is absent while a proposal is on screen, and only then", () => {
    expect(withheldRemoteActionCopy(PREPARED_WITH_DRAFT)).toBe(PROPOSAL_NOT_SENDABLE_COPY);
    // A ready proposal offers the send, so there is nothing to explain.
    expect(withheldRemoteActionCopy(STATE_PER_ARM.prepared)).toBeUndefined();
    // An arm with no proposal already renders its own empty state; a second sentence
    // under it would word one absence twice.
    expect(withheldRemoteActionCopy(PREPARED_WITHOUT_PROPOSAL)).toBeUndefined();
  });

  it("negative control: no arm that offers no act at all carries the sentence", () => {
    // Without this, a sentence composed from the proposal alone would print under
    // `refused` and `hosting-unavailable`, where no act is drawn for it to explain.
    for (const [kind, state] of Object.entries(STATE_PER_ARM)) {
      if (kind === "prepared") {
        continue;
      }
      expect(withheldRemoteActionCopy(state)).toBeUndefined();
    }
  });
});

describe("PROPOSAL_ACTION_HEAD_EFFECT — what an accepted act leaves of a proposal", () => {
  it("gives every action a head effect and no key beyond them", () => {
    expect(Object.keys(PROPOSAL_ACTION_HEAD_EFFECT).sort()).toStrictEqual(
      [...PROPOSAL_ACTIONS].sort(),
    );
  });

  it("negative control: exactly one act is classified as moving the head", () => {
    // A table that called everything `leaves-head` would satisfy the totality claim
    // above and would let a commit leave its obsolete proposal standing.
    const movers = PROPOSAL_ACTIONS.filter(
      (action) => PROPOSAL_ACTION_HEAD_EFFECT[action] === "moves-head",
    );
    expect(movers).toStrictEqual(["commit"]);
  });
});

describe("GIT_ACTION_PROPOSAL_ACTIONS — which acts reach the git action", () => {
  it("partitions the closed action set, leaving exactly the preparation call behind", () => {
    // The two sets are declared independently — the whole tuple in one place, this
    // subset in another — so this holds them against each other rather than trusting
    // that they agree. A fourth act added to `PROPOSAL_ACTIONS` and to neither side of
    // this partition fails here rather than being routed to a wire by default.
    const routedElsewhere = PROPOSAL_ACTIONS.filter((action) => !reachesGitAction(action));

    expect([...GIT_ACTION_PROPOSAL_ACTIONS].sort()).toStrictEqual(["commit", "push"]);
    expect(routedElsewhere).toStrictEqual(["prepare-proposal"]);
    expect(GIT_ACTION_PROPOSAL_ACTIONS.length + routedElsewhere.length).toBe(
      PROPOSAL_ACTIONS.length,
    );
  });

  it("negative control: the guard rejects the act that is not on that wire", () => {
    // Without this, a guard that answered `true` for everything would satisfy the
    // subset assertion above while handing the preparation act to the request builder.
    expect(reachesGitAction("prepare-proposal")).toBe(false);
    expect(reachesGitAction("commit")).toBe(true);
    expect(reachesGitAction("push")).toBe(true);
  });
});
