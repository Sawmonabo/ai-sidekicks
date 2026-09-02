// The window cap over a ten-thousand-row log.
//
// Ten thousand rows because the properties that matter — that children never trip
// the cap, that a closure never orphans, that a held row survives however old it is
// — are all invisible at a hundred and all obvious at ten thousand. The list is
// synthetic and generated, so the case states the shape it is testing rather than
// hiding it in a fixture.

import { describe, expect, it } from "vitest";

import { LEDGER_WINDOW_ROW_CAP } from "./frame-bounds.js";
import { LedgerWindow, PRUNE_DEFERRAL_REASONS, type PruneConditions } from "./window-cap.js";
import type { LedgerWindowRow } from "./window-cap.js";

const TOP_LEVEL_ROW_COUNT = 10_000;
const CHILDREN_PER_CHAPTER = 3;

/** A log of chapters, each with children, oldest first. */
function syntheticLog(topLevelCount: number): readonly LedgerWindowRow[] {
  const rows: LedgerWindowRow[] = [];
  for (let index = 0; index < topLevelCount; index += 1) {
    const key = `chapter-${String(index)}`;
    rows.push({ key, parentKey: undefined, rootCursor: `cursor-${String(index)}` });
    for (let child = 0; child < CHILDREN_PER_CHAPTER; child += 1) {
      rows.push({
        key: `${key}-child-${String(child)}`,
        parentKey: key,
        rootCursor: `cursor-${String(index)}`,
      });
    }
  }
  return rows;
}

/** A log whose every row names one run, and where no row IS that run. */
function runOnlyLog(entryCount: number): readonly LedgerWindowRow[] {
  return Array.from({ length: entryCount }, (_unused, index) => ({
    key: `run-1-entry-${String(index)}`,
    parentKey: "run-1",
    rootCursor: `cursor-${String(index)}`,
  }));
}

const PRUNABLE: PruneConditions = {
  hasActiveTurn: false,
  scrollControllerVetoes: false,
  revealDrainInFlight: false,
  pinnedRootCursor: undefined,
  heldRowKeys: [],
  readingFloorRowKey: undefined,
};

function loadedWindow(): LedgerWindow {
  const window = new LedgerWindow();
  window.ingest(syntheticLog(TOP_LEVEL_ROW_COUNT));
  return window;
}

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
      expect(outcome.applied).toBe(false);
      expect(outcome.prunedKeys).toStrictEqual([]);
      expect(window.topLevelRowKeys()).toHaveLength(TOP_LEVEL_ROW_COUNT);
    }
  });

  it("says `under-cap` rather than reporting a prune that dropped nothing", () => {
    const window = new LedgerWindow();
    window.ingest(syntheticLog(4));
    expect(window.prune(PRUNABLE).deferredBecause).toBe("under-cap");
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
});

describe("the ledger window — the reading floor", () => {
  /** The row a reader is parked on, far enough back that the cap wants it gone. */
  const READER_ROW = "chapter-10";

  it("stops the drop at the reader's row, and keeps the window contiguous", () => {
    const window = loadedWindow();
    const outcome = window.prune({ ...PRUNABLE, readingFloorRowKey: READER_ROW });
    expect(outcome.applied).toBe(true);
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

describe("the ledger window — leases and cursors", () => {
  it("re-parks a pruned row's lease under a synthetic key, and hands it back", () => {
    const window = loadedWindow();
    window.setLease("chapter-0", { density: "expanded", innerScrollTopPx: 44 });
    window.prune(PRUNABLE);
    expect(window.rows().some((row) => row.key === "chapter-0")).toBe(false);
    expect(window.lease("chapter-0")).toStrictEqual({ density: "expanded", innerScrollTopPx: 44 });
  });

  it("bounds the parked table, evicting the least recently parked", () => {
    const window = new LedgerWindow({ topLevelCap: 1, parkedLeaseCap: 2 });
    window.ingest(syntheticLog(4));
    for (const index of [0, 1, 2]) {
      window.setLease(`chapter-${String(index)}`, { density: "expanded", innerScrollTopPx: index });
    }
    window.prune(PRUNABLE);
    expect(window.lease("chapter-0")).toBeUndefined();
    expect(window.lease("chapter-1")?.innerScrollTopPx).toBe(1);
    expect(window.lease("chapter-2")?.innerScrollTopPx).toBe(2);
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
