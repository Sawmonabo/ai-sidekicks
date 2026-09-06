// The window cap: what it drops, what it refuses to drop, and what it leaves owed.
//
// The logs and the all-clear conditions are `window-cap.test-support.ts`', shared with
// `window-cap.leases.test.ts` — the seam to the lease table and the rules that decide
// what counts as one row, which is the other half of this module and a subject of its
// own.

import { describe, expect, it } from "vitest";

import { LEDGER_WINDOW_ROW_CAP } from "../frame-bounds.js";
import { LedgerWindow, PRUNE_DEFERRAL_REASONS, type PruneConditions } from "./window-cap.js";
import {
  CHILDREN_PER_CHAPTER,
  loadedWindow,
  PRUNABLE,
  syntheticWindowRows,
  TOP_LEVEL_ROW_COUNT,
} from "./window-cap.test-support.js";

describe("the ledger window — the cap", () => {
  it("caps top-level rows and lets children ride along", () => {
    const window = loadedWindow();
    expect(window.topLevelRowKeys()).toHaveLength(TOP_LEVEL_ROW_COUNT);
    const outcome = window.prune(PRUNABLE);
    expect(outcome.applied).toBe(true);
    expect(outcome.topLevelRetained).toBe(LEDGER_WINDOW_ROW_CAP);
    // Children never trip the cap: the retained set is the cap's worth of chapters
    // WITH their children, not the cap's worth of rows.
    expect(window.size).toBe(LEDGER_WINDOW_ROW_CAP * (CHILDREN_PER_CHAPTER + 1));
  });

  it("drops the oldest first, and keeps the newest", () => {
    const window = loadedWindow();
    window.prune(PRUNABLE);
    const retained = window.topLevelRowKeys();
    expect(retained[0]).toBe(`chapter-${String(TOP_LEVEL_ROW_COUNT - LEDGER_WINDOW_ROW_CAP)}`);
    expect(retained[retained.length - 1]).toBe(`chapter-${String(TOP_LEVEL_ROW_COUNT - 1)}`);
  });

  it("never orphans a child: every retained child's parent is retained too", () => {
    const window = loadedWindow();
    window.prune(PRUNABLE);
    const retainedKeys = new Set(window.rows().map((row) => row.key));
    const orphans = window
      .rows()
      .filter((row) => row.parentKey !== undefined && !retainedKeys.has(row.parentKey))
      .map((row) => row.key);
    expect(orphans).toStrictEqual([]);
  });

  it("negative control: the un-pruned log DOES contain more than the cap", () => {
    // Without this, every assertion above would pass over a window that had
    // silently ingested nothing at all.
    const window = loadedWindow();
    expect(window.topLevelRowKeys().length).toBeGreaterThan(LEDGER_WINDOW_ROW_CAP);
    expect(window.prune(PRUNABLE).prunedKeys.length).toBeGreaterThan(0);
  });
});

