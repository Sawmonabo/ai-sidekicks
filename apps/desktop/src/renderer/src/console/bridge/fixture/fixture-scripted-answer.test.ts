// What a caller is handed for each of the four settlements the seam reports.
//
// `scripted-reply.test.ts` next door holds the SEAM's claim — that the fixture bridge
// and the growth port produce the same codes from the same engine states, and that
// neither turns a reply which never arrived into an absent value. This file holds the
// half that is this module's alone: the translation, and in particular the one arm
// where the CALLER decides what nothing means. A fallback that always served would
// make an unscripted run read answer with an invented run; a fallback that always
// refused would make an unscripted enumeration claim the wire was missing. Both are
// wrong, both render as a plausible pane, and neither is visible in a surface.
//
// Every case drives the real `ScenarioEngine` and the real mapping. A double would be
// asserting its own arithmetic over `abandoned`, which is a state only the engine's
// own teardown produces — and the point of the case is that this module reports the
// engine's diagnosis rather than composing a second one.
//
// The over-cap arm is deliberately not repeated here: it reaches this module through
// the same `unanswered` settlement `abandoned` does, and `scripted-reply.test.ts`
// already drives the cap itself against the port.

import { describe, expect, it } from "vitest";

import type { WireErrorEnvelope } from "../../core/index.js";
import { answerFromScriptedReply } from "./fixture-scripted-answer.js";
import type { GrowthOutcome } from "../growth-port/growth-outcome.js";
import { growthUnavailable } from "../growth-port/index.js";
import { ScenarioEngine } from "../scenario-runtime/scenario-engine.js";
import type { ConsoleScenario, ScenarioReply } from "../scenario-runtime/scenario.js";
import { WORKFLOWS_PARKED_RUN } from "../scenarios/workflow-fixture-runs.js";
import { settleScriptedReply } from "../scenario-runtime/scripted-reply.js";
import {
  PROBE_PARTICIPANT_ID,
  PROBE_SESSION_ID,
} from "../scenario-runtime/scripted-probe.test-support.js";
import type { WorkflowRunSnapshot } from "../wire-shapes/workflow-projection.js";

/** The call every snapshot case below asks for, and the operation it answers. */
const RUN_READ_CALL = "workflow.runRead";

/** Longer than one tick, so a reply parked on it is observably pending. */
const SCRIPTED_LATENCY_MS = 120;

/**
 * A scenario that scripts exactly the replies one case needs and plays no beats.
 *
 * No beats on purpose: this module never reads the event stream, and a scenario
 * carrying beats would have to be held to `scenarios/wire-truth.ts` for facts no case
 * here asserts. What it does carry is a roster and a session id, because a
 * `ConsoleScenario` without them is not one.
 */
function scenarioScripting(replies: readonly ScenarioReply[]): ConsoleScenario {
  return {
    id: "fixture-scripted-answer-probe",
    label: "Scripted-answer probe",
    purpose: "Drives the scripted-answer mapping over one settlement at a time.",
    sessionId: PROBE_SESSION_ID,
    participantIdsInJoinOrder: [PROBE_PARTICIPANT_ID],
    startedAtIso: "2026-01-01T12:00:00.000Z",
    beats: [],
    replies,
  };
}

function engineScripting(replies: readonly ScenarioReply[]): ScenarioEngine {
  return new ScenarioEngine({ scenario: scenarioScripting(replies) });
}

/**
 * The run read, scripted behind a latency.
 *
 * A function rather than a constant because two cases need two engines holding the
 * same reply, and `exactOptionalPropertyTypes` makes a present-but-`undefined`
 * `afterMs` a different value from an absent one — which is the member the seam
 * branches on.
 */
function heldRunReadReply(): ScenarioReply {
  return { call: RUN_READ_CALL, result: WORKFLOWS_PARKED_RUN, afterMs: SCRIPTED_LATENCY_MS };
}

/**
 * The run read, asked through this module with the refusing fallback the port uses.
 *
 * The fallback is the port's own rather than a local stand-in: a snapshot read has no
 * empty form, so the answer for a scenario that says nothing is the refusal, and a
 * probe that passed some other fallback would be testing a call the console never
 * makes.
 */
function readRunThroughScriptedAnswer(
  engine: ScenarioEngine,
): Promise<GrowthOutcome<WorkflowRunSnapshot>> {
  return answerFromScriptedReply(
    engine,
    RUN_READ_CALL,
    "workflowRunRead",
    { workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId },
    () => growthUnavailable("workflowRunRead"),
  );
}

