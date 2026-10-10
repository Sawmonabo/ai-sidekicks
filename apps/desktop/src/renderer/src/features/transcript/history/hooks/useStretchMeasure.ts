// Hands the history reader the viewport a stretch is measured in: its height, and the estimates of
// its measurement table for rows the feed has not drawn yet. Laid out before any passive effect
// asks for a stretch, so a link reaching back for its message on the first mount is measured.

import { useCallback, useLayoutEffect, useMemo } from "react";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { type TranscriptRowRenderer } from "../../rows/renderer.js";
import { type TranscriptViewportBinding } from "../../viewport/hooks/useTranscriptViewport.js";
import { estimatePageHeightPx } from "../page-height.js";
import { type TranscriptStretchMeasure } from "../reader.js";
import { type TranscriptHistory } from "./useTranscriptHistory.js";

/** What a stretch is measured by: the viewport, and the feed's rules for drawing a row. */
export interface StretchMeasureInputs {
  readonly history: TranscriptHistory | undefined;
  readonly viewport: TranscriptViewportBinding;
  readonly drawsBody: TranscriptRowRenderer["drawsBody"];
  /** The run groups the reader folded; every other one draws open. */
  readonly foldedRunGroupKeys: ReadonlySet<string>;
  /** The calls the reader folded; every other call with a body draws open. */
  readonly foldedCallRowIds: ReadonlySet<string>;
}

/**
 * Measures this mount's stretches in its viewport, answering the measure it handed the reader.
 * Before the box is laid out the screen is the window's own height, which no pane exceeds.
 */
export function useStretchMeasure(inputs: StretchMeasureInputs): TranscriptStretchMeasure {
  const ownerWindow = useOwnerWindow();
  const { history, viewport, drawsBody, foldedRunGroupKeys, foldedCallRowIds } = inputs;
  const { scrollController, estimatedRowHeightPx, smallestRowHeightPx } = viewport;
  // Its own callback, stable while the box is, so the run windows cut against it are not cut
  // again each time a fold moves the measure below.
  const screenHeightPx = useCallback(() => {
    const viewportHeightPx = scrollController.geometry?.viewportHeight ?? 0;
    return viewportHeightPx > 0 ? viewportHeightPx : ownerWindow.innerHeight;
  }, [scrollController, ownerWindow]);
  const measure = useMemo<TranscriptStretchMeasure>(
    () => ({
      screenHeightPx,
      smallestRowHeightPx,
      pageHeightPx: (events) =>
        estimatePageHeightPx(events, {
          estimatedRowHeightPx,
          screenHeightPx,
          drawsBody,
          foldedRunGroupKeys,
          foldedCallRowIds,
        }),
    }),
    [
      screenHeightPx,
      estimatedRowHeightPx,
      smallestRowHeightPx,
      drawsBody,
      foldedRunGroupKeys,
      foldedCallRowIds,
    ],
  );
  const measureWith = history?.measureWith;
  useLayoutEffect(() => {
    measureWith?.(measure);
    return () => {
      measureWith?.(undefined);
    };
  }, [measureWith, measure]);
  return measure;
}
