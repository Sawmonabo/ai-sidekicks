import { useCallback, useEffect, useRef, useState } from "react";

import { useLatestRef } from "@renderer/hooks/useLatestRef.js";
import type { Refusal } from "@renderer/lib/refusal/refusal.js";
import type { DaemonReply } from "@renderer/services/daemon/daemon-reply.js";

/** Where one act on a run stands: not taken, in flight, refused in the daemon's words, or done. */
export type WorkflowActState<TResult> =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "refused"; readonly refusal: Refusal }
  | { readonly kind: "done"; readonly result: TResult };

/** One act's state and the press that takes it. */
export interface WorkflowAct<TRequest, TResult> {
  readonly state: WorkflowActState<TResult>;
  /** Send the act; a press while one is in flight is ignored, so one press is one call. */
  readonly take: (request: TRequest) => void;
}

/**
 * Hold one act on a run: the call it sends, and how it settled. A settlement after the view is
 * gone sets nothing. `onDone` runs once per served answer, after the state is set.
 */
export function useWorkflowAct<TRequest, TResult>(
  send: (request: TRequest) => Promise<DaemonReply<TResult>>,
  onDone?: (result: TResult, request: TRequest) => void,
): WorkflowAct<TRequest, TResult> {
  const [state, setState] = useState<WorkflowActState<TResult>>({ kind: "idle" });
  const isMounted = useRef(true);
  const isSending = useRef(false);
  const latestSend = useLatestRef(send);
  const latestOnDone = useLatestRef(onDone);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);
  const take = useCallback(
    (request: TRequest) => {
      if (isSending.current) {
        return;
      }
      isSending.current = true;
      setState({ kind: "sending" });
      void latestSend.current(request).then((reply) => {
        isSending.current = false;
        if (!isMounted.current) {
          return;
        }
        if (reply.status === "refused") {
          setState({ kind: "refused", refusal: reply.refusal });
          return;
        }
        setState({ kind: "done", result: reply.value });
        latestOnDone.current?.(reply.value, request);
      });
    },
    [latestSend, latestOnDone],
  );
  return { state, take };
}
