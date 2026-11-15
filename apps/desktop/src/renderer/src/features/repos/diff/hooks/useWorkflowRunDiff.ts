import { useCallback } from "react";

import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { PushDrivenReadState } from "#renderer/store/reads/push-driven.js";
import { useWindowTriggeredRead } from "#renderer/store/reads/hooks/useWindowTriggeredRead.js";
import type { DiffModel } from "../model.js";
import { createWorkflowRunDiffRead, type WorkflowRunDiffRequest } from "../workflow-run-read.js";

/** What Review draws for a run comparison, and the act that asks the daemon again. */
export interface WorkflowRunDiffHold {
  readonly state: PushDrivenReadState<DiffModel>;
  readonly readAgain: () => void;
}

/**
 * Hold the read of one run comparison for as long as the pane shows it: read once it commits,
 * again when the window regains focus or the transport comes back, and disposed when the pane goes
 * or is re-pointed at other snapshot points. No session event bears on pinned snapshots.
 */
export function useWorkflowRunDiff(
  bridge: PlatformBridge,
  request: WorkflowRunDiffRequest,
): WorkflowRunDiffHold {
  const clock = useClock();
  const { read, state } = useWindowTriggeredRead(
    bridge.transportReconnect,
    bridge,
    JSON.stringify(request),
    () => createWorkflowRunDiffRead(bridge, clock, request),
  );
  const readAgain = useCallback(() => {
    read?.refresh("user-request");
  }, [read]);
  return { state, readAgain };
}
