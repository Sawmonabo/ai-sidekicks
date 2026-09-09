// The two windows, and what happens at the seam between them.
//
// Every case here drives the real fold and the real matcher over a log big enough
// that the cap has something to take. The property under test is not "find works" —
// `find-model.test.ts` owns that — it is that find is asked about the window the
// VIEWPORT is showing, and that what falls outside it is counted rather than walked
// into.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useLedgerFind } from "../find/ledger-find.js";
import { useVisibleLedgerWindow, type VisibleLedgerWindow } from "./ledger-visible-window.js";
import {
  EVERY_ROW_QUERY,
  LOG_EVENT_COUNT,
  RETAINED_ROW_COUNT,
  syntheticEventLog,
} from "./ledger-visible-window.test-support.js";
import { NO_ROWS_REMOVED, deriveLedgerWindow, type LedgerWindowModel } from "./ledger-window.js";

/**
 * The find state over one visible window, with the upstream stages left unnarrowed.
 *
 * Every case in this file is about the cap, which is the narrowing BELOW the fold —
 * so neither upstream stage removed anything, both report the shared empty set, and
 * the filter and fold counts stay zero throughout. `ledger-find.test.ts` is where
 * those two are driven.
 */
function findOverVisible(visible: VisibleLedgerWindow): ReturnType<typeof useLedgerFind> {
  return useLedgerFind({
    visible,
    filteredAwayRows: NO_ROWS_REMOVED,
    foldedAwayRows: NO_ROWS_REMOVED,
  });
}

describe("the visible ledger window", () => {
  it("keeps only the rows the viewport reconciled, and counts the rest", () => {
    const ledgerWindow = deriveLedgerWindow(syntheticEventLog(LOG_EVENT_COUNT), false);
    const retained = ledgerWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const { result } = renderHook(() => useVisibleLedgerWindow(ledgerWindow, retained));
    expect(result.current.rows).toHaveLength(RETAINED_ROW_COUNT);
    expect(result.current.prunedAwayRows).toHaveLength(LOG_EVENT_COUNT - RETAINED_ROW_COUNT);
    // The partition is DECIDED by this set, and it is published rather than
    // re-derived, so an id-to-absence classifier asks the same question this did.
    const retainedKeys = new Set(retained.map((row) => row.key));
    expect([...result.current.heldRowKeys].sort()).toStrictEqual([...retainedKeys].sort());
  });

  it("walks only rows the viewport can scroll to, and names the matches beyond it", () => {
    const ledgerWindow = deriveLedgerWindow(syntheticEventLog(LOG_EVENT_COUNT), false);
    const retained = ledgerWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const retainedKeys = new Set(retained.map((row) => row.key));
    const { result } = renderHook(() => {
      const visible = useVisibleLedgerWindow(ledgerWindow, retained);
      return findOverVisible(visible);
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
    const ledgerWindow = deriveLedgerWindow(syntheticEventLog(LOG_EVENT_COUNT), false);
    const retainedKeys = new Set(
      ledgerWindow.viewportRows.slice(-RETAINED_ROW_COUNT).map((row) => row.key),
    );
    const wholeLogWindow: VisibleLedgerWindow = {
      rows: ledgerWindow.rows,
      prunedAwayRows: [],
      hasEarlierRows: false,
      heldRowKeys: new Set(ledgerWindow.rows.map((row) => row.id)),
    };
    const { result } = renderHook(() => findOverVisible(wholeLogWindow));
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
    return deriveLedgerWindow(syntheticEventLog(LOG_EVENT_COUNT), false);
  }

  it("says earlier rows exist exactly when the cap took some", () => {
    const ledgerWindow = loadedWindow();
    const retained = ledgerWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const { result } = renderHook(() => useVisibleLedgerWindow(ledgerWindow, retained));
    expect(result.current.hasEarlierRows).toBe(true);
  });

  it("negative control: a window holding its whole log claims nothing before it", () => {
    // Without this the case above would pass over a clip hard-coded the other
    // way round, which would put a truncation notice on every complete session.
    const ledgerWindow = loadedWindow();
    const { result } = renderHook(() =>
      useVisibleLedgerWindow(ledgerWindow, ledgerWindow.viewportRows),
    );
    expect(result.current.prunedAwayRows).toHaveLength(0);
    expect(result.current.hasEarlierRows).toBe(false);
  });
});
