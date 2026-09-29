// Does a scenario script events the daemon can actually emit?
//
// This is the predicate that reads every scenario in `fixtures/scenarios/`. It sits in
// the helpers rather than in one test because a test that reimplemented the rule would
// be checking its own copy of it, and because the rule has to be one function for every
// scenario to be held to it: a scenario added with a defect fails here without its
// author having to know this module exists.
//
// WHAT WIRE TRUTH IS, AND WHERE EACH LEG LIVES. `packages/contracts/src/event.ts`
// ships three schemas a scenario is measured against, and every beat meets all three,
// then the rules those schemas do not carry: the run state machine and the
// run-lifecycle payloads that have no registered variant. Not one of them is restated
// below: each is read off the single module in this tree that already owns it, so a
// beat this predicate admits is a beat the consumer of that rule admits too.
//
// One axis per module, each carrying the reasoning for its own:
//
//   • `beat-shape.ts`: the census, the canonical envelope, and the strict layer, in
//     that order, for every beat.
//   • `run-and-queue-semantics.ts`: the run state machine's transition table, the
//     queue payload's required member, the registered payloads of the four run kinds
//     no narrowed stream projects, and the registered projection `run.subscribeState`
//     delivers for the nine it does.
//   • `beat-order.ts`: the tick a beat is due at and the log position it occupies.
//   • `reply-checks.ts`: one scripted answer per call, and one spendable latency on
//     that answer.
//   • `caller-defects.ts`: the caller identity a scenario states.
//   • `scenario-contract-defect.ts`: what a defect is.
//
// WHERE A BEAT'S MEMBERS COME FROM WHEN THE STRICT LAYER REGISTERS NO VARIANT. The
// census and the strict layer are what this predicate can execute, and they are not the
// whole registry: the event taxonomy names a registered type's members whether or not
// the variant for it has landed in code yet.
//
// So "`packages/contracts` names no members for this type" is never a reason for a
// scenario to decline a beat. A scenario that scripts such a type carries every member
// the taxonomy makes required of an emitter, because a partial row teaches a view to
// read a shape no daemon produces: the same class of defect as an invented member, and
// one nothing here can catch. A scenario that declines the beat declines it for a
// reason about the session it is scripting, and says which.

import { describeBeatDefect } from "./beat-shape.js";
import { findBeatOrderDefects } from "./beat-order.js";
import type { ScenarioContractDefect } from "./scenario-contract-defect.js";
import { describeCallerDefect } from "./caller-defects.js";
import { findReplyDefects } from "./reply-checks.js";
import type { Scenario } from "../../../fixtures/scenario.js";

export type { ScenarioContractDefect };

/** Every wire-truth defect across the given scenarios. Empty is the passing state. */
export function findScenarioContractDefects(
  scenarios: readonly Scenario[],
): readonly ScenarioContractDefect[] {
  const defects: ScenarioContractDefect[] = [];
  for (const scenario of scenarios) {
    for (const [beatIndex, beat] of scenario.beats.entries()) {
      const reason = describeBeatDefect(beat);
      if (reason !== undefined) {
        defects.push({
          scenarioId: scenario.id,
          subject: `beat ${String(beatIndex)} (${beat.event.kind})`,
          reason,
        });
      }
    }
    defects.push(...findBeatOrderDefects(scenario));
    defects.push(...findReplyDefects(scenario));
    const callerDefect = describeCallerDefect(scenario);
    if (callerDefect !== undefined) {
      defects.push(callerDefect);
    }
  }
  return defects;
}
