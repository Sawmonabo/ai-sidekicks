// The composer-family scenarios, held to the properties a scenario file can silently
// lose.
//
// The wire-truth predicate is the shipped one, driven rather than restated — a test
// carrying its own copy of the rule would go green against a copy nobody ships. What
// this file adds is the property that predicate deliberately does not cover, because
// it is a fact about what a scenario is FOR rather than about the event contract: a
// scripted reply names a call something can actually make. The registry carries no
// `session.list`, so a reply for it is an answer to a question no surface asks.

import { describe, expect, it } from "vitest";

import { type ConsoleScenario } from "../../../../../../../fixtures/scenario.js";
import { APPROVALS_SCENARIO } from "../approvals/approvals.js";
import { COMPOSER_SCENARIO } from "./composer.js";
import { findScenarioWireTruthDefects } from "@test/helpers/scenario-contract-check/contract-check.js";

/** The two composer-family scenarios, named once so every case below covers both. */
const FAMILY_SCENARIOS: readonly ConsoleScenario[] = [COMPOSER_SCENARIO, APPROVALS_SCENARIO];

/**
 * Calls no method registry in the corpus carries, so no surface can ever make one.
 *
 * One entry today. `session.list` is the name these scenarios once shipped with: it
 * reads exactly like a real method, and the daemon registry has `session.read` and no
 * list verb.
 */
const UNREGISTERED_CALLS: readonly string[] = ["session.list"];

/** Every scripted call in a scenario that names no registered method. */
function unregisteredScriptedCalls(scenario: ConsoleScenario): readonly string[] {
  return scenario.replies
    .map((reply) => reply.call)
    .filter((call) => UNREGISTERED_CALLS.includes(call));
}

describe("the composer family's scenarios are wire-true", () => {
  it("plays only registered event types, with the payloads those types register", () => {
    const defects = findScenarioWireTruthDefects(FAMILY_SCENARIOS);

    // Printed in full rather than counted: the beat and the reason are what a reader
    // needs, not the number of things wrong.
    expect(
      defects.map((defect) => `${defect.scenarioId}: ${defect.subject} — ${defect.reason}`),
    ).toStrictEqual([]);
  });

  it("negative control: the predicate reports the defect these files used to carry", () => {
    // Without this the case above could be passing over a predicate that reports
    // nothing at all. The defect driven here is the exact one this lane repaired —
    // `agent.attached` carrying a `displayName` the wire does not have — expressed
    // on a kind the strict layer DOES register, so the control fails for its own
    // reason rather than for the absence of a variant.
    const defects = findScenarioWireTruthDefects([
      {
        ...COMPOSER_SCENARIO,
        id: "composer-control",
        beats: [
          {
            atMs: 0,
            event: {
              id: "019b7a11-1100-7e00-8110-e5e0c115c001",
              sessionId: COMPOSER_SCENARIO.sessionId,
              sequence: 1,
              kind: "session.created",
              occurredAt: COMPOSER_SCENARIO.startedAtIso,
              payload: { sessionId: COMPOSER_SCENARIO.sessionId, displayName: "Composer" },
            },
          },
        ],
      },
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("rejects this beat");
  });
});

describe("every scripted reply names a call something can make", () => {
  it.each(FAMILY_SCENARIOS)("$id scripts no unregistered method", (scenario) => {
    expect(unregisteredScriptedCalls(scenario)).toStrictEqual([]);
  });

  it("negative control: the check reports a scenario that scripts one", () => {
    const control: ConsoleScenario = {
      ...COMPOSER_SCENARIO,
      id: "composer-control",
      replies: [{ call: "session.list", result: { sessions: [] } }],
    };

    expect(unregisteredScriptedCalls(control)).toStrictEqual(["session.list"]);
  });
});

describe("every scenario states which user this window is", () => {
  it.each(FAMILY_SCENARIOS)("$id names a caller inside its own roster", (scenario) => {
    expect(scenario.callerUserId).toBeDefined();
    expect(scenario.userIdsInJoinOrder).toContain(scenario.callerUserId);
  });
});
