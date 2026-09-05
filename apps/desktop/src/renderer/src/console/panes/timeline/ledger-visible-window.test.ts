// The two windows, and what happens at the seam between them.
//
// Every case here drives the real fold, the real matcher, and the real rail model
// over a log big enough that the cap has something to take. The property under test
// is not "find works" — `find-model.test.ts` owns that — it is that find and the
// rail are asked about the window the VIEWPORT is showing, and that what falls
// outside it is counted rather than walked into.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LEDGER_OVERSCAN_ROWS } from "../../ledger/frame/frame-bounds.js";
import { type LedgerViewportRow } from "../../ledger/frame/index.js";
import { ProvenanceRailModel, railViewportBand } from "../../ledger/structure/index.js";
import { type ConsoleSessionEvent } from "../../store/index.js";
import { foldChapterHeaders } from "./ledger-chapter-fold.js";
import { useLedgerFind } from "./ledger-find.js";
import {
  useRailGeometry,
  useVisibleLedgerWindow,
  type VisibleLedgerWindow,
} from "./ledger-visible-window.js";
import { ledgerFixtureStampAt } from "./ledger-feed-logs.test-support.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "./ledger-window.js";

const SESSION_ID = "session-visible-window";
const LOG_EVENT_COUNT = 10;
const RETAINED_ROW_COUNT = 4;
const EVERY_ROW_QUERY = "user.message";

/** A log whose every row matches `EVERY_ROW_QUERY`, oldest first. */
function syntheticLog(count: number): readonly ConsoleSessionEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `event-${String(index)}`,
    sessionId: SESSION_ID,
    sequence: index,
    kind: EVERY_ROW_QUERY,
    occurredAt: ledgerFixtureStampAt(index),
    payload: {},
  }));
}

describe("the visible ledger window", () => {
  it("keeps only the rows the viewport reconciled, and counts the rest", () => {
    const ledgerWindow = deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false);
    const retained = ledgerWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const { result } = renderHook(() =>
      useVisibleLedgerWindow(ledgerWindow, ledgerWindow.viewportRows, retained),
    );
    expect(result.current.rows).toHaveLength(RETAINED_ROW_COUNT);
    expect(result.current.prunedAwayRows).toHaveLength(LOG_EVENT_COUNT - RETAINED_ROW_COUNT);
    // The rail marks what is on screen: every tick names a row the viewport holds,
    // so a tick is always a jump that arrives somewhere.
    const retainedKeys = new Set(retained.map((row) => row.key));
    for (const tick of result.current.railModel.model().ticks) {
      expect(retainedKeys.has(tick.rowId)).toBe(true);
    }
  });

  it("walks only rows the viewport can scroll to, and names the matches beyond it", () => {
    const ledgerWindow = deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false);
    const retained = ledgerWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const retainedKeys = new Set(retained.map((row) => row.key));
    const { result } = renderHook(() => {
      const visible = useVisibleLedgerWindow(ledgerWindow, ledgerWindow.viewportRows, retained);
      return useLedgerFind(visible);
    });

    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });

    expect(result.current.result.searchedRowCount).toBe(RETAINED_ROW_COUNT);
    expect(result.current.result.totalMatchCount).toBe(RETAINED_ROW_COUNT);
    expect(result.current.beyondWindowMatchCount).toBe(LOG_EVENT_COUNT - RETAINED_ROW_COUNT);
    for (let step = 0; step < LOG_EVENT_COUNT; step += 1) {
      const walked = result.current.step("next");
      expect(walked).toBeDefined();
      expect(retainedKeys.has(walked?.match.rowId ?? "")).toBe(true);
    }
  });

  it("negative control: searching the whole log walks rows the viewport does not hold", () => {
    // Without this the case above would pass over a find that simply had fewer rows
    // to look at. Handed the log instead of the window — which is what the field was
    // handed before — the same query counts every row and steps to the oldest one,
    // which the viewport reconciled away and `jumpToRow` cannot reach.
    const ledgerWindow = deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false);
    const retainedKeys = new Set(
      ledgerWindow.viewportRows.slice(-RETAINED_ROW_COUNT).map((row) => row.key),
    );
    const wholeLogWindow: VisibleLedgerWindow = {
      rows: ledgerWindow.rows,
      prunedAwayRows: [],
      withheldByReplayRows: [],
      hasEarlierRows: false,
      // Nothing outside this window, so both stage memberships are the rows
      // themselves — the identity the partition would have produced.
      revealedRowKeys: new Set(ledgerWindow.rows.map((row) => row.id)),
      heldRowKeys: new Set(ledgerWindow.rows.map((row) => row.id)),
      railModel: new ProvenanceRailModel({ rows: ledgerWindow.rows, hasEarlierRows: false }),
    };
    const { result } = renderHook(() => useLedgerFind(wholeLogWindow));
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    expect(result.current.result.totalMatchCount).toBe(LOG_EVENT_COUNT);
    expect(result.current.beyondWindowMatchCount).toBe(0);
    const walked = result.current.step("next");
    expect(retainedKeys.has(walked?.match.rowId ?? "")).toBe(false);
  });
});

