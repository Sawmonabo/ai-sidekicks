// What the pane holds for the six controls: one dispatcher, and the record of what
// it settled.
//
// Split from `run-control-dispatch.ts` because it is a second job: that module is
// the wire chokepoint and is drivable without React, and this one is the React
// binding that keeps the in-flight set and the settled records. The split is what
// lets a test drive every guard and every refusal arm against a stub bridge with no
// rendered tree at all.
//
// AND THE LATCH ANSWERS. `dispatch` used to return `void` and drop a latched call
// silently, which is right for a control the row disables — the person pressed it
// twice — and wrong for a form that records a pending baseline of its own before
// calling. A participant could cancel a form with its request still in flight,
// reopen the same run and control, type a new body, and confirm: the form marked
// itself pending, the surface dropped the call, and the OLD request's settlement
// then differed from the new form's baseline and was read as the new body's — an
// old success closing the form and discarding text that never went anywhere.
//
// So the latch returns a verdict. An admitted dispatch carries the token its own
// settlement will be recorded under, and a refused one carries the reason it was
// not admitted. The token is the record's own id rather than a second identifier
// beside it: one admitted dispatch appends exactly one record, so minting a second
// value to relate them would be two names for one thing.
//
// THE SINGLE-FLIGHT LATCH IS NOT THE STATE. `inFlightKeys` is what the row RENDERS,
// and a handler reading it sees the value from the render that produced the handler
// — so a double click, or repeated Enter on an intervention form before React
// commits the busy state, reaches `dispatch` twice in one tick and both calls read
// an empty set. Two dispatches mint two idempotency keys against one run version,
// which makes them two distinct mutations rather than replays of one: they race to
// apply and the loser's stale refusal can become the visible settlement. The latch
// is claimed before `perform` is called, so the second press is a no-op in the same
// tick — the person pressed the control for the act that is already going, and there
// is nothing to refuse them.
//
// AND ALL THREE HOLDERS BELONG TO THE BRIDGE. Only the dispatcher used to rotate
// when the window's transport was replaced: the held keys, the busy set and the
// records still belonged to the transport that was gone, so a retry of the same run
// and control through the NEW bridge was refused as already in flight — until the
// old call settled, and forever where it never did — and that old settlement was
// appended to a surface it was not about. All three now rotate together, and by
// whose they are rather than by a timer: `BridgeScopedLatch` holds each key under
// the bridge it was claimed on, so a settlement releases the generation it belongs
// to and leaves the live one untouched, and `useSubjectScopedState` holds the two
// readings under the bridge, resetting them during the render that first sees a new
// one and dropping a publish whose captured bridge has been replaced.
//
// THE RECORD IS THIS WINDOW'S OWN. `Spec-023 §Signature Feature Composition
// Sketches`' Runs View renders "intervention history per Spec-004" — the durable
// history, including the attempts that failed, with the `origin` discriminator and
// the admitting principal on the participant arm. Those live on the `interventions`
// table and no registered wire reads them, so
// what this surface can honestly hold is what it dispatched and what came back —
// every field of it daemon-supplied. The surface that renders it says so rather
// than passing a partial record off as the whole one.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BridgeScopedLatch,
  useSubjectScopedState,
  type ConsoleBridge,
} from "../../bridge/index.js";
import { INTERVENTION_OUTCOME_CAP } from "./runs-bounds.js";
import {
  RunControlDispatcher,
  carriedRunControlRefusal,
  type RunControl,
  type RunControlOutcome,
} from "./run-control-dispatch.js";

/** One recorded dispatch, for the pane's own intervention history. */
export interface RunControlRecord {
  /** The token its dispatch was admitted under. One admitted dispatch, one record. */
  readonly recordId: string;
  readonly runId: string;
  readonly control: RunControl;
  readonly outcome: RunControlOutcome;
}

/**
 * Why a dispatch was not admitted. Closed, and declared once.
 *
 * One member today because one thing refuses a dispatch: this run and control
 * already have one going. A second reason lands here and every caller's exhaustive
 * read fails to compile until it says what that reason means on screen.
 */
export type RunControlAdmissionRefusal = "in-flight";

/**
 * Whether a dispatch was admitted, and what a caller may do with the answer.
 *
 * The admitted arm carries the `dispatchToken` the settlement will be recorded
 * under — the record's own `recordId` — so a caller waiting on ITS dispatch reads
 * the record by that token rather than by whichever record happens to be newest.
 * That is the difference between "this run's newest settlement" and "the settlement
 * of the request I made".
 */
export type RunControlAdmission =
  | { readonly admitted: true; readonly dispatchToken: string }
  | { readonly admitted: false; readonly reason: RunControlAdmissionRefusal };

/** What the pane holds for the six controls: the dispatcher and its own record. */
export interface RunControlSurface {
  readonly dispatcher: RunControlDispatcher;
  /** Newest last, matching the ledger's reading direction. Bounded. */
  readonly records: readonly RunControlRecord[];
  /** Controls with a dispatch in flight, keyed `<runId>:<control>`. */
  readonly inFlightKeys: ReadonlySet<string>;
  readonly dispatch: (
    runId: string,
    control: RunControl,
    perform: (dispatcher: RunControlDispatcher) => Promise<RunControlOutcome>,
  ) => RunControlAdmission;
}

