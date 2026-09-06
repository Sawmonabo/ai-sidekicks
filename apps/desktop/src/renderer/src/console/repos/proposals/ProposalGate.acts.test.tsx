// The gate's acts: which are offered, which are held, and what a press must state
// before it happens.
//
// WHAT THE GATE DRAWS BEFORE ANY PRESS is `ProposalGate.test.tsx` — the absences, the
// two branch names, the status trichotomies, and the prepared proposal. Every case
// here is about a control: whether it is there, whether it is reachable, and what the
// participant is told when it is not.
//
// OFFERED, NEVER PROJECTED. The gate renders the acts the daemon's own reading admits
// and refuses to infer a fourth from the three it has, which is the claim the first
// block below exists to hold: a surface that decided for itself which act was
// available would be a second source of truth for a decision the daemon makes.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../../core/index.js";
import { ProposalGate } from "./ProposalGate.js";
import type { BranchContextReading } from "../mounts/branch-context-model.js";
import { type PreparedProposal } from "./prepared-proposal.js";
import {
  PROPOSAL_ACTION_PRESENTATION,
  PROPOSAL_NOT_SENDABLE_COPY,
  offeredProposalActions,
  type ProposalAction,
} from "./proposal-actions.js";
import type { ProposalGateState } from "./proposal-gate-state.js";

const BRANCH_CONTEXT: BranchContextReading = {
  branchContextId: "branch-context-01",
  baseBranch: "develop",
  headBranch: "sidekicks/abc123/rate-limit-wiring",
  upstreamRef: "origin/sidekicks/abc123/rate-limit-wiring",
  executionMode: "worktree",
  worktreeId: "worktree-01",
};

/**
 * A proposal a person may send.
 *
 * `ready` rather than `draft`, and the distinction is the surface's: only a `ready`
 * proposal admits the act that reaches the host, so a fixture marked `draft` would
 * have made every "the send is offered" case below assert the opposite of the rule.
 */
const PROPOSAL: PreparedProposal = {
  title: "Wire the rate limiter",
  body: "Adds the concurrency cap to the subscribe path.",
  baseBranch: "develop",
  headBranch: "sidekicks/abc123/rate-limit-wiring",
  state: "ready",
  trailers: ["Co-Authored-By: a sidekick"],
  changedPaths: ["packages/control-plane/src/rate-limit.ts"],
};

/** The same proposal still being assembled. */
const DRAFT_PROPOSAL: PreparedProposal = { ...PROPOSAL, state: "draft" };

const PREPARED_STATE: ProposalGateState = {
  kind: "prepared",
  context: BRANCH_CONTEXT,
  detectedHost: "github",
  proposal: PROPOSAL,
};

describe("ProposalGate — three acts, offered, never projected", () => {
  it("renders exactly the acts the rule offers, in that order", () => {
    // The offered set is the model's, so this holds the DOM against it rather than
    // against a list written twice. Each act carries its own confirm pair, opened one at
    // a time, so the closed surface carries exactly one control per offered act.
    const { container } = render(<ProposalGate state={PREPARED_STATE} onRequestAction={vi.fn()} />);
    const actionGroup = within(within(container).getByRole("group", { name: "Git actions" }));
    expect(actionGroup.getAllByRole("button").map((button) => button.textContent)).toStrictEqual(
      offeredProposalActions(PREPARED_STATE).map(
        (action) => PROPOSAL_ACTION_PRESENTATION[action].label,
      ),
    );
  });

  it("withholds the act that reaches the host until a proposal has been prepared", () => {
    // `Spec-011 §Interfaces And Contracts`: a reviewable proposal exists before any
    // remote mutation. With none prepared there is nothing to send, so the send is not
    // offered — a confirmable Push here would approve a payload never drawn.
    const { container } = render(
      <ProposalGate state={{ ...PREPARED_STATE, proposal: undefined }} onRequestAction={vi.fn()} />,
    );
    const actionGroup = within(within(container).getByRole("group", { name: "Git actions" }));
    expect(actionGroup.queryByRole("button", { name: "Push" })).toBeNull();
    expect(actionGroup.getByRole("button", { name: "Prepare proposal" })).toBeDefined();
  });

  it("negative control: the same arm with a proposal prepared offers the send, after it", () => {
    // Without this, the withholding above could be a gate that never offers the send at
    // all. The order is asserted with it, because the offer and the sequence are one rule.
    const { container } = render(<ProposalGate state={PREPARED_STATE} onRequestAction={vi.fn()} />);
    const actionGroup = within(within(container).getByRole("group", { name: "Git actions" }));
    const labels = actionGroup.getAllByRole("button").map((button) => button.textContent);
    expect(labels).toContain("Push");
    expect(labels.indexOf("Prepare proposal")).toBeLessThan(labels.indexOf("Push"));
  });

  it("states the consequence before the act and only sends on the second press", () => {
    const onRequestAction = vi.fn<(action: ProposalAction) => void>();
    const { container } = render(
      <ProposalGate state={PREPARED_STATE} onRequestAction={onRequestAction} />,
    );
    const gate = within(container);
    fireEvent.click(gate.getByRole("button", { name: "Prepare proposal" }));
    expect(container.textContent).toContain("Nothing is created on the host");
    expect(onRequestAction).not.toHaveBeenCalled();
    fireEvent.click(gate.getByRole("button", { name: "Prepare proposal now" }));
    expect(onRequestAction).toHaveBeenCalledWith("prepare-proposal");
  });

  it("renders a refusal beside the act and leaves the act standing", () => {
    // Controls are offered; the daemon's refusal renders. Nothing here recomputes
    // what the daemon would allow.
    const { container } = render(
      <ProposalGate
        state={PREPARED_STATE}
        onRequestAction={vi.fn()}
        actionRefusals={
          new Map([["push", refuse("repos", "gitflow.push_rejected", "The remote rejected it.")]])
        }
      />,
    );
    expect(container.textContent).toContain("gitflow.push_rejected");
    expect(within(container).getByRole("button", { name: "Push" })).toBeDefined();
  });

  it("negative control: with no action handler, the gate offers no act at all", () => {
    // Absence of a handler is the mount saying it cannot honour one — which is a
    // different thing from an act the daemon would refuse, and renders differently.
    const { container } = render(<ProposalGate state={PREPARED_STATE} />);
    expect(within(container).queryByRole("group", { name: "Git actions" })).toBeNull();
  });
});

