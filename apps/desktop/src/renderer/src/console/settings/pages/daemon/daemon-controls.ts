// The local-runtime page's reads and its two controls.
//
// SPLIT FROM THE PAGE for the reason its neighbours are: what is here owns
// lifetimes — a read that must not be answered by a stale reply, and two dispatches
// whose refusal has to reach the surface — and the page owns markup. The two fail
// differently and are read by different people.
//
// THE SUPERVISOR STATE IS NOT READ HERE. It arrives on the page's own context, from
// the one subscription the frame keeps live for the window. A page that re-read it
// would be a second answer to "is the runtime up", free to disagree with the chip in
// the corner of the same window.
//
// WHAT IS READ HERE is the one fact the subscription does not carry: the daemon's own
// reported status line and the version it is running. That read is not registered on
// any bridge namespace, so it goes through the growth port and refuses by name where
// the build does not carry it.
//
// AND IT IS A READING RATHER THAN A FACT, so it goes stale and something has to say
// when. Read once per port, it survived every event that could change it: a stop this
// page itself dispatched, and the supervisor going down under the window — so the page
// showed a stopped runtime beside the daemon's own `connected` for the rest of the
// visit, two answers to one question disagreeing on one screen. What makes it stale is
// declared here rather than at the call site, because which moments change an answer
// is a property of the QUESTION; the read is re-put by RE-ADDRESSING it, which the
// subject holder already knows how to do — the answer re-seeds to `reading` for the
// new subject, and a reply to the old one is dropped rather than overwriting a newer
// one. Nothing here polls, and nothing here arms a timer: the two triggers are a
// settlement this hook's sibling produced and a transition the shell pushed.
//
// AND EVERY CALL ON THIS PAGE SETTLES THROUGH `settleGrowthRead`, none of them through
// a bare `await`. The growth port is TYPED to resolve — its two arms are the answer
// and the refusal — and the rejection channel of a promise exists whether a contract
// uses it or not: a transport that goes away mid-call rejects, and the seam the
// fixture drives throws a daemon envelope verbatim. Read only on the fulfilment arm,
// that rejection left the status region rendering "Asking the runtime" for the rest of
// the visit, and left a control's dispatch latch HELD — both confirmation actions
// disabled for the life of the window over a call that had already failed — with the
// rejection itself reaching no surface at all. The settler is the console's one
// reading of that channel and it answers a refusal, so both failures render as the
// refusal they are.

import { useCallback, useMemo, useState } from "react";

import { settleGrowthRead, useSettledGrowthRead, type GrowthPort } from "../../../bridge/index.js";
import type { ConsoleRefusal } from "../../../core/index.js";
import { useGenerationLatch, type ShellConnection } from "../../../store/index.js";

/** What the daemon says about itself, once it has been asked. */
export interface DaemonStatus {
  readonly state: string;
  readonly version: string;
}

/** The read's three phases. `reading` is the seed; the other two are settlements. */
export type DaemonStatusReading =
  | { readonly phase: "reading" }
  | { readonly phase: "read"; readonly status: DaemonStatus }
  | { readonly phase: "refused"; readonly refusal: ConsoleRefusal };

/**
 * What makes the daemon's own answer stale.
 *
 * TWO MEMBERS, AND EACH IS A THING THAT HAPPENED rather than a clock. A control this
 * page dispatched is the one change the page itself caused; a supervisor transition is
 * every change it did not — the runtime going down, coming back, or failing its
 * handshake all arrive on the shell feed the frame already keeps live, so this hook
 * subscribes to nothing of its own and observes the reading the window is already
 * holding.
 */
export interface DaemonStatusFreshness {
  /** What the supervisor is reporting about the runtime right now. */
  readonly connection: ShellConnection;
  /** How many of this page's controls have settled. `DaemonControlDispatch`'s own. */
  readonly settledControlCount: number;
}

/** The holder key the status answer is addressed by, within one growth port. */
const DAEMON_STATUS_KEY = "daemon-status";

/**
 * The subject one status answer belongs to.
 *
 * THE CONNECTION'S KIND AND NEVER THE WHOLE CONNECTION. `reconnecting` carries an
 * attempt number that advances on every retry of the supervisor's ladder, and a
 * heartbeat timestamp moves on the healthy path — so keying on either would put a read
 * on the wire per attempt and per beat, which is the interval poll
 * `Spec-023 §Console Design (Meridian)` forbids arriving by the back door. What the
 * kind changing means is that the runtime is somewhere else than it was, which is
 * exactly when its own status line is worth asking for again.
 */
function daemonStatusSubject(freshness: DaemonStatusFreshness): string {
  return `${DAEMON_STATUS_KEY}:${freshness.connection.kind}:${freshness.settledControlCount}`;
}

/**
 * Read the daemon's own status line, and read it again when it can have changed.
 *
 * `useSettledGrowthRead` rather than a holder with a hand-written effect beside it,
 * because this read WAS that block token for token — state held against the port and
 * the subject, seeded to the unsettled phase, the call put inside an effect keyed on
 * the publisher, the answer projected — and the one token it did not carry is the arm
 * the shared reader exists for: a rejection settles into a refusal instead of leaving
 * the region on `reading` for the life of the window.
 *
 * The answer stays scoped to the port that produced it, which is the holder that
 * reader already keeps: a window whose bridge is swapped — which the fixture does on
 * a scenario change — must not keep rendering the previous port's answer, and a reply
 * arriving after a swap is dropped rather than overwriting a newer one.
 *
 * The freshness rides the KEY, and that is the whole re-read mechanism: the holder
 * re-seeds during the render that first sees a new subject and the read is put again.
 * A flag beside the state would have been a second record of which answer is current,
 * free to disagree with the one the holder keeps.
 */
