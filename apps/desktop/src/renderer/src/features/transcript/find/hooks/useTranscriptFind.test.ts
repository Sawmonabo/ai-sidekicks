// The find field: the walk when the window moves under it, and its own open act.
//
// Both subjects are about state the field HOLDS rather than about matching, which
// `find-model.test.ts` owns: a walk held by ordinal survived into a shorter result
// and read "10 of 2", and an open folded into the query setter reset a walk
// somebody was in the middle of.

import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { useTranscriptFind, type TranscriptFindState } from "./useTranscriptFind.js";
import { NO_ROWS_REMOVED, type TranscriptWindowModel } from "../../window/transcript-window.js";
import {
  useVisibleTranscriptWindow,
  type VisibleTranscriptWindow,
} from "../../window/hooks/useVisibleTranscriptWindow.js";
import { deriveLedgerWindow } from "../../window/transcript-window.js";
import {
  EVERY_ROW_QUERY,
  LOG_EVENT_COUNT,
  syntheticEventLog,
} from "../../window/visible-window.test-support.js";

describe("the walk when the result moves under it", () => {
  /** A visible window over exactly these rows, with nothing outside it. */
  function windowOver(rows: readonly TimelineRow[]): VisibleTranscriptWindow {
    return {
      rows,
      prunedAwayRows: [],
      hasEarlierRows: false,
      // Nothing outside this window, so the stage membership is the rows
      // themselves — the identity the partition would have produced.
      heldRowKeys: new Set(rows.map((row) => row.id)),
    };
  }

  /** The find state over a window a case can swap for a different one. */
  function findOver(
    rows: readonly TimelineRow[],
  ): RenderHookResult<TranscriptFindState, { readonly rows: readonly TimelineRow[] }> {
    return renderHook(
      ({ rows: currentRows }) =>
        useTranscriptFind({
          visible: windowOver(currentRows),
          // Nothing is folded here, so the fold reports the shared empty removal.
          foldedAwayRows: NO_ROWS_REMOVED,
        }),
      { initialProps: { rows } },
    );
  }

  const wholeLog = deriveLedgerWindow(syntheticEventLog(LOG_EVENT_COUNT), false).rows;

  /**
   * The find state over two stages of one pipeline, the folded one a prefix of the other.
   *
   * The fold REPORTS what it removed, which is what the hook counts, so a prefix models
   * the pipeline exactly at this seam: the rows the fold took are the unfurled log's tail
   * past the folded one. Building a terminal run chapter would produce the same set and
   * nothing else.
   */
  function findOverPipeline(stages: {
    readonly unfurled: number;
    readonly folded: number;
  }): RenderHookResult<TranscriptFindState, unknown> {
    const modelOf = (count: number): TranscriptWindowModel =>
      deriveLedgerWindow(syntheticEventLog(count), false);
    const foldedWindow = modelOf(stages.folded);
    return renderHook(() =>
      useTranscriptFind({
        visible: windowOver(foldedWindow.rows),
        foldedAwayRows: modelOf(stages.unfurled).rows.slice(stages.folded),
      }),
    );
  }

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

    // The same query over a window the cap has cut down to two rows,
    // neither of which is the selected one. A held ordinal read "10 of 2" here.
    rerender({ rows: wholeLog.slice(0, 2) });
    expect(result.current.result.matches).toHaveLength(2);
    expect(result.current.currentMatchIndex).toBe(-1);

    // And the next step ENTERS the shorter list rather than resuming from an
    // ordinal the new result cannot hold.
    let walked: ReturnType<TranscriptFindState["step"]>;
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

  it("counts matches a folded chapter is holding", () => {
    // Every finished run folds by default, so on a completed session most of the log is
    // behind a run group header and this is most of the matches.
    const { result } = findOverPipeline({ unfurled: 10, folded: 8 });
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });

    expect(result.current.result.totalMatchCount).toBe(8);
    expect(result.current.foldedAwayMatchCount).toBe(2);
  });

  it("negative control: an unfolded transcript counts nothing folded away", () => {
    // Without this the case above would pass over a count that reported the whole log
    // every time, which is the same lie in the other direction.
    const { result } = findOverPipeline({ unfurled: 10, folded: 10 });
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });

    expect(result.current.result.totalMatchCount).toBe(10);
    expect(result.current.foldedAwayMatchCount).toBe(0);
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
  function findOverWholeLog(): RenderHookResult<TranscriptFindState, void> {
    const ledgerWindow = deriveLedgerWindow(syntheticEventLog(LOG_EVENT_COUNT), false);
    return renderHook(() =>
      useTranscriptFind({
        visible: useVisibleTranscriptWindow(ledgerWindow, ledgerWindow.viewportRows),
        // Nothing is folded here, so the fold reports the shared empty removal.
        foldedAwayRows: NO_ROWS_REMOVED,
      }),
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