describe("the scripted answer — the caller decides what an unscripted script means", () => {
  it("hands back the caller's own answer when the scenario scripts nothing", async () => {
    const engine = engineScripting([]);

    const enumeration = await answerFromScriptedReply(
      engine,
      "workflow.definitionList",
      "workflowDefinitionList",
      { sessionId: PROBE_SESSION_ID },
      () => ({ status: "served", value: { definitions: [] } }),
    );
    const snapshot = await readRunThroughScriptedAnswer(engine);

    // Two callers, two meanings of "the script said nothing", and the mapping imposes
    // neither: one operation has an empty form that is a real answer and the other has
    // none at all. A mapping that chose for them would be wrong for one of the two.
    expect(enumeration).toStrictEqual({ status: "served", value: { definitions: [] } });
    expect(snapshot.status).toBe("unavailable");
    if (snapshot.status === "unavailable") {
      expect(snapshot.operationId).toBe("workflowRunRead");
      expect(snapshot.code).toBe("wire-unregistered");
    }
    expect(snapshot).not.toHaveProperty("value");
    engine.dispose();
  });

  it("serves a scripted reply verbatim, so the fallback never runs against a stated fact", async () => {
    // The negative control for the case above: a fallback that ran regardless would
    // satisfy it and would silently replace every scripted answer with a refusal —
    // the same refusal, from the same call, with nothing to tell the two apart.
    const engine = engineScripting([{ call: RUN_READ_CALL, result: WORKFLOWS_PARKED_RUN }]);

    const outcome = await readRunThroughScriptedAnswer(engine);

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // Identity: the value is the scenario's own object rather than a copy the
      // mapping built, which is what "verbatim" has to mean for an `unknown` result.
      expect(outcome.value).toBe(WORKFLOWS_PARKED_RUN);
    }
    engine.dispose();
  });

  it("throws a scripted daemon refusal verbatim and unwrapped", async () => {
    // The one settlement that is not an outcome. A growth-scoped code for it would
    // paraphrase the daemon's own envelope, and a rejection is what the caller gets
    // once the wire lands and this becomes an ordinary bridge call. The code below is
    // deliberately arbitrary — the mapping must not read it, which is what identity on
    // the thrown value pins. The case above is its control: a resolving reply of the
    // same shape settles instead of throwing.
    const refusal: WireErrorEnvelope = {
      code: "probe.refused",
      message: "The scenario states that the daemon refused this call.",
    };
    const engine = engineScripting([{ call: RUN_READ_CALL, refusal }]);

    await expect(readRunThroughScriptedAnswer(engine)).rejects.toBe(refusal);
    engine.dispose();
  });

  it("carries the seam's own diagnosis rather than composing a second one", async () => {
    // A reply the frozen clock never released refuses by name, and the sentence a
    // person acts on is `scripted-reply.ts`'s. Compared against the seam's settlement
    // for the same engine state rather than retyped here, so one remedy cannot become
    // two spellings that drift.
    const throughScriptedAnswer = engineScripting([heldRunReadReply()]);
    const throughSeam = engineScripting([heldRunReadReply()]);
    const answerPending = readRunThroughScriptedAnswer(throughScriptedAnswer);
    const seamPending = settleScriptedReply(throughSeam, RUN_READ_CALL, {
      workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId,
    });

    throughScriptedAnswer.dispose();
    throughSeam.dispose();

    const outcome = await answerPending;
    const settlement = await seamPending;
    expect(settlement.status).toBe("unanswered");
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable" && settlement.status === "unanswered") {
      expect(outcome.code).toBe(settlement.code);
      expect(outcome.detail).toBe(settlement.detail);
      expect(outcome.operationId).toBe("workflowRunRead");
    }
    // Never an absent value: that renders as "there is none", a claim about the run
    // that nothing checked.
    expect(outcome).not.toHaveProperty("value");
  });

  it("negative control: the same held read serves once the caller advances the clock", async () => {
    // Without this, a mapping that refused every parked read would pass the case
    // above. The refusal is shown to be a state of the engine rather than the only
    // answer this arm can produce.
    const engine = engineScripting([heldRunReadReply()]);
    const pending = readRunThroughScriptedAnswer(engine);

    engine.advance(SCRIPTED_LATENCY_MS);

    await expect(pending).resolves.toStrictEqual({ status: "served", value: WORKFLOWS_PARKED_RUN });
    engine.dispose();
  });
});
