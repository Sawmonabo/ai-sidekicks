// The runs pane's live spine: `run.subscribeState`, folded into one row per run.
//
// The stream has two arms — the registered request's response is
// `RunStateChangeEvent | RunRolledBackEvent` and nothing else — and this module
// keeps them apart structurally rather than by convention:
//
//   • `RunStateChangeEvent` — a transition, carrying both states, the advanced
//     `runVersion`, and the stop-condition provenance. Folded into the run's
//     current reading and appended to its status history.
//   • `RunRolledBackEvent` — deliberately NOT a transition. It carries no
//     `previousState` and no `currentState`, because a rollback is not one, and
//     THIS MODULE'S OWN RULE, because no committed document states it, is that a
//     transition is never fabricated for one. So the fold appends a status row
//     carrying NEITHER STATE, advances the run's version and its rewind position,
//     and reads the run as `paused` — which is where the rollback contract lands a
//     confirmed rewind, for every run and not only for one this pane has not seen.
//
// The two arms share one stream with no wire tag and stay unambiguous structurally:
// both registered schemas are `.strict()`, so a state change fails the rollback
// parse for want of `sessionId` / `targetPosition` and a rollback fails the state
// parse for want of `previousState` / `currentState` / `timestamp`. That is why the
// reader below tries both and refuses anything that parses as neither, rather than
// sniffing a member and guessing.
//
// WHY THIS SUBSCRIPTION DOES NOT GO THROUGH THE APPLY CHOKEPOINT. The console's
// rule is that exactly one thing subscribes to the SESSION EVENT stream — the
// chokepoint in front of `SessionStore.applyBatch` — and it holds because every
// session event projects into an entity partition. `run.subscribeState` streams a
// wire PROJECTION rather than session events: `RunStateChangeEvent` carries no
// `sequence` and no `sessionId`, so it can be neither deduped nor gap-checked by
// the store's own keys. Routing it through the chokepoint would mean inventing an
// envelope the wire does not send. The composer's queue feed took this same split
// for the same reason.
//
// NOTHING HERE POLLS. One subscription per mounted pane, closed on unmount, and no
// timer of any kind: elapsed is measured between two instants the WIRE supplied, so
// the pane never needs to know what time it is now.

import { useEffect, useMemo, useState } from "react";
import {
  RUN_STATE_SUBSCRIBE_STREAM,
  consoleClockFor,
  readSessionId,
  subscribeDaemon,
  type ConsoleBridge,
} from "../../bridge/index.js";
import { useSessionScopedState } from "../../seats/index.js";
import {
  normalizeWireRejection,
  refuse,
  type ConsoleClock,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../../core/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  useSessionInitialised,
  useSessionReadTriggers,
  type ReadTriggerTarget,
  type RefreshReason,
  type SessionStore,
} from "../../store/index.js";
import { RunStateProjection, type RunProjection } from "./run-state-projection.js";

/** The subsystem name every refusal this module raises carries. */
export const RUN_STATE_REFUSAL_ORIGIN = "runs-state";

/** What the pane reads off the state stream. */
export interface RunStateFeed {
  /** Runs, most recently touched first — the reading a live pane exists to give. */
  readonly runs: readonly RunProjection[];
  /**
   * Whether the read that says WHICH RUNS EXIST has completed.
   *
   * Deliberately not "the stream delivered something". `run.subscribeState` is a
   * live tail: it carries transitions, and a session with no runs produces no
   * transition, so a feed that flipped this on its first delivery could never
   * answer `true` with an empty list — the pane's empty state would be
   * unreachable and a session that has never run anything would read "Reading the
   * runs" forever. The wire registers no replay-complete marker on this stream
   * either (`api-payload-contracts.md §Plan-004`'s registry lists the stream's
   * response as `RunStateChangeEvent | RunRolledBackEvent` and nothing else), so
   * the completion signal is the SESSION STORE's: its snapshot read is what
   * establishes the session's base state, the run partition inside it is the
   * source of truth for which runs exist, and this stream is the tail that keeps
   * them current.
   */
  readonly hasRead: boolean;
  /**
   * Deliveries that parsed as neither arm. Counted, never guessed at, and RENDERED:
   * a live feed that is also partial is neither an absence nor a refusal, and the
   * pane says so beside the rows rather than in place of them.
   */
  readonly unreadableDeliveryCount: number;
  /** Why the stream could not be opened at all. Rendered rather than swallowed. */
  readonly openRefusal: ConsoleRefusal | undefined;
}

