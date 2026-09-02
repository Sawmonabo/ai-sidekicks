// The three things that make the approvals surface re-read, and nothing else.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules: "Reads happen on
// subscribe, on window focus, on reconnect, and on the terminal events the owning
// spec names". This module wires exactly those, through `ApprovalsReader`'s one
// scheduler. There is no interval, no `setTimeout`, and no second subscription.
//
// HOW A LIFECYCLE SIGNAL REACHES A PANE WITHOUT THE PANE SUBSCRIBING TO THE BRIDGE.
// The console's rule is that exactly one thing subscribes to the wire — the apply
// chokepoint — and components subscribe to a STORE. Every admitted event lands in
// `SessionStoreState.timeline`, so the pane watches that: it reads an entry's
// wire-verbatim `kind` and its `sequence` and NOTHING else, which is precisely what
// §7.6's leverage note asks for — the five events are opaque re-read triggers whose
// payloads are never decoded. No decision is ever taken from a signal; the answer
// always comes from the projection read.
//
// WHY THE SCAN IS INCREMENTAL. The timeline is append-only and ordered by sequence,
// and it grows for the life of the session. A cursor that re-scanned it on every
// event would cost O(n) per event, which is the shape of thing the endurance budget
// exists to catch — so the cursor walks backwards only as far as the events it has
// not already examined.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { RealClock, refuse, type ConsoleClock, type ConsoleRefusal } from "../../core/index.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import {
  useSessionStore,
  type ConsoleSessionEvent,
  type SessionStore,
  type SessionStoreState,
} from "../../store/index.js";
import { ApprovalsReader, type ApprovalsSnapshot } from "./approvals-reader.js";
import { APPROVAL_LIFECYCLE_EVENT_KINDS, APPROVAL_RULE_EVENT_KINDS } from "./approvals-wire.js";
import { clearSessionGoal, updateSessionGoal } from "./session-goal.js";
import { normalizeWireRejection } from "../../../../../shared/wire-errors.js";

/** The subsystem name every goal-mutation refusal this module raises carries. */
export const SESSION_GOAL_REFUSAL_ORIGIN = "session-goal";

/**
 * The kinds that trigger a re-read, as a lookup rather than two `includes` scans.
 *
 * Both families are here because both reads refresh together: a remembered rule is
 * minted by resolving an approval, so a grant moment and a decision moment are the
 * same participant action seen from two sides.
 */
const TRIGGERING_EVENT_KINDS: ReadonlySet<string> = new Set<string>([
  ...APPROVAL_LIFECYCLE_EVENT_KINDS,
  ...APPROVAL_RULE_EVENT_KINDS,
]);

/**
 * How far the signal watcher has read, and what it last saw.
 *
 * A class with private fields rather than two refs, because the two numbers are one
 * invariant: `#latestSignalSequence` is only meaningful relative to how much of the
 * timeline `#examinedThroughSequence` has covered, and a component that could move
 * one without the other would re-read forever or never.
 */
class ApprovalSignalCursor {
  #examinedThroughSequence = -1;
  #latestSignalSequence = -1;

  /** Examine the newly appended tail and answer the newest signal seen so far. */
  public observe(timeline: readonly ConsoleSessionEvent[]): number {
    for (let position = timeline.length - 1; position >= 0; position -= 1) {
      const entry = timeline[position];
      if (entry === undefined || entry.sequence <= this.#examinedThroughSequence) {
        break;
      }
      if (TRIGGERING_EVENT_KINDS.has(entry.kind) && entry.sequence > this.#latestSignalSequence) {
        this.#latestSignalSequence = entry.sequence;
      }
    }
    const newest = timeline.at(-1);
    if (newest !== undefined) {
      this.#examinedThroughSequence = Math.max(this.#examinedThroughSequence, newest.sequence);
    }
    return this.#latestSignalSequence;
  }
}

function selectTimeline(state: SessionStoreState): readonly ConsoleSessionEvent[] {
  return state.timeline;
}

