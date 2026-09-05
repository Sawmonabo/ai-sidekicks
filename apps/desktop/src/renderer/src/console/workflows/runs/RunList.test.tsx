// The list renders the projection and derives nothing, so the cases below drive it
// through `RunListProjection` rather than through hand-built rows: a test that
// constructed its own row values would prove the markup and leave the seam between
// the two — the part that can actually drift — unchecked.
//
// WHAT IS ASSERTED HERE AND WHAT IS ASSERTED NEXT DOOR. This suite is the list's own
// three claims: the absence, the header's counts, and the order the rows come out in.
// Everything a ROW draws is `RunListItem.test.tsx`, which splits along the same seam
// the modules do.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunList } from "./RunList.js";
import { RunListProjection } from "./run-list-projection.js";
import type { WorkflowPhaseStateRow, WorkflowRunSnapshot } from "./run-list-rows.js";
import { phase, run } from "./run-list-projection.test-support.js";

function renderList(runs: readonly WorkflowRunSnapshot[]): HTMLElement {
  const { container } = render(<RunList projection={new RunListProjection(runs)} />);
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) {
    throw new Error("the list rendered nothing");
  }
  return root;
}

function rowNames(root: HTMLElement): readonly string[] {
  return [...root.querySelectorAll(".meridian-run-row__name")].map(
    (name) => name.textContent ?? "",
  );
}

/** One phase parked on a person, which is what puts a run in the parked band. */
function parkedPhase(phaseId: string): WorkflowPhaseStateRow {
  return phase({
    phaseId,
    phaseName: "Sign-off",
    parkReason: "waiting-human",
    parkCause: "Waiting for sign-off.",
  });
}

describe("an empty list", () => {
  it("says there are none, in the shape a surface stands in for", () => {
    const root = renderList([]);
    expect(root.classList.contains("meridian-nothing--empty")).toBe(true);
    expect(root.classList.contains("meridian-nothing--block")).toBe(true);
  });

  it("negative control: a list with a run renders rows and not that absence", () => {
    const root = renderList([run()]);
    expect(root.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(rowNames(root)).toStrictEqual(["Release checklist"]);
  });
});

describe("the order the rows come out in", () => {
  it("follows the projection's order rather than the caller's", () => {
    const root = renderList([
      run({ workflowRunId: "run-active", definitionName: "Active", phaseStates: [] }),
      run({
        workflowRunId: "run-parked",
        definitionName: "Parked",
        phaseStates: [parkedPhase("phase-1")],
      }),
    ]);
    expect(rowNames(root)).toStrictEqual(["Parked", "Active"]);
  });

  it("negative control: the caller's own order is the other one", () => {
    // Without this the case above would pass over a list that happened to render its
    // input unchanged, which is exactly what it exists to disprove.
    const callerOrder = [
      run({ workflowRunId: "run-active", definitionName: "Active", phaseStates: [] }),
      run({
        workflowRunId: "run-parked",
        definitionName: "Parked",
        phaseStates: [parkedPhase("phase-1")],
      }),
    ].map((snapshot) => snapshot.definitionName);
    expect(callerOrder).toStrictEqual(["Active", "Parked"]);
  });
});

describe("the counts the header shows", () => {
  it("counts what it is showing, including the parks", () => {
    const root = renderList([
      run({ workflowRunId: "run-clean", phaseStates: [] }),
      run({ workflowRunId: "run-parked", phaseStates: [parkedPhase("phase-1")] }),
    ]);
    const summary = root.querySelector(".meridian-run-list__summary")?.textContent ?? "";
    expect(summary).toContain("Runs");
    expect(summary).toContain("Parked");
  });

  it("says nothing about parks or frozen pins on a list that has neither", () => {
    // The negative control for the case above: a header that printed both lines
    // unconditionally would satisfy it while claiming a park on every list.
    const summary =
      renderList([run({ phaseStates: [] })]).querySelector(".meridian-run-list__summary")
        ?.textContent ?? "";
    expect(summary).toContain("Runs");
    expect(summary).not.toContain("Parked");
    expect(summary).not.toContain("Frozen pins");
  });
});
