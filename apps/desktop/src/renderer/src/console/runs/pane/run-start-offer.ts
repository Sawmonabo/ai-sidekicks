// Whether the runs pane is offering its start act right now — one reading, both
// surfaces.
//
// The pane's empty state names an act ("send a message to an agent") and carries the
// control for it, and `Spec-023 §Console Design (Meridian)` requires every operator
// action to be palette-reachable. That makes the offer a question asked from two
// places, and a question asked twice is a question two files can answer differently:
// the button would sit on screen with no palette row beside it, or the palette would
// keep offering to start work in a pane that has since filled with runs.
//
// SO THE READING IS A FUNCTION AND NOT A CONVENTION. `NoRuns` renders its control on
// this answer and the pane's palette contribution is built on the same one, so the
// two cannot come apart — and the constant below is the words BOTH of them use, for
// the same reason: a row whose title had drifted from the button's label would be a
// second name for one act.
//
// THE THREE CONJUNCTS ARE THE EMPTY ARM'S OWN. A stream that never opened has no
// standing to say a run could be started; a read that has not landed does not know
// whether one already has; and a pane that seated a row is not empty. Only the arm
// whose sentence names the act offers it.

import { type ConsoleRefusal } from "../../core/index.js";

/** The words the button and the palette row both use. One act, one name. */
export const RUN_START_ACTION_LABEL = "Write a message";

/** What the offer is decided from: the seating, the read, and the stream. */
export interface RunStartOfferReading {
  /** How many rows the seating produced. A pane with rows is not empty. */
  readonly seatedRunCount: number;
  /** Whether the read that says WHICH RUNS EXIST has landed. */
  readonly hasRead: boolean;
  /** The refusal that closed the run-state stream, where one did. */
  readonly openRefusal: ConsoleRefusal | undefined;
}

/**
 * Whether the start act is offered — asked by the empty state and by the palette.
 *
 * Read at invoke time as well as at contribution time on the palette side: a run can
 * arrive between a row being contributed and somebody pressing Enter, and the pane's
 * own control is gone by then.
 */
export function offersRunStart(reading: RunStartOfferReading): boolean {
  return reading.seatedRunCount === 0 && reading.hasRead && reading.openRefusal === undefined;
}
