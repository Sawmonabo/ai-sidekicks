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

import { useEffect, useMemo, useRef } from "react";
import {
  RunRolledBackEventSchema,
  RunStateChangeEventSchema,
  RunStateSubscribeRequestSchema,
  type RunRolledBackEvent,
  type RunState,
  type RunStateChangeEvent,
} from "@ai-sidekicks/contracts";

import { normalizeWireRejection } from "../../../../../shared/wire-errors.js";
import {
  RUN_STATE_SUBSCRIBE_STREAM,
  subscribeDaemon,
  useSessionScopedState,
  type ConsoleBridge,
} from "../../bridge/index.js";
import {
  isConsoleRefusal,
  refuse,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../../core/index.js";
import { useSessionInitialised, type SessionStore } from "../../store/index.js";
import { PROJECTED_RUN_CAP, RUN_STATUS_ROW_CAP } from "./runs-bounds.js";
import { runStatusSubtypeFor, type RunStatusSubtype, type RunStopTrigger } from "./run-status.js";

/** One row of a run's status history, in the subtypes `run-status.ts` declares. */
export interface RunStatusRow {
  readonly subtype: RunStatusSubtype;
  /** Wire-verbatim, and `undefined` on the rewind arm, which carries no states. */
  readonly previousState: RunState | undefined;
  readonly currentState: RunState | undefined;
  /** The rewind anchor, present only on the rewind arm. */
  readonly targetPosition: number | undefined;
  readonly runVersion: number;
  /** ISO-8601 from the wire, or `undefined` — the rewind arm carries no timestamp. */
  readonly occurredAtIso: string | undefined;
}

/** One run, as the stream has described it so far. */
export interface RunProjection {
  readonly runId: string;
  /** The comparand every guarded mutation threads back. Wire-supplied, never guessed. */
  readonly runVersion: number;
  readonly state: RunState;
  readonly trigger: RunStopTrigger | undefined;
  /** A daemon-initiated clean close. Such a terminal is never read as a crash. */
  readonly intendedClose: boolean;
  readonly failureCategory: string | undefined;
  readonly providerFailureDetail: string | undefined;
  /** The rewind anchor the run last landed at, when one has been reported. */
  readonly rewoundToPosition: number | undefined;
  readonly firstSeenAtIso: string;
  readonly updatedAtIso: string;
  /** Newest last, matching the ledger's reading direction. Bounded. */
  readonly statusRows: readonly RunStatusRow[];
}

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
 * The fold, as a class with private fields rather than a reducer closed over by a
 * component.
 *
 * Two things follow from that and neither is stylistic. The bounded eviction needs
 * insertion order across many deliveries, which a per-event pure reducer would have
 * to rebuild each time; and the fold is drivable from a test without React, which
 * is what lets the rewind arm's "advances the version and leaves the state alone"
 * property be asserted directly rather than through a rendered tree.
 */
export class RunStateProjection {
  readonly #runsById = new Map<string, RunProjection>();
  #unreadableDeliveryCount = 0;

  /** Fold one delivered payload. Answers whether it was readable. */
  public accept(payload: unknown): boolean {
    const transition = RunStateChangeEventSchema.safeParse(payload);
    if (transition.success) {
      this.#acceptTransition(transition.data);
      return true;
    }
    const rewind = RunRolledBackEventSchema.safeParse(payload);
    if (rewind.success) {
      this.#acceptRewind(rewind.data);
      return true;
    }
    this.#unreadableDeliveryCount += 1;
    return false;
  }

  /** Runs, most recently touched first. */
  public runs(): readonly RunProjection[] {
    return [...this.#runsById.values()].sort(byMostRecentlyTouched);
  }

  public get unreadableDeliveryCount(): number {
    return this.#unreadableDeliveryCount;
  }

  public get runCount(): number {
    return this.#runsById.size;
  }

  #acceptTransition(event: RunStateChangeEvent): void {
    const held = this.#runsById.get(event.runId);
    const row: RunStatusRow = {
      subtype: runStatusSubtypeFor(event.previousState, event.currentState),
      previousState: event.previousState,
      currentState: event.currentState,
      targetPosition: undefined,
      runVersion: event.runVersion,
      occurredAtIso: event.timestamp,
    };
    this.#store({
      runId: event.runId,
      runVersion: event.runVersion,
      state: event.currentState,
      trigger: event.trigger,
      intendedClose: event.intendedClose === true,
      failureCategory: event.failureCategory,
      providerFailureDetail: event.providerFailureDetail,
      rewoundToPosition: held?.rewoundToPosition,
      firstSeenAtIso: held?.firstSeenAtIso ?? event.timestamp,
      updatedAtIso: event.timestamp,
      statusRows: appendBounded(held?.statusRows ?? [], row),
    });
  }

  /**
   * A rewind, which is not a transition.
   *
   * The run reads `paused` afterwards — every run, not only one this pane has not
   * seen before. `Spec-004`'s absorption rule states it directly ("after a rollback
   * has re-opened the run in `paused`"), and `RunRolledBackEventSchema` is
   * `{sessionId, runId, runVersion, channelId?, targetPosition}` and strict, so the
   * state comes from the contract rather than from a member. Carrying the held
   * state forward instead would leave a run this pane had already seen `completed`,
   * `failed`, or `waiting_for_approval` looking terminal or blocked indefinitely —
   * this event is the operation's only state-stream notification — and would
   * withhold the controls the rewound run now has.
   *
   * The metadata that described the pre-rewind epoch goes with it: a trigger, a
   * clean-close marking, and a failure category all describe a run that no longer
   * exists at this position, and rendering them beside `paused` would be reporting
   * a stop that has been undone.
   *
   * Still NO fabricated transition, per this module's rule above: a rewind never
   * becomes one. The appended row keeps `subtype: "rewound"` with both states
   * `undefined`, so the history says a rewind happened and never says from what to
   * what. A run this pane meets through a rewind alone still gets a row, because
   * the rewind is real and dropping it would leave a person looking at a run whose
   * position moved with nothing on screen saying so.
   */
  #acceptRewind(event: RunRolledBackEvent): void {
    const held = this.#runsById.get(event.runId);
    const row: RunStatusRow = {
      subtype: "rewound",
      previousState: undefined,
      currentState: undefined,
      targetPosition: event.targetPosition,
      runVersion: event.runVersion,
      occurredAtIso: undefined,
    };
    this.#store({
      runId: event.runId,
      runVersion: event.runVersion,
      state: "paused",
      trigger: undefined,
      intendedClose: false,
      failureCategory: undefined,
      providerFailureDetail: undefined,
      rewoundToPosition: event.targetPosition,
      firstSeenAtIso: held?.firstSeenAtIso ?? UNTIMED_FIRST_SEEN,
      updatedAtIso: held?.updatedAtIso ?? UNTIMED_FIRST_SEEN,
      statusRows: appendBounded(held?.statusRows ?? [], row),
    });
  }

  /**
   * Write one run back, re-inserting it so the map's order is touch order.
   *
   * The delete-then-set is what makes the eviction below mean "drop the run nothing
   * has said anything about for longest" rather than "drop whichever run this map
   * happened to receive first".
   */
  #store(projection: RunProjection): void {
    this.#runsById.delete(projection.runId);
    this.#runsById.set(projection.runId, projection);
    while (this.#runsById.size > PROJECTED_RUN_CAP) {
      const leastRecent = this.#runsById.keys().next();
      if (leastRecent.done === true) {
        return;
      }
      this.#runsById.delete(leastRecent.value);
    }
  }
}

