// The two windows, and what happens at the seam between them.
//
// Every case here drives the real fold, the real matcher, and the real rail model
// over a log big enough that the cap has something to take. The property under test
// is not "find works" — `find-model.test.ts` owns that — it is that find and the
// rail are asked about the window the VIEWPORT is showing, and that what falls
// outside it is counted rather than walked into.
//
// WHERE THE RAIL PUTS A MARK is `ledger-rail-geometry.test.ts`': that is a question
// about two fractions over an ordering and it is measured with no window at all,
// while every case here is about which rows a window holds and which it counts.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type LedgerViewportRow } from "../frame/index.js";
import { ProvenanceRailModel } from "../structure/index.js";
import { useLedgerFind } from "./ledger-find.js";
import { useVisibleLedgerWindow, type VisibleLedgerWindow } from "./ledger-visible-window.js";
import {
  EVERY_ROW_QUERY,
  LOG_EVENT_COUNT,
  RETAINED_ROW_COUNT,
  syntheticLog,
} from "./ledger-visible-window.test-support.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "./ledger-window.js";

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