describe("the clip the window states", () => {
  /** One loaded log, from which a case keeps the whole window or only its tail. */
  function loadedWindow(): LedgerWindowModel {
    return deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false);
  }

  it("says earlier rows exist exactly when the cap took some", () => {
    const ledgerWindow = loadedWindow();
    const retained = ledgerWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const { result } = renderHook(() =>
      useVisibleLedgerWindow(ledgerWindow, ledgerWindow.viewportRows, retained),
    );
    expect(result.current.hasEarlierRows).toBe(true);
    // The rail's dotted segment reads this, and it was drawn on no window at all
    // while the clip was a constant `false`.
    expect(result.current.railModel.model().clip.hasUnloadedExtent).toBe(true);
  });

  it("carries that clip into the find result's stated boundary", () => {
    const ledgerWindow = loadedWindow();
    const retained = ledgerWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const { result } = renderHook(() => {
      const visible = useVisibleLedgerWindow(ledgerWindow, ledgerWindow.viewportRows, retained);
      return useLedgerFind(visible);
    });
    expect(result.current.result.hasEarlierRows).toBe(true);
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    // Both arms of the matcher, because the empty-query result is its own value and
    // a boundary stated on one and not the other is a boundary that comes and goes
    // as somebody types.
    expect(result.current.result.hasEarlierRows).toBe(true);
  });

  it("negative control: a window holding its whole log claims nothing before it", () => {
    // Without this the two cases above would pass over a clip hard-coded the other
    // way round, which would draw a dotted segment on every complete session.
    const ledgerWindow = loadedWindow();
    const { result } = renderHook(() => {
      const visible = useVisibleLedgerWindow(
        ledgerWindow,
        ledgerWindow.viewportRows,
        ledgerWindow.viewportRows,
      );
      return { visible, find: useLedgerFind(visible) };
    });
    expect(result.current.visible.prunedAwayRows).toHaveLength(0);
    expect(result.current.visible.hasEarlierRows).toBe(false);
    expect(result.current.visible.railModel.model().clip.hasUnloadedExtent).toBe(false);
    expect(result.current.find.result.hasEarlierRows).toBe(false);
  });
});