/**
 * Open the run-state subscription for one session.
 *
 * The projection instance lives inside the subscribing effect, which is the only
 * thing that folds into it — a re-render does not restart the fold because it does
 * not re-run the effect, and a mount-lifetime cell holding it beside the effect was a
 * second, longer-lived reference to the same object that nothing read. The rendered
 * snapshot is state so a delivery re-renders. Deliveries after unmount are dropped
 * rather than written into a torn-down component, which is the same close-race
 * posture the session binder takes one layer down.
 *
 * THE FEED IS STAMPED WITH ITS SUBJECT, so a pane rebound from one session to
 * another never renders the previous session's runs. Clearing the feed in the
 * effect would leave the previous projections on screen for the render that first
 * commits the new session — and the pane seats every projected run, so those rows
 * and their run-addressed controls would be live under a session they do not belong
 * to. The stamped holder answers with the empty feed on that pass instead, which is
 * synchronous rather than one commit late.
 *
 * TAKES THE STORE AND NOT A BARE SESSION ID, because two different reads answer two
 * different questions here. This stream answers "what has happened to the runs";
 * the store's snapshot answers "has the read that says which runs exist landed", and
 * only the second can ever say "there are none" — see `RunStateFeed.hasRead`.
 */
// NAMED FOR THE FEED AND NOT FOR THE STATE IT CARRIES. `use<Subject>...State...` is
// the shape the console reserves for a subject-scoped holder, and this is not one: it
// opens a subscription and folds deliveries into a reading held by the one holder the
// store publishes.
export function useRunFeed(bridge: ConsoleBridge, sessionStore: SessionStore): RunStateFeed {
  const sessionId = sessionStore.sessionId;
  const hasReadSnapshot = useSessionInitialised(sessionStore);
  const { value: feed, publish: setFeed } = useSessionScopedState<RunStateFeed>(
    bridge,
    sessionId,
    () => EMPTY_FEED,
  );

  // THE FOLD OUTLIVES THE SUBSCRIPTION AND DIES WITH THE SUBJECT. A re-open is the
  // same session's stream coming back, so the rows it already established are still
  // this session's rows — minting a fold per subscription would blank the pane on
  // every reconnect and leave it blank for as long as the daemon took to re-deliver
  // them. A rebind mints a new one, because then they are somebody else's rows.
  const fold = useMemo(() => new RunStateProjection(), [bridge, sessionId]);
  const [reopenGeneration, setReopenGeneration] = useState(0);
  const reopen = useMemo(
    () =>
      new RunStreamReopen(consoleClockFor(bridge), () => {
        setReopenGeneration((generation) => generation + 1);
      }),
    [bridge, sessionId],
  );
  useEffect(() => () => reopen.dispose(), [reopen]);
  // THE SESSION HALF ALONE. A stream-only reading has no snapshot to re-take, so its
  // only re-read is a re-open — and re-opening because a surface mounted or the
  // window regained focus would tear down a live tail that had missed nothing. What
  // it does owe a re-open is a repair: the stream that went away is the one this
  // hook is holding, and nothing else in the console will notice it came back.
  useSessionReadTriggers(reopen, sessionStore);

  useEffect(() => {
    let isMounted = true;

    // The stream's own scope, read through the bridge family's identifier reader
    // rather than assembled at the wrapper: an id the wire's `SessionId` brand
    // refuses is a refusal this surface renders, not an unscoped subscription it
    // opens anyway.
    const scopedSessionId = readSessionId(sessionId);
    if (scopedSessionId === undefined) {
      setFeed({
        ...EMPTY_FEED,
        openRefusal: refuse(
          RUN_STATE_REFUSAL_ORIGIN,
          "session-unreadable",
          "The run-state stream is session-scoped and this pane's session did not match the registered request shape, so the console did not open it.",
        ),
      });
      return () => {
        isMounted = false;
      };
    }

    // The open itself can fail in this frame — the shipped live preload throws on
    // every method — and an unopenable stream is a refusal this feed already has a
    // field for, not an exception thrown during React's effect commit.
    let unsubscribe: Unsubscribe;
    try {
      unsubscribe = subscribeDaemon(
        bridge,
        { method: RUN_STATE_SUBSCRIBE_STREAM, request: { sessionId: scopedSessionId } },
        (payload) => {
          // EVERY delivery publishes, readable or not. An unreadable one raises the
          // fold's counter, and a counter that never reached a render could not be
          // shown at all — leaving an old reading presented as current with nothing
          // on screen saying the stream is incomplete. `runs` is rebuilt from the
          // same fold either way, so an unreadable delivery changes no row.
          fold.accept(payload);
          if (!isMounted) {
            return;
          }
          setFeed({
            runs: fold.runs(),
            // Kept `false` here and supplied below from the store: a delivery proves
            // a run exists, not that the read which enumerates them has completed.
            hasRead: false,
            unreadableDeliveryCount: fold.unreadableDeliveryCount,
            openRefusal: undefined,
          });
        },
      );
    } catch (thrown: unknown) {
      // The console's one reading of a rejected promise, consumed and not copied.
      // What used to stand here unwrapped a carried refusal through a bare cast and
      // otherwise built a refusal out of an `Error`'s NAME — so a daemon that
      // refused with `session.not_found` rendered as `Error`, and a rejection whose
      // own property access throws took the read down. No fallback pair is passed:
      // a stream that would not open is diagnosed by what the transport said, and a
      // sentence of this file's own would displace it.
      setFeed({
        ...EMPTY_FEED,
        openRefusal: normalizeWireRejection(RUN_STATE_REFUSAL_ORIGIN, thrown),
      });
      // No unsubscribe was ever handed back, so the refused path has nothing to
      // close — it only stops deliveries that can no longer arrive from landing.
      return () => {
        isMounted = false;
      };
    }
    return () => {
      isMounted = false;
      unsubscribe();
    };
    // `setFeed` AND NOT JUST THE PAIR. The publisher's identity changes exactly when
    // the ADDRESSING does, which is strictly finer than `(bridge, sessionId)` and is
    // the correct fact here: a pane rendered at one session, rendered at a second in a
    // pass React discarded, and re-rendered at the first commits a publisher from a
    // later addressing than the one this effect captured. The pair is unchanged across
    // those two commits, so an effect keyed on it alone keeps a publisher the holder
    // now refuses — the subscription stays open, every delivery folds, and the pane
    // renders the empty feed for the life of the mount with nothing saying why. It is
    // stable across every render that did not re-address, so this costs no extra
    // subscribe and re-opens the stream exactly when the addressing moves.
    //
    // `fold` and `reopenGeneration` join it for the two other reasons this effect
    // must run again: the fold is the subject's, so a new one means a new subject,
    // and the generation is the repair trigger's one output — bumping it is how a
    // reconnect closes the dead stream and opens a live one over the rows already
    // folded.
  }, [bridge, fold, reopenGeneration, sessionId, setFeed]);

  return useMemo(() => ({ ...feed, hasRead: hasReadSnapshot }), [feed, hasReadSnapshot]);
}

