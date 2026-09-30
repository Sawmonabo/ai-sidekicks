// What one run's row draws, driven through `RunListProjection` so the seam between projection
// and row stays checked.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatClockTime, formatDateTime } from "@renderer/lib/wire-figures.js";
import { RunListItem } from "./RunListItem.js";
import {
  RunListProjection,
  type OpenRun,
  type WorkflowRunListRow,
} from "../run-list-projection.js";
import type { WorkflowRunSnapshot } from "../run-list-rows.js";
import { phase, run } from "../run-list-projection.test-support.js";

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
 * `failureReason` carries a bound breach's reason and a cancel's, so the status alone says which
 * arrived. The row must not render a requested cancel as a breach.
 */
describe("the reason a run carries", () => {
  function reasonOf(root: HTMLElement, className: string): string | undefined {
    return root.querySelector(`.${className}`)?.textContent?.trim();
  }

  it("says a cancellation is one, in prose rather than in the failure treatment", () => {
    const root = renderRow(
      run({
        state: "canceled",
        failureReason: "Canceled: the incident was resolved out of band.",
      }),
    );

    expect(reasonOf(root, "meridian-run-row__reason")).toBe(
      "Cancellation reason Canceled: the incident was resolved out of band.",
    );
    expect(root.querySelector(".meridian-run-row__reason")?.textContent).toContain(
      "Canceled: the incident was resolved out of band.",
    );
    expect(root.querySelector(".meridian-run-row__failure")).toBeNull();
  });

  it("keeps the failure treatment, unlabeled, for a run that failed", () => {
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
    const root = renderRow(run({ state: "completed" }));

    expect(root.querySelector(".meridian-run-row__reason")).toBeNull();
    expect(root.querySelector(".meridian-run-row__failure")).toBeNull();
  });

  it("spends the status chip's tone on the status and the treatment on the reason", () => {
    // A canceled run is settled rather than broken: neither chip nor reason wears the failure hue.
    const root = renderRow(
      run({ state: "canceled", failureReason: "Canceled: superseded by a newer run." }),
    );

    expect(root.querySelector(".meridian-chip--failure")).toBeNull();
    expect(root.querySelector(".meridian-run-row__reason-label")?.textContent).toBe(
      "Cancellation reason",
    );
  });
});

describe("the start a row reads", () => {
  // No day divider sits above a run list, so two runs started a week apart at the same hour
  // are the pair a date-free reading collapses.
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

  it("negative control: the transcript's date-free reading renders the two identically", () => {
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
    // A typed capture: reading the row back off an untyped mock call would assert against `any`.
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
