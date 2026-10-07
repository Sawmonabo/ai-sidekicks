// A stored run state change or intervention event is the record a rebuild reads the run from, so
// each type must carry its own state and only the members that state may carry.
import { describe, expect, it } from "vitest";

import { SessionEventSchema } from "../../event/session.js";

const SESSION_ID = "0f2b4d5e-1111-4111-8111-111111111111";
const RUN_ID = "0f2b4d5e-6666-4666-8666-666666666666";
const INTERVENTION_ID = "0f2b4d5e-7777-4777-8777-777777777777";

function storedEvent(
  type: string,
  category: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: "evt-0007",
    sessionId: SESSION_ID,
    sequence: 7,
    occurredAt: "2026-10-06T12:00:00.000Z",
    category,
    type,
    actor: null,
    payload,
    version: "1.0",
  };
}

function runEvent(newState: string, members: Record<string, unknown> = {}) {
  return storedEvent(`run.${newState}`, "run_lifecycle", {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    runVersion: 3,
    previousState: "running",
    newState,
    ...members,
  });
}

const COMPLETED_TURN = runEvent("completed", { completionKind: "turn" });

describe("stored run and intervention events", () => {
  it("round-trips a completed turn through the session event parser", () => {
    expect(SessionEventSchema.parse(COMPLETED_TURN)).toEqual(COMPLETED_TURN);
  });

  it("refuses a run.completed that does not say whether a turn or the task completed", () => {
    expect(SessionEventSchema.safeParse(runEvent("completed")).success).toBe(false);
  });

  it.each([
    [
      "run.paused naming running",
      storedEvent("run.paused", "run_lifecycle", {
        sessionId: SESSION_ID,
        runId: RUN_ID,
        runVersion: 3,
        previousState: "pausing",
        newState: "running",
      }),
    ],
    [
      "intervention.expired naming applied",
      storedEvent("intervention.expired", "interactive_request", {
        sessionId: SESSION_ID,
        interventionId: INTERVENTION_ID,
        targetRunId: RUN_ID,
        type: "steer",
        state: "applied",
      }),
    ],
  ])("refuses %s, another type's state", (_case, event) => {
    expect(SessionEventSchema.safeParse(event).success).toBe(false);
  });

  // Each member parses on its own state, so the refusal elsewhere is about where it rides.
  it.each([
    ["failureCause", "failed", "completed", { cause: "retries-exhausted", origin: "provider" }],
    ["processExit", "failed", "stopped", { exitCode: 1, outputTail: "panic: lost connection" }],
    ["providerFailureDetail", "failed", "interrupted", "driver.text_neutralization_failed"],
    ["trigger", "interrupted", "completed", "step_limit"],
    [
      "executionPosture",
      "running",
      "starting",
      { mode: "ask", writableRoots: ["/repo"], credentialPolicyRef: "policy://workspace" },
    ],
    ["intendedClose", "stopped", "paused", true],
  ])("carries %s on run.%s and refuses it on run.%s", (member, ownState, otherState, value) => {
    // `run.completed` needs its completion kind whichever side of the case it is on.
    const membersOn = (state: string) => ({
      ...(state === "completed" ? { completionKind: "task" } : {}),
      [member]: value,
    });
    expect(SessionEventSchema.safeParse(runEvent(ownState, membersOn(ownState))).success).toBe(
      true,
    );
    expect(SessionEventSchema.safeParse(runEvent(otherState, membersOn(otherState))).success).toBe(
      false,
    );
  });
});
