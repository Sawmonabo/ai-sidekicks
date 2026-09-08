// The park attention fold: what a set of parked runs reads as, once the ones waiting
// on the same thing are counted together.
//
// WHY A FOLD EXISTS AT ALL. A provider account that has spent its window parks every
// run dispatching against it, and the engine says so by stamping each of those parked
// phases with the same `parkAttentionKey`. Drawn one entry per run that is one fact
// reported N times — six lines saying the same account is out of capacity, none of
// them saying it is one account. `Spec-017 §Park integrity and cancellability (SA-42)`
// mints the key for exactly this, and until this module nothing read it: the key
// reached `WorkflowParkedPhase`, travelled through the projection, and stopped.
//
// THE FOLD IS OVER PARKED PHASES AND THE COUNT IS OVER RUNS. Those are two different
// collections and conflating them is the easy defect here: a run whose fan-out parked
// two branches against one account contributes two parked phases and ONE affected
// run, and an entry reporting "2 runs affected" for a single run would be a number an
// operator cannot reconcile with the list under it. `affectedRunCount` is therefore
// the size of a set of run ids, never a length of anything else.
//
// A SET THAT IS NOT UNIFORMLY KEYED NEVER FOLDS, AND THE UNKEYED PARK IS NOT DROPPED.
// The engine computes a key only where it can correlate the wait; where it cannot,
// the member is absent. Such a park takes an entry of its own — the run it belongs to
// surfaces on its own terms — so the fold FAILS OPEN toward more entries rather than
// fewer. The opposite disposition, folding unkeyed parks together under some "no key"
// bucket, would invent a correlation the engine declined to state.
//
// THE FOLD GATES NOTHING. It is a reading for a person, not an input to a control:
// cancel, resume, re-pin and start are the daemon's adjudications and an attention
// entry never suppresses, delays, or enables one. Nor does it notify — this surface
// mints no OS notification, which is `Spec-019`'s to decide and not a run list's.
//
// ORDER IS FIRST ENCOUNTER OVER ROWS THE PROJECTION ALREADY SORTED. The rows arrive
// attention-first and newest-first inside a band, so walking them gives a stable
// order with no second comparator to disagree with the first — and an entry folding
// three runs sits where its FIRST run sits, which is the one an operator scanning the
// list meets first.

import type { WorkflowParkedPhase, WorkflowParkReason } from "./run-list-rows.js";
import { parkAwaitsPerson } from "./run-list-rows.js";

/**
 * One line of the attention surface: either a correlated wait, or one park the engine
 * could not correlate.
 *
 * TWO ARMS RATHER THAN ONE SHAPE WITH AN OPTIONAL KEY, because the two are different
 * things to draw and different things to count. A folded entry is about a shared
 * cause and names it; an uncorrelated entry is about one phase of one run and names
 * those. A single shape carrying `parkAttentionKey?` would leave every reader to
 * re-derive which of the two it was holding — the discriminator defect
 * `run-list-rows.ts` records for the park members themselves.
 */
export type WorkflowParkAttentionEntry = WorkflowFoldedParks | WorkflowUncorrelatedPark;

/** Every concurrently parked run sharing one attention key, as one line. */
export interface WorkflowFoldedParks {
  readonly kind: "folded";
  /** The engine's own correlation key. An opaque wire value, rendered verbatim. */
  readonly parkAttentionKey: string;
  /**
   * How many distinct RUNS this entry stands for. Never a count of phases.
   *
   * One run parking two branches against one account is one affected run, and the
   * list under this entry will show it once — so a phase count here would be a figure
   * contradicted by the rows beside it.
   */
  readonly affectedRunCount: number;
  /**
   * The park reasons folded here, distinct and in first-encounter order.
   *
   * Carried rather than assumed: the key is minted for provider-capacity waits in
   * practice, but the wire admits it on any parked phase, and a surface that hard-
   * coded one reason would mislabel the day the engine correlates the other. A reader
   * naming the reasons reads them off this.
   */
  readonly parkReasons: readonly WorkflowParkReason[];
  /**
   * True when any park in this fold ends only when a person ends it.
   *
   * ANY rather than ALL, which is the fail-closed direction: an entry standing for
   * six waits, one of which needs somebody, needs somebody. The per-park reading is
   * `parkAwaitsPerson`'s and is not remade here — the badge, the phase node and this
   * entry all spend amber on the same answer, which is what keeps two surfaces from
   * disagreeing about one phase.
   */
  readonly awaitsPerson: boolean;
}

