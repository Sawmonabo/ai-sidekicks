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

import { formatDateTime } from "../../primitives/index.js";
import { RunList } from "./RunList.js";
import { RunListProjection } from "./run-list-projection.js";
import { workflowInstant } from "./run-list-rows.js";
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

/** Each row's start figure, in the order the list drew the rows. */
function startFigures(root: HTMLElement): readonly string[] {
  return [...root.querySelectorAll(".meridian-run-row__meta")].map((meta) => {
    const start = [...meta.querySelectorAll(".meridian-figure--wire")].find(
      (figure) => figure.getAttribute("title") !== null,
    );
    return start?.textContent ?? "";
  });
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

/*
 * The start is DISPLAYED under the grammar it is SORTED under, and the two used to be
 * different readers. `run-list-rows.ts` declares this plane `"utc-only"` so an encoding
 * change arrives as the unreadable value it is; the row printed through the figure
 * chokepoint's `formatDateTime`, whose default policy admits a numeric offset. So a run
 * spelled `+02:00` sorted last — under every start the plane could read — and printed a
 * legible time on the row, with nothing saying its stamp had been refused.
 */
describe("a start spelled with a numeric offset", () => {
  // 10:00Z, so it is genuinely NEWER than the run below it and belongs above it in a
  // newest-first band — which is what makes its placement last a visible symptom
  // rather than a coincidence of the values chosen.
  const offsetSpelled = "2026-01-01T12:00:00+02:00";
  const utcSpelled = "2026-01-01T09:00:00Z";

  function twoRuns(): HTMLElement {
    return renderList([
      run({ workflowRunId: "run-offset", definitionName: "Offset", startedAt: offsetSpelled }),
      run({ workflowRunId: "run-utc", definitionName: "Utc", startedAt: utcSpelled }),
      // Both unparked and both active, so the band is not what orders them.
    ]);
  }

  it("sorts it last and prints it as the unreadable value the plane made it", () => {
    const root = twoRuns();
    expect(rowNames(root)).toStrictEqual(["Utc", "Offset"]);
    expect(startFigures(root)).toStrictEqual([formatDateTime(utcSpelled), "—"]);
  });

  it("keeps the wire's own spelling on the refused row, as the only evidence of it", () => {
    const meta = [...twoRuns().querySelectorAll(".meridian-run-row__meta")][1];
    const titles = [...(meta?.querySelectorAll(".meridian-figure--wire") ?? [])].map((figure) =>
      figure.getAttribute("title"),
    );
    expect(titles).toContain(offsetSpelled);
  });

  it("negative control: the display formatter alone reads that spelling perfectly well", () => {
    // The finding. Without it the case above would pass over a row that printed the em
    // dash for some unrelated reason, and would not name the reader that disagreed.
    expect(formatDateTime(offsetSpelled)).not.toBe("—");
    expect(formatDateTime(offsetSpelled)).toBe(formatDateTime("2026-01-01T10:00:00Z"));
  });

  it("negative control: the plane's own reader is the one that refuses it", () => {
    expect(workflowInstant(offsetSpelled).kind).toBe("malformed");
    expect(workflowInstant(utcSpelled).kind).toBe("instant");
  });

  it("negative control: a plain Z start still prints its figure rather than the dash", () => {
    // Without this the case above would be satisfied by a row that had stopped
    // rendering a start at all.
    expect(startFigures(renderList([run({ startedAt: utcSpelled })]))).toStrictEqual([
      formatDateTime(utcSpelled),
    ]);
  });
});
