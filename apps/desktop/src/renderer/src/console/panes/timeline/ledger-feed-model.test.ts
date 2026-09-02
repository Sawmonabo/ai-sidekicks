// The two windows, and what happens at the seam between them.
//
// Every case here drives the real fold, the real matcher, and the real rail model
// over a log big enough that the cap has something to take. The property under test
// is not "find works" — `find-model.test.ts` owns that — it is that find and the
// rail are asked about the window the VIEWPORT is showing, and that what falls
// outside it is counted rather than walked into.

import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProvenanceRailModel } from "../../ledger/structure/index.js";
import { type ConsoleSessionEvent } from "../../store/index.js";
import {
  useLedgerFind,
  useVisibleLedgerWindow,
  type LedgerFindState,
  type VisibleLedgerWindow,
} from "./ledger-feed-model.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "./ledger-window.js";

const SESSION_ID = "session-visible-window";
const LOG_EVENT_COUNT = 10;
const RETAINED_ROW_COUNT = 4;
const EVERY_ROW_QUERY = "user.message";

/** A log whose every row matches `EVERY_ROW_QUERY`, oldest first. */
function syntheticLog(count: number): readonly ConsoleSessionEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({
    sessionId: SESSION_ID,
    sequence: index,
    kind: EVERY_ROW_QUERY,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString(),
    payload: {},
  }));
}

describe("the visible ledger window", () => {
  it("keeps only the rows the viewport reconciled, and counts the rest", () => {
    const ledgerWindow = deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false);
    const retained = ledgerWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const { result } = renderHook(() => useVisibleLedgerWindow(ledgerWindow, retained));
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
      const visible = useVisibleLedgerWindow(ledgerWindow, retained);
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
      hasEarlierRows: false,
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
    const { result } = renderHook(() => useVisibleLedgerWindow(ledgerWindow, retained));
    expect(result.current.hasEarlierRows).toBe(true);
    // The rail's dotted segment reads this, and it was drawn on no window at all
    // while the clip was a constant `false`.
    expect(result.current.railModel.model().clip.hasUnloadedExtent).toBe(true);
  });

  it("carries that clip into the find result's stated boundary", () => {
    const ledgerWindow = loadedWindow();
    const retained = ledgerWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const { result } = renderHook(() => {
      const visible = useVisibleLedgerWindow(ledgerWindow, retained);
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
      const visible = useVisibleLedgerWindow(ledgerWindow, ledgerWindow.viewportRows);
      return { visible, find: useLedgerFind(visible) };
    });
    expect(result.current.visible.prunedAwayRows).toHaveLength(0);
    expect(result.current.visible.hasEarlierRows).toBe(false);
    expect(result.current.visible.railModel.model().clip.hasUnloadedExtent).toBe(false);
    expect(result.current.find.result.hasEarlierRows).toBe(false);
  });
});

describe("the find field's own open act", () => {
  /** The find state over one whole window, with nothing pruned. */
  function findOverWholeLog(): RenderHookResult<LedgerFindState, void> {
    const ledgerWindow = deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false);
    return renderHook(() =>
      useLedgerFind(useVisibleLedgerWindow(ledgerWindow, ledgerWindow.viewportRows)),
    );
  }

  it("reveals the field", () => {
    const { result } = findOverWholeLog();
    expect(result.current.isOpen).toBe(false);
    act(() => {
      result.current.open();
    });
    expect(result.current.isOpen).toBe(true);
  });

  it("leaves the query and the walk exactly where they were", () => {
    // Which is why it is not `setQuery("")`: the palette row opens a field somebody
    // is about to type into, and resetting a walk they were in the middle of is a
    // different act wearing the same name.
    const { result } = findOverWholeLog();
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    act(() => {
      result.current.step("next");
    });
    const walkedIndex = result.current.currentMatchIndex;
    act(() => {
      result.current.open();
    });
    expect(result.current.query).toBe(EVERY_ROW_QUERY);
    expect(result.current.currentMatchIndex).toBe(walkedIndex);
  });

  it("negative control: a field nobody opened stays closed", () => {
    // Without this the case above would pass over a hook that reported `isOpen`
    // true from its first render, which is a find field nobody asked for.
    const { result, rerender } = findOverWholeLog();
    rerender();
    expect(result.current.isOpen).toBe(false);
  });
});
