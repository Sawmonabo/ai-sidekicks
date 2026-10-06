import { useMemo } from "react";

import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import type { SubjectKey } from "#renderer/lib/subject-scoped/holder.js";
import type { SubjectScopedDisposal } from "#renderer/lib/subject-scoped/disposal.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { PushDrivenRead, PushDrivenReadState } from "#renderer/store/reads/push-driven.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import { useWindowReadTriggers } from "#renderer/store/reads/hooks/useWindowReadTriggers.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "#renderer/store/reads/triggers.js";

/** A workflows read and the state it publishes; `read` is absent while nothing draws it. */
export interface WorkflowReadHold<TValue> {
  readonly read: PushDrivenRead<TValue> | undefined;
  readonly state: PushDrivenReadState<TValue>;
}

/**
 * Hold one workflows read for as long as `subject` and `key` name it: `open` builds it, the
 * window's triggers start it on mount and read it again when the window regains focus or the
 * transport comes back, and it is disposed when the view goes or `subject` or `key` moves, and
 * built again on a re-mount of the same view. No session event bears on a workflows read; the
 * notice feed it subscribes to is its live tail. An `open` answering `undefined`, while nothing
 * on screen draws the read, asks nothing and leaves the state `not-loaded`.
 */
export function useWorkflowRead<TValue>(
  bridge: PlatformBridge,
  subject: object,
  key: SubjectKey,
  open: () => PushDrivenRead<TValue> | undefined,
): WorkflowReadHold<TValue> {
  const { value: read } = useSubjectScopedResource<PushDrivenRead<TValue> | undefined>(
    subject,
    key,
    open,
    WORKFLOW_READ_DISPOSAL,
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
  return { read, state: usePushDrivenRead(read) };
}

/** A read ends with its view, and a disposed one is replaced rather than reused. */
const WORKFLOW_READ_DISPOSAL: SubjectScopedDisposal<PushDrivenRead<unknown> | undefined> = {
  dispose: (read) => {
    read?.dispose();
  },
  isClosed: (read) => read?.isDisposed === true,
};
