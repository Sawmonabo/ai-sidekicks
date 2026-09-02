// What the proposal gate puts on screen, and what it refuses to.
//
// The cases drive the real component against the real model rather than a stand-in,
// and each clean assertion is paired with the case that would pass if the gate stopped
// doing the thing: "not-checked is not empty" is only meaningful beside the arm that
// must read as empty, and "controls are offered" is only meaningful beside a refusal
// that leaves the control standing.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../core/index.js";
import { ProposalGate } from "./ProposalGate.js";
import type { BranchContextReading } from "./branch-context-model.js";
import {
  ONE_CUMULATIVE_PROPOSAL_COPY,
  PROPOSAL_ACTIONS,
  type PreparedProposal,
  type ProposalAction,
  type ProposalGateState,
} from "./proposal-model.js";

const BRANCH_CONTEXT: BranchContextReading = {
  branchContextId: "branch-context-01",
  baseBranch: "develop",
  headBranch: "sidekicks/abc123/rate-limit-wiring",
  upstreamRef: "origin/sidekicks/abc123/rate-limit-wiring",
  executionMode: "worktree",
  worktreeId: "worktree-01",
};

const PROPOSAL: PreparedProposal = {
  title: "Wire the rate limiter",
  body: "Adds the concurrency cap to the subscribe path.",
  baseBranch: "develop",
  headBranch: "sidekicks/abc123/rate-limit-wiring",
  state: "draft",
  trailers: ["Co-Authored-By: a sidekick"],
  changedPaths: ["packages/control-plane/src/rate-limit.ts"],
};

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

  it("names the mode as the reason a read-only workspace produces no context", () => {
    const { container } = render(
      <ProposalGate state={{ kind: "no-context", executionMode: "read-only" }} />,
    );
    expect(container.textContent).toContain("read-only");
    expect(container.textContent).toContain("preparation side effects");
  });

  it("negative control: the read-only arm is an empty and not an unasked question", () => {
    // The two arms must not share copy. A read-only workspace was asked and answered;
    // the unregistered wire was never asked at all.
    const readOnly = render(
      <ProposalGate state={{ kind: "no-context", executionMode: "read-only" }} />,
    );
    const notChecked = render(<ProposalGate state={{ kind: "not-checked" }} />);
    expect(readOnly.container.textContent).not.toContain("Nothing has asked");
    expect(notChecked.container.textContent).not.toContain("read-only");
  });

  it("routes a writable mode with no context to the unread sentence, not the read-only one", () => {
    const { container } = render(
      <ProposalGate state={{ kind: "no-context", executionMode: "worktree" }} />,
    );
    expect(container.textContent).toContain("has a branch context");
    expect(container.textContent).not.toContain("read-only");
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
    expect(container.textContent).toContain("draft");
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

describe("ProposalGate — three acts, offered, never projected", () => {
  it("offers exactly the three modelled actions", () => {
    const { container } = render(<ProposalGate state={PREPARED_STATE} onRequestAction={vi.fn()} />);
    const actionGroup = within(within(container).getByRole("group", { name: "Git actions" }));
    for (const action of PROPOSAL_ACTIONS) {
      expect(actionGroup.queryAllByRole("button").length).toBeGreaterThan(0);
      expect(action.length).toBeGreaterThan(0);
    }
    // Three acts, each with its own confirm pair opened one at a time, so the closed
    // surface carries exactly three controls.
    expect(actionGroup.getAllByRole("button")).toHaveLength(PROPOSAL_ACTIONS.length);
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
