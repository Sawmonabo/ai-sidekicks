import { useMemo } from "react";

import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { type TranscriptRowRenderer } from "../../rows/renderer.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { DrawnRowFilter } from "../drawn-rows.js";

/**
 * Take the rows the feed draws nothing for out of the folded window. One filter per session, as the
 * fold keeps one retention table per session, so its held decision never names another log's rows.
 */
export function useDrawnRows(
  model: TranscriptWindowModel,
  drawsBody: TranscriptRowRenderer["drawsBody"],
  sessionId: string,
): TranscriptWindowModel {
  const bridge = usePlatformBridge();
  const filter = useSubjectScopedState(bridge, sessionId, () => new DrawnRowFilter());
  const heldFilter = filter.value;
  return useMemo(() => heldFilter.filter(model, drawsBody), [heldFilter, model, drawsBody]);
}