/** The key one in-flight dispatch is held under. One control per run at a time. */
export function inFlightKeyFor(runId: string, control: RunControl): string {
  return `${runId}:${control}`;
}

/**
 * The subject this surface's state belongs to.
 *
 * The whole surface belongs to the BRIDGE, so its key within one is fixed: a run id
 * would be the wrong key here, since one surface holds every run's controls at once
 * and the axis that actually moves under it is the transport.
 */
const RUN_CONTROL_SURFACE_SUBJECT = "run-controls";

/**
 * Hold the dispatcher and record what it settles.
 *
 * The record is this window's own — the pane dispatched it and read the answer. It
 * is deliberately NOT presented as the durable audit record: the `interventions`
 * table carries `origin` and the admitting principal and has no registered read, so
 * a history claiming to be complete would be claiming something the wire cannot
 * support.
 */
export function useRunControlSurface(
  bridge: ConsoleBridge,
  mintIdempotencyKey?: () => string,
): RunControlSurface {
  const [records, publishRecords] = useSubjectScopedState<readonly RunControlRecord[]>(
    bridge,
    RUN_CONTROL_SURFACE_SUBJECT,
    EMPTY_RECORDS,
  );
  const [inFlightKeys, publishInFlightKeys] = useSubjectScopedState<ReadonlySet<string>>(
    bridge,
    RUN_CONTROL_SURFACE_SUBJECT,
    EMPTY_KEYS,
  );
  const nextDispatchOrdinal = useRef(0);
  const isMounted = useRef(true);
  // A `useState` initializer rather than a `useMemo`, on `approvals-hooks.ts`'s
  // reasoning: a latch React was free to rebuild would forget a call still in flight.
  const [controlLatch] = useState(() => new BridgeScopedLatch());

  const dispatcher = useMemo(
    () =>
      new RunControlDispatcher(
        mintIdempotencyKey === undefined ? { bridge } : { bridge, mintIdempotencyKey },
      ),
    [bridge, mintIdempotencyKey],
  );

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const dispatch = useCallback(
    (
      runId: string,
      control: RunControl,
      perform: (held: RunControlDispatcher) => Promise<RunControlOutcome>,
    ): RunControlAdmission => {
      const key = inFlightKeyFor(runId, control);
      if (!controlLatch.claim(bridge, key)) {
        return { admitted: false, reason: "in-flight" };
      }
      // Minted here rather than at settlement, because the caller needs it NOW: a
      // form that waits on its own settlement has to know which record will be its
      // own before the answer exists.
      nextDispatchOrdinal.current += 1;
      const dispatchToken = `${runId}:${control}:${String(nextDispatchOrdinal.current)}`;
      publishInFlightKeys((held) => {
        const next = new Set(held);
        next.add(key);
        return next;
      });
      const settle = (outcome: RunControlOutcome): void => {
        // The latch is released before the mount check and never inside it: an
        // unmounted surface writes no state, but a key left held would survive the
        // mount/unmount/mount that development-mode React performs on one hook
        // instance and leave that control latched for the rest of the window. The
        // bridge released is the one the call was CLAIMED on, so a settlement landing
        // after a swap frees the generation it belongs to and not the live one.
        controlLatch.release(bridge, key);
        if (!isMounted.current) {
          return;
        }
        const record: RunControlRecord = { recordId: dispatchToken, runId, control, outcome };
        // Published through this bridge's own publishers, so an answer to a call made
        // on a transport that has since been replaced is dropped rather than appended
        // to a surface that never made it.
        publishInFlightKeys((held) => {
          const next = new Set(held);
          next.delete(key);
          return next;
        });
        publishRecords((held) => {
          const appended = [...held, record];
          return appended.length <= INTERVENTION_OUTCOME_CAP
            ? appended
            : appended.slice(appended.length - INTERVENTION_OUTCOME_CAP);
        });
      };
      const settleRejection = (rejection: unknown): void => {
        settle(carriedRunControlRefusal(control, rejection));
      };
      // Every settlement path, not only the resolved one. A `perform` that rejects
      // — or that throws before it returns a promise at all — settles the dispatch
      // just as surely as one that resolves: without these two arms the latch stays
      // held, that control is busy for the rest of the window, and the rejection
      // reaches no surface at all.
      try {
        void perform(dispatcher).then(settle, settleRejection);
      } catch (rejection) {
        settleRejection(rejection);
      }
      return { admitted: true, dispatchToken };
    },
    [bridge, controlLatch, dispatcher, publishInFlightKeys, publishRecords],
  );

  return useMemo(
    () => ({ dispatcher, records, inFlightKeys, dispatch }),
    [dispatcher, records, inFlightKeys, dispatch],
  );
}

const EMPTY_RECORDS: readonly RunControlRecord[] = Object.freeze([]);
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();
