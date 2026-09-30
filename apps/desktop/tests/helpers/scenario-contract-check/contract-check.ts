// Does a scenario script events the daemon can actually emit?
//
// One predicate over every scenario in `fixtures/scenarios/`, so a scenario added with a defect
// fails here without its author knowing this module exists. Every beat meets the three schemas in
// `@ai-sidekicks/contracts` (`beat-shape.ts`), then the rules those schemas do not carry,
// each read off the module that owns it: run and queue semantics, beat order, replies and the
// caller identity, one module per axis.
//
// The taxonomy names a registered type's members whether or not the strict variant has landed, so
// "the contracts package names no members for this type" never justifies a partial row: a scenario
// scripting such a type carries every member the taxonomy requires of an emitter.

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
