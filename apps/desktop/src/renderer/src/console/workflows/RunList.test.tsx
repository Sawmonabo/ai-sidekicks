// The list renders the projection and derives nothing, so the cases below drive it
// through `RunListProjection` rather than through hand-built rows: a test that
// constructed its own row values would prove the markup and leave the seam between
// the two — the part that can actually drift — unchecked.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunList } from "./RunList.js";
import {
  RunListProjection,
  type WorkflowRunListRow,
  type WorkflowRunSnapshot,
} from "./run-list-projection.js";

function run(overrides: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    workflowRunId: "run-1",
    state: "running",
    workflowVersionId: "version-1",
    startedAt: "2026-09-01T10:00:00.000Z",
    phaseStates: [],
    definitionName: "Release checklist",
    ...overrides,
  };
}

function renderList(
  runs: readonly WorkflowRunSnapshot[],
  onOpenRun?: (row: WorkflowRunListRow) => void,
): HTMLElement {
  const { container } = render(
    <RunList projection={new RunListProjection(runs)} onOpenRun={onOpenRun} />,
  );
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

describe("the rows", () => {
  it("follows the projection's order rather than the caller's", () => {
    const root = renderList([
      run({ workflowRunId: "run-active", definitionName: "Active" }),
      run({
        workflowRunId: "run-parked",
        definitionName: "Parked",
        phaseStates: [
          {
            phaseId: "phase-1",
            phaseName: "Sign-off",
            state: "running",
            parkReason: "waiting-human",
            parkCause: "Waiting for sign-off.",
          },
        ],
      }),
    ]);
    expect(rowNames(root)).toStrictEqual(["Parked", "Active"]);
  });

  it("says one park per parked phase and none on a run with no park", () => {
    const root = renderList([
      run({
        phaseStates: [
          {
            phaseId: "phase-1",
            phaseName: "Sign-off",
            state: "running",
            parkReason: "waiting-human",
            parkCause: "Waiting for sign-off.",
          },
          { phaseId: "phase-2", phaseName: "Publish", state: "pending" },
        ],
      }),
    ]);
    expect(root.querySelectorAll(".meridian-park")).toHaveLength(1);
    expect(root.textContent).toContain("Sign-off");
  });

  it("counts what it is showing, including the parks", () => {
    const root = renderList([
      run({ workflowRunId: "run-clean" }),
      run({
        workflowRunId: "run-parked",
        phaseStates: [
          {
            phaseId: "phase-1",
            phaseName: "Sign-off",
            state: "running",
            parkReason: "waiting-human",
            parkCause: "Waiting for sign-off.",
          },
        ],
      }),
    ]);
    const summary = root.querySelector(".meridian-run-list__summary")?.textContent ?? "";
    expect(summary).toContain("Runs");
    expect(summary).toContain("Parked");
  });

  it("renders a failure reason verbatim, as the daemon's sentence about the run", () => {
    const root = renderList([
      run({ state: "failed", failureReason: "Quality gate rejected the phase output." }),
    ]);
    expect(root.querySelector(".meridian-run-row__failure")?.textContent).toBe(
      "Quality gate rejected the phase output.",
    );
    expect(root.querySelector(".meridian-chip--failure")).not.toBeNull();
  });
});

/*
 * One wire member, two facts. `failureReason` is preserved on any bound breach AND
 * carries the reason a cancel supplied, so the run's status is the only thing that
 * says which arrived — and the row used to render both in the failure treatment,
 * presenting an outcome somebody asked for as a breach.
 *
 * The cancelled run's sentence is the committed workflows fixture's own, so the case
 * reads what a person actually sees on that scenario. It is built through this file's
 * factory rather than imported from the scenario, on the header's rule: the seam
 * under test is the projection's, and a unit case reaching into the fixture module
 * would be a second import edge for a string.
 */
describe("the reason a run carries", () => {
  function reasonOf(root: HTMLElement, className: string): string | undefined {
    return root.querySelector(`.${className}`)?.textContent?.trim();
  }

  it("says a cancellation is one, in prose rather than in the failure treatment", () => {
    const root = renderList([
      run({
        state: "cancelled",
        failureReason: "Cancelled: the incident was resolved out of band.",
      }),
    ]);

    expect(reasonOf(root, "meridian-run-row__reason")).toBe(
      "Cancellation reason Cancelled: the incident was resolved out of band.",
    );
    // The daemon's sentence verbatim, with only the name in front of it added.
    expect(root.querySelector(".meridian-run-row__reason")?.textContent).toContain(
      "Cancelled: the incident was resolved out of band.",
    );
    expect(root.querySelector(".meridian-run-row__failure")).toBeNull();
  });

  it("keeps the failure treatment, unlabelled, for a run that failed", () => {
    // Negative control for the case above: it would pass over a row that had dropped
    // the failure arm entirely and called every reason a cancellation.
    const root = renderList([
      run({ state: "failed", failureReason: "Quality gate rejected the phase output." }),
    ]);

    expect(reasonOf(root, "meridian-run-row__failure")).toBe(
      "Quality gate rejected the phase output.",
    );
    expect(root.querySelector(".meridian-run-row__reason")).toBeNull();
  });

  it("renders neither shape for a run that carries no reason", () => {
    // The second control: both cases above read a class off a row, and a list that
    // rendered an empty paragraph for every run would satisfy neither claim honestly.
    const root = renderList([run({ state: "completed" })]);

    expect(root.querySelector(".meridian-run-row__reason")).toBeNull();
    expect(root.querySelector(".meridian-run-row__failure")).toBeNull();
  });

  it("spends the status chip's tone on the status and the treatment on the reason", () => {
    // A cancelled run is settled rather than broken, so neither the chip nor the
    // reason wears the failure hue — the two facts are told apart by words here.
    const root = renderList([
      run({ state: "cancelled", failureReason: "Cancelled: superseded by a newer run." }),
    ]);

    expect(root.querySelector(".meridian-chip--failure")).toBeNull();
    expect(root.querySelector(".meridian-run-row__reason-label")?.textContent).toBe(
      "Cancellation reason",
    );
  });
});

describe("the frozen-definition state", () => {
  it("marks a run whose pin is behind its definition, and shows the pin it is on", () => {
    const root = renderList([
      run({ workflowVersionId: "version-1", definitionLatestWorkflowVersionId: "version-4" }),
    ]);
    expect(root.textContent).toContain("Frozen on an older version");
    expect(root.querySelector(".meridian-run-row__pin")?.textContent).toContain("version-1");
  });

  it("negative control: a run whose latest the caller does not hold is not marked", () => {
    const root = renderList([run({ workflowVersionId: "version-1" })]);
    expect(root.textContent).not.toContain("Frozen on an older version");
    expect(root.querySelector(".meridian-run-row__pin")).toBeNull();
  });
});

describe("the open control", () => {
  it("is absent while nothing can address a run", () => {
    expect(renderList([run()]).querySelectorAll("button")).toHaveLength(0);
  });

  it("hands the row back when its caller supplies the action", () => {
    // A typed capture rather than a bare spy: the claim is that the ROW travels, and
    // reading it back off an untyped mock call would assert against `any`.
    const openedRuns: WorkflowRunListRow[] = [];
    const root = renderList([run({ workflowRunId: "run-1" })], (row) => {
      openedRuns.push(row);
    });
    const button = root.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("the row rendered no open control");
    }
    button.click();
    expect(openedRuns.map((row) => row.run.workflowRunId)).toStrictEqual(["run-1"]);
  });
});
