// The boundary a run executed under, read the one way for every surface that shows it.
//
// ONE FACT, TWO TRANSPORTS, AND A STATED PRECEDENCE. The daemon stamps the execution
// posture on `run.running` exactly once, and that event reaches this window twice: as
// a `RunStateChangeEvent` on the runs pane's own subscription, and as a durable entry
// the session store folds through the ordinary apply chokepoint. Both are honest
// derivations of the same stamp, so neither is wrong — but two surfaces each reading
// a different one can render different postures for one run while the two are landing,
// with nothing to say which ordering was right.
//
// SO THE STORE READING WINS AND THE STREAM IS THE NAMED FALLBACK. The store's entry is
// the durable one — it survives a reopened subscription, it is what the approvals pane
// reads to say which boundary a decision is about, and it is validated through the
// registered parse (`bridge/`'s `stampedExecutionPostureOf`). The stream projection is
// consulted only for a run the partition does not carry yet, which is a real case: a
// run the stream has described before the snapshot caught up seats a row, and dropping
// its posture would replace a known boundary with an unknown one.
//
// WHAT IT DOES NOT DO. It does not merge the two, and it does not decide that one of
// them is stale: an absent store reading is absent — never `trusted`, never a default
// — and the chip's own absent arm renders that as the fact it is.

import type { ExecutionPosture } from "@ai-sidekicks/contracts";

import { stampedExecutionPostureOf } from "../../bridge/index.js";
import type { ConsoleEntity } from "../../store/index.js";

/**
 * The posture to show for one run, from the durable entry where there is one.
 *
 * `undefined` where neither source carries a stamp — a run that has not reached
 * `running`, or one whose stamp this build could not validate.
 */
export function settledRunPosture(
  entity: ConsoleEntity | undefined,
  projected: ExecutionPosture | undefined,
): ExecutionPosture | undefined {
  return stampedExecutionPostureOf(entity) ?? projected;
}
