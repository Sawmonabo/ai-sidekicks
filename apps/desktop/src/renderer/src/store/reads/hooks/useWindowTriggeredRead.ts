import { useMemo } from "react";

import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import type { SubjectKey } from "#renderer/lib/subject-scoped/holder.js";
import type { SubjectScopedDisposal } from "#renderer/lib/subject-scoped/disposal.js";
import type { TransportReconnectObservable } from "#renderer/lib/transport-reconnect.js";
import type { PushDrivenRead, PushDrivenReadState } from "../push-driven.js";
import { NO_TRIGGERING_EVENT_KINDS, type ReadTriggerTarget } from "../triggers.js";
import { usePushDrivenRead } from "./usePushDrivenRead.js";
import { useWindowReadTriggers } from "./useWindowReadTriggers.js";

/** A held read and the state it publishes; `read` is absent while nothing draws it. */
export interface WindowTriggeredReadHold<TValue> {
  readonly read: PushDrivenRead<TValue> | undefined;
  readonly state: PushDrivenReadState<TValue>;
}

/** A held read whose `open` always builds one, so `read` is always there. */
export interface AlwaysOpenWindowTriggeredReadHold<TValue> extends WindowTriggeredReadHold<TValue> {
  readonly read: PushDrivenRead<TValue>;
}

/**
 * Hold one read that no session event bears on for as long as `subject` and `key` name it:
 * `open` builds it, the window's triggers start it on mount and read it again when the window
 * regains focus or `transportReconnect` fires, and it is disposed when the view goes or `subject`
 * or `key` moves, and built again on a re-mount of the same view. An `open` answering
 * `undefined`, while nothing on screen draws the read, asks nothing and leaves it `not-loaded`.
 */
export function useWindowTriggeredRead<TValue>(
  transportReconnect: TransportReconnectObservable,
  subject: object,
  key: SubjectKey,
  open: () => PushDrivenRead<TValue>,
): AlwaysOpenWindowTriggeredReadHold<TValue>;
/** The same hold where `open` may answer `undefined`, and `read` is then absent. */
export function useWindowTriggeredRead<TValue>(
  transportReconnect: TransportReconnectObservable,
  subject: object,
  key: SubjectKey,
  open: () => PushDrivenRead<TValue> | undefined,
): WindowTriggeredReadHold<TValue>;
export function useWindowTriggeredRead<TValue>(
  transportReconnect: TransportReconnectObservable,
  subject: object,
  key: SubjectKey,
  open: () => PushDrivenRead<TValue> | undefined,
): WindowTriggeredReadHold<TValue> {
  const { value: read } = useSubjectScopedResource<PushDrivenRead<TValue> | undefined>(
    subject,
    key,
    open,
    HELD_READ_DISPOSAL,
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
  useWindowReadTriggers(triggerTarget, transportReconnect);
  return { read, state: usePushDrivenRead(read) };
}

/**
 * A read ends with its view, and a disposed one is replaced rather than reused: the controller
 * disposal's rule, here over a read that is absent while nothing on screen draws it, which the
 * controller disposal's type does not admit.
 */
const HELD_READ_DISPOSAL: SubjectScopedDisposal<PushDrivenRead<unknown> | undefined> = {
  dispose: (read) => {
    read?.dispose();
  },
  isClosed: (read) => read?.isDisposed === true,
};
