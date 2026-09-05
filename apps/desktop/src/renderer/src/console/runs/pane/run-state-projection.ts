// The runs pane's fold: the two stream arms, folded into one reading per run.
//
// Split from `run-state-feed.ts`, which now owns the SUBSCRIPTION — opening it,
// closing it, and what the pane sees while it is open — while this owns what a
// delivered frame does to what the pane knows. The two fail differently: a stream
// that never opened is a refusal to report, and a frame that parsed as neither arm
// is a delivery to count, and reading them out of one module made those one fact.
//
// THE ROLLBACK ARM IS DELIBERATELY NOT A TRANSITION. It carries no `previousState`
// and no `currentState`, because a rollback is not one, and THIS MODULE'S OWN RULE,
// because no committed document states it, is that a transition is never fabricated
// for one: the fold appends a status row carrying NEITHER state, advances the run's
// version and its rewind position, and reads the run as `paused`.
//
// NOTHING HERE READS A CLOCK. Elapsed is measured between two instants the WIRE
// supplied, so a projection is the same projection whenever it is read.

import type { RunRolledBackEvent, RunState, RunStateChangeEvent } from "@ai-sidekicks/contracts";
import { readRunRolledBack, readRunStateChange } from "../../bridge/index.js";
import { compareInstants, parseInstant } from "../../core/index.js";
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
    const transition = readRunStateChange(payload);
    if (transition !== undefined) {
      this.#acceptTransition(transition);
      return true;
    }
    const rewind = readRunRolledBack(payload);
    if (rewind !== undefined) {
      this.#acceptRewind(rewind);
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
  const ranked = compareInstants(
    parseInstant(left.updatedAtIso),
    parseInstant(right.updatedAtIso),
    "newest-first",
  );
  return ranked === 0 ? left.runId.localeCompare(right.runId) : ranked;
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
  const from = parseInstant(run.firstSeenAtIso);
  const to = parseInstant(run.updatedAtIso);
  if (from.kind === "malformed" || to.kind === "malformed") {
    return undefined;
  }
  const elapsed = to.epochMilliseconds - from.epochMilliseconds;
  return elapsed < 0 ? undefined : elapsed;
}
