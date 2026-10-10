import { useMemo } from "react";

import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { TranscriptRowRetention } from "../../window/row-retention.js";
import {
  type TranscriptPipelineStage,
  type TranscriptWindowModel,
} from "../../window/transcript-window.js";
import { foldRunGroupHeaders } from "../run-group-fold.js";

/**
 * Put the run group headers into the projected window and fold the groups a person folded. Its
 * own hook so a press re-folds without re-deriving the projection.
 */
export function useFoldedRunGroups(
  model: TranscriptWindowModel,
  foldedRunIds: ReadonlySet<string>,
  sessionId: string,
): TranscriptPipelineStage {
  // One retention table per session, not per mount, as the projection hook does: this pane
  // follows a navigation to another log without unmounting, and a table carried across would
  // hold the rows of a session nobody is reading.
  const bridge = usePlatformBridge();
  const retention = useSubjectScopedState(bridge, sessionId, () => new TranscriptRowRetention());
  const heldRetention = retention.value;
  return useMemo(
    () => foldRunGroupHeaders(model, foldedRunIds, heldRetention),
    [model, foldedRunIds, heldRetention],
  );
}
