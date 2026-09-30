// Driven through `RunListProjection` rather than hand-built rows, so the seam between projection
// and list stays checked. Claims here: the absence, the header counts, the row order; what a row
// draws is `RunListItem.test.tsx`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatDateTime } from "@renderer/lib/wire-figures.js";
import { RunList } from "./RunList.js";
import { RunListProjection } from "../run-list-projection.js";
import { workflowInstant } from "../run-list-rows.js";
import type { WorkflowPhaseStateRow, WorkflowRunSnapshot } from "../run-list-rows.js";
import { phase, run } from "../run-list-projection.test-support.js";

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

/** One phase parked on a person, which is what makes a run parked. */
function parkedPhase(phaseId: string): WorkflowPhaseStateRow {
  return phase({
    phaseId,
    phaseName: "Sign-off",
    parkReason: "waiting-human",
    parkCause: "Waiting for sign-off.",
  });
}

describe("an empty list", () => {
  it("says there are none, as the block-sized empty absence", () => {
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
      run({
        workflowRunId: "run-older",
        definitionName: "Older",
        startedAt: "2026-09-01T09:00:00.000Z",
      }),
      run({
        workflowRunId: "run-newer",
        definitionName: "Newer",
        startedAt: "2026-09-01T11:00:00.000Z",
      }),
    ]);
    expect(rowNames(root)).toStrictEqual(["Newer", "Older"]);
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
    const summary =
      renderList([run({ phaseStates: [] })]).querySelector(".meridian-run-list__summary")
        ?.textContent ?? "";
    expect(summary).toContain("Runs");
    expect(summary).not.toContain("Parked");
    expect(summary).not.toContain("Frozen pins");
  });
});

/*
 * The start is displayed under the grammar it is sorted under: `workflowInstant` is `"utc-only"`
 * while `formatDateTime` admits a numeric offset, so a `+02:00` start sorted last must not print
 * a legible time.
 */
describe("a start spelled with a numeric offset", () => {
  // 10:00Z is genuinely newer than the run below it, so placing it last is a visible symptom.
  const offsetSpelled = "2026-01-01T12:00:00+02:00";
  const utcSpelled = "2026-01-01T09:00:00Z";

  function twoRuns(): HTMLElement {
    return renderList([
      run({ workflowRunId: "run-offset", definitionName: "Offset", startedAt: offsetSpelled }),
      run({ workflowRunId: "run-utc", definitionName: "Utc", startedAt: utcSpelled }),
    ]);
  }

  it("sorts it last and prints it as the unreadable value workflowInstant made it", () => {
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
    expect(formatDateTime(offsetSpelled)).not.toBe("—");
    expect(formatDateTime(offsetSpelled)).toBe(formatDateTime("2026-01-01T10:00:00Z"));
  });

  it("negative control: workflowInstant is the reader that refuses it", () => {
    expect(workflowInstant(offsetSpelled).kind).toBe("malformed");
    expect(workflowInstant(utcSpelled).kind).toBe("instant");
  });

  it("negative control: a plain Z start still prints its figure rather than the dash", () => {
    expect(startFigures(renderList([run({ startedAt: utcSpelled })]))).toStrictEqual([
      formatDateTime(utcSpelled),
    ]);
  });
});
