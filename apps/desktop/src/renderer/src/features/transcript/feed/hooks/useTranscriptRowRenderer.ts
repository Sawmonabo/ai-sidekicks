import { createElement, useCallback } from "react";

import { type ViewportRowRenderer } from "../../viewport/components/VirtualRow.js";
import { type ViewportRow } from "../../viewport/snapshot.js";
import {
  TranscriptRowDispatch,
  type TranscriptRowDispatchOptions,
} from "../components/TranscriptRowDispatch.js";

/**
 * Build the feed's row renderer. Its identity moves whenever the window does, deliberately: the
 * window is what a row's body is looked up in, so a callback pinned across a changed window
 * would hand the viewport a lookup that could not see the change.
 */
export function useTranscriptRowRenderer(
  options: TranscriptRowDispatchOptions,
): ViewportRowRenderer {
  const {
    transcriptWindow,
    foldedRunGroupKeys,
    foldedCallRowIds,
    hueForAgent,
    toggleRunGroup,
    runCallWindows,
    openRunStretch,
    renderTranscriptRow,
  } = options;
  return useCallback(
    (row: ViewportRow) =>
      createElement(TranscriptRowDispatch, {
        row,
        transcriptWindow,
        foldedRunGroupKeys,
        foldedCallRowIds,
        hueForAgent,
        toggleRunGroup,
        runCallWindows,
        openRunStretch,
        renderTranscriptRow,
      }),
    [
      hueForAgent,
      transcriptWindow,
      foldedRunGroupKeys,
      foldedCallRowIds,
      renderTranscriptRow,
      toggleRunGroup,
      runCallWindows,
      openRunStretch,
    ],
  );
}
