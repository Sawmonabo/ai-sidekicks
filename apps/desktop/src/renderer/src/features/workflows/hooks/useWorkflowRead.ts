import { useEffect, useMemo } from "react";

import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import type {
  PushDrivenRead,
  PushDrivenReadState,
} from "#renderer/store/reads/push-driven-read.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import { useWindowReadTriggers } from "#renderer/store/reads/hooks/useWindowReadTriggers.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "#renderer/store/reads/triggers.js";

/**
 * Hold one workflows read for the life of the view that draws it: the window's triggers start it
 * on mount and read it again when the window regains focus or the transport comes back, and it is
 * disposed when the view goes or the read is replaced. No session event bears on a workflows read;
 * the notice feed it subscribes to is its live tail. The read is constructed by the caller, never
 * in a render body. With no read, while nothing on screen draws it, nothing is asked and the state
 * stays `not-loaded`.
 */
export function useWorkflowRead<TValue>(
  read: PushDrivenRead<TValue> | undefined,
  bridge: PlatformBridge,
): PushDrivenReadState<TValue> {
  useEffect(
    () => () => {
      read?.dispose();
    },
    [read],
  );
  const triggerTarget = useMemo<ReadTriggerTarget>(
    () => ({
      triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
      requestRead: (reason) => {
        read?.refresh(reason);
      },
    }),
    [read],
  );
  useWindowReadTriggers(triggerTarget, bridge.transportReconnect);
  return usePushDrivenRead(read);
}
