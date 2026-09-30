// What is held for the run controls: one dispatcher, and the record of what it settled.
//
// Split from `services/run-control-dispatch.ts` because it is a second job: that module is
// the wire chokepoint and is drivable without React, and this one is the React
// binding that keeps the in-flight set and the settled records. The split is what
// lets a test drive every guard and every settled arm against stub calls with no
// rendered tree at all.
//
// THE LATCH ANSWERS. A silently dropped latched call is wrong for a form that records
// a pending baseline of its own before calling: a user could cancel a form with its
// request still in flight, reopen the same run and control, type a new body, and
// confirm — the form marked itself pending, the latch dropped the call, and the OLD
// request's settlement then differed from the new form's baseline and was read as the
// new body's, an old success closing the form and discarding text that never went
// anywhere.
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
// ALL THREE HOLDERS BELONG TO THE BRIDGE. When the window's transport is replaced, the
// dispatcher, the held keys, the busy set and the records rotate together, so a retry of
// the same run and control through the new bridge is not refused as already in flight,
// and an old settlement is not appended to records it was not about. They rotate by
// whose they are rather than by a timer: the console's one `GenerationLatch` holds each
// key under the bridge it was claimed on, so a settlement releases the round it belongs
// to and leaves the live one untouched, and `useSubjectScopedState` holds the two
// readings under the bridge, resetting them during the render that first sees a new one
// and dropping a publish whose captured bridge has been replaced.
//
// THE IN-FLIGHT SET IS THE LATCH'S RENDERING AND NOT A SECOND RULE. What admits a
// dispatch is the claim; what a control renders as busy is this set, published only
// from inside the claim's own settlement. The latch bounds what it holds and answers
// only about the round it owns, so a set is what a component can read a key out of —
// and because nothing outside the settlement writes it, the two cannot disagree.
//
// THE RECORD IS THIS WINDOW'S OWN. The durable intervention history, including the
// attempts that failed, carries the `origin` discriminator and the admitting principal
// on the user arm. Those live on the `interventions` table and no registered wire reads
// them, so what the run controls can honestly hold is what they dispatched and what came
// back — every field of it daemon-supplied. Whatever renders these records says so
// rather than passing a partial record off as the whole one.

import { useCallback, useMemo, useRef } from "react";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { useGenerationLatch } from "@renderer/hooks/useGenerationLatch.js";
import { useLatestRef } from "@renderer/hooks/useLatestRef.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { INTERVENTION_OUTCOME_CAP } from "../../run-caps.js";
import {
  RunControlDispatcher,
  type RunControl,
  type RunControlCalls,
  type RunControlOutcome,
} from "../services/run-control-dispatch.js";
import { inFlightKeyFor, mintRunControlDispatchToken } from "../run-control-keys.js";

/** One recorded dispatch and what it settled to, read back by the steer box. */
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
  | {
      readonly admitted: true;
      readonly dispatchToken: string;
      /** Settles when the dispatch has been recorded; rejects with what `perform` rejected. */
      readonly settled: Promise<void>;
    }
  | { readonly admitted: false; readonly reason: RunControlAdmissionRefusal };

/** What is held for the run controls: the dispatcher and its own record. */
export interface RunControlDispatchState {
  readonly dispatcher: RunControlDispatcher;
  /** Newest last, matching the transcript's reading direction. Bounded. */
  readonly records: readonly RunControlRecord[];
  /** Controls with a dispatch in flight, keyed `<runId>:<control>`. */
  readonly inFlightKeys: ReadonlySet<string>;
  readonly dispatch: (
    runId: string,
    control: RunControl,
    perform: (dispatcher: RunControlDispatcher) => Promise<RunControlOutcome>,
  ) => RunControlAdmission;
}

/**
 * The key the run controls' held state is kept under.
 *
 * The whole state belongs to the BRIDGE, so its key within one is fixed: a run id
 * would be the wrong key here, since one dispatch state holds every run's controls at
 * once and the axis that actually moves under it is the transport.
 */
const RUN_CONTROL_STATE_KEY = "run-controls";

