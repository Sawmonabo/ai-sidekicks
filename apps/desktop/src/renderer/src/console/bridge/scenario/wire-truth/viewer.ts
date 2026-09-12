// The viewer a scenario states.
//
// One claim, and the defect it catches renders as nothing at all rather than as
// anything wrong — which is why a predicate has to hold every scenario to it.

import type { ScenarioWireTruthDefect } from "./defect.js";
import type { ConsoleScenario } from "../runtime/index.js";

/**
 * A stated viewer who is not in the session, or `undefined` when the scenario is sound.
 *
 * `viewingParticipantId` is what the caller-identity read answers with, and every
 * surface that attributes what it renders to this window resolves it by looking that
 * id up in the session's own participant projection. An id outside
 * `participantIdsInJoinOrder` resolves to nothing there, so the window's own rows are
 * attributed to nobody — which is invisible in the fixture, because it looks exactly
 * like a session nobody is looking at.
 *
 * Scoped to scenarios that STATE one: an absent viewer is the deliberate state the
 * fixture refuses the caller-identity read from, not a defect.
 */
export function describeViewerDefect(
  scenario: ConsoleScenario,
): ScenarioWireTruthDefect | undefined {
  const { viewingParticipantId } = scenario;
  if (viewingParticipantId === undefined) {
    return undefined;
  }
  if (scenario.participantIdsInJoinOrder.includes(viewingParticipantId)) {
    return undefined;
  }
  return {
    scenarioId: scenario.id,
    subject: `viewingParticipantId "${viewingParticipantId}"`,
    reason:
      "the stated viewer is not in `participantIdsInJoinOrder`, so no surface can " +
      "resolve them in this session's own participants. Name a participant the " +
      "scenario actually joins, or leave the field absent and let the caller-identity " +
      "read refuse.",
  };
}