describe("cap retention and replay visibility are two facts", () => {
  const REVEALED_PREFIX_ROW_COUNT = 4;

  /**
   * The window an ENGAGED replay parked before the tail produces.
   *
   * The revealed prefix is what the viewport ingests and the cap ADOPTS, so the two
   * arrays are the same one: nothing was pruned, and the rows past the prefix are
   * withheld rather than gone.
   */
  function replayParkedBeforeTail(): {
    readonly ledgerWindow: LedgerWindowModel;
    readonly revealed: readonly LedgerViewportRow[];
  } {
    const ledgerWindow = deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false);
    return {
      ledgerWindow,
      revealed: ledgerWindow.viewportRows.slice(0, REVEALED_PREFIX_ROW_COUNT),
    };
  }

  it("reports a replay's unreached rows as withheld and nothing as pruned", () => {
    const { ledgerWindow, revealed } = replayParkedBeforeTail();
    const { result } = renderHook(() => useVisibleLedgerWindow(ledgerWindow, revealed, revealed));
    expect(result.current.rows).toHaveLength(REVEALED_PREFIX_ROW_COUNT);
    expect(result.current.prunedAwayRows).toHaveLength(0);
    expect(result.current.withheldByReplayRows).toHaveLength(
      LOG_EVENT_COUNT - REVEALED_PREFIX_ROW_COUNT,
    );
  });

  it("draws no unloaded segment for a window nothing was taken out of", () => {
    // The rail's dotted segment says rows are missing from the head. A replay
    // holding the TAIL back is the opposite fact, and drawing it there told a
    // person a complete session had been truncated.
    const { ledgerWindow, revealed } = replayParkedBeforeTail();
    const { result } = renderHook(() => useVisibleLedgerWindow(ledgerWindow, revealed, revealed));
    expect(result.current.hasEarlierRows).toBe(false);
    expect(result.current.railModel.model().clip.hasUnloadedExtent).toBe(false);
  });

  it("counts the two absences in two figures, and states neither as the other", () => {
    const { ledgerWindow, revealed } = replayParkedBeforeTail();
    const { result } = renderHook(() =>
      useLedgerFind(useVisibleLedgerWindow(ledgerWindow, revealed, revealed)),
    );
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    expect(result.current.beyondWindowMatchCount).toBe(0);
    expect(result.current.notYetReplayedMatchCount).toBe(
      LOG_EVENT_COUNT - REVEALED_PREFIX_ROW_COUNT,
    );
    // And the boundary the field states stays false, because no row is before the
    // head — which is what the single complement got wrong.
    expect(result.current.result.hasEarlierRows).toBe(false);
  });

  it("negative control: an idle dock over a capped window still reports a prune", () => {
    // Without this the three cases above would pass over a partition that called
    // every absent row a replay withholding, which would silence the cap entirely.
    const ledgerWindow = deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false);
    const retained = ledgerWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const { result } = renderHook(() =>
      useLedgerFind(useVisibleLedgerWindow(ledgerWindow, ledgerWindow.viewportRows, retained)),
    );
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    expect(result.current.beyondWindowMatchCount).toBe(LOG_EVENT_COUNT - RETAINED_ROW_COUNT);
    expect(result.current.notYetReplayedMatchCount).toBe(0);
    expect(result.current.result.hasEarlierRows).toBe(true);
  });
});