/**
 * Hold the dispatcher and record what it settles.
 *
 * The record is this window's own — this window dispatched it and read the answer. It
 * is deliberately NOT presented as the durable audit record: the `interventions`
 * table carries `origin` and the admitting principal and has no registered read, so
 * a history claiming to be complete would be claiming something the wire cannot
 * support.
 *
 * `bridge` scopes the held state to one transport. `calls` are read through a
 * latest-ref, so a caller that rebuilds them each render keeps one dispatcher and its
 * comparand cache.
 */
export function useRunControlDispatch(
  bridge: PlatformBridge,
  calls: RunControlCalls,
  mintIdempotencyKey?: () => string,
): RunControlDispatchState {
  const { value: records, publish: publishRecords } = useSubjectScopedState<
    readonly RunControlRecord[]
  >(bridge, RUN_CONTROL_STATE_KEY, () => EMPTY_RECORDS);
  const { value: inFlightKeys, publish: publishInFlightKeys } = useSubjectScopedState<
    ReadonlySet<string>
  >(bridge, RUN_CONTROL_STATE_KEY, () => EMPTY_KEYS);
  const nextDispatchOrdinal = useRef(0);
  const controlLatch = useGenerationLatch();

  const callsRef = useLatestRef(calls);
  const dispatcher = useMemo(
    () =>
      new RunControlDispatcher(
        {
          pause: (request) => callsRef.current.pause(request),
          resume: (request) => callsRef.current.resume(request),
          intervene: (request) => callsRef.current.intervene(request),
        },
        mintIdempotencyKey,
      ),
    [callsRef, bridge, mintIdempotencyKey],
  );

  const dispatch = useCallback(
    (
      runId: string,
      control: RunControl,
      perform: (held: RunControlDispatcher) => Promise<RunControlOutcome>,
    ): RunControlAdmission => {
      const key = inFlightKeyFor(runId, control);
      const claim = controlLatch.claim(bridge, key);
      if (claim === undefined) {
        return { admitted: false, reason: "in-flight" };
      }
      // Minted here rather than at settlement, because the caller needs it NOW: a
      // form that waits on its own settlement has to know which record will be its
      // own before the answer exists. The ordinal keeps two dispatches of one control
      // on one run distinct, and `run-control-keys.ts` mints the token from it.
      nextDispatchOrdinal.current += 1;
      const dispatchToken = mintRunControlDispatchToken(
        runId,
        control,
        nextDispatchOrdinal.current,
      );
      publishInFlightKeys((held) => {
        const next = new Set(held);
        next.add(key);
        return next;
      });
      const clearInFlight = (): void => {
        publishInFlightKeys((held) => {
          const next = new Set(held);
          next.delete(key);
          return next;
        });
      };
      const settle = (outcome: RunControlOutcome): void => {
        const record: RunControlRecord = { recordId: dispatchToken, runId, control, outcome };
        // Published inside the claim, so an answer to a call made on a transport that
        // has since been replaced — or by a mount React has already discarded — is
        // dropped rather than appended to records that never made it.
        claim.settle(() => {
          clearInFlight();
          publishRecords((held) => {
            const appended = [...held, record];
            return appended.length <= INTERVENTION_OUTCOME_CAP
              ? appended
              : appended.slice(appended.length - INTERVENTION_OUTCOME_CAP);
          });
        });
        // Released after the publish: a key left held would survive the
        // mount/unmount/mount that development-mode React performs on one hook instance
        // and leave that control latched for the rest of the window. The round released
        // is the one the call was CLAIMED in, so a settlement landing after a swap frees
        // its own and not the live one.
        claim.release();
      };
      // A `perform` that rejects, or throws before it returns a promise, frees the latch
      // and then propagates: left held, that control would stay busy for the rest of the
      // window, and the rejection is still the caller's to see.
      const abandon = (): void => {
        claim.settle(clearInFlight);
        claim.release();
      };
      const settled = (async (): Promise<void> => {
        try {
          settle(await perform(dispatcher));
        } catch (rejection) {
          abandon();
          throw rejection;
        }
      })();
      return { admitted: true, dispatchToken, settled };
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
