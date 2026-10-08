// Hands the history reader the viewport a stretch is measured in: its height, and the estimates of
// its measurement table for rows the feed has not drawn yet. Laid out before any passive effect
// asks for a stretch, so a link reaching back for its message on the first mount is measured.

import { useLayoutEffect, useMemo } from "react";

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
  /** The finished run groups the reader opened; every other one draws folded. */
  readonly openedTerminalRunIds: ReadonlySet<string>;
}

/**
 * Measures this mount's stretches in its viewport, answering the measure it handed the reader.
 * Before the box is laid out the screen is the window's own height, which no pane exceeds.
 */
export function useStretchMeasure(inputs: StretchMeasureInputs): TranscriptStretchMeasure {
  const ownerWindow = useOwnerWindow();
  const { history, viewport, drawsBody, openedTerminalRunIds } = inputs;
  const { scrollController, estimatedRowHeightPx, smallestRowHeightPx } = viewport;
  const measure = useMemo<TranscriptStretchMeasure>(
    () => ({
      screenHeightPx: () => {
        const viewportHeightPx = scrollController.geometry?.viewportHeight ?? 0;
        return viewportHeightPx > 0 ? viewportHeightPx : ownerWindow.innerHeight;
      },
      smallestRowHeightPx,
      pageHeightPx: (events) =>
        estimatePageHeightPx(events, { estimatedRowHeightPx, drawsBody, openedTerminalRunIds }),
    }),
    [
      ownerWindow,
      scrollController,
      estimatedRowHeightPx,
      smallestRowHeightPx,
      drawsBody,
      openedTerminalRunIds,
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