/** One parked phase the engine did not correlate, standing for its own run. */
export interface WorkflowUncorrelatedPark {
  readonly kind: "uncorrelated";
  readonly workflowRunId: string;
  readonly parked: WorkflowParkedPhase;
}

/** One run's parked phases, as the fold's input. The projection supplies these. */
export interface WorkflowRunParks {
  readonly workflowRunId: string;
  readonly parkedPhases: readonly WorkflowParkedPhase[];
}

/**
 * Accumulates one key's fold while the walk is in progress.
 *
 * A class rather than a mutable literal because the invariant — distinct runs,
 * distinct reasons, and the disjunction over `awaitsPerson` — is what this holds, and
 * a literal updated at the call site is where the run set silently becomes a counter
 * that double-counts a two-branch fan-out.
 */
class ParkAttentionAccumulator {
  readonly #parkAttentionKey: string;
  readonly #affectedRunIds = new Set<string>();
  readonly #parkReasons: WorkflowParkReason[] = [];
  #awaitsPerson = false;

  public constructor(parkAttentionKey: string) {
    this.#parkAttentionKey = parkAttentionKey;
  }

  public admit(workflowRunId: string, parked: WorkflowParkedPhase): void {
    this.#affectedRunIds.add(workflowRunId);
    if (!this.#parkReasons.includes(parked.park.parkReason)) {
      this.#parkReasons.push(parked.park.parkReason);
    }
    this.#awaitsPerson = this.#awaitsPerson || parkAwaitsPerson(parked.schedule);
  }

  public settle(): WorkflowFoldedParks {
    return {
      kind: "folded",
      parkAttentionKey: this.#parkAttentionKey,
      affectedRunCount: this.#affectedRunIds.size,
      parkReasons: this.#parkReasons,
      awaitsPerson: this.#awaitsPerson,
    };
  }
}

/**
 * Every live park, folded where the engine correlated it and standing alone where it
 * did not.
 *
 * Takes the runs' parked phases rather than whole snapshots, on
 * `projectParkedPhases`' reason one module over: what this needs is a run's identity
 * and its live parks, and demanding a snapshot would make a caller holding neither
 * build one.
 */
export function foldParkAttention(
  runParks: readonly WorkflowRunParks[],
): readonly WorkflowParkAttentionEntry[] {
  const accumulatorsByKey = new Map<string, ParkAttentionAccumulator>();
  // One slot per entry, in first-encounter order. A fold's slot holds the ACCUMULATOR
  // rather than its key, so the settling pass below needs no second lookup and has no
  // absent case to answer for — a key written into a slot is a key already in the map,
  // and a `Map.get` there would have made that invariant something to re-check.
  const slots: (WorkflowUncorrelatedPark | ParkAttentionAccumulator)[] = [];
  for (const { workflowRunId, parkedPhases } of runParks) {
    for (const parked of parkedPhases) {
      const { parkAttentionKey } = parked.park;
      if (parkAttentionKey === undefined) {
        slots.push({ kind: "uncorrelated", workflowRunId, parked });
        continue;
      }
      let accumulator = accumulatorsByKey.get(parkAttentionKey);
      if (accumulator === undefined) {
        accumulator = new ParkAttentionAccumulator(parkAttentionKey);
        accumulatorsByKey.set(parkAttentionKey, accumulator);
        slots.push(accumulator);
      }
      accumulator.admit(workflowRunId, parked);
    }
  }
  // Settled only once every park has been admitted, so an entry's count is the whole
  // fold rather than however much of it had been walked when its slot was taken.
  return slots.map((slot) => (slot instanceof ParkAttentionAccumulator ? slot.settle() : slot));
}
