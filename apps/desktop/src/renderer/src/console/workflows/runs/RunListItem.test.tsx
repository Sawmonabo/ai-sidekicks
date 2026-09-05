// What one run's row draws, driven through the projection that feeds it.
//
// The row is handed a `WorkflowRunListRow` and derives nothing, so every case below
// builds its row through `RunListProjection` rather than by hand: a suite that
// constructed row values itself would prove the markup and leave the seam between the
// projection and the row — the part that can actually drift — unchecked. It is the
// same rule the list's own suite states, applied one module down.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatClockTime, formatDateTime } from "../../primitives/index.js";
import { RunListItem } from "./RunListItem.js";
import { RunListProjection, type OpenRun, type WorkflowRunListRow } from "./run-list-projection.js";
import type { WorkflowRunSnapshot } from "./run-list-rows.js";
import { phase, run } from "./run-list-projection.test-support.js";

/** The row the projection makes of one run, which is the only row a person sees. */
function rowOf(snapshot: WorkflowRunSnapshot): WorkflowRunListRow {
  const row = new RunListProjection([snapshot]).rows[0];
  if (row === undefined) {
    throw new Error("the projection produced no row");
  }
  return row;
}

function renderRow(snapshot: WorkflowRunSnapshot, onOpenRun?: OpenRun): HTMLElement {
  const { container } = render(<RunListItem row={rowOf(snapshot)} onOpenRun={onOpenRun} />);
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) {
    throw new Error("the row rendered nothing");
  }
  return root;
}

describe("the parks a row says in place", () => {
  it("says one park per parked phase and none for a phase with none", () => {
    const root = renderRow(
      run({
        phaseStates: [
          phase({
            phaseId: "phase-1",
            phaseName: "Sign-off",
            parkReason: "waiting-human",
            parkCause: "Waiting for sign-off.",
          }),
          phase({ phaseId: "phase-2", phaseName: "Publish", state: "pending" }),
        ],
      }),
    );
    expect(root.querySelectorAll(".meridian-park")).toHaveLength(1);
    expect(root.textContent).toContain("Sign-off");
  });

  it("negative control: a run with nothing parked draws no badge at all", () => {
    expect(renderRow(run()).querySelectorAll(".meridian-park")).toHaveLength(0);
  });
});

/*
 * One wire member, two facts. `failureReason` is preserved on any bound breach AND
 * carries the reason a cancel supplied, so the run's status is the only thing that
 * says which arrived — and the row used to render both in the failure treatment,
 * presenting an outcome somebody asked for as a breach.
 *
 * The cancelled run's sentence is the committed workflows fixture's own, so the case
 * reads what a person actually sees on that scenario. It is built through the shared
 * factory rather than imported from the scenario, on this file's rule: the seam under
 * test is the projection's, and a unit case reaching into the fixture module would be
 * a second import edge for a string.
 */
describe("the reason a run carries", () => {
  function reasonOf(root: HTMLElement, className: string): string | undefined {
    return root.querySelector(`.${className}`)?.textContent?.trim();
  }

  it("says a cancellation is one, in prose rather than in the failure treatment", () => {
    const root = renderRow(
      run({
        state: "cancelled",
        failureReason: "Cancelled: the incident was resolved out of band.",
      }),
    );

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
    const root = renderRow(
      run({ state: "failed", failureReason: "Quality gate rejected the phase output." }),
    );

    expect(reasonOf(root, "meridian-run-row__failure")).toBe(
      "Quality gate rejected the phase output.",
    );
    expect(root.querySelector(".meridian-run-row__reason")).toBeNull();
    expect(root.querySelector(".meridian-chip--failure")).not.toBeNull();
  });

  it("renders neither shape for a run that carries no reason", () => {
    // The second control: both cases above read a class off a row, and a row that
    // rendered an empty paragraph for every run would satisfy neither claim honestly.
    const root = renderRow(run({ state: "completed" }));

    expect(root.querySelector(".meridian-run-row__reason")).toBeNull();
    expect(root.querySelector(".meridian-run-row__failure")).toBeNull();
  });

  it("spends the status chip's tone on the status and the treatment on the reason", () => {
    // A cancelled run is settled rather than broken, so neither the chip nor the
    // reason wears the failure hue — the two facts are told apart by words here.
    const root = renderRow(
      run({ state: "cancelled", failureReason: "Cancelled: superseded by a newer run." }),
    );

    expect(root.querySelector(".meridian-chip--failure")).toBeNull();
    expect(root.querySelector(".meridian-run-row__reason-label")?.textContent).toBe(
      "Cancellation reason",
    );
  });
});

describe("the start a row reads", () => {
  // A run list has no day divider above it, so the two runs below — started at the
  // same hour a week apart — are the pair the ledger's date-free reading collapses.
  const startedOnTheFirst = "2026-09-01T10:00:00.000Z";
  const startedOnTheEighth = "2026-09-08T10:00:00.000Z";

  function startFigureText(startedAt: string): string {
    const meta = renderRow(run({ startedAt })).querySelector(".meridian-run-row__meta");
    return [...(meta?.querySelectorAll(".meridian-figure--wire") ?? [])]
      .map((figure) => figure.textContent ?? "")
      .join(" ");
  }

  it("tells two runs a week apart apart", () => {
    expect(startFigureText(startedOnTheEighth)).not.toBe(startFigureText(startedOnTheFirst));
  });

  it("negative control: the ledger's date-free reading renders the two identically", () => {
    // The finding. Without it the case above would pass over a row that differed for
    // some other reason and would not name the reading that lost the day.
    expect(formatClockTime(startedOnTheEighth)).toBe(formatClockTime(startedOnTheFirst));
  });

  it("draws the figure chokepoint's date-carrying reading beside the wire instant", () => {
    const meta = renderRow(run({ startedAt: startedOnTheFirst })).querySelector(
      ".meridian-run-row__meta",
    );
    const start = [...(meta?.querySelectorAll(".meridian-figure--wire") ?? [])].find(
      (figure) => figure.getAttribute("title") === startedOnTheFirst,
    );
    expect(start?.textContent).toBe(formatDateTime(startedOnTheFirst));
  });
});

describe("the frozen-definition state", () => {
  it("marks a run whose pin is behind its definition, and shows the pin it is on", () => {
    const root = renderRow(
      run({ workflowVersionId: "version-1", definitionLatestWorkflowVersionId: "version-4" }),
    );
    expect(root.textContent).toContain("Frozen on an older version");
    expect(root.querySelector(".meridian-run-row__pin")?.textContent).toContain("version-1");
  });

  it("negative control: a run whose latest the caller does not hold is not marked", () => {
    const root = renderRow(run({ workflowVersionId: "version-1" }));
    expect(root.textContent).not.toContain("Frozen on an older version");
    expect(root.querySelector(".meridian-run-row__pin")).toBeNull();
  });
});

describe("the open control", () => {
  it("is absent while nothing can address a run", () => {
    expect(renderRow(run()).querySelectorAll("button")).toHaveLength(0);
  });

  it("hands the row back when its caller supplies the action", () => {
    // A typed capture rather than a bare spy: the claim is that the ROW travels, and
    // reading it back off an untyped mock call would assert against `any`.
    const openedRuns: WorkflowRunListRow[] = [];
    const root = renderRow(run({ workflowRunId: "run-1" }), (row) => {
      openedRuns.push(row);
    });
    const button = root.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("the row rendered no open control");
    }
    button.click();
    expect(openedRuns.map((opened) => opened.run.workflowRunId)).toStrictEqual(["run-1"]);
  });
});
