// The scenario catalog and the lookup by id.

import { APPROVAL_REQUEST_SCENARIO } from "./scenarios/approval-request.js";
import { WAITING_FOR_INPUT_SCENARIO } from "./scenarios/waiting-for-input.js";
import { FIRST_RUN_SCENARIO } from "./scenarios/first-run.js";
import { CONCURRENT_STREAMING_SCENARIO } from "./scenarios/concurrent-streaming.js";
import { EMPTY_SESSION_SCENARIO } from "./scenarios/empty-session.js";
import { TRANSCRIPT_STATES_SCENARIO } from "./scenarios/transcript-states.js";
import { TERMINAL_LEASE_SCENARIO } from "./scenarios/terminal-lease.js";
import type { Scenario } from "./scenarios/script.js";

/** Every scenario the fixture bridge can play. */
export const SCENARIOS: readonly Scenario[] = [
  FIRST_RUN_SCENARIO,
  CONCURRENT_STREAMING_SCENARIO,
  // The busy and the empty transcript stay separate sessions so each is reachable alone.
  TRANSCRIPT_STATES_SCENARIO,
  EMPTY_SESSION_SCENARIO,
  WAITING_FOR_INPUT_SCENARIO,
  APPROVAL_REQUEST_SCENARIO,
  TERMINAL_LEASE_SCENARIO,
];

/** Scenario lookup by id. Throws rather than returning a silent default. */
export function findScenario(scenarioId: string): Scenario {
  const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId);
  if (scenario === undefined) {
    throw new RangeError(
      `no scenario named "${scenarioId}" (have: ` +
        `${SCENARIOS.map((candidate) => candidate.id).join(", ")})`,
    );
  }
  return scenario;
}
