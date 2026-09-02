// The runs pane's live spine: `run.subscribeState`, folded into one row per run.
//
// `Spec-023 §Console Design (Meridian)` §7.1 gives the stream two arms and this
// module keeps them apart structurally rather than by convention:
//
//   • `RunStateChangeEvent` — a transition, carrying both states, the advanced
//     `runVersion`, and the stop-condition provenance. Folded into the run's
//     current reading and appended to its status history.
//   • `RunRolledBackEvent` — deliberately NOT a transition. It carries no
//     `previousState` and no `currentState`, because a rollback is not one, and
//     §7.1's Never list forbids fabricating one. So the fold advances the run's
//     version and its rewind position and LEAVES THE STATE ALONE.
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

import { useEffect, useRef, useState } from "react";
import {
  RunRolledBackEventSchema,
  RunStateChangeEventSchema,
  type RunRolledBackEvent,
  type RunState,
  type RunStateChangeEvent,
} from "@ai-sidekicks/contracts";

import {
  RUN_STATE_SUBSCRIBE_STREAM,
  subscribeDaemon,
  type ConsoleBridge,
} from "../../bridge/index.js";
import { PROJECTED_RUN_CAP, RUN_STATUS_ROW_CAP } from "./runs-bounds.js";
import { runStatusSubtypeFor, type RunStatusSubtype, type RunStopTrigger } from "./run-status.js";

/** One row of a run's status history, as §7.1's subtype table renders it. */
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

/** What the pane reads off the state stream. */
export interface RunStateFeed {
  /** Runs, most recently touched first — the reading a live pane exists to give. */
  readonly runs: readonly RunProjection[];
  /** Whether the subscription has delivered anything this pane could read. */
  readonly hasRead: boolean;
  /** Deliveries that parsed as neither arm. Counted, never guessed at. */
  readonly unreadableDeliveryCount: number;
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
   * The run's `state` is carried forward untouched — §7.1: "Never fabricates a
   * transition for a rewind." A run this pane has not seen a transition for still
   * gets a row, because the rewind is real and dropping it would leave a person
   * looking at a run whose position moved with nothing on screen saying so; its
   * state reads `paused`, which is where `Spec-004` lands a confirmed rollback and
   * is the only state the wire's own contract establishes for this arm.
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
      state: held?.state ?? "paused",
      trigger: held?.trigger,
      intendedClose: held?.intendedClose ?? false,
      failureCategory: held?.failureCategory,
      providerFailureDetail: held?.providerFailureDetail,
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
 */
export function useRunStateFeed(bridge: ConsoleBridge, sessionId: string): RunStateFeed {
  const projection = useRef<RunStateProjection>(new RunStateProjection());
  const [feed, setFeed] = useState<RunStateFeed>(EMPTY_FEED);

  useEffect(() => {
    const fold = new RunStateProjection();
    projection.current = fold;
    setFeed(EMPTY_FEED);
    let isMounted = true;
    const unsubscribe = subscribeDaemon(bridge, RUN_STATE_SUBSCRIBE_STREAM, (payload) => {
      const wasReadable = fold.accept(payload);
      if (!isMounted || !wasReadable) {
        return;
      }
      setFeed({
        runs: fold.runs(),
        hasRead: true,
        unreadableDeliveryCount: fold.unreadableDeliveryCount,
      });
    });
    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [bridge, sessionId]);

  return feed;
}

/** The reading before anything has been delivered. Frozen so no caller mutates it. */
const EMPTY_FEED: RunStateFeed = Object.freeze({
  runs: Object.freeze([]),
  hasRead: false,
  unreadableDeliveryCount: 0,
});
