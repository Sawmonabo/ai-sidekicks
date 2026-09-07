// What this run's controls last came back with, and whether there is still a run.
//
// Split out of `RunControls.tsx` the moment a second surface needed it. The row's
// control strip is one reader; the palette contribution is the other, and two files
// walking the same records with their own loops is how the strip and the palette came
// to offer different sets — the exact defect `offeredRunControls` exists to prevent
// on the capability axis.
//
// NEWEST SETTLEMENT ONLY, NEVER NEWEST REFUSAL EVER. A refusal that has since been
// superseded by a control that worked is not what the row is in, and leaving it on
// screen reports a state the daemon has moved past. So the walk stops at the newest
// record for this run and answers about THAT one, refusal or not.
//
// AND "NEWEST" IS THE NEWEST REQUEST, NOT THE NEWEST ANSWER. The surface admits
// different controls for one run concurrently and appends a record when its promise
// SETTLES, so the array's order is completion order. Treating that as authoritative
// made an older request's late answer the newest entry: a `cancel` answering
// `run.not_found` followed by a `pause` dispatched earlier and answered afterwards
// cleared `isGone` and handed back every control on a run the daemon had already said
// was absent. So the walk ranks by the dispatch ordinal the record's own token
// carries — `run-control-dispatch-token.ts` owns both halves of that encoding — and a
// newer run-loss verdict is never superseded by an older request's late settlement.
//
// A RECORD WHOSE TOKEN CARRIES NO ORDINAL RANKS BELOW EVERY ONE THAT DOES, with
// append position breaking ties among them. That is deliberately the reading this
// walk had before the ordinal existed: an unreadable token is not evidence of
// anything, so it neither displaces a verdict this module can rank nor stops being
// readable for a surface whose records are the only ones there are.
//
// AND `run.not_found` IS READ AS THE RUN BEING GONE, WHICH IS THE ONE REFUSAL THAT
// CHANGES WHAT THE ROW IS. Every other refusal is about the act: the comparand was
// stale, the driver cannot do it, the transition is not admissible — the run is still
// there and the same control may work on the next press. This one says the daemon has
// no such run, so every control on the row would refuse identically and forever.
//
// THE ROW IS NOT REMOVED, AND ITS FIGURES ARE NOT CLEARED. What the feed folded is
// the last thing anyone will ever know about this run, and dropping the row would
// destroy it while a person was reading it. So the reading withdraws the ACTS and
// leaves the record, and the remedy table's own sentence for the code says exactly
// that — what is shown is the last state the stream reported.
//
// IT IS DERIVED AND NOTHING IS STORED. The feed is untouched: a second copy of "this
// run is gone" held beside the projections would be a second source of truth for a
// fact the settlement records already carry, and the two would disagree the first
// time a record was dropped by the outcome cap.

import { type ConsoleRefusal } from "../../../core/index.js";
import {
  FIRST_RUN_CONTROL_DISPATCH_ORDINAL,
  runControlDispatchOrdinalOf,
} from "./run-control-dispatch-token.js";
import { type RunControlRecord, type RunControlSurface } from "./run-control-surface.js";

/**
 * The wire code that says this run is no longer the daemon's.
 *
 * Named here rather than compared inline because two surfaces read it and a second
 * spelling of a wire string is how one of them stops matching.
 */
const RUN_GONE_CODE = "run.not_found";

/**
 * Where a record whose token carries no ordinal sits.
 *
 * Derived from the surface's own floor rather than written as a number, so the two
 * cannot come apart: every real ordinal is at least the floor, and this is one below
 * it.
 */
const UNRANKED_DISPATCH_ORDINAL = FIRST_RUN_CONTROL_DISPATCH_ORDINAL - 1;

/** What one run's newest control settlement says, for every surface that acts on it. */
export interface RunControlSettlementReading {
  /** The refusal the newest settlement carried, or nothing where it carried none. */
  readonly refusal: ConsoleRefusal | undefined;
  /**
   * Whether the daemon answered that this run does not exist.
   *
   * `true` withdraws every control on every surface. It is deliberately not a
   * projection over run STATE — a terminal run is still the daemon's and its
   * controls still refuse on the daemon's own rule, which is the fail-closed
   * direction. Only the daemon saying the run is gone makes it gone.
   */
  readonly isGone: boolean;
}

/** Read one run's newest control settlement off the surface's own records. */
export function readRunControlSettlement(
  surface: RunControlSurface,
  runId: string,
): RunControlSettlementReading {
  const newest = newestDispatchedFor(surface, runId);
  const refusal = newest?.outcome.kind === "refused" ? newest.outcome.refusal : undefined;
  return { refusal, isGone: refusal?.code === RUN_GONE_CODE };
}

/** Every run this surface has been told no longer exists. Built once per contribution. */
export function goneRunIds(surface: RunControlSurface): ReadonlySet<string> {
  const gone = new Set<string>();
  for (const record of surface.records) {
    if (readRunControlSettlement(surface, record.runId).isGone) {
      gone.add(record.runId);
    }
  }
  return gone;
}

/**
 * This run's newest-DISPATCHED settled record, or nothing where it has none.
 *
 * Scoped to one run before it ranks: the ordinal is the surface's and is monotonic
 * across every run at once, so comparing across runs would answer about whichever
 * run dispatched last. `>=` is what makes append position the tie-break among records
 * this module cannot rank.
 */
function newestDispatchedFor(
  surface: RunControlSurface,
  runId: string,
): RunControlRecord | undefined {
  let newest: RunControlRecord | undefined;
  let newestOrdinal = UNRANKED_DISPATCH_ORDINAL;
  for (const record of surface.records) {
    if (record.runId !== runId) {
      continue;
    }
    const ordinal = runControlDispatchOrdinalOf(record.recordId) ?? UNRANKED_DISPATCH_ORDINAL;
    if (newest === undefined || ordinal >= newestOrdinal) {
      newest = record;
      newestOrdinal = ordinal;
    }
  }
  return newest;
}
