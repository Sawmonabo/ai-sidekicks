// The boundary a run executed under, read the one way for every surface that shows it.
//
// ONE FACT, TWO TRANSPORTS, AND A STATED SCOPE. The daemon stamps the execution
// posture on `run.running` exactly once, and that event reaches this window twice: as
// a `RunStateChangeEvent` on the runs pane's own subscription, and as a durable entry
// the session store folds through the ordinary apply chokepoint. Both are honest
// derivations of the same stamp, so neither is wrong — but two surfaces each reading
// a different one can render different postures for one run while the two are landing,
// with nothing to say which ordering was right.
//
// SO THE SCOPE IS SETTLED BEFORE THE SOURCE IS. The stamp lands on `run.running` alone
// — the post-setup-gate transition where the resolved root and effective posture are
// final — and is absent on every other transition. A stamp therefore describes the run
// that is executing under it and nothing else, so a reading is offered only while the
// source it is read from still says the run is running. Both sources take that same
// gate, and the gate is what makes the two agree instead of racing.
//
// IT IS NEEDED ON BOTH BECAUSE BOTH RETAIN. The store's entity is written by a SPREAD
// MERGE, so a later paused, completed, or rewound event that omits the member leaves
// the old value on the body — the entity's `state` is what moves, and it is what says
// whether the retained stamp is still this run's. The stream's fold clears the member
// per event (`run-state-projection.ts` writes the delivered event's own member and
// never the held one), so its clearing is already explicit; the gate below is what
// keeps a STALE PROJECTION from re-admitting a boundary through the other source.
//
// AND WITHIN THAT SCOPE THE STREAM ANSWERS FIRST. Its fold is the explicit per-event
// one and it is the live reading, so a fresh stamp is on screen without waiting for
// the durable entry to land. The durable entry is the named fallback for the one gap
// the stream genuinely has: a run whose `run.running` landed before this subscription
// opened carries no stamp on the stream at all, and dropping it would replace a known
// boundary with an unknown one.
//
// WHAT IT DOES NOT DO. It does not merge the two, and it never invents one: absence
// is absence — never `trusted`, never a default — and the chip's own absent arm
// renders that as the fact it is.

import type { ExecutionPosture, RunState } from "@ai-sidekicks/contracts";

import { stampedExecutionPostureOf } from "../../bridge/index.js";
import type { ConsoleEntity } from "../../store/index.js";
import type { RunProjection } from "./run-state-projection.js";

/**
 * The one state a posture is stamped on, and therefore the only one it describes.
 *
 * Named once because both readings below are gated on it, and a second spelling of a
 * wire state is how one of the two stops matching.
 */
const POSTURE_STAMPING_STATE: RunState = "running";

/**
 * The posture to show for one run, from whichever source still describes it.
 *
 * `undefined` where the run is no longer running, and equally where neither source
 * carries a stamp for a run that is — a run that never reached `running`, or one
 * whose stamp this build could not validate.
 */
export function settledRunPosture(
  entity: ConsoleEntity | undefined,
  projection: RunProjection,
): ExecutionPosture | undefined {
  if (projection.state !== POSTURE_STAMPING_STATE) {
    return undefined;
  }
  return projection.executionPosture ?? retainedRunPosture(entity);
}

/**
 * The durable entry's stamp, where that entry still says the run is running.
 *
 * The state check is the whole of this function: `stampedExecutionPostureOf` validates
 * the VALUE against the registered parse and says nothing about whether it is current,
 * and on a merged body those are different questions.
 */
function retainedRunPosture(entity: ConsoleEntity | undefined): ExecutionPosture | undefined {
  return entity?.state === POSTURE_STAMPING_STATE ? stampedExecutionPostureOf(entity) : undefined;
}
