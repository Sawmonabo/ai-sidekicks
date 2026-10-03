// The run group body's bounds: where the clip falls, and how much of the head the body can still
// reach.

import { describe, expect, it } from "vitest";

import { RUN_GROUP_VISIBLE_ROW_CAP } from "./run-group-body.js";
import {
  RunGroupBodyRowWindow,
  countClippedHeadRows,
  listClippedHeadRowIds,
} from "./run-group-body.js";
import { runRow } from "../timeline-rows.test-support.js";

function runGroupRow(sequence: number): ReturnType<typeof runRow> {
  return runRow({
    id: `r${String(sequence)}`,
    sequence,
    type: "run.running",
    runId: "run-a",
    position: sequence,
  });
}

describe("where the clip falls", () => {
  it("clips the OLDER head, never the newest rows", () => {
    const rowIds = Array.from({ length: RUN_GROUP_VISIBLE_ROW_CAP + 3 }, (_unused, index) =>
      String(index),
    );
    const head = listClippedHeadRowIds(rowIds);
    expect(head).toEqual(["0", "1", "2"]);
    expect(head).not.toContain(String(RUN_GROUP_VISIBLE_ROW_CAP + 2));
  });

  it("counts exactly what the list form would have listed, at every boundary", () => {
    // The two forms are one rule with two shapes; they agree on both sides of the cap and on
    // the cap itself.
    for (const length of [
      0,
      1,
      RUN_GROUP_VISIBLE_ROW_CAP - 1,
      RUN_GROUP_VISIBLE_ROW_CAP,
      RUN_GROUP_VISIBLE_ROW_CAP + 1,
      RUN_GROUP_VISIBLE_ROW_CAP * 2,
    ]) {
      const rowIds = Array.from({ length }, (_unused, index) => String(index));
      expect(listClippedHeadRowIds(rowIds)).toHaveLength(countClippedHeadRows(length));
    }
  });
});

describe("the body's row window — bounded on both sides", () => {
  it("holds the rows the mounted window displaced, oldest first", () => {
    const window = new RunGroupBodyRowWindow();
    for (let sequence = 1; sequence <= RUN_GROUP_VISIBLE_ROW_CAP + 2; sequence += 1) {
      window.admit(runGroupRow(sequence));
    }
    expect(window.headRows.map((row) => row.id)).toEqual(["r1", "r2"]);
  });

  it("never grows past the ceiling, however long the run is", () => {
    const window = new RunGroupBodyRowWindow();
    const admitted = RUN_GROUP_VISIBLE_ROW_CAP * 3;
    for (let sequence = 1; sequence <= admitted; sequence += 1) {
      window.admit(runGroupRow(sequence));
    }
    expect(window.headRows).toHaveLength(RUN_GROUP_VISIBLE_ROW_CAP);
    // The newest of the head, which is what a body scrolls up into first.
    expect(window.headRows.at(-1)?.id).toBe(`r${String(admitted - RUN_GROUP_VISIBLE_ROW_CAP)}`);
  });
});
