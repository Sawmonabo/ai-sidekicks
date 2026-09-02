// One settled read, the four ways it can finish, and who each refusal names as author.
//
// The daemon-refusal case drives the REAL scripted-reply adapter over a real scenario
// engine rather than throwing a hand-made envelope at the helper: the claim is that the
// shape that seam throws is the shape this module settles, and a locally invented
// envelope would agree with whatever this module happened to expect.
//
// The two pass-through cases are the control on every rejection case below. A helper
// that refused everything would satisfy all of them while replacing the fixture's own
// answers with a refusal no surface could tell from a real one.

import { describe, expect, it } from "vitest";

import type { WireErrorEnvelope } from "../../../../shared/wire-errors.js";
import { growthUnavailable } from "../bridge/index.js";
import type { GrowthOutcome } from "../bridge/growth-outcome.js";
import type { GrowthOperationSignatures } from "../bridge/growth-signatures.js";
import { ScenarioEngine, type ConsoleScenario } from "../bridge/scenario.js";
import { answerFromScriptedReply } from "../bridge/scripted-reply-adapter.js";
import { ConsoleRefusalError, refuse } from "../core/index.js";
import {
  DAEMON_REFUSAL_ORIGIN,
  READ_REJECTED_REFUSAL_CODE,
  READ_SETTLEMENT_REFUSAL_ORIGIN,
  settleGrowthRead,
} from "./read-settlement.js";

const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";
const PROBE_PARTICIPANT_ID = "019b7a12-0280-79a4-8110-cca0117a0401";

/** The refusal the scenario below scripts, in the envelope a daemon sends. */
const SCRIPTED_DAEMON_REFUSAL: WireErrorEnvelope = {
  code: "workflow.session_not_found",
  message: "No session with that id is open on this node.",
};

/** What the enumeration answers with, read from the signature table rather than retyped. */
type DefinitionListValue = GrowthOperationSignatures["workflowDefinitionList"]["value"];

/**
 * A scenario that scripts one daemon refusal for the definition enumeration.
 *
 * No beats: nothing here reads the event stream, and beats would have to be held to the
 * wire-truth layer for facts no case below asserts.
 */
function scenarioRefusingTheEnumeration(): ConsoleScenario {
  return {
    id: "read-settlement-probe",
    label: "Read settlement probe",
    purpose: "Scripts a daemon refusal for the definition enumeration, and nothing else.",
    sessionId: PROBE_SESSION_ID,
    participantIdsInJoinOrder: [PROBE_PARTICIPANT_ID],
    startedAtIso: "2026-01-01T12:00:00.000Z",
    beats: [],
    replies: [{ call: "workflow.definitionList", refusal: SCRIPTED_DAEMON_REFUSAL }],
  };
}

/** The enumeration, asked through the same seam the fixture's own port asks it through. */
function enumerationThroughTheSeam(
  engine: ScenarioEngine,
): Promise<GrowthOutcome<DefinitionListValue>> {
  return answerFromScriptedReply(
    engine,
    "workflow.definitionList",
    "workflowDefinitionList",
    () => ({
      status: "served",
      value: { definitions: [] },
    }),
  );
}

describe("settleGrowthRead — a fulfilled outcome is the port's, untouched", () => {
  it("passes a served outcome through by identity", async () => {
    const served = { status: "served", value: { definitions: [] } } as const;

    await expect(settleGrowthRead(Promise.resolve(served))).resolves.toBe(served);
  });

  it("passes the port's own refusal through with everything it knows", async () => {
    // The control for every rejection case below: a helper that rebuilt refusals would
    // drop `operationId`, `slateRow`, and the document that owes the wire, and those are
    // what make a growth refusal actionable rather than merely typed.
    const refused = growthUnavailable("workflowDefinitionList");

    await expect(settleGrowthRead(Promise.resolve(refused))).resolves.toBe(refused);
  });
});

describe("settleGrowthRead — a rejection becomes a refusal, and names its author", () => {
  it("carries a scripted daemon refusal's own code and message, unreworded", async () => {
    const engine = new ScenarioEngine({ scenario: scenarioRefusingTheEnumeration() });

    const settled = await settleGrowthRead(enumerationThroughTheSeam(engine));

    // Verbatim on both halves. A console that composed its own sentence here would be
    // quoting a refusal it had edited, which rule 9 forbids.
    expect(settled).toStrictEqual({
      status: "unavailable",
      code: SCRIPTED_DAEMON_REFUSAL.code,
      detail: SCRIPTED_DAEMON_REFUSAL.message,
      origin: DAEMON_REFUSAL_ORIGIN,
    });
    engine.dispose();
  });

  it("negative control: the same seam without this helper rejects rather than settling", async () => {
    // Without this case the one above would pass over a seam that had been returning an
    // outcome all along, and the defect it fixes — an unhandled rejection leaving a
    // surface in `reading` forever — would be invisible.
    const engine = new ScenarioEngine({ scenario: scenarioRefusingTheEnumeration() });

    await expect(enumerationThroughTheSeam(engine)).rejects.toBe(SCRIPTED_DAEMON_REFUSAL);
    engine.dispose();
  });

  it("carries a refusal thrown inside a console refusal error verbatim", async () => {
    const raised = refuse(
      "workflow-authoring",
      "workflow.control_denied",
      "You are not admitted to read definitions at the shared scope on this node.",
    );

    const settled = await settleGrowthRead(Promise.reject(new ConsoleRefusalError(raised)));

    // The origin survives the relay, which is the whole reason it is on the shape.
    expect(settled).toStrictEqual({ ...raised, status: "unavailable" });
  });

  it("carries a bare thrown refusal verbatim too", async () => {
    const raised = refuse("persistence", "persistence.quota_exceeded", "The store is full.");

    const settled = await settleGrowthRead(Promise.reject(raised));

    expect(settled).toStrictEqual({ ...raised, status: "unavailable" });
  });

  it("names a rejection that carries no refusal, rather than swallowing it", async () => {
    const settled = await settleGrowthRead(Promise.reject(new Error("the bridge closed mid-read")));

    expect(settled.code).toBe(READ_REJECTED_REFUSAL_CODE);
    expect(settled.origin).toBe(READ_SETTLEMENT_REFUSAL_ORIGIN);
    // The thrown text is carried: a read that failed for a reason nobody can read is
    // indistinguishable from one that was never put.
    expect(settled.detail).toContain("the bridge closed mid-read");
  });

  it("renders a rejection whose own stringification throws, instead of throwing with it", async () => {
    // A read whose failure cannot be described must still settle. This is the arm the
    // shared stringifier exists for: a bare `String(...)` here rethrows inside the very
    // handler meant to absorb the first failure.
    const unrepresentable: object = Object.create(null) as object;

    const settled = await settleGrowthRead(Promise.reject(unrepresentable));

    expect(settled.code).toBe(READ_REJECTED_REFUSAL_CODE);
    expect(settled.status).toBe("unavailable");
  });
});