/**
 * The reader for one session, plus its current snapshot.
 *
 * The clock is the fixture's frozen one wherever a scenario is playing and the real
 * one otherwise, resolved once per reader rather than per render — §The fixture
 * bridge makes the frozen clock the only clock the renderer reads in fixture mode,
 * and a surface that reached for `RealClock` unconditionally would be the one place
 * a fixture frame drifted.
 */
export function useApprovalsReader(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): { readonly reader: ApprovalsReader; readonly snapshot: ApprovalsSnapshot } {
  const [reader] = useState(
    () =>
      new ApprovalsReader({
        bridge,
        sessionId: sessionStore.sessionId,
        clock: resolveClock(bridge),
      }),
  );

  useEffect(() => {
    reader.requestRead("subscribe");
    return () => {
      reader.dispose();
    };
  }, [reader]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const onFocus = (): void => {
      reader.requestRead("window-focus");
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [reader]);

  // The timeline is subscribed to in the render body and EXAMINED in an effect.
  // Reading a store through its selector is what a render does; advancing a cursor
  // is a mutation, and a mutation in a render body runs twice under React's strict
  // double-invoke and once more on every discarded pass.
  const timeline = useSessionStore(sessionStore, selectTimeline);
  const cursorRef = useRef<ApprovalSignalCursor>(undefined);
  const requestedThroughRef = useRef(-1);

  useEffect(() => {
    cursorRef.current ??= new ApprovalSignalCursor();
    const latestSignalSequence = cursorRef.current.observe(timeline);
    if (latestSignalSequence <= requestedThroughRef.current) {
      return;
    }
    requestedThroughRef.current = latestSignalSequence;
    reader.requestRead("terminal-event");
  }, [reader, timeline]);

  const snapshot = useSyncExternalStore(
    (onStoreChange) => reader.subscribe(onStoreChange),
    () => reader.snapshot,
    () => reader.snapshot,
  );

  return { reader, snapshot };
}

function resolveClock(bridge: ConsoleBridge): ConsoleClock {
  return bridge.scenarioEngine?.clock ?? new RealClock();
}

/**
 * The one goal mutation a session may have in flight.
 *
 * §7.11: a second mutation is never queued behind the first. The guard is the
 * ref below rather than the disabled attribute, because a disabled button is a
 * rendering and this is a rule about the wire — a keyboard-driven double submit
 * lands between renders and would otherwise send two.
 */
export function useSessionGoalMutation(
  bridge: ConsoleBridge,
  sessionId: string,
): {
  readonly isMutating: boolean;
  readonly refusal: ConsoleRefusal | undefined;
  readonly update: (text: string) => void;
  readonly clear: () => void;
} {
  const [isMutating, setIsMutating] = useState(false);
  const [refusal, setRefusal] = useState<ConsoleRefusal | undefined>(undefined);
  const inFlightRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const perform = useCallback((mutate: () => Promise<void>) => {
    if (inFlightRef.current) {
      setRefusal(
        refuse(
          SESSION_GOAL_REFUSAL_ORIGIN,
          "goal_mutation_in_flight",
          "A goal change is still settling. Wait for it to land, then try again — a second change is not queued behind the first.",
        ),
      );
      return;
    }
    inFlightRef.current = true;
    setIsMutating(true);
    setRefusal(undefined);
    void mutate()
      .catch((rejection: unknown) => {
        if (!isMountedRef.current) {
          return;
        }
        const wireError = normalizeWireRejection(rejection, { total: true });
        setRefusal(refuse(SESSION_GOAL_REFUSAL_ORIGIN, wireError.name, wireError.message));
      })
      .finally(() => {
        inFlightRef.current = false;
        if (isMountedRef.current) {
          setIsMutating(false);
        }
      });
  }, []);

  const update = useCallback(
    (text: string) => {
      perform(() => updateSessionGoal(bridge, sessionId, text));
    },
    [bridge, perform, sessionId],
  );

  const clear = useCallback(() => {
    perform(() => clearSessionGoal(bridge, sessionId));
  }, [bridge, perform, sessionId]);

  return { isMutating, refusal, update, clear };
}
