// The caller identity a scenario states. The defect renders as nothing rather than as anything
// wrong, so a predicate must hold every scenario to it.

import type { ScenarioContractDefect } from "./scenario-contract-defect.js";
import type { Scenario } from "../../../fixtures/scenario.js";

/**
 * A stated caller who is not in the session, or `undefined` when the scenario is sound.
 *
 * `callerUserId` is what the caller-identity read answers with, and views resolve it against the
 * session's user projection. An id outside `userIdsInJoinOrder` resolves to nothing, so the
 * window's own rows are attributed to nobody, which looks like a session nobody is viewing.
 * Only scenarios that state one are checked: an absent caller is the deliberate state in which
 * the fixture refuses the caller-identity read.
 */
export function describeCallerDefect(scenario: Scenario): ScenarioContractDefect | undefined {
  const { callerUserId } = scenario;
  if (callerUserId === undefined) {
    return undefined;
  }
  if (scenario.userIdsInJoinOrder.includes(callerUserId)) {
    return undefined;
  }
  return {
    scenarioId: scenario.id,
    subject: `callerUserId "${callerUserId}"`,
    reason:
      "the stated caller is not in `userIdsInJoinOrder`, so no view can " +
      "resolve them in this session's own users. Name a user the " +
      "scenario actually joins, or leave the field absent and let the caller-identity " +
      "read refuse.",
  };
}
