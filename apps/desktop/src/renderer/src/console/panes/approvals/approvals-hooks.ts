// The four things that make the approvals surface re-read, and nothing else.
//
// `Spec-023 §Rules every console surface obeys`: "Reads happen on subscribe, on
// window focus, on reconnect, and on the terminal events the owning spec names".
// This module wires exactly those, through `ApprovalsReader`'s one scheduler.
// There is no interval, no `setTimeout`, and no second subscription.
//
// WHAT RECONNECT IS, HERE. The console has no wire-level connection state to read —
// what it has is the session store's own sticky degraded flag, which is raised for a
// stream that stopped and is cleared by nothing except a completed re-pull. So the
// moment this surface treats as a reconnect is that flag CLEARING: the stream was
// interrupted and a read has since re-established the session. It matters because
// the five lifecycle events are the only thing that tells this pane an approval was
// created or resolved, and events raised while the stream was down are events this
// pane never saw — leaving a resolved request rendered as pending, with an approve
// button under it, until an unrelated focus or a later event happened to arrive.
//
// HOW A LIFECYCLE SIGNAL REACHES A PANE WITHOUT THE PANE SUBSCRIBING TO THE BRIDGE.
// The console's rule is that exactly one thing subscribes to the wire — the apply
// chokepoint — and components subscribe to a STORE. Every admitted event lands in
// `SessionStoreState.timeline`, so the pane watches that: it reads an entry's
// wire-verbatim `kind` and its `sequence` and NOTHING else, which is precisely the
// never-decoded rule `approvals-wire.ts` states — the five events are opaque re-read
// triggers whose payloads are never decoded. No decision is ever taken from a
// signal; the answer always comes from the projection read.
//
// WHY THE SCAN IS INCREMENTAL. The timeline is append-only and ordered by sequence,
// and it grows for the life of the session. A cursor that re-scanned it on every
// event would cost O(n) per event, which is the shape of thing the endurance budget
// exists to catch — so the cursor walks backwards only as far as the events it has
// not already examined.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import {
  SessionRepairWatcher,
  consoleClockFor,
  type ConsoleBridge,
  type GrowthOutcome,
} from "../../bridge/index.js";
import { useSessionScopedState } from "../../seats/index.js";
import {
  useGenerationLatch,
  useSessionDegradedCause,
  useSessionStore,
  type ConsoleSessionEvent,
  type SessionStore,
  type SessionStoreState,
} from "../../store/index.js";
import { ApprovalsReader, type ApprovalsSnapshot } from "./approvals-reader.js";
import { APPROVAL_LIFECYCLE_EVENT_KINDS, APPROVAL_RULE_EVENT_KINDS } from "./approvals-wire.js";
import { clearSessionGoal, updateSessionGoal } from "./session-goal.js";
import { wireRejectionToError } from "../../../../../shared/wire-errors.js";

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
 * How far the signal watcher has read, what it last saw, and what it has asked for.
 *
 * A class with private fields rather than three refs, because the three numbers are
 * one invariant: `#latestSignalSequence` is only meaningful relative to how much of
 * the timeline `#examinedThroughSequence` has covered, and asking again for a signal
 * `#requestedThroughSequence` already covers is the re-read loop this cursor exists
 * to stop. A component that could move one without the others would re-read forever
 * or never — and, since all three are one session's history, they are constructed
 * and discarded with the reader they belong to rather than kept in refs that outlive
 * a rebind.
 */
class ApprovalSignalCursor {
  #examinedThroughSequence = -1;
  #latestSignalSequence = -1;
  #requestedThroughSequence = -1;

  /** Examine the newly appended tail and answer whether it owes a re-read. */
  public observe(timeline: readonly ConsoleSessionEvent[]): boolean {
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
    if (this.#latestSignalSequence <= this.#requestedThroughSequence) {
      return false;
    }
    this.#requestedThroughSequence = this.#latestSignalSequence;
    return true;
  }
}

function selectTimeline(state: SessionStoreState): readonly ConsoleSessionEvent[] {
  return state.timeline;
}

/**
 * Everything one session's reading apparatus is: the reader and the two memories
 * that are only meaningful about the session it reads.
 *
 * They are minted together because they DIE together. A repair watcher carrying the
 * previous session's standing-degraded flag, or a cursor carrying its high-water
 * mark, would suppress the new session's first re-read — so a rebind that replaced
 * only the reader would answer the new session out of the old one's history.
 */
interface ApprovalsReadingSession {
  readonly reader: ApprovalsReader;
  readonly repairWatcher: SessionRepairWatcher;
  readonly signalCursor: ApprovalSignalCursor;
}

