// The find field: the walk when the window moves under it, and its own open act.
//
// Both subjects are about state the field HOLDS rather than about matching, which
// `find-model.test.ts` owns: a walk held by ordinal survived into a shorter result
// and read "10 of 2", and an open folded into the query setter reset a walk
// somebody was in the middle of.

import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { ProvenanceRailModel } from "../../ledger/structure/index.js";
import { type ConsoleSessionEvent } from "../../store/index.js";
import { useLedgerFind, type LedgerFindState } from "./ledger-find.js";
import { useVisibleLedgerWindow, type VisibleLedgerWindow } from "./ledger-visible-window.js";
import { ledgerFixtureStampAt } from "./ledger-feed-logs.test-support.js";
import { deriveLedgerWindow } from "./ledger-window.js";

const SESSION_ID = "session-visible-window";
const LOG_EVENT_COUNT = 10;
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

describe("the walk when the result moves under it", () => {
  /** A visible window over exactly these rows, with nothing outside it. */
  function windowOver(rows: readonly TimelineRow[]): VisibleLedgerWindow {
    return {
      rows,
      prunedAwayRows: [],
      withheldByReplayRows: [],
      hasEarlierRows: false,
      // Nothing outside this window, so both stage memberships are the rows
      // themselves — the identity the partition would have produced.
      revealedRowKeys: new Set(rows.map((row) => row.id)),
      heldRowKeys: new Set(rows.map((row) => row.id)),
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