/**
 * The instant a rewind-first run reports for "first seen".
 *
 * `RunRolledBackEvent` carries no timestamp — deliberately, since it records no
 * transition — so a run this pane meets through a rewind has no wire instant to
 * start its elapsed reading from. An empty string is what `formatDuration`'s
 * callers below read as "no reading", and it is deliberately not `new Date()`: a
 * console-invented instant would render an elapsed figure the wire never supported.
 */
const UNTIMED_FIRST_SEEN = "";

/** Append, keeping the newest `RUN_STATUS_ROW_CAP` rows with the newest last. */
function appendBounded(rows: readonly RunStatusRow[], row: RunStatusRow): readonly RunStatusRow[] {
  const appended = [...rows, row];
  return appended.length <= RUN_STATUS_ROW_CAP
    ? appended
    : appended.slice(appended.length - RUN_STATUS_ROW_CAP);
}

/** Newest activity first, with the run id breaking an exact tie deterministically. */
function byMostRecentlyTouched(left: RunProjection, right: RunProjection): number {
  if (left.updatedAtIso === right.updatedAtIso) {
    return left.runId.localeCompare(right.runId);
  }
  return left.updatedAtIso < right.updatedAtIso ? 1 : -1;
}

/**
 * Elapsed between the two wire instants a run reported, in milliseconds.
 *
 * Both ends come from the wire and the subtraction is the console's own derivation,
 * which is why callers render the result through `formatDuration` as a DERIVED
 * figure rather than a wire one. `undefined` where either end is missing or
 * unparseable: a run that reported no instant has no elapsed reading, and rendering
 * a zero there would claim it started and finished in the same moment.
 */
