// One parked phase, drawn by the pane's card and by the run list's row, from one
// projection.
//
// THE CLAIM IS AN AGREEMENT BETWEEN TWO SURFACES, so the suite renders both. The park
// discriminator, the schedule classification, and the phase's name were derived three
// times — once in `run-list-projection.ts`, once here, and once in the phase graph —
// and two of the three disagreed about the name: the projection read the row's own
// member and this pane substituted a module constant that was permanently `undefined`.
// One run, one park, and a phase the list named while the cards beside it drew it
// nameless. A suite that rendered only one of the two could not see that.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkflowRunSnapshot } from "../../bridge/index.js";
import { RunListItem } from "../../workflows/runs/RunListItem.js";
import { RunListProjection } from "../../workflows/runs/run-list-projection.js";
import { RunParks } from "./RunParks.js";
import type { HumanFormSelection } from "./human-form-selection.js";

/**
 * A selection that has nothing open, which is every case here.
 *
 * The form route is not this suite's subject — `WorkflowRunPane.forms.test.tsx` owns
 * it — and a card's route is decided from members the park projection deliberately
 * does not carry, so the two are separable.
 */
const NO_FORM_OPEN: HumanFormSelection = {
  openForm: undefined,
  isOpen: () => false,
  openFormFor: () => undefined,
};

/**
 * One phase, parked on a person, carrying an authored name.
 *
 * Bound to a variable rather than written inline at the snapshot, and that is
 * load-bearing rather than stylistic: `WorkflowPhaseState` declares no `phaseName`,
 * because no read reachable from this build carries one — so a fresh literal in the
 * `phaseStates` position would be refused for the excess property. Through a binding
 * the shape is merely wider than the wire's, which is exactly the state the day a
 * definition read lands puts every phase in, and the state the two surfaces have to
 * agree in.
 */
const NAMED_PARKED_PHASE = {
  phaseId: "phase-review",
  phaseName: "Review",
  state: "running",
  gateState: "open",
  parkReason: "waiting-human",
  parkCause: "Waiting for sign-off.",
} as const;

/** The same phase with its name taken away, and nothing else changed. */
const UNNAMED_PARKED_PHASE = {
  phaseId: "phase-review",
  state: "running",
  gateState: "open",
  parkReason: "waiting-human",
  parkCause: "Waiting for sign-off.",
} as const;

function runWith(phase: WorkflowRunSnapshot["phaseStates"][number]): WorkflowRunSnapshot {
  return {
    workflowRunId: "run-1",
    sessionId: "session-1",
    workflowVersionId: "version-1",
    state: "suspended",
    startedAt: "2026-09-01T10:00:00.000Z",
    phaseStates: [phase],
  };
}

/** What the pane's stack of cards calls the parked phase, or nothing. */
function paneParkPhaseName(run: WorkflowRunSnapshot): string | undefined {
  const { container } = render(<RunParks run={run} humanForms={NO_FORM_OPEN} />);
  return container.querySelector(".meridian-park__phase-name")?.textContent ?? undefined;
}

/** And what the run list's own row calls it, through the projection that feeds it. */
function listParkPhaseName(run: WorkflowRunSnapshot): string | undefined {
  const row = new RunListProjection([run]).rows[0];
  if (row === undefined) {
    throw new Error("the projection produced no row");
  }
  const { container } = render(<RunListItem row={row} onOpenRun={undefined} />);
  return container.querySelector(".meridian-park__phase-name")?.textContent ?? undefined;
}

describe("the phase a park is about", () => {
  it("is named the same by the pane's card and by the run list's row", () => {
    const run = runWith(NAMED_PARKED_PHASE);
    expect(paneParkPhaseName(run)).toBe("Review");
    expect(listParkPhaseName(run)).toBe(paneParkPhaseName(run));
  });

  it("negative control: neither surface invents a name where the read carries none", () => {
    // Without this the case above would be satisfied by two surfaces that both printed
    // the identifier in the name's place, which is the invention this family renders
    // the absence of rather than papering over.
    const run = runWith(UNNAMED_PARKED_PHASE);
    expect(paneParkPhaseName(run)).toBeUndefined();
    expect(listParkPhaseName(run)).toBeUndefined();
  });

  it("negative control: both surfaces still identify the phase by its wire id", () => {
    // And without THIS, the case above would be satisfied by a card that had stopped
    // saying which phase it is about at all — which is what makes a fan-out's cards
    // indistinguishable.
    const run = runWith(UNNAMED_PARKED_PHASE);
    const { container } = render(<RunParks run={run} humanForms={NO_FORM_OPEN} />);
    expect(container.querySelector(".meridian-park__phase")?.textContent).toContain("phase-review");
  });
});

describe("a run with nothing parked", () => {
  it("says so rather than rendering an empty region", () => {
    const run = runWith({ phaseId: "phase-draft", state: "running", gateState: "open" });
    const { container } = render(<RunParks run={run} humanForms={NO_FORM_OPEN} />);
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(container.querySelectorAll(".meridian-park")).toHaveLength(0);
  });
});
