// The scenario lookup: a scenario by its id, out of the catalog in `corpus.ts`.

import type { ConsoleScenario } from "../../../../../../fixtures/scenario.js";
import { CONSOLE_SCENARIOS } from "../../../../../../fixtures/index.js";

/** Scenario lookup by id. Throws rather than returning a silent default. */
export function consoleScenario(scenarioId: string): ConsoleScenario {
  const scenario = CONSOLE_SCENARIOS.find((candidate) => candidate.id === scenarioId);
  if (scenario === undefined) {
    throw new RangeError(
      `no console scenario named "${scenarioId}" (have: ${CONSOLE_SCENARIOS.map((candidate) => candidate.id).join(", ")})`,
    );
  }
  return scenario;
}
