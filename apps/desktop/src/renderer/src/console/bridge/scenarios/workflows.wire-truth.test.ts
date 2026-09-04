// Are the workflows scenario's beats events a daemon could actually have emitted?
//
// Answered by driving the SHIPPED predicate — `findScenarioWireTruthDefects` — rather
// than by restating its rules here; a local copy would go green against a rule nobody
// ships. What the fixture DATA carries is a different question, and its own claim
// about content rather than shape, so it lives in the sibling suites beside this one:
// `workflows.replies.test.ts`, `workflows.runs.test.ts`,
// `workflows.definitions.test.ts`, `workflows.phase-outputs.test.ts`, and
// `workflows.chronology.test.ts`.

import { describe, expect, it } from "vitest";

import { WORKFLOWS_SCENARIO } from "./workflows.js";
import { findScenarioWireTruthDefects } from "./wire-truth.js";
import type { ConsoleScenario } from "../scenario.js";

describe("the workflows scenario — wire truth", () => {
  it("plays only registered event types, with the payloads those types register", () => {
    const defects = findScenarioWireTruthDefects([WORKFLOWS_SCENARIO]);

    // Printed rather than counted: a failure here has to name the beat and the reason.
    expect(defects.map((defect) => `${defect.subject} — ${defect.reason}`)).toStrictEqual([]);
  });

  it("reports a defect when a beat of this scenario is perturbed", () => {
    // The negative control for the case above. Without it that assertion would pass
    // against a predicate that never looked at this scenario at all.
    const [firstBeat, ...remainingBeats] = WORKFLOWS_SCENARIO.beats;
    if (firstBeat === undefined) {
      throw new Error("the scenario plays no beats");
    }
    const perturbed: ConsoleScenario = {
      ...WORKFLOWS_SCENARIO,
      beats: [
        { ...firstBeat, event: { ...firstBeat.event, kind: "workflow.phase_suspended" } },
        ...remainingBeats,
      ],
    };

    const defects = findScenarioWireTruthDefects([perturbed]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("not a registered event type");
  });

  it("states a viewer the session's own roster carries", () => {
    // The identity the fixture answers the caller-identity read from. Asserted here as
    // well as by the predicate because its absence is silent: every role gate would
    // read unchecked, which looks exactly like a member with no elevated role.
    expect(WORKFLOWS_SCENARIO.viewingParticipantId).toBeDefined();
    expect(WORKFLOWS_SCENARIO.participantIdsInJoinOrder).toContain(
      WORKFLOWS_SCENARIO.viewingParticipantId,
    );
  });
});