/**
 * The reader for one session, plus its current snapshot.
 *
 * A READER IS BOUND TO THE SESSION IT READS. Its identity is `(bridge, sessionId)`,
 * so a pane rebound from one session to another builds a second reader rather than
 * keeping the first: the reader captures both at construction, and a retained one
 * would display the previous session's requests under the new session and resolve
 * or revoke them against the wrong session id.
 *
 * WHICH INSTANCE EACH PATH DISPOSES. React runs an effect's cleanup with the values
 * that effect closed over, so the cleanup below always disposes the reader that
 * effect's own body read on: a rebind disposes the OLD reader and reads on the new
 * one, and an unmount disposes exactly the live reader, exactly once. Nothing
 * disposes a reader twice, because the memo hands each effect pass a distinct one.
 * A reader built during a render React later discards is never disposed and does
 * not need to be — construction arms no timer and opens no subscription, so it is
 * plain garbage until an effect asks it to read.
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
  const { sessionId } = sessionStore;
  const readingSession = useMemo<ApprovalsReadingSession>(
    () => ({
      reader: new ApprovalsReader({ bridge, sessionId, clock: consoleClockFor(bridge) }),
      repairWatcher: new SessionRepairWatcher(),
      signalCursor: new ApprovalSignalCursor(),
    }),
    [bridge, sessionId],
  );
  const { reader } = readingSession;

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

  // The reconnect read. Subscribed to in the render body like the timeline, and
  // examined in an effect for the same reason: advancing the watcher is a mutation,
  // and a mutation in a render body runs twice under React's strict double-invoke.
  const degradedCause = useSessionDegradedCause(sessionStore);

  useEffect(() => {
    if (readingSession.repairWatcher.observe(degradedCause)) {
      readingSession.reader.requestRead("reconnect");
    }
  }, [readingSession, degradedCause]);

  // The timeline is subscribed to in the render body and EXAMINED in an effect.
  // Reading a store through its selector is what a render does; advancing a cursor
  // is a mutation, and a mutation in a render body runs twice under React's strict
  // double-invoke and once more on every discarded pass.
  const timeline = useSessionStore(sessionStore, selectTimeline);

  useEffect(() => {
    if (readingSession.signalCursor.observe(timeline)) {
      readingSession.reader.requestRead("terminal-event");
    }
  }, [readingSession, timeline]);

  const snapshot = useSyncExternalStore(
    (onStoreChange) => reader.subscribe(onStoreChange),
    () => reader.snapshot,
    () => reader.snapshot,
  );

  return { reader, snapshot };
}

/**
 * The one goal mutation a session may have in flight.
 *
 * THIS HOOK'S OWN RULE, because no committed document states it: a second mutation
 * is never queued behind the first. The guard is the console's one `GenerationLatch`
 * rather than the disabled attribute, because a disabled button is a rendering and
 * this is a rule about the wire — a keyboard-driven double submit lands between
 * renders and would otherwise send two.
 *
 * EVERYTHING THIS HOOK HOLDS BELONGS TO A SUBJECT. The state, the refusal, and the
 * latch are all about the `(bridge, sessionId)` the mutation was issued under, and
 * the component outlives a change of that pair — so a rebind used to leave the new
 * session's controls blocked by the old session's request and its rejection rendered
 * beside the new session's goal. The two readings ride `useSessionScopedState`, which
 * resets them during the render that first sees a new subject and drops a settlement
 * whose captured subject is no longer current; the act rides one `GenerationLatch`
 * claim under the same pair, so this session's slot is the only one a settlement of
 * this session's call can release. Nothing here is a timer or a counter: a late
 * answer is discarded because of WHOSE it is, not because of when it arrived.
 *
 * THE CLAIM ALSO REPLACES THE MOUNTED FLAG. `claim.settle` runs its body only while
 * the claim is still the live round, and the hook's latch is superseded when the
 * mount goes away, so an unmounted settlement publishes nothing without this hook
 * tracking mount-ness itself — one rule, in the module that owns it.
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
  const { value: isMutating, publish: publishIsMutating } = useSessionScopedState(
    bridge,
    sessionId,
    () => false,
  );
  const { value: refusal, publish: publishRefusal } = useSessionScopedState<
    ConsoleRefusal | undefined
  >(bridge, sessionId, () => undefined);
  const latch = useGenerationLatch();

  const perform = useCallback(
    (mutate: () => Promise<GrowthOutcome<undefined>>) => {
      const claim = latch.claim(bridge, sessionId);
      if (claim === undefined) {
        publishRefusal(
          refuse(
            SESSION_GOAL_REFUSAL_ORIGIN,
            "goal_mutation_in_flight",
            "A goal change is still settling. Wait for it to land, then try again — a second change is not queued behind the first.",
          ),
        );
        return;
      }
      publishIsMutating(true);
      publishRefusal(undefined);
      // The port never rejects, so there is one settlement and no `catch`: a
      // refusal is a VALUE, and it is published as it arrived — its origin still
      // names the operation that refused and the document that owes its wire.
      void mutate().then((outcome) => {
        claim.settle(() => {
          if (outcome.status === "unavailable") {
            publishRefusal(outcome);
          }
          publishIsMutating(false);
        });
        // Released through the claim the call was ISSUED under, so a settlement
        // that arrives after a rebind frees its own round and never the one the
        // pane is now addressed to.
        claim.release();
      });
    },
    [bridge, latch, publishIsMutating, publishRefusal, sessionId],
  );

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
