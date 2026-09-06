// Which runs this pane's decisions are about, and the boundary each of them ran under.
//
// THE PANE HOLDS NO RUN OF ITS OWN, so "the addressed run" has to be derived from
// something the pane already reads — and there is exactly one honest source: every
// approval record carries the `runId` that raised it, required on the wire. A person
// deciding whether an agent may write a file is deciding about one particular run,
// and the boundary that run is executing under is the fact that makes the decision
// answerable. So the pane shows a posture per run its PENDING decisions name, in the
// order those decisions are listed, and shows none for a run nothing is asking about.
//
// THE POSTURE ITSELF IS READ, NEVER SUBSCRIBED TO HERE. `run.running` reaches the
// session store through the ordinary apply chokepoint and `bridge/`'s
// `stampedExecutionPostureOf` narrows the run entity's body through the registered
// parse. Opening the run-state subscription for it would be a second arrival path for
// one fact, with no way to say which ordering was right when the two disagreed.
//
// AN UNSTAMPED RUN IS CARRIED, NOT DROPPED. A run that has not reached `running`, or
// one whose stamp this build could not validate, yields `undefined` — and the row
// still appears, because "this decision is about a run whose boundary is unknown" is
// exactly the reading the chip's absent arm exists to render. Filtering it out would
// turn missing evidence into silence.

import type { ExecutionPosture } from "@ai-sidekicks/contracts";

import { stampedExecutionPostureOf, type ApprovalRecord } from "../../../bridge/index.js";
import type { ConsoleEntity } from "../../../store/index.js";

/** One run a decision is about, with the boundary the daemon stamped on it. */
export interface AddressedRunPosture {
  readonly runId: string;
  readonly posture: ExecutionPosture | undefined;
}

/**
 * The distinct runs named by these records, each with its stamped posture.
 *
 * Deduplicated in first-appearance order: several requests raised by one turn name
 * one run, and rendering that run's boundary once per request would say the same
 * thing three times and imply three boundaries.
 */
export function addressedRunPostures(
  records: readonly ApprovalRecord[],
  runEntities: Readonly<Record<string, ConsoleEntity>>,
): readonly AddressedRunPosture[] {
  const seen = new Set<string>();
  const addressed: AddressedRunPosture[] = [];
  for (const record of records) {
    if (seen.has(record.runId)) {
      continue;
    }
    seen.add(record.runId);
    addressed.push({
      runId: record.runId,
      posture: stampedExecutionPostureOf(runEntities[record.runId]),
    });
  }
  return addressed;
}
