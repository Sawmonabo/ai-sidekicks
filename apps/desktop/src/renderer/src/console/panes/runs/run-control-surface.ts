// What the pane holds for the six controls: one dispatcher, and the record of what
// it settled.
//
// Split from `run-control-dispatch.ts` because it is a second job: that module is
// the wire chokepoint and is drivable without React, and this one is the React
// binding that keeps the in-flight set and the settled records. The split is what
// lets a test drive every guard and every refusal arm against a stub bridge with no
// rendered tree at all.
//
// THE SINGLE-FLIGHT LATCH IS A REF AND NOT THE STATE. `inFlightKeys` is what the
// row RENDERS, and a handler reading it sees the value from the render that produced
// the handler — so a double click, or repeated Enter on an intervention form before
// React commits the busy state, reaches `dispatch` twice in one tick and both calls
// read an empty set. Two dispatches mint two idempotency keys against one run
// version, which makes them two distinct mutations rather than replays of one: they
// race to apply and the loser's stale refusal can become the visible settlement. The
// ref is read and written before `perform` is called, so the second press is a no-op
// in the same tick — the person pressed the control for the act that is already
// going, and there is nothing to refuse them.
//
// THE RECORD IS THIS WINDOW'S OWN. `Spec-023 §Console Design (Meridian)` §7.5 asks
// for the durable intervention history, including the attempts that failed, with
// the `origin` discriminator and the admitting principal on the participant arm.
// Those live on the `interventions` table and no registered wire reads them, so
// what this surface can honestly hold is what it dispatched and what came back —
// every field of it daemon-supplied. The surface that renders it says so rather
// than passing a partial record off as the whole one.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type ConsoleBridge } from "../../bridge/index.js";
import { INTERVENTION_OUTCOME_CAP } from "./runs-bounds.js";
import {
  RunControlDispatcher,
  carriedRunControlRefusal,
  type RunControl,
  type RunControlOutcome,
} from "./run-control-dispatch.js";

/** One recorded dispatch, for the pane's own intervention history. */
export interface RunControlRecord {
  readonly recordId: string;
  readonly runId: string;
  readonly control: RunControl;
  readonly outcome: RunControlOutcome;
}

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
  ) => void;
}

/** The key one in-flight dispatch is held under. One control per run at a time. */
export function inFlightKeyFor(runId: string, control: RunControl): string {
  return `${runId}:${control}`;
}

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
  const [records, setRecords] = useState<readonly RunControlRecord[]>(EMPTY_RECORDS);
  const [inFlightKeys, setInFlightKeys] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  const nextRecordOrdinal = useRef(0);
  const isMounted = useRef(true);
  const heldControlKeys = useRef<Set<string>>(new Set());

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
    ) => {
      const key = inFlightKeyFor(runId, control);
      if (heldControlKeys.current.has(key)) {
        return;
      }
      heldControlKeys.current.add(key);
      setInFlightKeys((held) => {
        const next = new Set(held);
        next.add(key);
        return next;
      });
      const settle = (outcome: RunControlOutcome): void => {
        // The latch is released before the mount check and never inside it: an
        // unmounted surface writes no state, but a key left held would survive the
        // mount/unmount/mount that development-mode React performs on one hook
        // instance and leave that control latched for the rest of the window.
        heldControlKeys.current.delete(key);
        if (!isMounted.current) {
          return;
        }
        nextRecordOrdinal.current += 1;
        const record: RunControlRecord = {
          recordId: `${runId}:${control}:${String(nextRecordOrdinal.current)}`,
          runId,
          control,
          outcome,
        };
        setInFlightKeys((held) => {
          const next = new Set(held);
          next.delete(key);
          return next;
        });
        setRecords((held) => {
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
    },
    [dispatcher],
  );

  return useMemo(
    () => ({ dispatcher, records, inFlightKeys, dispatch }),
    [dispatcher, records, inFlightKeys, dispatch],
  );
}

const EMPTY_RECORDS: readonly RunControlRecord[] = Object.freeze([]);
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();
