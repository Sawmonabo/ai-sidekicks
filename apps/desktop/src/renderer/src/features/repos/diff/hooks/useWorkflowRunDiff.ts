import { useCallback, useMemo } from "react";

import { CONTROLLER_DISPOSAL } from "#renderer/lib/subject-scoped/disposal.js";
import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { PushDrivenReadState } from "#renderer/store/reads/push-driven.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import { useWindowReadTriggers } from "#renderer/store/reads/hooks/useWindowReadTriggers.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "#renderer/store/reads/triggers.js";
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
  const { value: read } = useSubjectScopedResource(
    bridge,
    JSON.stringify(request),
    () => createWorkflowRunDiffRead(bridge, clock, request),
    CONTROLLER_DISPOSAL,
  );
  const triggerTarget = useMemo<ReadTriggerTarget>(
    () => ({
      triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
      requestRead: (reason) => {
        read.refresh(reason);
      },
    }),
    [read],
  );
  useWindowReadTriggers(triggerTarget, bridge.transportReconnect);
  const readAgain = useCallback(() => {
    read.refresh("user-request");
  }, [read]);
  return { state: usePushDrivenRead(read), readAgain };
}