describe("the ledger window — when prune may not land", () => {
  it("declares its deferral reasons closed", () => {
    expect([...PRUNE_DEFERRAL_REASONS]).toStrictEqual([
      "under-cap",
      "active-turn",
      "scroll-write",
      "reveal-drain",
      "pinned-history",
      "reading-floor",
      "held-rows",
    ]);
  });

  it("defers, naming the reason, and drops nothing while deferred", () => {
    const conditionsByReason: readonly (readonly [string, PruneConditions])[] = [
      ["pinned-history", { ...PRUNABLE, pinnedRootCursor: "cursor-9" }],
      ["active-turn", { ...PRUNABLE, hasActiveTurn: true }],
      ["scroll-write", { ...PRUNABLE, scrollControllerVetoes: true }],
      ["reveal-drain", { ...PRUNABLE, revealDrainInFlight: true }],
    ];
    for (const [reason, conditions] of conditionsByReason) {
      const window = loadedWindow();
      const outcome = window.prune(conditions);
      expect(outcome.deferredBecause).toBe(reason);
      expect(outcome.owedBecause).toBe(reason);
      expect(outcome.applied).toBe(false);
      expect(outcome.prunedKeys).toStrictEqual([]);
      expect(window.topLevelRowKeys()).toHaveLength(TOP_LEVEL_ROW_COUNT);
    }
  });

  it("says `under-cap` rather than reporting a prune that dropped nothing", () => {
    const window = new LedgerWindow();
    window.ingest(syntheticWindowRows(4));
    const outcome = window.prune(PRUNABLE);
    expect(outcome.deferredBecause).toBe("under-cap");
    // And owes nothing: a window inside its cap is not one waiting on a condition,
    // so the caller that re-asks has nothing to re-ask about.
    expect(outcome.owedBecause).toBeUndefined();
  });

  it("never prunes a held row, however old, nor the chapter above a held child", () => {
    const window = loadedWindow();
    const outcome = window.prune({
      ...PRUNABLE,
      heldRowKeys: ["chapter-0", "chapter-1-child-2"],
    });
    const retainedKeys = new Set(window.rows().map((row) => row.key));
    expect(retainedKeys.has("chapter-0")).toBe(true);
    expect(retainedKeys.has("chapter-1")).toBe(true);
    expect(retainedKeys.has("chapter-1-child-2")).toBe(true);
    expect(outcome.prunedKeys).not.toContain("chapter-0");
  });

  it("names `held-rows` when every candidate the cap wanted is held", () => {
    // The second way a pass can end over its cap: no floor stopped the walk, it
    // simply had nothing it was allowed to take. Reported as an applied prune with
    // an empty key list this reads exactly like a window already under cap.
    const window = new LedgerWindow({ topLevelCap: 2 });
    window.ingest(syntheticWindowRows(5));
    const outcome = window.prune({
      ...PRUNABLE,
      heldRowKeys: ["chapter-0", "chapter-1", "chapter-2", "chapter-3", "chapter-4"],
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.deferredBecause).toBe("held-rows");
    expect(outcome.owedBecause).toBe("held-rows");
    expect(window.topLevelRowKeys()).toHaveLength(5);
  });

  it("owes `held-rows` for a pass that took what it could and stayed over cap", () => {
    // One of the three rows the cap wanted is free, so the pass APPLIES — and the
    // window is still two rows over its ceiling with nobody re-asking unless the
    // residual is named beside the applied outcome.
    const window = new LedgerWindow({ topLevelCap: 2 });
    window.ingest(syntheticWindowRows(5));
    const outcome = window.prune({
      ...PRUNABLE,
      heldRowKeys: ["chapter-0", "chapter-2", "chapter-3", "chapter-4"],
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.deferredBecause).toBeUndefined();
    expect(outcome.prunedKeys).toContain("chapter-1");
    expect(outcome.owedBecause).toBe("held-rows");
    expect(window.topLevelRowKeys()).toHaveLength(4);
  });

  it("negative control: the same rows unheld leave nothing owed", () => {
    // Without this the two cases above would pass over a window that had started
    // reporting `held-rows` for every prune it performed.
    const window = new LedgerWindow({ topLevelCap: 2 });
    window.ingest(syntheticWindowRows(5));
    const outcome = window.prune(PRUNABLE);
    expect(outcome.applied).toBe(true);
    expect(outcome.owedBecause).toBeUndefined();
    expect(window.topLevelRowKeys()).toHaveLength(2);
  });
});

describe("the ledger window — the reading floor", () => {
  /** The row a reader is parked on, far enough back that the cap wants it gone. */
  const READER_ROW = "chapter-10";

  it("stops the drop at the reader's row, and keeps the window contiguous", () => {
    const window = loadedWindow();
    const outcome = window.prune({ ...PRUNABLE, readingFloorRowKey: READER_ROW });
    expect(outcome.applied).toBe(true);
    // AND SAYS SO IS NOT THE WHOLE STORY. Ten rows went and 9 590 stayed, so the
    // window is still far over its cap — an outcome that reported only `applied`
    // told the re-ask there was nothing owed, and on a session that then went quiet
    // those rows stayed resident for the life of the mount.
    expect(outcome.owedBecause).toBe("reading-floor");
    expect(outcome.topLevelRetained).toBeGreaterThan(LEDGER_WINDOW_ROW_CAP);
    // Everything above the reader that the cap wanted, and not one row more: the
    // dropped set is the ten chapters before them, with their children.
    expect(outcome.prunedKeys).toStrictEqual(
      Array.from({ length: 10 }, (_unused, index) => `chapter-${String(index)}`).flatMap(
        (chapterKey) => [
          chapterKey,
          ...Array.from(
            { length: CHILDREN_PER_CHAPTER },
            (_unused, child) => `${chapterKey}-child-${String(child)}`,
          ),
        ],
      ),
    );
    // The reader's row survives, and so does everything after it — the window the
    // reader is about to scroll into is whole rather than holed.
    const retainedKeys = window.rows().map((row) => row.key);
    expect(retainedKeys[0]).toBe(READER_ROW);
    expect(retainedKeys).toHaveLength((TOP_LEVEL_ROW_COUNT - 10) * (CHILDREN_PER_CHAPTER + 1));
  });

  it("negative control: without the floor the very same row is dropped", () => {
    // Which is what makes the case above the floor's doing rather than an accident
    // of where the cap happened to cut.
    const window = loadedWindow();
    expect(window.prune(PRUNABLE).prunedKeys).toContain(READER_ROW);
  });

  it("holds a chapter whose child the reader is on, rather than dropping its head", () => {
    const readerChildRow = "chapter-3-child-1";
    const window = loadedWindow();
    const outcome = window.prune({ ...PRUNABLE, readingFloorRowKey: readerChildRow });
    expect(outcome.prunedKeys).not.toContain("chapter-3");
    expect(outcome.prunedKeys[outcome.prunedKeys.length - 1]).toBe("chapter-2-child-2");
  });

  it("names `reading-floor` when the floor leaves it nothing to take", () => {
    // A prune that returned `applied` with an empty key list would be
    // indistinguishable from a window that was already under cap.
    const window = loadedWindow();
    const outcome = window.prune({ ...PRUNABLE, readingFloorRowKey: "chapter-0" });
    expect(outcome.applied).toBe(false);
    expect(outcome.deferredBecause).toBe("reading-floor");
    expect(outcome.prunedKeys).toStrictEqual([]);
    expect(window.topLevelRowKeys()).toHaveLength(TOP_LEVEL_ROW_COUNT);
  });

  it("negative control: a floor the drop never reaches owes nothing", () => {
    // Without this, `owedBecause` could be a member the reading floor sets on every
    // pass it is given rather than only on the passes it actually stopped.
    const nearTheTailRow = `chapter-${String(TOP_LEVEL_ROW_COUNT - 5)}`;
    const window = loadedWindow();
    const outcome = window.prune({ ...PRUNABLE, readingFloorRowKey: nearTheTailRow });
    expect(outcome.applied).toBe(true);
    expect(outcome.owedBecause).toBeUndefined();
    expect(outcome.topLevelRetained).toBe(LEDGER_WINDOW_ROW_CAP);
  });

  it("negative control: a floor at the tail prunes byte-identically to no floor at all", () => {
    // The reader at the tail is the common case, and the floor must cost it
    // nothing: same outcome value, same retained window.
    const tailKey = `chapter-${String(TOP_LEVEL_ROW_COUNT - 1)}`;
    const withoutFloor = loadedWindow();
    const withFloorAtTail = loadedWindow();
    expect(withFloorAtTail.prune({ ...PRUNABLE, readingFloorRowKey: tailKey })).toStrictEqual(
      withoutFloor.prune(PRUNABLE),
    );
    expect(withFloorAtTail.rows()).toStrictEqual(withoutFloor.rows());
  });

  it("ignores a floor naming a row the window no longer holds", () => {
    const window = loadedWindow();
    const outcome = window.prune({ ...PRUNABLE, readingFloorRowKey: "a-row-pruned-long-ago" });
    expect(outcome.applied).toBe(true);
    expect(outcome.topLevelRetained).toBe(LEDGER_WINDOW_ROW_CAP);
  });
});
