// What the window hands to the lease table, and what it counts as one row.
//
// SPLIT FROM `window-cap.test.ts`, which is about the cap itself, the refusals a prune
// can answer with, and the reading floor. The subjects here are the two the cap
// depends on rather than states: the SEAM to the lease table, so a pruned row's
// arrangement survives its row, and the COUNTING rule, so a folded chapter is one
// entry and a run-only log is still bounded. The two suites were one file over the
// size at which a file is doing two jobs.

import { describe, expect, it } from "vitest";

import { LedgerWindow } from "./window-cap.js";
import {
  CHILDREN_PER_CHAPTER,
  foldedChapterLog,
  loadedWindow,
  PRUNABLE,
  runOnlyLog,
  syntheticLog,
} from "./window-cap.test-support.js";

describe("the ledger window — leases and cursors", () => {
  // The SEAM only. What parking means and the bound it is held to are
  // `row-lease-table.test.ts`'s; this case pins that the prune reaches it at all.
  it("re-parks a pruned row's lease under a synthetic key, and hands it back", () => {
    const window = loadedWindow();
    window.setLease("chapter-0", { density: "expanded", innerScrollTopPx: 44 });
    window.prune(PRUNABLE);
    expect(window.rows().some((row) => row.key === "chapter-0")).toBe(false);
    expect(window.lease("chapter-0")).toStrictEqual({ density: "expanded", innerScrollTopPx: 44 });
  });

  it("cuts at the pin's cursor while pinned and at the oldest retained row otherwise", () => {
    const window = new LedgerWindow();
    window.ingest(syntheticLog(3));
    expect(window.cutAtRootCursor(undefined)).toBe("cursor-0");
    expect(window.cutAtRootCursor("cursor-2")).toBe("cursor-2");
  });

  it("adopts the projection verbatim, so a second identical read changes nothing", () => {
    const window = new LedgerWindow();
    const rows = syntheticLog(3);
    window.ingest(rows);
    window.ingest(rows);
    expect(window.topLevelRowKeys()).toHaveLength(3);
    expect(window.size).toBe(3 * (CHILDREN_PER_CHAPTER + 1));
  });

  it("keeps a repeated key rather than collapsing an entry out of the log", () => {
    // The window is not the layer that decides what to do about a projection
    // defect: `RowWindow` reports the repeat and draws it at an estimated height,
    // and it can only do that if the row reaches it at all.
    const window = new LedgerWindow();
    window.ingest([
      { key: "chapter-0", parentKey: undefined, rootCursor: "cursor-0" },
      { key: "chapter-0", parentKey: undefined, rootCursor: "cursor-1" },
    ]);
    expect(window.rows()).toHaveLength(2);
  });

  it("counts a row whose parent is not in the window, so a run-only log is capped", () => {
    // The shape the ledger actually produces: every row names its run, and the run
    // itself is not a row. Read as "has a parent, therefore a child", the window
    // counted nobody and a session that never left one run grew without a ceiling.
    const window = new LedgerWindow({ topLevelCap: 10 });
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
    // Without this the case above would pass over a window that had simply stopped
    // honouring parents at all. Give the run a row of its own and the fifty entries
    // collapse into one countable head — the property the cap has always had.
    const window = new LedgerWindow({ topLevelCap: 10 });
    window.ingest([
      { key: "run-1", parentKey: undefined, rootCursor: "cursor-run-1" },
      ...runOnlyLog(50),
    ]);
    expect(window.topLevelRowKeys()).toEqual(["run-1"]);
    expect(window.prune(PRUNABLE).deferredBecause).toBe("under-cap");
    expect(window.size).toBe(51);
  });

  it("counts a folded chapter as one, so the cap bounds chapters and not rows", () => {
    // The load-bearing consequence of the ledger emitting a chapter header. Before
    // it, every run row named its run, no row WAS that run, and the cap counted each
    // of them — so ten chapters of a hundred rows read as a thousand against the
    // ceiling. With the header present the same log is ten.
    const window = new LedgerWindow({ topLevelCap: 4 });
    window.ingest(foldedChapterLog(10));
    expect(window.topLevelRowKeys()).toHaveLength(10);
    const outcome = window.prune(PRUNABLE);
    expect(outcome.applied).toBe(true);
    expect(outcome.topLevelRetained).toBe(4);
    // Header and receipt leave together — the ancestor closure — so no receipt is
    // left hanging under a chapter the window no longer holds.
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
    // Without this the case above would pass over a cap that had stopped counting
    // anything. Take the headers away and the ten receipts are ten orphans, each its
    // own top-level row — which is exactly the reading the ledger used to give it.
    const window = new LedgerWindow({ topLevelCap: 4 });
    window.ingest(foldedChapterLog(10).filter((row) => row.parentKey !== undefined));
    expect(window.topLevelRowKeys()).toHaveLength(10);
    expect(window.prune(PRUNABLE).topLevelRetained).toBe(4);
  });

  it("drops an orphan alone, never the siblings that share its absent parent", () => {
    // An orphan is its own cut unit. Dropping the whole absent-parent group would
    // evict a run's entire middle to make room for one row.
    const window = new LedgerWindow({ topLevelCap: 3 });
    window.ingest(runOnlyLog(5));
    window.prune(PRUNABLE);
    expect(window.rows().map((row) => row.key)).toEqual([
      "run-1-entry-2",
      "run-1-entry-3",
      "run-1-entry-4",
    ]);
  });
});