export function runElapsedMilliseconds(run: RunProjection): number | undefined {
  const from = Date.parse(run.firstSeenAtIso);
  const to = Date.parse(run.updatedAtIso);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) {
    return undefined;
  }
  return to - from;
}

/**
 * Open the run-state subscription for one session.
 *
 * The projection instance lives in a ref so a re-render does not restart the fold,
 * and the rendered snapshot is state so a delivery re-renders. Deliveries after
 * unmount are dropped rather than written into a torn-down component, which is the
 * same close-race posture the session binder takes one layer down.
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
export function useRunStateFeed(bridge: ConsoleBridge, sessionStore: SessionStore): RunStateFeed {
  const sessionId = sessionStore.sessionId;
  const hasReadSnapshot = useSessionInitialised(sessionStore);
  const projection = useRef<RunStateProjection>(new RunStateProjection());
  const [feed, setFeed] = useSessionScopedState<RunStateFeed>(bridge, sessionId, EMPTY_FEED);

  useEffect(() => {
    const fold = new RunStateProjection();
    projection.current = fold;
    let isMounted = true;

    // The stream's own registered request, parsed here rather than assembled at
    // the wrapper: an id the wire's `SessionId` brand refuses is a refusal this
    // surface renders, not an unscoped subscription it opens anyway.
    const subscribeRequest = RunStateSubscribeRequestSchema.safeParse({ sessionId });
    if (!subscribeRequest.success) {
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
        { method: RUN_STATE_SUBSCRIBE_STREAM, request: subscribeRequest.data },
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
      setFeed({ ...EMPTY_FEED, openRefusal: streamOpenRefusal(thrown) });
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
  }, [bridge, sessionId]);

  return useMemo(() => ({ ...feed, hasRead: hasReadSnapshot }), [feed, hasReadSnapshot]);
}

/**
 * The refusal an unopenable stream renders.
 *
 * A `ConsoleRefusalError` from the wrapper's own unscoped-open guard already
 * carries a refusal, and re-wrapping it would replace a sentence that names the
 * defect with one that names the exception. Anything else is a wire rejection and
 * normalizes exactly as every other console catch boundary normalizes one, so this
 * file grows no second normalizer.
 */
function streamOpenRefusal(thrown: unknown): ConsoleRefusal {
  const carried = (thrown as { readonly refusal?: unknown } | null | undefined)?.refusal;
  if (isConsoleRefusal(carried)) {
    return carried;
  }
  const wireError = normalizeWireRejection(thrown, { total: true });
  return refuse(RUN_STATE_REFUSAL_ORIGIN, wireError.name, wireError.message);
}

/** The reading before anything has been delivered. Frozen so no caller mutates it. */
const EMPTY_FEED: RunStateFeed = Object.freeze({
  runs: Object.freeze([]),
  hasRead: false,
  unreadableDeliveryCount: 0,
  openRefusal: undefined,
});
