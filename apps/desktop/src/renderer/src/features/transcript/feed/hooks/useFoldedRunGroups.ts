import { useMemo } from "react";

import { useConsoleBridge } from "@renderer/console/bridge/BridgeProvider.js";
import { useSessionScopedState } from "@renderer/console/seats/index.js";
import { LedgerRowRetention } from "../../window/row-retention.js";
import {
  type LedgerPipelineStage,
  type LedgerWindowModel,
} from "../../window/transcript-window.js";
import { foldChapterHeaders } from "../run-group-fold.js";

/**
 * Fold the chapters of the window a narrowing left.
 *
 * Its own hook rather than a second half of the projection, so a disclosure toggle
 * re-folds over a projection and a narrowing it did not have to redo — and so the
 * narrowing has somewhere to sit between the two.
 */
export function useFoldedChapters(
  model: LedgerWindowModel,
  openedTerminalRunIds: ReadonlySet<string>,
  sessionId: string,
): LedgerPipelineStage {
  // One table per SESSION rather than per mount — the projection hook's own idiom,
  // for its reason, and a second INSTANCE rather than a second class. The session is
  // the subject because this pane follows a navigation that changes which log it is
  // of without unmounting, and a table carried across that holds the rows of a
  // session nobody is reading.
  const bridge = useConsoleBridge();
  const retention = useSessionScopedState(bridge, sessionId, () => new LedgerRowRetention());
  const heldRetention = retention.value;
  return useMemo(
    () => foldChapterHeaders(model, openedTerminalRunIds, heldRetention),
    [model, openedTerminalRunIds, heldRetention],
  );
}
