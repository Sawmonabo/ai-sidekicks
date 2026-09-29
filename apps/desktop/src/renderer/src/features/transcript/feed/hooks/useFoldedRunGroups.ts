import { useMemo } from "react";

import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { useSessionScopedState } from "@renderer/store/subject-scoped/useSessionScopedState.js";
import { TranscriptRowRetention } from "../../window/row-retention.js";
import {
  type TranscriptPipelineStage,
  type TranscriptWindowModel,
} from "../../window/transcript-window.js";
import { foldRunGroupHeaders } from "../run-group-fold.js";

/**
 * Fold the run groups of the window a narrowing left.
 *
 * Its own hook rather than a second half of the projection, so a disclosure toggle
 * re-folds over a projection and a narrowing it did not have to redo — and so the
 * narrowing has somewhere to sit between the two.
 */
export function useFoldedRunGroups(
  model: TranscriptWindowModel,
  openedTerminalRunIds: ReadonlySet<string>,
  sessionId: string,
): TranscriptPipelineStage {
  // One table per SESSION rather than per mount — the projection hook's own idiom,
  // for its reason, and a second INSTANCE rather than a second class. The session is
  // the subject because this pane follows a navigation that changes which log it is
  // of without unmounting, and a table carried across that holds the rows of a
  // session nobody is reading.
  const bridge = usePlatformBridge();
  const retention = useSessionScopedState(bridge, sessionId, () => new TranscriptRowRetention());
  const heldRetention = retention.value;
  return useMemo(
    () => foldRunGroupHeaders(model, openedTerminalRunIds, heldRetention),
    [model, openedTerminalRunIds, heldRetention],
  );
}
