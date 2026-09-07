// Which of a session's runs a channel pins, and what that run's progress reads as.
//
// The card next door draws one run. This decides WHICH one and what can be said about
// it, as a value — so the picking rule and the counting rule are one place rather than
// two branches inside a render, and a test drives them without a DOM.
//
// THE PICK IS ATTENTION FIRST AND THEN LIVENESS, and both halves are the run list's own
// reading rather than a second one. `RunListProjection` already orders runs
// parked-first and then newest-first inside a band, so the run a person most needs to
// see is `rows[0]` — of the rows scoped to this channel. What this adds is that a
// SETTLED run is not pinned at all: a completed run's progress is complete, and a card
// that stayed above a channel forever would be the one piece of chrome a person cannot
// dismiss reporting a thing that already ended.
//
// THERE IS A PICK BECAUSE THERE CAN BE MORE THAN ONE. `Spec-017 §Chat-start surface
// (SA-38)` registers `channelId` as PROVENANCE — the channel a start was issued from,
// never an input to the adjudication and never a uniqueness key — so a room that
// started a second run while its first was still going holds two, and the fold answers
// with the head of the order rather than with "the" run. Anything above this that reads
// the answer as a uniqueness claim is reading a guarantee no wire makes.
//
// THE COUNT IS PHASES COMPLETED OF PHASES KNOWN, and it is deliberately not a
// percentage. The engine's phase list is what the run read carries; a percentage would
// be a figure with a denominator a person cannot see, and a run whose phase list grows
// mid-run would move a bar backwards with nothing on screen saying why.
//
// NOTHING HERE ADJUDICATES AND NOTHING HERE READS A PARK. Whether a phase is parked is
// `projectParkedPhases`' answer, applied once in the run list's projection and carried
// on the row — this module reads that answer and never `PhaseState.state`, which
// carries no suspended arm on purpose (`Spec-017 §Park surfacing on the read model
// (SA-44)`).

import { RunListProjection, type WorkflowRunListRow } from "../runs/run-list-projection.js";
import type { WorkflowRunListEntry } from "../../bridge/index.js";

/** One channel's pinned run, and the two figures a card states about it. */
export interface ChannelWorkflowProgress {
  readonly row: WorkflowRunListRow;
  /** How many of the run's known phases have completed. */
  readonly completedPhaseCount: number;
  /** How many phases the run read carried at all. */
  readonly totalPhaseCount: number;
}

/**
 * The run this channel most needs looked at, or nothing.
 *
 * `undefined` covers three different facts on purpose — no run named this channel, the
 * caller holds no channel to name, and every run this channel holds has settled — and
 * the card draws the same nothing for all three, because a pinned region's only honest
 * absence is contributing no element. The three are separable by a reader that wants
 * them; nothing in this console does.
 */
export function channelWorkflowProgress(
  runs: readonly WorkflowRunListEntry[],
  channelId: string | undefined,
): ChannelWorkflowProgress | undefined {
  if (channelId === undefined) {
    return undefined;
  }
  // Filtered BEFORE the projection rather than after it: the projection's ordering and
  // its per-row derivations are about the set it was handed, and projecting a session's
  // whole run list to use one row of it would sort and derive over runs no channel ever
  // shows.
  const scoped = runs.filter((run) => run.channelId === channelId);
  const pinned = new RunListProjection(scoped).rows.find((row) => row.attentionBand !== "settled");
  if (pinned === undefined) {
    return undefined;
  }
  return {
    row: pinned,
    completedPhaseCount: pinned.run.phaseStates.filter((phase) => phase.state === "completed")
      .length,
    totalPhaseCount: pinned.run.phaseStates.length,
  };
}
