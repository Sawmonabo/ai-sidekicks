// The scenario catalog: every scenario the fixture can play, and the lookup by id.
//
// ORDER IS PICKER ORDER. The scenario switcher renders these in array order, so this list
// is also what a person sees. First run comes first because it is the one that makes sense
// with nothing else loaded.

import { APPROVALS_SCENARIO } from "./scenarios/approval-request.js";
import { COMPOSER_SCENARIO } from "./scenarios/waiting-for-input.js";
import { FIRST_RUN_SCENARIO } from "./scenarios/first-run.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/concurrent-streaming.js";
import { LEDGER_QUIET_SCENARIO } from "./scenarios/empty-session.js";
import { LEDGER_SCENARIO } from "./scenarios/transcript-states.js";
import { TERMINAL_SCENARIO } from "./scenarios/terminal-lease.js";
import type { ConsoleScenario } from "./scenario.js";

/** Every scenario the fixture bridge can play, in picker order. */
export const CONSOLE_SCENARIOS: readonly ConsoleScenario[] = [
  FIRST_RUN_SCENARIO,
  FLAGSHIP_SCENARIO,
  // The transcript, busy and empty: two states worth pinning, which folding into one
  // session would make reachable only through each other's noise.
  LEDGER_SCENARIO,
  LEDGER_QUIET_SCENARIO,
  COMPOSER_SCENARIO,
  APPROVALS_SCENARIO,
  TERMINAL_SCENARIO,
];

/** Scenario lookup by id. Throws rather than returning a silent default. */
export function findScenario(scenarioId: string): ConsoleScenario {
  const scenario = CONSOLE_SCENARIOS.find((candidate) => candidate.id === scenarioId);
  if (scenario === undefined) {
    throw new RangeError(
      `no scenario named "${scenarioId}" (have: ${CONSOLE_SCENARIOS.map((candidate) => candidate.id).join(", ")})`,
    );
  }
  return scenario;
}
