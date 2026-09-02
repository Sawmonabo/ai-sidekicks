// The two windows, and what happens at the seam between them.
//
// Every case here drives the real fold, the real matcher, and the real rail model
// over a log big enough that the cap has something to take. The property under test
// is not "find works" — `find-model.test.ts` owns that — it is that find and the
// rail are asked about the window the VIEWPORT is showing, and that what falls
// outside it is counted rather than walked into.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProvenanceRailModel } from "../../ledger/structure/index.js";
import { type ConsoleSessionEvent } from "../../store/index.js";
import {
  useLedgerFind,
  useVisibleLedgerWindow,
  type VisibleLedgerWindow,
} from "./ledger-feed-model.js";
import { deriveLedgerWindow } from "./ledger-window.js";

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
