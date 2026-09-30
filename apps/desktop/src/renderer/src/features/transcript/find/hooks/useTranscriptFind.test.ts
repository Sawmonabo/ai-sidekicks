// The find field's held state: the walk when the window moves under it, and its own open
// act. Matching is `find-model.test.ts`'s.

import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { useTranscriptFind, type TranscriptFindState } from "./useTranscriptFind.js";
import { NO_ROWS_REMOVED, type TranscriptWindowModel } from "../../window/transcript-window.js";
import {
  useVisibleTranscriptWindow,
  type VisibleTranscriptWindow,
} from "../../window/hooks/useVisibleTranscriptWindow.js";
import { deriveTranscriptWindow } from "../../window/transcript-window.js";
import {
  EVERY_ROW_QUERY,
  LOG_EVENT_COUNT,
  syntheticEventLog,
} from "../../window/visible-window.test-support.js";

describe("the walk when the result moves under it", () => {
  function windowOver(rows: readonly TimelineRow[]): VisibleTranscriptWindow {
    return {
      rows,
      prunedAwayRows: [],
      hasEarlierRows: false,
      // Nothing outside this window, so stage membership is the rows themselves.
      heldRowKeys: new Set(rows.map((row) => row.id)),
    };
  }

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

  const wholeLog = deriveTranscriptWindow(syntheticEventLog(LOG_EVENT_COUNT)).rows;

  /**
   * Two stages of one pipeline, the folded one a prefix of the other. The fold reports what
   * it removed, so a prefix models the seam exactly.
   */
  function findOverPipeline(stages: {
    readonly unfurled: number;
    readonly folded: number;
  }): RenderHookResult<TranscriptFindState, unknown> {
    const modelOf = (count: number): TranscriptWindowModel =>
      deriveTranscriptWindow(syntheticEventLog(count));
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

    // Same query over a window the cap cut to two rows, neither selected: a held ordinal
    // would read "10 of 2".
    rerender({ rows: wholeLog.slice(0, 2) });
    expect(result.current.result.matches).toHaveLength(2);
    expect(result.current.currentMatchIndex).toBe(-1);

    // The next step enters the shorter list rather than resuming from an ordinal it cannot hold.
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

  it("counts matches a folded run group is holding", () => {
    // Finished runs fold by default, so this is most of the matches on a completed session.
    const { result } = findOverPipeline({ unfurled: 10, folded: 8 });
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });

    expect(result.current.result.totalMatchCount).toBe(8);
    expect(result.current.foldedAwayMatchCount).toBe(2);
  });

  it("negative control: an unfolded transcript counts nothing folded away", () => {
    // Guards against a count that reports the whole log every time.
    const { result } = findOverPipeline({ unfurled: 10, folded: 10 });
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });

    expect(result.current.result.totalMatchCount).toBe(10);
    expect(result.current.foldedAwayMatchCount).toBe(0);
  });

  it("negative control: a new query still restarts the walk", () => {
    // Guards against "never reset", which would resume a walk inside a list from another question.
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
  function findOverWholeLog(): RenderHookResult<TranscriptFindState, void> {
    const transcriptWindow = deriveTranscriptWindow(syntheticEventLog(LOG_EVENT_COUNT));
    return renderHook(() =>
      useTranscriptFind({
        visible: useVisibleTranscriptWindow(transcriptWindow, transcriptWindow.viewportRows),
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
    // Not `setQuery("")`: the palette row opens a field somebody is about to type into, and must
    // not reset a walk in progress.
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
    // Guards against a hook that reports `isOpen` true from its first render.
    const { result, rerender } = findOverWholeLog();
    rerender();
    expect(result.current.isOpen).toBe(false);
  });
});
