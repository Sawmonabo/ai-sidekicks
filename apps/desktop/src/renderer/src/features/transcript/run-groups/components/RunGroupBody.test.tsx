// The run group body, held to what it undoes: rows that were counted and unreachable. Every case
// reads the rendered body, since a case over the fold alone would pass against a console that
// drew no body at all.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RUN_GROUP_VISIBLE_ROW_CAP } from "../../structure/structure-caps.js";
import {
  RUN_GROUP_BODY_FALLBACK_HEIGHT,
  RUN_GROUP_BODY_INTRINSIC_HEIGHT,
} from "../run-group-body.js";
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
  const sealed = findRunGroup(groupRowsByRun(rows).runGroups, RUN_ID);
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
  it("draws nothing at all for a run group that clips nothing", () => {
    expect(renderBody(longRun(-1))).toBeNull();
  });

  it("draws the clipped rows, which were previously a figure and nothing else", () => {
    const body = renderBody(longRun(2));
    expect(body?.textContent).toContain("entry 1");
    expect(body?.textContent).toContain("entry 2");
    // The outer list mounts those rows; the body never draws them twice.
    expect(body?.textContent).not.toContain(`entry ${String(RUN_GROUP_VISIBLE_ROW_CAP + 2)}`);
  });

  it("sets the height the engine agreed to on the scroller itself", () => {
    const scroller = renderBody(longRun(2))?.querySelector<HTMLElement>(
      ".meridian-run-group-body__scroller",
    );
    expect(scroller?.style.maxBlockSize).toBe(RUN_GROUP_BODY_INTRINSIC_HEIGHT);
  });

  it("falls back to a length every engine parses where the expression is refused", () => {
    const sealed = findRunGroup(groupRowsByRun(longRun(2)).runGroups, RUN_ID);
    const { container } = render(
      <RunGroupBody runGroup={sealed} supportsDeclaration={() => false} />,
    );
    expect(
      container.querySelector<HTMLElement>(".meridian-run-group-body__scroller")?.style
        .maxBlockSize,
    ).toBe(RUN_GROUP_BODY_FALLBACK_HEIGHT);
  });

  it("re-pins through the engine's own anchoring rather than a second scroll writer", () => {
    const scroller = renderBody(longRun(2))?.querySelector<HTMLElement>(
      ".meridian-run-group-body__scroller",
    );
    expect(scroller).not.toBeNull();
    expect(scroller?.scrollTop).toBe(0);
  });
});

describe("the top-edge fade — drawn only while something is clipped above", () => {
  it("draws no fade at the top of the body", () => {
    expect(renderBody(longRun(2))?.querySelector(".meridian-run-group-body__fade")).toBeNull();
  });

  it("draws the fade once the body has been scrolled off its top", () => {
    const body = renderBody(longRun(2));
    const scroller = body?.querySelector<HTMLElement>(".meridian-run-group-body__scroller");
    if (scroller === null || scroller === undefined) {
      throw new Error("the body drew no scroller");
    }
    fireEvent.scroll(scroller, { target: { scrollTop: 24 } });
    expect(body?.querySelector(".meridian-run-group-body__fade")).not.toBeNull();
  });
});

describe("what the body does not hold", () => {
  it("says how many earlier entries are outside its own window", () => {
    const body = renderBody(longRun(RUN_GROUP_VISIBLE_ROW_CAP + 3));
    expect(body?.textContent).toContain("3 earlier entries are outside this window.");
  });

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
