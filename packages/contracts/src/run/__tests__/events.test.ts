// A stored run state change or intervention event is the record a rebuild reads the run from, so
// each type must carry its own state and no member only another state carries. The rows a
// provider delivery produces are read back by the transcript, the agent tree and recovery, so
// each must parse as its producer builds it.
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
        actor: "daemon",
      }),
    ],
  ])("refuses %s, another type's state", (_case, event) => {
    expect(SessionEventSchema.safeParse(event).success).toBe(false);
  });

  // Each member parses on its own state, so the refusal elsewhere is about where it rides.
  it.each([
    ["failureCause", "failed", "completed", { cause: "retries-exhausted", origin: "provider" }],
    ["processExit", "failed", "stopped", { exitCode: 1, outputTail: "panic: lost connection" }],
    ["providerFailureDetail", "failed", "interrupted", "The conversation file was not found"],
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

const STAMP = { sourceEpoch: 1, sourcePosition: 4 };
const SUBAGENT = {
  sessionId: SESSION_ID,
  runId: RUN_ID,
  provider: "claude",
  subagentId: "task_01k9wq4m2h",
  parentToolCallId: "toolu_01",
};
const MARKER = { sessionId: SESSION_ID, runId: RUN_ID, runVersion: 3 };

describe("stored rows a provider delivery produces", () => {
  it.each([
    storedEvent("run.provider_initialized", "run_lifecycle", {
      ...MARKER,
      provider: "codex",
      model: "gpt-5.5",
    }),
    storedEvent("run.turn_started", "run_lifecycle", { ...MARKER, position: 2 }),
    storedEvent("run.worker_shutdown", "run_lifecycle", { ...MARKER, reason: "Server restarting" }),
    storedEvent("subagent.started", "tool_activity", SUBAGENT),
    storedEvent("subagent.completed", "tool_activity", { ...SUBAGENT, ...STAMP }),
    storedEvent("session.provider_status", "session_lifecycle", {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      provider: "claude",
      status: "requesting",
      ...STAMP,
    }),
    storedEvent("intervention.failed", "interactive_request", {
      sessionId: SESSION_ID,
      interventionId: INTERVENTION_ID,
      targetRunId: RUN_ID,
      type: "faster_model_retry",
      state: "failed",
      actor: "daemon",
      failureReason: "Codex refused the fork",
    }),
  ])("round-trips $type through the session event parser", (event) => {
    expect(SessionEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    [
      "a run marker carrying a state change's members",
      storedEvent("run.turn_started", "run_lifecycle", {
        ...MARKER,
        previousState: "running",
        newState: "running",
      }),
    ],
    [
      "a stamped subagent row with no run",
      storedEvent("subagent.started", "tool_activity", {
        sessionId: SESSION_ID,
        provider: "claude",
        subagentId: "task_01k9wq4m2h",
        ...STAMP,
      }),
    ],
    [
      "a provider status stamped with no run",
      storedEvent("session.provider_status", "session_lifecycle", {
        sessionId: SESSION_ID,
        provider: "codex",
        status: "idle",
        ...STAMP,
      }),
    ],
    [
      "a failed intervention with no reason",
      storedEvent("intervention.failed", "interactive_request", {
        sessionId: SESSION_ID,
        interventionId: INTERVENTION_ID,
        targetRunId: RUN_ID,
        type: "steer",
        state: "failed",
        actor: "daemon",
      }),
    ],
    [
      "a reason on an applied intervention",
      storedEvent("intervention.applied", "interactive_request", {
        sessionId: SESSION_ID,
        interventionId: INTERVENTION_ID,
        targetRunId: RUN_ID,
        type: "steer",
        state: "applied",
        actor: "daemon",
        failureReason: "Codex refused the fork",
      }),
    ],
  ])("refuses %s", (_case, event) => {
    expect(SessionEventSchema.safeParse(event).success).toBe(false);
  });
});
