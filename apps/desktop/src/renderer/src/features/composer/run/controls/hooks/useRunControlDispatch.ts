// What is held for the run controls: one dispatcher, and the record of what it settled.
//
// The latch is claimed before `perform` runs, so a double click in one tick is refused, not
// sent under two idempotency keys. An admitted dispatch carries the token its settlement is
// recorded under, so a form never reads another request's settlement as its own. All held
// state belongs to the bridge and rotates with it. Records are this window's own; the durable
// history is on the `interventions` table, which no registered wire reads.

import { useCallback, useMemo, useRef } from "react";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useGenerationLatch } from "#renderer/hooks/useGenerationLatch.js";
import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { INTERVENTION_OUTCOME_CAP } from "../../caps.js";
import {
  RunControlDispatcher,
  type RunControl,
  type RunControlCalls,
  type RunControlOutcome,
} from "../services/dispatch.js";
import { inFlightKeyFor, mintRunControlDispatchToken } from "../keys.js";

/** One recorded dispatch and what it settled to, read back by the steer box. */
export interface RunControlRecord {
  /** The token its dispatch was admitted under. One admitted dispatch, one record. */
  readonly recordId: string;
  readonly runId: string;
  readonly control: RunControl;
  readonly outcome: RunControlOutcome;
}

/**
 * Why a dispatch was not admitted. A second reason fails every caller's exhaustive read
 * until it says what that reason means on screen.
 */
export type RunControlAdmissionRefusal = "in-flight";

/**
 * Whether a dispatch was admitted. The admitted arm carries the `dispatchToken` (the
 * record's `recordId`), so a caller reads the record of the request it made, not the newest.
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

/** The key the held state sits under: fixed, since the state belongs to the bridge. */
const RUN_CONTROL_STATE_KEY = "run-controls";

/**
 * Holds the dispatcher and records what it settles. `bridge` scopes the held state to one
 * transport; `calls` are read through a latest-ref, so rebuilding them each render keeps one
 * dispatcher and its comparand cache.
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
      // Minted here because the caller needs the token before the answer exists; the ordinal
      // keeps two dispatches of one control on one run distinct.
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
        // Published inside the claim, so an answer from a replaced transport or a discarded mount
        // is dropped, not appended.
        claim.settle(() => {
          clearInFlight();
          publishRecords((held) => {
            const appended = [...held, record];
            return appended.length <= INTERVENTION_OUTCOME_CAP
              ? appended
              : appended.slice(appended.length - INTERVENTION_OUTCOME_CAP);
          });
        });
        // Released after the publish: a held key would survive development-mode React's
        // mount/unmount/mount and leave the control latched. The round released is the one the call
        // was claimed in.
        claim.release();
      };
      // A `perform` that rejects or throws frees the latch, then propagates.
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
