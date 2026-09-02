// One scripted answer per call.

import type { ScenarioWireTruthDefect } from "./defect.js";
import type { ConsoleScenario } from "../../scenario.js";

/**
 * Replies whose `call` another reply in the same scenario already claims.
 *
 * `replyFor` answers with the FIRST match, so a second entry for one call is a
 * scripted answer that can never be served — and the two are usually a rename and
 * its leftover, where the leftover is the one that wins.
 */
export function findDuplicateReplyCalls(
  scenario: ConsoleScenario,
): readonly ScenarioWireTruthDefect[] {
  const seenCalls = new Set<string>();
  const defects: ScenarioWireTruthDefect[] = [];
  for (const reply of scenario.replies) {
    if (seenCalls.has(reply.call)) {
      defects.push({
        scenarioId: scenario.id,
        subject: `reply "${reply.call}"`,
        reason:
          "a second reply claims this call, and the fixture serves the first — so this one " +
          "is unreachable. Keep one entry per call.",
      });
      continue;
    }
    seenCalls.add(reply.call);
  }
  return defects;
}