describe("ProposalGate — a draft proposal is drawn and cannot be sent", () => {
  const DRAFT_STATE: ProposalGateState = { ...PREPARED_STATE, proposal: DRAFT_PROPOSAL };

  it("draws the proposal, withholds the send, and says why it is absent", () => {
    const { container } = render(<ProposalGate state={DRAFT_STATE} onRequestAction={vi.fn()} />);
    const actionGroup = within(within(container).getByRole("group", { name: "Git actions" }));
    // The payload is on screen — this is not the no-proposal arm.
    expect(container.textContent).toContain("Wire the rate limiter");
    expect(actionGroup.queryByRole("button", { name: "Push" })).toBeNull();
    // The absence has a reason rather than being a control a participant hunts for.
    expect(container.textContent).toContain(PROPOSAL_NOT_SENDABLE_COPY);
  });

  it("negative control: a ready proposal offers the send and carries no such sentence", () => {
    // Without this the case above would pass against a gate that had simply stopped
    // offering the send, and against copy printed on every prepared arm.
    const { container } = render(<ProposalGate state={PREPARED_STATE} onRequestAction={vi.fn()} />);
    const actionGroup = within(within(container).getByRole("group", { name: "Git actions" }));
    expect(actionGroup.getByRole("button", { name: "Push" })).toBeDefined();
    expect(container.textContent).not.toContain(PROPOSAL_NOT_SENDABLE_COPY);
  });
});

