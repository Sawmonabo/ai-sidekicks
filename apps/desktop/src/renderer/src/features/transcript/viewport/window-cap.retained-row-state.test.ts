// What the window hands to the lease table, and what it counts as one row: the seam that lets a
// pruned row's arrangement survive its row, and the counting rule that makes a folded run group
// one entry and bounds a run-only log. `window-cap.test.ts` covers the cap itself.

import { describe, expect, it } from "vitest";

import { TranscriptWindow } from "./window-cap.js";
import {
  CHILDREN_PER_RUN_GROUP,
  foldedRunGroupLog,
  loadedWindow,
  PRUNABLE,
  runOnlyLog,
  syntheticWindowRows,
} from "./window-cap.test-support.js";

describe("the transcript window — leases and cursors", () => {
  // The seam only: parking and its bound are `retained-row-state-table.test.ts`'s; this pins
  // that the prune reaches the table at all.
  it("re-parks a pruned row's lease under a synthetic key, and hands it back", () => {
    const window = loadedWindow();
    window.setLease("run-group-0", { density: "expanded", innerScrollTopPx: 44 });
    window.prune(PRUNABLE);
    expect(window.rows().some((row) => row.key === "run-group-0")).toBe(false);
    expect(window.lease("run-group-0")).toStrictEqual({
      density: "expanded",
      innerScrollTopPx: 44,
    });
  });

  it("cuts at the pin's cursor while pinned and at the oldest retained row otherwise", () => {
    const window = new TranscriptWindow();
    window.ingest(syntheticWindowRows(3));
    expect(window.cutAtRootCursor(undefined)).toBe("cursor-0");
    expect(window.cutAtRootCursor("cursor-2")).toBe("cursor-2");
  });

  it("adopts the projection verbatim, so a second identical read changes nothing", () => {
    const window = new TranscriptWindow();
    const rows = syntheticWindowRows(3);
    window.ingest(rows);
    window.ingest(rows);
    expect(window.topLevelRowKeys()).toHaveLength(3);
    expect(window.size).toBe(3 * (CHILDREN_PER_RUN_GROUP + 1));
  });

  it("keeps a repeated key rather than collapsing an entry out of the log", () => {
    // The window keeps a repeated key; the measurement ledger's key projection reports and
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

  it("negative control: the same rows under a parent the window holds count once", () => {
    // Without this the case above passes over a window that stopped honoring parents. Give the
    // run a row and the fifty entries collapse into one countable head.
    const window = new TranscriptWindow({ topLevelCap: 10 });
    window.ingest([
      { key: "run-1", parentKey: undefined, rootCursor: "cursor-run-1" },
      ...runOnlyLog(50),
    ]);
    expect(window.topLevelRowKeys()).toEqual(["run-1"]);
    expect(window.prune(PRUNABLE).deferredBecause).toBe("under-cap");
    expect(window.size).toBe(51);
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

  it("negative control: the same receipts with no header count one apiece", () => {
    // Without this the case above passes over a cap that stopped counting anything: without
    // headers the ten receipts are ten orphans, each its own top-level row.
    const window = new TranscriptWindow({ topLevelCap: 4 });
    window.ingest(foldedRunGroupLog(10).filter((row) => row.parentKey !== undefined));
    expect(window.topLevelRowKeys()).toHaveLength(10);
    expect(window.prune(PRUNABLE).topLevelRetained).toBe(4);
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
