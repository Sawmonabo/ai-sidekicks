// Find is asked about the window the viewport shows, and rows outside it are counted, not walked
// into. Drives the real fold and matcher over a log big enough for the cap to take rows.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { useTranscriptFind } from "../../find/hooks/useTranscriptFind.js";
import { type ViewportRow } from "../../viewport/snapshot.js";
import { TranscriptRowRetention } from "../row-retention.js";
import {
  useVisibleTranscriptWindow,
  type VisibleTranscriptWindow,
} from "./useVisibleTranscriptWindow.js";
import {
  EVERY_ROW_QUERY,
  LOG_EVENT_COUNT,
  RETAINED_ROW_COUNT,
  syntheticEventLog,
} from "../visible-window.test-support.js";
import {
  NO_ROWS_REMOVED,
  deriveTranscriptWindow,
  type TranscriptWindowModel,
} from "../transcript-window.js";

/** Find over a visible window with nothing removed by the fold; these cases exercise the cap. */
function findOverVisible(visible: VisibleTranscriptWindow): ReturnType<typeof useTranscriptFind> {
  return useTranscriptFind({
    visible,
    foldedAwayRows: NO_ROWS_REMOVED,
    drawsRow: () => true,
  });
}

describe("the visible transcript window", () => {
  it("keeps only the rows the viewport reconciled, and counts the rest", () => {
    const transcriptWindow = deriveTranscriptWindow(syntheticEventLog(LOG_EVENT_COUNT));
    const retained = transcriptWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const { result } = renderHook(() => useVisibleTranscriptWindow(transcriptWindow, retained));
    expect(result.current.rows).toHaveLength(RETAINED_ROW_COUNT);
    expect(result.current.prunedAwayRows).toHaveLength(LOG_EVENT_COUNT - RETAINED_ROW_COUNT);
  });

  it("walks only rows the viewport can scroll to, and names the matches beyond it", () => {
    const transcriptWindow = deriveTranscriptWindow(syntheticEventLog(LOG_EVENT_COUNT));
    const retained = transcriptWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const retainedKeys = new Set(retained.map((row) => row.key));
    const { result } = renderHook(() => {
      const visible = useVisibleTranscriptWindow(transcriptWindow, retained);
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
});

describe("the clip the window states", () => {
  function loadedWindow(): TranscriptWindowModel {
    return deriveTranscriptWindow(syntheticEventLog(LOG_EVENT_COUNT));
  }

  it("says earlier rows exist exactly when the cap took some", () => {
    const transcriptWindow = loadedWindow();
    const retained = transcriptWindow.viewportRows.slice(-RETAINED_ROW_COUNT);
    const { result } = renderHook(() => useVisibleTranscriptWindow(transcriptWindow, retained));
    expect(result.current.prunedAwayRows.length).toBeGreaterThan(0);
  });

  it("a window holding its whole log claims nothing before it", () => {
    // Guards the case above against a hard-coded clip, which would put a truncation notice on every
    // complete session.
    const transcriptWindow = loadedWindow();
    const { result } = renderHook(() =>
      useVisibleTranscriptWindow(transcriptWindow, transcriptWindow.viewportRows),
    );
    expect(result.current.prunedAwayRows).toHaveLength(0);
  });
});

describe("a streamed update to a row the viewport holds", () => {
  /** The log after its newest row streamed more text: that event's payload replaced, nothing else. */
  function afterStreamedUpdate(
    log: readonly ProjectedSessionEvent[],
  ): readonly ProjectedSessionEvent[] {
    const newest = log.at(-1);
    if (newest === undefined) {
      throw new Error("the log has no row to stream into");
    }
    return [...log.slice(0, -1), { ...newest, payload: { text: "more of the reply" } }];
  }

  it("hands find the row's current object while the split it took stands", () => {
    // One retention across both passes, as the projection keeps one per session, so only the
    // streamed row takes a new object and every identity is the one the viewport already holds.
    const retention = new TranscriptRowRetention();
    const log = syntheticEventLog(LOG_EVENT_COUNT);
    const before = deriveTranscriptWindow(log, retention);
    const after = deriveTranscriptWindow(afterStreamedUpdate(log), retention);
    expect(after.rows.at(-1)).not.toBe(before.rows.at(-1));

    const { result, rerender } = renderHook<
      VisibleTranscriptWindow,
      { readonly window: TranscriptWindowModel; readonly held: readonly ViewportRow[] }
    >((props) => useVisibleTranscriptWindow(props.window, props.held), {
      initialProps: {
        window: before,
        held: before.viewportRows.slice(-RETAINED_ROW_COUNT),
      },
    });
    const prunedBeforeUpdate = result.current.prunedAwayRows;

    // The snapshot is the one reconciled before the update; its rows are the same identities.
    rerender({ window: after, held: before.viewportRows.slice(-RETAINED_ROW_COUNT) });
    expect(result.current.rows.at(-1)).toBe(after.rows.at(-1));
    expect(result.current.prunedAwayRows).toBe(prunedBeforeUpdate);

    // Holding every identity, the viewport took nothing: the window's own rows go to find whole.
    rerender({ window: after, held: before.viewportRows });
    expect(result.current.rows).toBe(after.rows);
    expect(result.current.prunedAwayRows).toBe(NO_ROWS_REMOVED);
  });
});
