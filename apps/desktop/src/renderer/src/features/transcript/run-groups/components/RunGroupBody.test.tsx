// The run group body, held to what it undoes: rows that were counted and unreachable. Every case
// reads the rendered body, since a case over the fold alone would pass against a transcript that
// drew no body at all.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RUN_GROUP_VISIBLE_ROW_CAP } from "../run-group-body.js";
import { RunGroupBody } from "./RunGroupBody.js";
import { groupRowsByRun } from "../run-groups.js";
import { findRunGroup } from "../run-groups.test-support.js";
import { runRow } from "../../timeline-rows.test-support.js";
import { type TimelineRow } from "@ai-sidekicks/contracts";

const RUN_ID = "run-a";

function longRun(extraRows: number): readonly TimelineRow[] {
  return Array.from({ length: RUN_GROUP_VISIBLE_ROW_CAP + extraRows }, (_unused, index) =>
    runRow({
      id: `r${String(index + 1)}`,
      sequence: index + 1,
      type: "run.running",
      summary: `entry ${String(index + 1)}`,
      runId: RUN_ID,
      position: index + 1,
    }),
  );
}

function renderBody(
  rows: readonly TimelineRow[],
  narrowedRowIds?: readonly string[],
): HTMLElement | null {
  const sealed = findRunGroup(groupRowsByRun(rows), RUN_ID);
  const runGroup =
    narrowedRowIds === undefined
      ? sealed
      : { ...sealed, rowIds: narrowedRowIds, rowCount: narrowedRowIds.length };
  const { container } = render(
    <RunGroupBody runGroup={runGroup} supportsDeclaration={() => true} />,
  );
  return container.querySelector<HTMLElement>(".meridian-run-group-body");
}

describe("the run group body — the head the outer list left out", () => {
  it("draws the clipped rows, not only their count", () => {
    const body = renderBody(longRun(2));
    expect(body?.textContent).toContain("entry 1");
    expect(body?.textContent).toContain("entry 2");
    // The outer list mounts those rows; the body never draws them twice.
    expect(body?.textContent).not.toContain(`entry ${String(RUN_GROUP_VISIBLE_ROW_CAP + 2)}`);
  });
});

describe("what the body does not hold", () => {
  it("asks only for the rows a narrowing admitted, never the whole run's", () => {
    const admitted = [
      "r1",
      "r2",
      ...Array.from(
        { length: RUN_GROUP_VISIBLE_ROW_CAP },
        (_unused, index) => `r${String(index + 3)}`,
      ),
    ];
    const body = renderBody(longRun(40), admitted);
    // Two admitted rows sit outside the ceiling, so the body draws exactly those two, not the
    // thirty-eight the unfiltered run group would have clipped.
    expect(body?.querySelectorAll(".meridian-run-group-body__row")).toHaveLength(2);
    expect(body?.textContent).toContain("entry 1");
    expect(body?.textContent).toContain("entry 2");
  });
});
