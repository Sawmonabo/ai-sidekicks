// The park attention fold: parked runs waiting on the same thing, counted together. The engine
// stamps each phase parked against one provider account with the same `parkAttentionKey`; drawn
// per run that would be one fact reported N times. The fold is over parked phases but the count
// is over runs: `affectedRunCount` is the size of a set of run ids, so a run parking two branches
// on one account counts once. A park with no key (the engine could not correlate it) takes its
// own entry; the fold fails open toward more entries. It gates and notifies nothing. Order is
// first encounter over rows the projection already sorted newest first.

import type { WorkflowParkedPhase, WorkflowParkReason } from "./run-list-rows.js";
import { parkAwaitsPerson } from "./run-list-rows.js";

/**
 * One line of the run list's attention list: a correlated wait, or one park the engine could not
 * correlate. Two arms, not an optional key, so no reader re-derives which one it holds.
 */
export type WorkflowParkAttentionEntry = WorkflowFoldedParks | WorkflowUncorrelatedPark;

/** Every concurrently parked run sharing one attention key, as one line. */
export interface WorkflowFoldedParks {
  readonly kind: "folded";
  /** The engine's own correlation key. An opaque wire value, rendered verbatim. */
  readonly parkAttentionKey: string;
  /** How many distinct runs this entry stands for; never a count of phases. */
  readonly affectedRunCount: number;
  /**
   * The park reasons folded here, distinct and in first-encounter order. Carried, not assumed:
   * the wire admits the key on any parked phase.
   */
  readonly parkReasons: readonly WorkflowParkReason[];
  /**
   * True when any park in this fold ends only when a person ends it. Any, not all: one wait that
   * needs somebody means the entry does. The per-park reading is `parkAwaitsPerson`'s.
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
 * Every live park, folded where the engine correlated it and standing alone where it did not.
 * Takes parked phases rather than snapshots, as `projectParkedPhases` does.
 */
export function foldParkAttention(
  runParks: readonly WorkflowRunParks[],
): readonly WorkflowParkAttentionEntry[] {
  const accumulatorsByKey = new Map<string, ParkAttentionAccumulator>();
  // Pending entries in first-encounter order; a fold's entry is its accumulator, so settling
  // needs no second map lookup.
  const pendingEntries: (WorkflowUncorrelatedPark | ParkAttentionAccumulator)[] = [];
  for (const { workflowRunId, parkedPhases } of runParks) {
    for (const parked of parkedPhases) {
      const { parkAttentionKey } = parked.park;
      if (parkAttentionKey === undefined) {
        pendingEntries.push({ kind: "uncorrelated", workflowRunId, parked });
        continue;
      }
      let accumulator = accumulatorsByKey.get(parkAttentionKey);
      if (accumulator === undefined) {
        accumulator = new ParkAttentionAccumulator(parkAttentionKey);
        accumulatorsByKey.set(parkAttentionKey, accumulator);
        pendingEntries.push(accumulator);
      }
      accumulator.admit(workflowRunId, parked);
    }
  }
  // Settled after every park is admitted, so a count is the whole fold.
  return pendingEntries.map((pending) =>
    pending instanceof ParkAttentionAccumulator ? pending.settle() : pending,
  );
}

/**
 * Accumulates one key's fold during the walk. A class so the run set stays a set and cannot
 * become a counter that double-counts a two-branch fan-out.
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