describe("ProposalGate — the acts are held while one is unanswered", () => {
  it("holds every control and names the act being waited on", () => {
    const { container } = render(
      <ProposalGate state={PREPARED_STATE} onRequestAction={vi.fn()} inFlightAction="commit" />,
    );
    const acts = within(within(container).getByRole("group", { name: "Git actions" }));
    for (const button of acts.getAllByRole("button")) {
      expect(button).toHaveProperty("disabled", true);
    }
    // A row that stopped responding with nothing saying why reads as a broken surface.
    expect(container.textContent).toContain("Commit was sent");
  });

  it("withdraws an open confirm rather than leaving it pressable", () => {
    // The confirm's own button is not in the disabled outer row, so a confirm opened
    // before the act started would stay pressable and issue the second request the
    // holder is there to refuse.
    const { container, rerender } = render(
      <ProposalGate state={PREPARED_STATE} onRequestAction={vi.fn()} />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Push" }));
    expect(within(container).getByRole("button", { name: "Push now" })).toBeDefined();

    rerender(
      <ProposalGate state={PREPARED_STATE} onRequestAction={vi.fn()} inFlightAction="push" />,
    );

    expect(within(container).queryByRole("button", { name: "Push now" })).toBeNull();
  });

  it("negative control: with nothing in flight the same acts are offered and pressable", () => {
    // Without this the two cases above would pass against a gate that never offered a
    // usable control at all.
    const { container } = render(<ProposalGate state={PREPARED_STATE} onRequestAction={vi.fn()} />);
    const acts = within(within(container).getByRole("group", { name: "Git actions" }));
    for (const button of acts.getAllByRole("button")) {
      expect(button).toHaveProperty("disabled", false);
    }
    expect(container.textContent).not.toContain("was sent");
  });
});

describe("ProposalGate — the incompatible checkout is a blocking choice", () => {
  const conflict = {
    reason: "The checkout has uncommitted changes on a different branch.",
    options: [
      { optionId: "stash", label: "Stash and continue" },
      { optionId: "abort", label: "Leave it alone" },
    ],
  };

  it("puts the daemon's reason and its options, and resolves nothing automatically", () => {
    const onResolveCheckoutConflict = vi.fn<(optionId: string) => void>();
    const { container } = render(
      <ProposalGate
        state={PREPARED_STATE}
        checkoutConflict={conflict}
        onResolveCheckoutConflict={onResolveCheckoutConflict}
        onRequestAction={vi.fn()}
      />,
    );
    expect(container.textContent).toContain(conflict.reason);
    expect(onResolveCheckoutConflict).not.toHaveBeenCalled();
    fireEvent.click(within(container).getByRole("button", { name: "Stash and continue" }));
    expect(onResolveCheckoutConflict).toHaveBeenCalledWith("stash");
  });

  it("holds the acts until the choice is answered", () => {
    const { container } = render(
      <ProposalGate state={PREPARED_STATE} checkoutConflict={conflict} onRequestAction={vi.fn()} />,
    );
    const acts = within(within(container).getByRole("group", { name: "Git actions" }));
    for (const button of acts.getAllByRole("button")) {
      expect(button).toHaveProperty("disabled", true);
    }
  });

  it("negative control: with no conflict, the same acts are offered", () => {
    const { container } = render(<ProposalGate state={PREPARED_STATE} onRequestAction={vi.fn()} />);
    const acts = within(within(container).getByRole("group", { name: "Git actions" }));
    for (const button of acts.getAllByRole("button")) {
      expect(button).toHaveProperty("disabled", false);
    }
  });
});

describe("ProposalGate — hosting unavailable is a feature, not an error page", () => {
  it("still produces the summary and names the bundle a participant acts on by hand", () => {
    const { container } = render(
      <ProposalGate
        state={{
          kind: "hosting-unavailable",
          context: BRANCH_CONTEXT,
          proposal: PROPOSAL,
          bundlePath: "/tmp/sidekicks/proposal-01.bundle",
        }}
      />,
    );
    expect(container.textContent).toContain("Wire the rate limiter");
    expect(container.textContent).toContain("develop");
    expect(container.textContent).toContain("/tmp/sidekicks/proposal-01.bundle");
    expect(container.textContent).toContain("complete enough to act on by hand");
  });

  it("negative control: the degraded arm is not the refused arm", () => {
    // A degraded read is the system working. Sharing copy with the failure arm would
    // report a required behaviour as a fault.
    const degraded = render(
      <ProposalGate
        state={{
          kind: "hosting-unavailable",
          context: BRANCH_CONTEXT,
          proposal: PROPOSAL,
          bundlePath: "/tmp/sidekicks/proposal-01.bundle",
        }}
      />,
    );
    expect(degraded.container.textContent).not.toContain("The daemon refused this action");
  });
});

describe("ProposalGate — a confirmation belongs to what it was opened over", () => {
  /** Open Push's confirmation on the ready arm, and give back the gate to move. */
  function openPushConfirmation(): ReturnType<typeof render> {
    const gate = render(<ProposalGate state={PREPARED_STATE} onRequestAction={vi.fn()} />);
    fireEvent.click(within(gate.container).getByRole("button", { name: "Push" }));
    expect(within(gate.container).getByRole("button", { name: "Push now" })).toBeDefined();
    return gate;
  }

  it("closes when the offered acts change and the send comes back", () => {
    // The whole defect: a refresh moving the proposal from `ready` to `draft` took the
    // Push row away while the pending confirmation stayed, so the next proposal to
    // become `ready` remounted with its confirmation already open — a send confirmable
    // against a payload whose consequence nobody had read.
    const { container, rerender } = openPushConfirmation();

    rerender(
      <ProposalGate
        state={{ ...PREPARED_STATE, proposal: DRAFT_PROPOSAL }}
        onRequestAction={vi.fn()}
      />,
    );
    rerender(<ProposalGate state={PREPARED_STATE} onRequestAction={vi.fn()} />);

    expect(within(container).queryByRole("button", { name: "Push now" })).toBeNull();
    expect(within(container).getByRole("button", { name: "Push" })).toBeDefined();
  });

  it("closes when a different proposal reaches the same offered acts", () => {
    // The case the offered set cannot see: preparing again over the same context
    // leaves every act offered and replaces the payload underneath the open confirm.
    const { container, rerender } = openPushConfirmation();

    rerender(
      <ProposalGate
        state={{ ...PREPARED_STATE, proposal: { ...PROPOSAL, title: "A different change" } }}
        onRequestAction={vi.fn()}
      />,
    );

    expect(within(container).queryByRole("button", { name: "Push now" })).toBeNull();
  });

  it("negative control: a re-read that served the same arm leaves it open", () => {
    // Without this the two cases above would pass against a gate that closed the
    // confirmation on every render — and this gate re-reads on focus, on a reconnect,
    // and on every repo frame the daemon sends, so the confirm would close under a
    // participant part way through reading it.
    const { container, rerender } = openPushConfirmation();

    rerender(
      <ProposalGate
        state={{ ...PREPARED_STATE, proposal: { ...PROPOSAL } }}
        onRequestAction={vi.fn()}
      />,
    );

    expect(within(container).getByRole("button", { name: "Push now" })).toBeDefined();
  });
});
