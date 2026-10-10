// The find field's held state: the walk when the log moves under it, and its own open act.
// Matching is `matcher.test.ts`'s.

import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import { describe, expect, it } from "vitest";

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { useTranscriptFind, type TranscriptFindState } from "./useTranscriptFind.js";
import {
  NO_ROWS_REMOVED,
  deriveTranscriptWindow,
  type TranscriptWindowModel,
} from "../../window/transcript-window.js";
import {
  transcriptFixtureStampAt,
  transcriptFixtureStreamCursor,
} from "../../logs.test-support.js";

/** Long enough to walk past a shorter window, short enough to enumerate. */
const LOG_EVENT_COUNT = 10;
/** A query every row of the log below matches, so a walk is over the whole log. */
const EVERY_ROW_QUERY = "user.message";

/** A log of `count` events, oldest first, every one matching {@link EVERY_ROW_QUERY}. */
function syntheticEventLog(count: number): readonly ProjectedSessionEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `event-${String(index)}`,
    sessionId: "session-find",
    sequence: index,
    cursor: transcriptFixtureStreamCursor(index),
    kind: EVERY_ROW_QUERY,
    occurredAt: transcriptFixtureStampAt(index),
    payload: {},
  }));
}

describe("the walk when the result moves under it", () => {
  function findOver(
    rows: readonly TranscriptEventRow[],
  ): RenderHookResult<TranscriptFindState, { readonly rows: readonly TranscriptEventRow[] }> {
    return renderHook(
      ({ rows: currentRows }) =>
        useTranscriptFind({
          rows: currentRows,
          // Nothing is folded here, so the fold reports the shared empty removal.
          foldedAwayRows: NO_ROWS_REMOVED,
          drawsRow: () => true,
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
    readonly drawsRow: (row: TranscriptEventRow) => boolean;
  }): RenderHookResult<TranscriptFindState, unknown> {
    const modelOf = (count: number): TranscriptWindowModel =>
      deriveTranscriptWindow(syntheticEventLog(count));
    const foldedWindow = modelOf(stages.folded);
    return renderHook(() =>
      useTranscriptFind({
        rows: foldedWindow.rows,
        foldedAwayRows: modelOf(stages.unfurled).rows.slice(stages.folded),
        drawsRow: stages.drawsRow,
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

    // Same query over a log rebuilt to two rows, neither selected: a held ordinal would read
    // "10 of 2".
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

  it("keeps the selected row's position when the log only grew", () => {
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

  it("counts matches a folded run group is holding, but none the group would not draw", () => {
    // Finished runs fold by default, so this is most of the matches on a completed session. A
    // folded row the feed draws nothing for stays hidden when the group opens.
    const undrawnRowId = wholeLog[LOG_EVENT_COUNT - 1]?.id;
    const { result } = findOverPipeline({
      unfurled: LOG_EVENT_COUNT,
      folded: LOG_EVENT_COUNT - 2,
      drawsRow: (row) => row.id !== undrawnRowId,
    });
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });

    expect(result.current.result.totalMatchCount).toBe(LOG_EVENT_COUNT - 2);
    expect(result.current.foldedAwayMatchCount).toBe(1);
  });

  it("a new query still restarts the walk", () => {
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
        rows: transcriptWindow.rows,
        // Nothing is folded here, so the fold reports the shared empty removal.
        foldedAwayRows: NO_ROWS_REMOVED,
        drawsRow: () => true,
      }),
    );
  }

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
});
