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
// AND THE LATCH BELONGS TO A GENERATION, not to the hook. The set of in-flight runs
// used to be one object cleared in place when the bridge or the session changed —
// and clearing it in place is not the same as replacing it, because the call already
// travelling still holds a reference to it. Its settlement then ran an unconditional
// `delete(runId)` against the object the NEW subject was latching on, releasing a
// call that was still in flight and letting a second press dispatch a duplicate
// compaction. So each subject owns its own set: a settlement releases the generation
// it was issued under, and releasing an abandoned one changes nothing. The rotation
// happens where the latch is taken rather than in an effect, so a press that arrives
// before an effect could run is still measured against its own subject.
//
// WHAT IS NEVER TREATED AS A COMPACTION. The reply is evidence the REQUEST settled,
// never evidence the context was compacted — both provider mechanisms answer before
// the work is done, and the completed state is the `usage.context_compacted` row
// alone. This module produces no such row and reads none; it reports what the call
// answered and stops there.

import { useCallback } from "react";
import { RunIdSchema, SessionIdSchema, type DriverCompactionResult } from "@ai-sidekicks/contracts";
import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";
import { callDaemon, type ConsoleBridge } from "../../../console/bridge/index.js";
import { useGenerationLatch, useSubjectScopedState } from "../../../console/store/index.js";

/** The subsystem name every refusal this module raises carries. */
export const COMPACTION_REFUSAL_ORIGIN = "composer-compaction";

/**
 * Why the console refused a compaction on its own side.
 *
 * One code, and a closed set so a second is a decision rather than a free string.
 * The unreadable REPLY is deliberately not among them: the call door owns that
 * vocabulary for the whole console, and a second spelling here would be a second
 * name for one failure. What is left is the question the door cannot answer — the
 * composer is addressed at identifiers the registered request would not accept, so
 * nothing was asked.
 */
export const COMPACTION_REFUSAL_CODES = ["addressed-run-unparseable"] as const;

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

/**
 * The latch key one compaction round is claimed under.
 *
 * The run WITHIN the session rather than the run alone: the holder's subject is the
 * bridge and its key is the session, and a latch keyed on the run alone would let one
 * session's outstanding call refuse the same run id in another.
 */
function compactionLatchKey(sessionId: string, targetRunId: string): string {
  return `${sessionId}:${targetRunId}`;
}
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
 * BOTH HALVES COME FROM THE CONSOLE'S SUBJECT PRIMITIVES. The reading is held under
 * `(bridge, sessionId)` and carries the run it is about on the value, so a settlement
 * that lands after the composer moved is dropped by the holder rather than attributed
 * to a run the control is not showing. The single-flight rule is one `GenerationLatch`
 * claim per `(bridge, "<session>:<run>")`, which is readable and writable in the click
 * handler's own tick — a rendered flag read there is the one from the render that
 * produced the handler, so two clicks inside one frame would both see `idle` and both
 * dispatch. The unmount path is the latch's own teardown and the holder's own drop;
 * neither is a flag this hook keeps.
 */
export function useCompactionDispatch(
  bridge: ConsoleBridge,
  sessionId: string,
  targetRunId: string | undefined,
): CompactionDispatch {
  const { value: held, publish: publishHeld } = useSubjectScopedState<
    HeldCompactionReading | undefined
  >(bridge, sessionId, () => undefined);
  const latch = useGenerationLatch();

  const requestCompaction = useCallback(() => {
    if (targetRunId === undefined) {
      return;
    }
    const claim = latch.claim(bridge, compactionLatchKey(sessionId, targetRunId));
    if (claim === undefined) {
      // A second press on the run already compacting: the no-op the single-flight
      // rule asks for. A press on a run this composer has since moved to is a first
      // press on a different key and dispatches.
      return;
    }
    const target: CompactionTarget = { bridge, sessionId, targetRunId };
    publishHeld({ target, state: DISPATCHING });
    void settleCompaction(bridge, sessionId, targetRunId).then((settled) => {
      claim.settle(() => {
        // The slot belongs to the newest act. A settlement arriving after a
        // compaction was begun on ANOTHER run would otherwise replace that run's
        // in-flight reading with a result about a run the control is not showing.
        publishHeld((current) =>
          current === undefined || isSameCompactionTarget(current.target, target)
            ? { target, state: settled }
            : current,
        );
      });
      claim.release();
    });
  }, [bridge, latch, publishHeld, sessionId, targetRunId]);

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
  const parsedSessionId = SessionIdSchema.safeParse(sessionId);
  const parsedRunId = RunIdSchema.safeParse(targetRunId);
  if (!parsedSessionId.success || !parsedRunId.success) {
    return { phase: "rejected", refusal: unparseableAddress() };
  }
  const reply = await callDaemon(bridge, "driver.compactContext", {
    sessionId: parsedSessionId.data,
    runId: parsedRunId.data,
  });
  // A refusal renders under its own code — `driver.capability_unsupported`,
  // `session.not_found`, or the door's own `reply-unreadable` — and its own
  // sentence. Nothing here rewords one, and nothing maps one onto a result reason,
  // which would name a settlement the daemon reached and this call never did.
  return reply.status === "refused"
    ? { phase: "rejected", refusal: reply.refusal }
    : { phase: "settled", result: reply.value };
}

/** The refusal for a composer addressed at identifiers the wire would not accept. */
function unparseableAddress(): ConsoleRefusal {
  const code: CompactionRefusalCode = "addressed-run-unparseable";
  return refuse(
    COMPACTION_REFUSAL_ORIGIN,
    code,
    "The console is holding identifiers for this run that the daemon would not accept, so it requested no compaction. Reopen the session so its identifiers are read again.",
  );
}
