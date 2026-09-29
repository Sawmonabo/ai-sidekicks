// The local-runtime page's status read and its two controls.
//
// What is here owns lifetimes: a read that must not be answered by a stale reply, and
// two dispatches that must not overlap. The page owns markup.
//
// The supervisor state is not read here. It arrives on the page's own context, from the
// one subscription the frame keeps live, so the page never gives a second answer to "is
// the runtime up". What is read here is the one fact that subscription does not carry:
// the daemon's own reported status line and version.
//
// That reading goes stale, and what stales it is declared here as a thing that happened
// rather than a clock: a control this page dispatched, or a supervisor transition. The
// read is re-put by re-addressing it, which the subject holder already does: the answer
// re-seeds to `reading` and a reply to the old subject is dropped. Nothing polls.

import { useCallback, useEffect, useMemo, useState } from "react";

import { useGenerationLatch } from "@renderer/hooks/useGenerationLatch.js";
import type { ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { type ShellConnection } from "@renderer/store/window/main-process-state.js";

/** What the daemon says about itself, once it has been asked. */
export interface DaemonStatus {
  readonly state: string;
  readonly version: string;
}

/**
 * The daemon verbs this page drives.
 */
export interface DaemonOperations {
  readonly readStatus: () => Promise<DaemonStatus>;
  readonly stop: () => Promise<unknown>;
  readonly restart: () => Promise<unknown>;
}

/** The read's two phases. `reading` is the seed; `read` is the settlement. */
export type DaemonStatusReading =
  | { readonly phase: "reading" }
  | { readonly phase: "read"; readonly status: DaemonStatus };

/**
 * What makes the daemon's own answer stale.
 *
 * Two members, each a thing that happened. A control this page dispatched is the one
 * change the page caused; a supervisor transition is every change it did not.
 */
export interface DaemonStatusFreshness {
  /** What the supervisor is reporting about the runtime right now. */
  readonly connection: ShellConnection;
  /** How many of this page's controls have settled. `DaemonControlDispatch`'s own. */
  readonly settledControlCount: number;
}

const DAEMON_STATUS_KEY = "daemon-status";

const READING_DAEMON_STATUS: DaemonStatusReading = { phase: "reading" };

/** Which of the two controls was pressed. Closed, because the page offers two. */
export type DaemonControl = "stop" | "restart";

/** What a dispatched control settled as. */
export interface DaemonControlSettlement {
  readonly control: DaemonControl;
}

/**
 * Read the daemon's own status line, and read it again when it can have changed.
 *
 * The freshness rides the subject key: the holder re-seeds during the render that first
 * sees a new subject and the read is put again, so no flag beside the state can disagree
 * with which answer is current.
 */
export function useDaemonStatus(
  bridge: ConsoleBridge,
  freshness: DaemonStatusFreshness,
  operations: DaemonOperations,
): DaemonStatusReading {
  const { value, publish } = useSubjectScopedState<DaemonStatusReading>(
    bridge,
    daemonStatusSubject(freshness),
    () => READING_DAEMON_STATUS,
  );
  useEffect(() => {
    void operations.readStatus().then((status) => {
      publish({ phase: "read", status });
    });
  }, [operations, publish]);
  return value;
}

/**
 * The subject one status answer belongs to.
 *
 * The connection's kind and never the whole connection: `reconnecting` carries an
 * attempt number and the healthy path a heartbeat timestamp, and keying on either would
 * put a read on the wire per attempt and per beat.
 */
function daemonStatusSubject(freshness: DaemonStatusFreshness): string {
  return `${DAEMON_STATUS_KEY}:${freshness.connection.kind}:${freshness.settledControlCount}`;
}

/**
 * The single-flight key the two controls share: one destructive act at a time against
 * this machine's runtime, not one of each.
 */
const DAEMON_CONTROL_KEY = "daemon-control";

/** One control in flight, and the way to put one. */
export interface DaemonControlDispatch {
  /** Which control is outstanding, or `undefined` while none is. */
  readonly inFlight: DaemonControl | undefined;
  /**
   * How many dispatches have settled on this visit.
   *
   * A count and not the settlement, because the status read needs the edge: two stops in
   * a row settle to the same value and are two reasons to ask the runtime again.
   */
  readonly settledCount: number;
  /**
   * Put one control. A press arriving while one is outstanding puts nothing.
   *
   * Settles when the call does, and rejects with it: a failed call is the caller's to
   * hear, and the dispatch is released either way.
   */
  readonly put: (control: DaemonControl) => Promise<void>;
}

/**
 * Dispatch one control and report that it was sent.
 *
 * `sent` and not `done`: a stop that was accepted is not a runtime that has stopped, and
 * the supervisor's next report is what says so. Single flight is decided in the tick by
 * the latch's key, taken before the call goes out, because a second press in the same
 * frame reads the flag from the render that produced its handler and finds it idle. The
 * latch is mount-scoped, so a reply arriving after the page is gone installs nothing.
 */
export function useDaemonControl(
  bridge: ConsoleBridge,
  operations: DaemonOperations,
  onSettled: (settlement: DaemonControlSettlement) => void,
): DaemonControlDispatch {
  const dispatchLatch = useGenerationLatch();
  const [inFlight, setInFlight] = useState<DaemonControl | undefined>(undefined);
  const [settledCount, setSettledCount] = useState(0);
  const put = useCallback(
    async (control: DaemonControl) => {
      const dispatch = dispatchLatch.claim(bridge, DAEMON_CONTROL_KEY);
      if (dispatch === undefined) {
        return;
      }
      setInFlight(control);
      try {
        await operations[control]();
        dispatch.settle(() => {
          setSettledCount((previous) => previous + 1);
          onSettled({ control });
        });
      } finally {
        dispatch.settle(() => {
          setInFlight(undefined);
        });
        dispatch.release();
      }
    },
    [bridge, dispatchLatch, onSettled, operations],
  );
  return useMemo(() => ({ inFlight, settledCount, put }), [inFlight, settledCount, put]);
}
