// What the window hands to the retained state table, and what it counts as one row: the seam that
// lets a pruned row's arrangement survive its row, and the counting rule that makes a folded run
// group one entry and bounds a run-only log. `window-cap.test.ts` covers the cap itself.

import { describe, expect, it } from "vitest";

import { TranscriptWindow } from "./window-cap.js";
import {
  foldedRunGroupLog,
  loadedWindow,
  PRUNABLE,
  runOnlyLog,
} from "./window-cap.test-support.js";

describe("the transcript window — retained state and cursors", () => {
  // The seam only: parking and its bound are `retained-row-state-table.test.ts`'s; this pins
  // that the prune reaches the table at all.
  it("re-parks a pruned row's retained state under a synthetic key, and hands it back", () => {
    const window = loadedWindow();
    window.setRetainedState("run-group-0", { density: "expanded", innerScrollTopPx: 44 });
    window.prune(PRUNABLE);
    expect(window.rows().some((row) => row.key === "run-group-0")).toBe(false);
    expect(window.retainedState("run-group-0")).toStrictEqual({
      density: "expanded",
      innerScrollTopPx: 44,
    });
  });

  it("keeps a repeated key rather than collapsing an entry out of the log", () => {
    // The window keeps a repeated key; the measurement table's key projection reports and
    // draws it, which needs the row to reach it.
    const window = new TranscriptWindow();
    window.ingest([
      { key: "run-group-0", parentKey: undefined, rootCursor: "cursor-0" },
      { key: "run-group-0", parentKey: undefined, rootCursor: "cursor-1" },
    ]);
    expect(window.rows()).toHaveLength(2);
  });

  it("counts a row whose parent is not in the window, so a run-only log is capped", () => {
    // The shape the transcript produces: every row names its run and the run itself is not a
    // row. Reading a parent as proof of a child counted nobody, and a session that never left one
    // run grew without a ceiling.
    const window = new TranscriptWindow({ topLevelCap: 10 });
    window.ingest(runOnlyLog(50));
    expect(window.topLevelRowKeys()).toHaveLength(50);
    const outcome = window.prune(PRUNABLE);
    expect(outcome.applied).toBe(true);
    expect(outcome.topLevelRetained).toBe(10);
    expect(window.size).toBe(10);
    // Oldest first, so what survives is the tail of the run rather than its head.
    expect(window.rows()[0]?.key).toBe("run-1-entry-40");
  });

  it("counts a folded run group as one, so the cap bounds run groups and not rows", () => {
    // A run group header row gives every run row a parent that is a row; without it each run row
    // counted, so ten run groups of a hundred rows read as a thousand against the ceiling.
    const window = new TranscriptWindow({ topLevelCap: 4 });
    window.ingest(foldedRunGroupLog(10));
    expect(window.topLevelRowKeys()).toHaveLength(10);
    const outcome = window.prune(PRUNABLE);
    expect(outcome.applied).toBe(true);
    expect(outcome.topLevelRetained).toBe(4);
    // Header and receipt leave together (the ancestor closure), so no receipt hangs under a run
    // group the window no longer holds.
    expect(window.rows().map((row) => row.key)).toEqual([
      "run-6",
      "run-6-receipt",
      "run-7",
      "run-7-receipt",
      "run-8",
      "run-8-receipt",
      "run-9",
      "run-9-receipt",
    ]);
  });

  it("drops an orphan alone, never the siblings that share its absent parent", () => {
    // An orphan is its own cut unit; dropping the whole absent-parent group would evict a run's
    // entire middle to make room for one row.
    const window = new TranscriptWindow({ topLevelCap: 3 });
    window.ingest(runOnlyLog(5));
    window.prune(PRUNABLE);
    expect(window.rows().map((row) => row.key)).toEqual([
      "run-1-entry-2",
      "run-1-entry-3",
      "run-1-entry-4",
    ]);
  });
});