/**
 * The one re-read a stream-only feed has: closing the dead tail and opening a live one.
 *
 * A class rather than a bare callback because the trigger set is a contract — the
 * declared kinds and the request method — and because the scheduler behind it is the
 * console's one answer to "two surfaces asked at once". `perform` returns nothing to
 * await: the re-open lands as a render, and the stream that render opens answers
 * whenever the daemon answers.
 */
class RunStreamReopen implements ReadTriggerTarget {
  /**
   * The stream carries every run-state change this feed folds, so nothing in the
   * timeline tells it anything its own tail did not — and the repair trigger, which
   * is what this class exists for, is not an event kind.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #refresh: RefreshScheduler;

  public constructor(clock: ConsoleClock, reopenStream: () => void) {
    this.#refresh = new RefreshScheduler({
      clock,
      perform: async () => {
        reopenStream();
      },
      // Nothing here can reject: the body sets state and returns.
      onError: () => undefined,
    });
  }

  public requestRead(reason: RefreshReason): void {
    this.#refresh.request(reason);
  }

  /** Disarm the pending re-open when the mount that would render it is gone. */
  public dispose(): void {
    this.#refresh.dispose();
  }
}

/** The reading before anything has been delivered. Frozen so no caller mutates it. */
const EMPTY_FEED: RunStateFeed = Object.freeze({
  runs: Object.freeze([]),
  hasRead: false,
  unreadableDeliveryCount: 0,
  openRefusal: undefined,
});