describe("the rail's two fractions", () => {
  const RAIL_WINDOW_ROW_COUNT = 300;
  const VISIBLE_ROW_COUNT = 5;
  const FIRST_VISIBLE_INDEX = 100;

  it("measures the range the box intersects, not the range it mounts", () => {
    const { result } = renderHook(() =>
      useRailGeometry(
        {
          startIndex: FIRST_VISIBLE_INDEX,
          endIndex: FIRST_VISIBLE_INDEX + VISIBLE_ROW_COUNT - 1,
        },
        RAIL_WINDOW_ROW_COUNT,
      ),
    );
    expect(result.current.extent).toBeCloseTo(VISIBLE_ROW_COUNT / RAIL_WINDOW_ROW_COUNT, 6);
    // One denominator for both readings — the retained row count — which is what
    // makes the thumb the span of the bands the marks are placed in.
    expect(result.current.position).toBeCloseTo(FIRST_VISIBLE_INDEX / RAIL_WINDOW_ROW_COUNT, 6);
  });

  it("negative control: the overscanned mount range gives a different, wrong answer", () => {
    // The mounted range is the visible one widened by the overscan at both edges,
    // which is exactly what the geometry used to be handed. Feeding it here shows
    // the two readings are not the same number, so the case above is discriminating
    // rather than passing over either.
    const { result } = renderHook(() =>
      useRailGeometry(
        {
          startIndex: FIRST_VISIBLE_INDEX - LEDGER_OVERSCAN_ROWS,
          endIndex: FIRST_VISIBLE_INDEX + VISIBLE_ROW_COUNT - 1 + LEDGER_OVERSCAN_ROWS,
        },
        RAIL_WINDOW_ROW_COUNT,
      ),
    );
    expect(result.current.extent).toBeCloseTo(
      (VISIBLE_ROW_COUNT + 2 * LEDGER_OVERSCAN_ROWS) / RAIL_WINDOW_ROW_COUNT,
      6,
    );
    expect(result.current.position).toBeLessThan(FIRST_VISIBLE_INDEX / RAIL_WINDOW_ROW_COUNT);
  });

  it("ends a tail viewport's thumb exactly at the rail's foot", () => {
    // Rows 90 to 99 of 100: the arithmetic that shipped read 90.9% down with 10%
    // of height, and `thumbStyle` clamped the two independently, so the thumb ran
    // off the end of the rail rather than finishing at it.
    const { result } = renderHook(() => useRailGeometry({ startIndex: 90, endIndex: 99 }, 100));
    expect(result.current.position + result.current.extent).toBeCloseTo(1, 12);
  });

  it("negative control: the old top-against-the-last-index form overruns", () => {
    const staleTop = 90 / (100 - 1);
    const { result } = renderHook(() => useRailGeometry({ startIndex: 90, endIndex: 99 }, 100));
    expect(staleTop + result.current.extent).toBeGreaterThan(1);
    expect(result.current.position).toBeLessThan(staleTop);
  });

  it("gives a viewport spanning every row the whole rail", () => {
    const { result } = renderHook(() =>
      useRailGeometry(
        { startIndex: 0, endIndex: RAIL_WINDOW_ROW_COUNT - 1 },
        RAIL_WINDOW_ROW_COUNT,
      ),
    );
    expect(result.current).toStrictEqual({ position: 0, extent: 1 });
  });

  it("negative control: an unmeasured box claims the whole rail rather than the head", () => {
    const { result } = renderHook(() => useRailGeometry(undefined, RAIL_WINDOW_ROW_COUNT));
    expect(result.current).toStrictEqual({ position: 0, extent: 1 });
  });

  it("negative control: an empty window claims the whole rail too", () => {
    const { result } = renderHook(() => useRailGeometry({ startIndex: 0, endIndex: 0 }, 0));
    expect(result.current).toStrictEqual({ position: 0, extent: 1 });
  });
});

