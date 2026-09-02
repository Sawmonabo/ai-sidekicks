// The two windows, and what happens at the seam between them.
//
// Every case here drives the real fold, the real matcher, and the real rail model
// over a log big enough that the cap has something to take. The property under test
// is not "find works" — `find-model.test.ts` owns that — it is that find and the
// rail are asked about the window the VIEWPORT is showing, and that what falls
// outside it is counted rather than walked into.

import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { LEDGER_OVERSCAN_ROWS } from "../../ledger/frame/frame-bounds.js";
import { type LedgerViewportRow } from "../../ledger/frame/index.js";
import { ProvenanceRailModel } from "../../ledger/structure/index.js";
import { type ConsoleSessionEvent } from "../../store/index.js";
import {
  useLedgerFind,
  useRailGeometry,
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
    id: `event-${String(index)}`,
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

describe("the walk when the result moves under it", () => {
  /** A visible window over exactly these rows, with nothing outside it. */
  function windowOver(rows: readonly TimelineRow[]): VisibleLedgerWindow {
    return {
      rows,
      prunedAwayRows: [],
      withheldByReplayRows: [],
      hasEarlierRows: false,
      railModel: new ProvenanceRailModel({ rows, hasEarlierRows: false }),
    };
  }

  /** The find state over a window a case can swap for a different one. */
  function findOver(
    rows: readonly TimelineRow[],
  ): RenderHookResult<LedgerFindState, { readonly rows: readonly TimelineRow[] }> {
    return renderHook(({ rows: currentRows }) => useLedgerFind(windowOver(currentRows)), {
      initialProps: { rows },
    });
  }

  const wholeLog = deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false).rows;

  it("reports no position once the selected row has left the result", () => {
    const { result, rerender } = findOver(wholeLog);
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    for (let step = 0; step < LOG_EVENT_COUNT; step += 1) {
      act(() => {
        result.current.step("next");
      });
    }
    expect(result.current.currentMatchIndex).toBe(LOG_EVENT_COUNT - 1);

    // The same query over a window the replay or the cap has cut down to two rows,
    // neither of which is the selected one. A held ordinal read "10 of 2" here.
    rerender({ rows: wholeLog.slice(0, 2) });
    expect(result.current.result.matches).toHaveLength(2);
    expect(result.current.currentMatchIndex).toBe(-1);

    // And the next step ENTERS the shorter list rather than resuming from an
    // ordinal the new result cannot hold.
    let walked: ReturnType<LedgerFindState["step"]>;
    act(() => {
      walked = result.current.step("next");
    });
    expect(walked?.index).toBe(0);
    expect(result.current.currentMatchIndex).toBe(0);
  });

  it("keeps the selected row's position when the window only grew", () => {
    const SELECTED_MATCH_INDEX = 3;
    const { result, rerender } = findOver(wholeLog.slice(0, LOG_EVENT_COUNT - 2));
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    for (let step = 0; step <= SELECTED_MATCH_INDEX; step += 1) {
      act(() => {
        result.current.step("next");
      });
    }
    expect(result.current.currentMatchIndex).toBe(SELECTED_MATCH_INDEX);
    rerender({ rows: wholeLog });
    expect(result.current.result.matches).toHaveLength(LOG_EVENT_COUNT);
    expect(result.current.currentMatchIndex).toBe(SELECTED_MATCH_INDEX);
  });

  it("negative control: a new query still restarts the walk", () => {
    // Without this the retention above could have been written as "never reset",
    // which would resume a walk inside a match list built from a different question.
    const { result } = findOver(wholeLog);
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    act(() => {
      result.current.step("next");
    });
    expect(result.current.currentMatchIndex).toBe(0);
    act(() => {
      result.current.setQuery("user");
    });
    expect(result.current.currentMatchIndex).toBe(-1);
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
    expect(result.current.position).toBeCloseTo(
      FIRST_VISIBLE_INDEX / (RAIL_WINDOW_ROW_COUNT - 1),
      6,
    );
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
    expect(result.current.position).toBeLessThan(FIRST_VISIBLE_INDEX / (RAIL_WINDOW_ROW_COUNT - 1));
  });

  it("negative control: an unmeasured box claims the whole rail rather than the head", () => {
    const { result } = renderHook(() => useRailGeometry(undefined, RAIL_WINDOW_ROW_COUNT));
    expect(result.current).toStrictEqual({ position: 0, extent: 1 });
  });
});

describe("the find field's own open act", () => {
  /** The find state over one whole window, with nothing pruned. */
  function findOverWholeLog(): RenderHookResult<LedgerFindState, void> {
    const ledgerWindow = deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false);
    return renderHook(() =>
      useLedgerFind(
        useVisibleLedgerWindow(ledgerWindow, ledgerWindow.viewportRows, ledgerWindow.viewportRows),
      ),
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