export function useDaemonStatus(
  growth: GrowthPort,
  freshness: DaemonStatusFreshness,
): DaemonStatusReading {
  return useSettledGrowthRead<
    Awaited<ReturnType<GrowthPort["daemonStatusRead"]>>,
    DaemonStatusReading
  >(growth, daemonStatusSubject(freshness), () => growth.daemonStatusRead({}), {
    unsettled: () => ({ phase: "reading" }),
    settled: (settlement) =>
      settlement.status === "served"
        ? { phase: "read", status: settlement.value }
        : { phase: "refused", refusal: settlement },
  }).value;
}

/** Which of the two controls was pressed. Closed, because the page offers two. */
export type DaemonControl = "stop" | "restart";

/** What a dispatched control settled as, or `undefined` while none has been. */
export type DaemonControlSettlement =
  | { readonly control: DaemonControl; readonly outcome: "sent" }
  | {
      readonly control: DaemonControl;
      readonly outcome: "refused";
      readonly refusal: ConsoleRefusal;
    };

/**
 * The single-flight key the two controls SHARE, within one growth port.
 *
 * One key and not one per control, because the rule is one destructive act at a time
 * against this machine's runtime rather than one of each: a stop dispatched while a
 * restart is outstanding is two conflicting orders nobody confirmed together.
 */
const DAEMON_CONTROL_KEY = "daemon-control";

/** One control in flight, and the way to put one. */
export interface DaemonControlDispatch {
  /** Which control is outstanding, or `undefined` while none is. */
  readonly inFlight: DaemonControl | undefined;
  /**
   * How many dispatches have settled on this visit.
   *
   * A COUNT AND NOT THE SETTLEMENT ITSELF, because what the status read needs is the
   * EDGE: two stops in a row settle to the same `{ control, outcome }` and are two
   * reasons to ask the runtime again. The settlement a surface renders travels through
   * `onSettled`, where it already did; this is the fact nothing else records.
   */
  readonly settledCount: number;
  /** Put one control. A press arriving while one is outstanding puts nothing. */
  readonly put: (control: DaemonControl) => void;
}

/**
 * Dispatch one control and report what came back.
 *
 * `sent` AND NOT `done`, deliberately. Neither operation reports the state it
 * produced — a stop that was accepted is not a runtime that has stopped — and the
 * supervisor's next report is what says so. The settlement here says only that the
 * console asked and was not refused, which is the whole of what the call answers.
 *
 * SINGLE FLIGHT IS DECIDED IN THE TICK AND RENDERED AFTERWARDS, and it takes both
 * halves. The rendered `inFlight` is what disables the confirmation, but a second
 * press landing in the same frame reads the flag from the render that produced its
 * handler and finds the surface idle — so the key is what actually refuses it, taken
 * synchronously before the call goes out. `store/generation-latch.ts` owns that
 * register for the console; a boolean here would be the copy that drifts.
 *
 * The latch is mount-scoped and superseded by its own unmount, so a reply arriving
 * after the page is gone installs nothing rather than reporting a settlement into a
 * tree that no longer exists.
 *
 * AND THE CALL IS AWAITED INSIDE THE CLEANUP THAT RELEASES IT. The release is what
 * lets the next press through, so the one thing it must survive is the call failing:
 * awaited outside, a rejection left the key held and both confirmation actions
 * disabled for the rest of the window — a destructive control that quietly stopped
 * working, with the reason nowhere on screen. Inside, the settler answers a refusal
 * on that arm, the refusal renders through `onSettled` like any the port served, and
 * the `finally` gives the key back whichever way the settlement went.
 */
export function useDaemonControl(
  growth: GrowthPort,
  onSettled: (settlement: DaemonControlSettlement) => void,
): DaemonControlDispatch {
  const dispatchLatch = useGenerationLatch();
  const [inFlight, setInFlight] = useState<DaemonControl | undefined>(undefined);
  const [settledCount, setSettledCount] = useState(0);
  const put = useCallback(
    (control: DaemonControl) => {
      const dispatch = dispatchLatch.claim(growth, DAEMON_CONTROL_KEY);
      if (dispatch === undefined) {
        return;
      }
      setInFlight(control);
      void (async () => {
        try {
          const settlement = await settleGrowthRead(
            control === "stop" ? growth.daemonStop({}) : growth.daemonRestart({}),
          );
          dispatch.settle(() => {
            setInFlight(undefined);
            // Counted inside the latch's own settle, so a reply that arrives after the
            // page is gone advances nothing — the same rule that keeps it from
            // reporting a settlement into a tree that no longer exists.
            setSettledCount((previous) => previous + 1);
            onSettled(
              settlement.status === "served"
                ? { control, outcome: "sent" }
                : { control, outcome: "refused", refusal: settlement },
            );
          });
        } finally {
          dispatch.release();
        }
      })();
    },
    [dispatchLatch, growth, onSettled],
  );
  return useMemo(() => ({ inFlight, settledCount, put }), [inFlight, settledCount, put]);
}
