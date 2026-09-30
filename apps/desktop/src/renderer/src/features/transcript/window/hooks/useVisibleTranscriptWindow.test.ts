// Find is asked about the window the viewport shows, and rows outside it are counted, not walked
// into. Drives the real fold and matcher over a log big enough for the cap to take rows.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useTranscriptFind } from "../../find/hooks/useTranscriptFind.js";
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
    expect(result.current.hasEarlierRows).toBe(true);
  });

  it("a window holding its whole log claims nothing before it", () => {
    // Guards the case above against a hard-coded clip, which would put a truncation notice on every
    // complete session.
    const transcriptWindow = loadedWindow();
    const { result } = renderHook(() =>
      useVisibleTranscriptWindow(transcriptWindow, transcriptWindow.viewportRows),
    );
    expect(result.current.prunedAwayRows).toHaveLength(0);
    expect(result.current.hasEarlierRows).toBe(false);
  });
});
