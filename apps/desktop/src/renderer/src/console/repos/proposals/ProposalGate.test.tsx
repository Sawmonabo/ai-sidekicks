// What the proposal gate puts on screen, and what it refuses to.
//
// The cases drive the real component against the real model rather than a stand-in,
// and each clean assertion is paired with the case that would pass if the gate stopped
// doing the thing: "not-checked is not empty" is only meaningful beside the arm that
// must read as empty, and "controls are offered" is only meaningful beside a refusal
// that leaves the control standing.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProposalGate } from "./ProposalGate.js";
import type { BranchContextReading } from "../mounts/branch-context-model.js";
import { ONE_CUMULATIVE_PROPOSAL_COPY, type PreparedProposal } from "./prepared-proposal.js";
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
const PREPARED_STATE: ProposalGateState = {
  kind: "prepared",
  context: BRANCH_CONTEXT,
  detectedHost: "github",
  proposal: PROPOSAL,
};

describe("ProposalGate — the absences do not stand in for each other", () => {
  it("says nothing was asked when no branch-context read is registered", () => {
    const { container } = render(<ProposalGate state={{ kind: "not-checked" }} />);
    expect(container.textContent).toContain("No branch context has been read");
    expect(container.textContent).toContain("the question could not be put");
  });

  it("reports a workspace with no branch context in the daemon's own words", () => {
    // Where a `(workspace, worktree)` pair resolves no row the registered read
    // REFUSES — the reply is flat and carries no absence — so this arm is where "there
    // is no context here" lands, and the sentence is the daemon's rather than a
    // console reading of an empty envelope.
    const { container } = render(
      <ProposalGate state={{ kind: "refused", message: "worktree.not_found: no such worktree" }} />,
    );
    expect(container.textContent).toContain("no such worktree");
  });

  it("negative control: a refused read is not an unasked question", () => {
    // The two arms must not share copy. A refused read was asked and answered; the
    // unregistered wire was never asked at all.
    const refused = render(
      <ProposalGate state={{ kind: "refused", message: "worktree.not_found: no such worktree" }} />,
    );
    const notChecked = render(<ProposalGate state={{ kind: "not-checked" }} />);
    expect(refused.container.textContent).not.toContain("the question could not be put");
    expect(notChecked.container.textContent).not.toContain("no such worktree");
  });

  it("renders a failed action as a first-class failure carrying the daemon's own text", () => {
    // There is no `gitflow` error namespace, so a failure arrives with a message and
    // no code. It is a state, never a silent no-op.
    const { container } = render(
      <ProposalGate state={{ kind: "refused", message: "gh: not authenticated" }} />,
    );
    expect(container.textContent).toContain("gh: not authenticated");
    expect(container.textContent).toContain("The daemon refused this action");
  });
});

describe("ProposalGate — base and head come from the context", () => {
  it("shows the four named values and the worktree association", () => {
    const { container } = render(<ProposalGate state={PREPARED_STATE} />);
    expect(container.textContent).toContain("develop");
    expect(container.textContent).toContain("sidekicks/abc123/rate-limit-wiring");
    expect(container.textContent).toContain("origin/sidekicks/abc123/rate-limit-wiring");
    expect(container.textContent).toContain("worktree-01");
  });

  it("says a branch-mode context binds no separate root rather than drawing an empty slot", () => {
    const { container } = render(
      <ProposalGate
        state={{
          ...PREPARED_STATE,
          context: { ...BRANCH_CONTEXT, executionMode: "branch", worktreeId: undefined },
        }}
      />,
    );
    expect(container.textContent).toContain("binds no separate root");
  });

  it("negative control: an absent upstream reads as no upstream, not as an unread field", () => {
    const { container } = render(
      <ProposalGate
        state={{ ...PREPARED_STATE, context: { ...BRANCH_CONTEXT, upstreamRef: undefined } }}
      />,
    );
    expect(container.textContent).toContain("No upstream set");
    expect(container.textContent).not.toContain("origin/");
  });

  it("reports the detected host rather than offering a picker", () => {
    const { container } = render(<ProposalGate state={PREPARED_STATE} />);
    expect(container.textContent).toContain("github");
    // A picker would be a control. The host is a report and nothing selects it.
    const controls = within(container).queryAllByRole("combobox");
    expect(controls).toHaveLength(0);
  });
});

describe("ProposalGate — the status trichotomies are always visible", () => {
  it("renders state, mergeability, and the check rollup on the face", () => {
    const { container } = render(
      <ProposalGate
        state={{
          ...PREPARED_STATE,
          status: {
            state: "open",
            mergeable: "unknown",
            checks: [
              { name: "lint", status: "success" },
              { name: "test", status: "pending" },
            ],
          },
        }}
      />,
    );
    expect(container.textContent).toContain("open");
    expect(container.textContent).toContain("unknown");
    expect(container.textContent).toContain("checks");
    expect(container.textContent).toContain("still computing");
  });

  it("says no decision yet where the host recorded no review verdict", () => {
    const { container } = render(
      <ProposalGate
        state={{
          ...PREPARED_STATE,
          status: { state: "open", mergeable: "mergeable", checks: [] },
        }}
      />,
    );
    expect(container.textContent).toContain("No decision yet");
  });

  it("negative control: a recorded verdict replaces the absence rather than joining it", () => {
    const { container } = render(
      <ProposalGate
        state={{
          ...PREPARED_STATE,
          status: {
            state: "open",
            mergeable: "mergeable",
            checks: [],
            reviewDecision: "changes-requested",
          },
        }}
      />,
    );
    expect(container.textContent).toContain("changes-requested");
    expect(container.textContent).not.toContain("No decision yet");
  });
});

describe("ProposalGate — the prepared proposal, before any remote mutation", () => {
  it("puts title, state, base, and head on the face and says the lineage rule plainly", () => {
    const { container } = render(<ProposalGate state={PREPARED_STATE} />);
    expect(container.textContent).toContain("Wire the rate limiter");
    expect(container.textContent).toContain("ready");
    expect(container.textContent).toContain(ONE_CUMULATIVE_PROPOSAL_COPY);
  });

  it("keeps body, trailers, and the file list behind disclosures", () => {
    const { container } = render(<ProposalGate state={PREPARED_STATE} />);
    const disclosures = container.querySelectorAll("details");
    expect(disclosures.length).toBeGreaterThanOrEqual(2);
    for (const disclosure of disclosures) {
      expect(disclosure.hasAttribute("open")).toBe(false);
    }
  });

  it("negative control: with no proposal prepared, the lineage rule is the empty state's copy", () => {
    const { container } = render(
      <ProposalGate state={{ ...PREPARED_STATE, proposal: undefined }} />,
    );
    expect(container.textContent).toContain("No proposal has been prepared");
    expect(container.textContent).not.toContain("Wire the rate limiter");
  });

  it("opens a changed path in the diff pane when the mount supplies the navigation", () => {
    const onOpenChangedPath = vi.fn();
    const { container } = render(
      <ProposalGate state={PREPARED_STATE} onOpenChangedPath={onOpenChangedPath} />,
    );
    const pathButton = within(container).getByRole("button", {
      name: "packages/control-plane/src/rate-limit.ts",
    });
    fireEvent.click(pathButton);
    expect(onOpenChangedPath).toHaveBeenCalledWith("packages/control-plane/src/rate-limit.ts");
  });
});
