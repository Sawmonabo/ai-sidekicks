// The run group body's bounds: the height the engine agreed to, where the clip falls, and how
// much of the head the body can still reach. The height cases drive both arms through the
// injected probe, since the host's own engine only ever takes one.

import { describe, expect, it } from "vitest";

import { RUN_GROUP_VISIBLE_ROW_CAP } from "../structure/structure-caps.js";
import {
  RUN_GROUP_BODY_FALLBACK_HEIGHT,
  RUN_GROUP_BODY_INTRINSIC_HEIGHT,
  RunGroupBodyRowWindow,
  countClippedHeadRows,
  listClippedHeadRowIds,
  resolveRunGroupBodyHeight,
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

describe("the body's height — validated before it is applied", () => {
  it("takes the intrinsic expression where the engine parses it", () => {
    expect(resolveRunGroupBodyHeight(() => true)).toBe(RUN_GROUP_BODY_INTRINSIC_HEIGHT);
  });

  it("falls back to a length every engine parses where it does not", () => {
    expect(resolveRunGroupBodyHeight(() => false)).toBe(RUN_GROUP_BODY_FALLBACK_HEIGHT);
  });

  it("asks about the property it is going to set", () => {
    const asked: string[] = [];
    resolveRunGroupBodyHeight((property, value) => {
      asked.push(`${property}: ${value}`);
      return true;
    });
    expect(asked).toEqual([`max-height: ${RUN_GROUP_BODY_INTRINSIC_HEIGHT}`]);
  });
});

describe("where the clip falls", () => {
  it("clips nothing while the run group is under the ceiling", () => {
    expect(listClippedHeadRowIds(["a", "b", "c"])).toEqual([]);
  });

  it("clips the OLDER head, never the newest rows", () => {
    const rowIds = Array.from({ length: RUN_GROUP_VISIBLE_ROW_CAP + 3 }, (_unused, index) =>
      String(index),
    );
    const head = listClippedHeadRowIds(rowIds);
    expect(head).toEqual(["0", "1", "2"]);
    expect(head).not.toContain(String(RUN_GROUP_VISIBLE_ROW_CAP + 2));
  });

  it("returns one identity for every empty head, so a memo over it does not re-run", () => {
    expect(listClippedHeadRowIds(["a"])).toBe(listClippedHeadRowIds(["b", "c"]));
  });

  it("counts the clip from the run group's length alone, without building the list", () => {
    // The count is what a sealed run group carries, and it is arithmetic, not the length of
    // a sliced list.
    expect(countClippedHeadRows(RUN_GROUP_VISIBLE_ROW_CAP - 1)).toBe(0);
    expect(countClippedHeadRows(RUN_GROUP_VISIBLE_ROW_CAP)).toBe(0);
    expect(countClippedHeadRows(RUN_GROUP_VISIBLE_ROW_CAP + 7)).toBe(7);
    // A negative length is not reachable; the floor states what happens anyway.
    expect(countClippedHeadRows(0)).toBe(0);
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
  it("holds nothing while the run group is under the ceiling", () => {
    const window = new RunGroupBodyRowWindow();
    for (let sequence = 1; sequence <= RUN_GROUP_VISIBLE_ROW_CAP; sequence += 1) {
      window.admit(runGroupRow(sequence));
    }
    expect(window.headRows).toEqual([]);
  });

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
