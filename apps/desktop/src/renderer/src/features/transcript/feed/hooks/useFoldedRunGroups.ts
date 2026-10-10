import { useMemo } from "react";

import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import {
  type TranscriptPipelineStage,
  type TranscriptWindowModel,
} from "../../window/transcript-window.js";
import { RunGroupFold, type RunWindowInputs } from "../run-group-fold.js";

/**
 * Put the run group headers into the projected window, fold the groups a person folded, and cut
 * each long run to its window. Its own hook so a press re-folds without re-deriving the projection.
 */
export function useFoldedRunGroups(
  model: TranscriptWindowModel,
  foldedRunGroupKeys: ReadonlySet<string>,
  runWindowInputs: RunWindowInputs,
  sessionId: string,
): TranscriptPipelineStage {
  // One fold per session, not per mount, as the projection hook keeps one derivation: this pane
  // follows a navigation to another log without unmounting, and a fold carried across would hold
  // the rows of a session nobody is reading.
  const bridge = usePlatformBridge();
  const fold = useSubjectScopedState(bridge, sessionId, () => new RunGroupFold());
  const heldFold = fold.value;
  return useMemo(
    () => heldFold.fold(model, foldedRunGroupKeys, runWindowInputs),
    [heldFold, model, foldedRunGroupKeys, runWindowInputs],
  );
}
