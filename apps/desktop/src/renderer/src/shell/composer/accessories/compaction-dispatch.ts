// The compaction call's own state machine, kept out of the control that renders it.
//
// The rule the design fixes is narrow and easy to break by accident: "one call per
// explicit request; the in-progress state clears when the call settles in EVERY
// arm". A control that held its own boolean would clear it on the arm the author
// remembered and leave the button spinning forever on the one they did not — and
// the arm nobody remembers is the rejection, which is exactly the arm a person
// meets when the driver cannot compact at all.
//
// So settlement is total here by construction: one `finally`-shaped resolution path
// that every outcome flows through, and a single-flight latch that makes a second
// press while a call is in flight a no-op rather than a second call.
//
// AND EVERY PIECE OF THAT STATE IS KEYED TO THE TARGET IT IS ABOUT. The hook used to
// hold one latch and one reading for the whole composer, with the run supplied at
// press time — so a composer re-addressed while a call was in flight carried BOTH
// halves of the mistake across the move: the latch was still closed, which made the
// newly addressed run's Compact button a no-op it gave no reason for, and the
// settlement that came back was rendered beside a control it was not about. The
// target — the bridge, the session, and the run — is therefore the hook's own
// argument, the latch is held per run, and a reading is stored WITH the target it
// settled for and rendered only where that target is the addressed one.
//
// THE DISPOSITION FOR A SETTLEMENT WHOSE TARGET IS NO LONGER ADDRESSED, stated once
// rather than left to the reader: it is kept under its own target and rendered
// nowhere else, so a person who presses Compact on Ada's run, looks at Priya's, and
// comes back still learns what Ada's call answered — an outcome they asked for is
// not thrown away merely because they looked elsewhere while it travelled. There is
// ONE such slot, and a newer act owns it: a settlement arriving after the composer
// has begun a compaction on another run is discarded rather than displacing that
// run's in-flight reading. The console does not accumulate a per-run history here,
// because the durable record of a compaction is the ledger's own boundary row and a
// second unbounded copy of it beside a button would be a worse one.
//
// WHAT IS NEVER TREATED AS A COMPACTION. The reply is evidence the REQUEST settled,
// never evidence the context was compacted — both provider mechanisms answer before
// the work is done, and the completed state is the `usage.context_compacted` row
// alone. This module produces no such row and reads none; it reports what the call
// answered and stops there.