describe("the marks and the thumb are one measurement over one ordering", () => {
  const RUN_ID = "run-a";
  const FOLDED_RUN_ROW_COUNT = 10;

  /**
   * A log a folded chapter and a filter both act on.
   *
   * A message, a finished run of ten rows, then two more messages. Folding the run
   * leaves ONE header band standing for ten sequences, which is the shape that
   * pulls row order and sequence order apart — and it is produced by the real fold
   * rather than assembled here, so the ordering the rail is handed is the ordering
   * a mounted feed renders.
   */
  function foldedWindow(): LedgerWindowModel {
    const log: ConsoleSessionEvent[] = [messageEvent(0)];
    for (let position = 0; position < FOLDED_RUN_ROW_COUNT; position += 1) {
      const isLast = position === FOLDED_RUN_ROW_COUNT - 1;
      log.push(runEvent(log.length, isLast ? "run.completed" : "run.running"));
    }
    // One at a time: both arguments of a two-value push are evaluated before
    // either lands, so a shared `log.length` would mint two events on one sequence
    // and one id.
    log.push(messageEvent(log.length));
    log.push(messageEvent(log.length));
    return foldChapterHeaders(deriveLedgerWindow(log, false), new Set<string>());
  }

  function messageEvent(sequence: number): ConsoleSessionEvent {
    return {
      id: `event-${String(sequence)}`,
      sessionId: SESSION_ID,
      sequence,
      kind: EVERY_ROW_QUERY,
      occurredAt: ledgerFixtureStampAt(sequence),
      payload: {},
    };
  }

  function runEvent(sequence: number, kind: string): ConsoleSessionEvent {
    return {
      id: `event-${String(sequence)}`,
      sessionId: SESSION_ID,
      sequence,
      kind,
      occurredAt: ledgerFixtureStampAt(sequence),
      payload: { sessionId: SESSION_ID, runId: RUN_ID },
    };
  }

  /** Every viewport window of `visibleRowCount` rows over an ordering of `rowCount`. */
  function everyViewport(
    rowCount: number,
    visibleRowCount: number,
  ): readonly { readonly startIndex: number; readonly endIndex: number }[] {
    const windows: { startIndex: number; endIndex: number }[] = [];
    for (let startIndex = 0; startIndex + visibleRowCount <= rowCount; startIndex += 1) {
      windows.push({ startIndex, endIndex: startIndex + visibleRowCount - 1 });
    }
    return windows;
  }

  const VISIBLE_ROW_COUNT = 2;

  it("keeps every visible row's mark inside the thumb, at every scroll position", () => {
    const ledgerWindow = foldedWindow();
    const retained = ledgerWindow.viewportRows;
    // The fold really did insert a band no projected row stands behind.
    expect(retained.map((row) => row.key)).toContain(RUN_ID);
    expect(retained.length).toBeGreaterThan(ledgerWindow.rows.length);

    const { result } = renderHook(() => useVisibleLedgerWindow(ledgerWindow, retained, retained));
    const positionByRowId = new Map(
      result.current.railModel.model().ticks.map((tick) => [tick.rowId, tick.position]),
    );
    let markedWindowCount = 0;
    for (const viewport of everyViewport(retained.length, VISIBLE_ROW_COUNT)) {
      const band = railViewportBand(viewport.startIndex, viewport.endIndex, retained.length);
      for (const row of retained.slice(viewport.startIndex, viewport.endIndex + 1)) {
        const position = positionByRowId.get(row.key);
        if (position === undefined) {
          continue;
        }
        markedWindowCount += 1;
        expect(position).toBeGreaterThanOrEqual(band.position);
        expect(position).toBeLessThanOrEqual(band.position + band.extent);
      }
    }
    expect(markedWindowCount).toBeGreaterThan(0);
  });

  it("negative control: the sequence axis and the last-index thumb disagree somewhere", () => {
    // The two derivations that shipped, evaluated over the same folded window: a
    // mark placed by sequence distance and a thumb placed by row index against the
    // last index. At least one scroll position puts a visible row's mark outside
    // the thumb meant to be pointing at it, which is what the case above proves
    // can no longer happen.
    const ledgerWindow = foldedWindow();
    const retained = ledgerWindow.viewportRows;
    const rows = ledgerWindow.rows;
    const firstSequence = rows[0]?.sequence ?? 0;
    const sequenceSpan = (rows[rows.length - 1]?.sequence ?? 0) - firstSequence;
    const bySequence = new Map(
      rows.map((row) => [row.id, (row.sequence - firstSequence) / sequenceSpan]),
    );
    let escapedCount = 0;
    for (const viewport of everyViewport(retained.length, VISIBLE_ROW_COUNT)) {
      const staleTop = viewport.startIndex / Math.max(1, retained.length - 1);
      const staleHeight = VISIBLE_ROW_COUNT / retained.length;
      for (const row of retained.slice(viewport.startIndex, viewport.endIndex + 1)) {
        const position = bySequence.get(row.key);
        if (position === undefined) {
          continue;
        }
        if (position < staleTop || position > staleTop + staleHeight) {
          escapedCount += 1;
        }
      }
    }
    expect(escapedCount).toBeGreaterThan(0);
  });
});