import { useCallback, useEffect, useRef, useState } from "react";
import { DriverCompactionResultSchema, type DriverCompactionResult } from "@ai-sidekicks/contracts";
import { normalizeWireRejection } from "../../../../../shared/wire-errors.js";
import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";
import {
  COMPACT_CONTEXT_METHOD,
  callDaemon,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";

/** The subsystem name every refusal this module raises carries. */
export const COMPACTION_REFUSAL_ORIGIN = "composer-compaction";

/**
 * Why the console refused to render the reply as a settlement.
 *
 * One code, and a closed set so a second is a decision rather than a free string.
 * It is raised only for a reply that does not parse as the registered result — a
 * daemon-composed shape the console has no reading for, which is a composition bug
 * and not a user-facing outcome.
 */
export const COMPACTION_REFUSAL_CODES = ["reply-unreadable"] as const;

/** One composer-side compaction refusal code. Derived, declared once. */
export type CompactionRefusalCode = (typeof COMPACTION_REFUSAL_CODES)[number];

/**
 * Where a compaction request has got to.
 *
 * `rejected` is the wire's own refusal envelope — `driver.capability_unsupported`,
 * `session.not_found`, and every other code the daemon may answer with — rendered
 * verbatim rather than mapped onto one of the result union's reasons, which name
 * settlements the daemon reached and this one never did.
 */
export type CompactionDispatchState =
  | { readonly phase: "idle" }
  | { readonly phase: "dispatching" }
  | { readonly phase: "settled"; readonly result: DriverCompactionResult }
  | { readonly phase: "rejected"; readonly refusal: ConsoleRefusal };

/** What the control is handed: the current state and the one act it may perform. */
export interface CompactionDispatch {
  readonly state: CompactionDispatchState;
  /**
   * Dispatch one compaction for the ADDRESSED run.
   *
   * No argument: the run is the hook's own identity, so a caller cannot press the
   * button for one run while the control renders another's state. A no-op while a
   * call for this same run is in flight, and a no-op where no run is addressed.
   */
  readonly requestCompaction: () => void;
}

/**
 * What a compaction call is about: the transport, the session, and the run.
 *
 * All three, because all three can change under a mounted composer — the pane can be
 * re-addressed to another run, the route to another session, and the window's bridge
 * is replaced in the fixture picker. Two of these compared equal while the third
 * differed would let a settlement land under a control it is not about, which is the
 * whole of what this key exists to prevent.
 */
export interface CompactionTarget {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly targetRunId: string;
}

/** Whether two targets name the same compaction. The bridge compares by identity. */
export function isSameCompactionTarget(one: CompactionTarget, other: CompactionTarget): boolean {
  return (
    one.bridge === other.bridge &&
    one.sessionId === other.sessionId &&
    one.targetRunId === other.targetRunId
  );
}

/** One reading, held under the target it is about rather than under the hook. */
interface HeldCompactionReading {
  readonly target: CompactionTarget;
  readonly state: CompactionDispatchState;
}

const IDLE: CompactionDispatchState = { phase: "idle" };
const DISPATCHING: CompactionDispatchState = { phase: "dispatching" };

/**
 * The reading to render at this address, or idle.
 *
 * The guard that makes the keying visible rather than incidental: a held reading
 * whose target is not the one the control is rendering for contributes nothing, so a
 * settlement can be stored the moment it arrives without ever being attributed to a
 * run it is not about.
 */
function readingAtTarget(
  held: HeldCompactionReading | undefined,
  addressed: CompactionTarget | undefined,
): CompactionDispatchState {
  if (held === undefined || addressed === undefined) {
    return IDLE;
  }
  return isSameCompactionTarget(held.target, addressed) ? held.state : IDLE;
}

/**
 * Drive one compaction request.
 *
 * The latch is a ref rather than state on purpose: it has to be readable and
 * writable in the same tick the click handler runs, and a state read inside that
 * handler would see the value from the render that produced it — so two clicks
 * inside one frame would both see `idle` and both dispatch.
 */
export function useCompactionDispatch(
  bridge: ConsoleBridge,
  sessionId: string,
  targetRunId: string | undefined,
): CompactionDispatch {
  const [held, setHeld] = useState<HeldCompactionReading | undefined>(undefined);
  // The run ids with a call in flight, so the latch is per RUN: a second press on
  // the run already compacting is the no-op the single-flight rule asks for, while a
  // press on a run this composer has since moved to is a first press and dispatches.
  // Allocated on first use rather than on every render, which a bare initialiser
  // would do and then discard.
  const inFlightRunIdsRef = useRef<Set<string> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    const inFlightRunIds = inFlightRunIdsRef;
    return () => {
      // A settle that lands after the composer unmounted has nowhere to go. The
      // latch is cleared with it so a remount starts idle rather than wedged.
      isMountedRef.current = false;
      inFlightRunIds.current?.clear();
    };
  }, []);

  useEffect(() => {
    // A different transport or session is a different set of calls entirely, and no
    // run id from the previous one names a call this hook could still be waiting on.
    inFlightRunIdsRef.current?.clear();
  }, [bridge, sessionId]);

  const requestCompaction = useCallback(() => {
    if (targetRunId === undefined) {
      return;
    }
    const inFlightRunIds = (inFlightRunIdsRef.current ??= new Set<string>());
    if (inFlightRunIds.has(targetRunId)) {
      return;
    }
    const target: CompactionTarget = { bridge, sessionId, targetRunId };
    inFlightRunIds.add(targetRunId);
    setHeld({ target, state: DISPATCHING });
    void settleCompaction(bridge, sessionId, targetRunId).then((settled) => {
      inFlightRunIds.delete(targetRunId);
      if (!isMountedRef.current) {
        return;
      }
      // The slot belongs to the newest act. A settlement arriving after a
      // compaction was begun on ANOTHER run would otherwise replace that run's
      // in-flight reading with a result about a run the control is not showing.
      setHeld((current) =>
        current === undefined || isSameCompactionTarget(current.target, target)
          ? { target, state: settled }
          : current,
      );
    });
  }, [bridge, sessionId, targetRunId]);

  const addressed: CompactionTarget | undefined =
    targetRunId === undefined ? undefined : { bridge, sessionId, targetRunId };
  return { state: readingAtTarget(held, addressed), requestCompaction };
}

/**
 * One request, resolved into exactly one settled state.
 *
 * Returns rather than throws, and returns on every path — which is what makes the
 * "clears in every arm" guarantee structural instead of a promise the caller keeps.
 */
export async function settleCompaction(
  bridge: ConsoleBridge,
  sessionId: string,
  targetRunId: string,
): Promise<CompactionDispatchState> {
  try {
    const reply = await callDaemon(bridge, COMPACT_CONTEXT_METHOD, {
      sessionId,
      runId: targetRunId,
    });
    const parsed = DriverCompactionResultSchema.safeParse(reply);
    if (!parsed.success) {
      return {
        phase: "rejected",
        refusal: unreadableReply(),
      };
    }
    return { phase: "settled", result: parsed.data };
  } catch (rejection) {
    const wireError = normalizeWireRejection(rejection, { total: true });
    return {
      phase: "rejected",
      // `Error.name` carries the wire code when the rejection was a typed envelope
      // — that is what `normalizeWireRejection` puts there — so the refusal renders
      // `driver.capability_unsupported: …` rather than a class name nobody can
      // search for. The message is the daemon's own and is never reworded.
      refusal: refuse(COMPACTION_REFUSAL_ORIGIN, wireError.name, wireError.message),
    };
  }
}

function unreadableReply(): ConsoleRefusal {
  const code: CompactionRefusalCode = "reply-unreadable";
  return refuse(
    COMPACTION_REFUSAL_ORIGIN,
    code,
    "The compaction reply did not match the registered result shape, so the console did not read a settlement from it.",
  );
}
