// `lifecycle.ts` turn ends: the `result` that confirms an interrupt is never a second end of the
// run the driver delivers, whether the daemon writes the end (a refusal settled as cancelled) or
// the turn ends `interrupted` (the driver's own interrupt or an intervention's).

import { describe, expect, it, vi } from "vitest";

import { ClaudeDriver } from "../index.js";
import {
  buildCreateSessionParams,
  buildInterruptParams,
  buildStartRunParams,
  TEST_RUN_ID,
  TEST_SESSION_ID,
} from "../__fixtures__/transport-doubles.js";
import {
  armRunDispatch,
  buildHarness,
  openGate,
  spawnedChannel,
  startLiveRun,
  type LifecycleHarness,
} from "./lifecycle.test-support.js";

// The `result` Claude Code ends an interrupted turn with.
const INTERRUPTED_RESULT = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  terminal_reason: "aborted_streaming",
};

function runEnds(harness: LifecycleHarness): unknown[] {
  return harness.runMoves.filter(
    (change) => change.runId === TEST_RUN_ID && change.newState !== "waiting_for_input",
  );
}

describe("ClaudeSessionLifecycle turn end", () => {
  it("delivers an intervention's held turn end as interrupted once it is answered", async () => {
    const harness = buildHarness();
    const driver = new ClaudeDriver({
      ...harness.dependencies,
      readSpawnedVersion: () => Promise.reject(new Error("no build is read here")),
      probe: () => Promise.reject(new Error("no build is probed here")),
    });
    await driver.createSession(buildCreateSessionParams());
    const channel = spawnedChannel(harness);
    armRunDispatch(harness);
    await driver.startRun(buildStartRunParams());
    channel.emitStreamFrame("system/status");
    // The turn's end arrives while the interrupt is still unanswered.
    const { gate, release } = openGate();
    channel.controlResponseGate = gate;

    const interrupted = driver.applyIntervention(buildInterruptParams());
    await vi.waitFor(() => {
      expect(channel.controlRequests.at(-1)).toMatchObject({ subtype: "interrupt" });
    });
    channel.emitStreamFrame("result/error_during_execution", undefined, INTERRUPTED_RESULT);
    release();

    await expect(interrupted).resolves.toStrictEqual({ status: "applied" });
    // The run ends whichever of this end and the daemon's own verdict lands first.
    expect(runEnds(harness)).toStrictEqual([{ runId: TEST_RUN_ID, newState: "interrupted" }]);
  });

  it("delivers the turn end held for an interrupt that never reached Claude Code", async () => {
    const harness = buildHarness();
    const driver = new ClaudeDriver({
      ...harness.dependencies,
      readSpawnedVersion: () => Promise.reject(new Error("no build is read here")),
      probe: () => Promise.reject(new Error("no build is probed here")),
    });
    await driver.createSession(buildCreateSessionParams());
    const channel = spawnedChannel(harness);
    armRunDispatch(harness);
    await driver.startRun(buildStartRunParams());
    channel.emitStreamFrame("system/status");
    const { gate, release } = openGate();
    channel.controlResponseGate = gate;
    channel.controlRequestFailure = new Error("the pipe closed");

    const interrupted = driver.applyIntervention(buildInterruptParams());
    await vi.waitFor(() => {
      expect(channel.controlRequests.at(-1)).toMatchObject({ subtype: "interrupt" });
    });
    channel.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });
    release();

    await expect(interrupted).rejects.toThrow("the pipe closed");
    expect(runEnds(harness)).toStrictEqual([
      { runId: TEST_RUN_ID, newState: "completed", completionKind: "turn" },
    ]);
  });

  it("ends the run once, interrupted, on the driver's own interrupt", async () => {
    const harness = buildHarness();
    const channel = await startLiveRun(harness);
    channel.emitStreamFrame("system/status");

    await harness.lifecycle.interruptRun({ runId: TEST_RUN_ID });
    channel.emitStreamFrame("result/error_during_execution", undefined, INTERRUPTED_RESULT);
    channel.emitStreamFrame("result/error_during_execution", undefined, INTERRUPTED_RESULT);

    expect(runEnds(harness)).toStrictEqual([{ runId: TEST_RUN_ID, newState: "interrupted" }]);
  });

  it("settles a held refusal as cancelled in the interrupt's place, ending the run once", async () => {
    const harness = buildHarness();
    const channel = await startLiveRun(harness);
    channel.emitStreamFrame("system/status");
    channel.emitInboundRequest({
      kind: "request",
      request: {
        requestId: "dialog-1",
        subtype: "request_user_dialog",
        request: {
          subtype: "request_user_dialog",
          dialog_kind: "refusal_fallback_prompt",
          payload: { originalModel: "claude-fable-5", fallbackModel: "claude-opus-4-1" },
        },
      },
    });

    await harness.lifecycle.interruptRun({ runId: TEST_RUN_ID });
    channel.emitStreamFrame("result/error_during_execution", undefined, INTERRUPTED_RESULT);

    expect(channel.controlRequests.filter((request) => request.subtype === "interrupt")).toEqual(
      [],
    );
    expect(channel.answeredRequests).toStrictEqual([
      { requestId: "dialog-1", response: { behavior: "cancelled" } },
    ]);
    expect(runEnds(harness)).toStrictEqual([
      {
        runId: TEST_RUN_ID,
        newState: "failed",
        failureCategory: "refused",
        failureCause: { cause: "refused", origin: "provider", model: "claude-fable-5" },
      },
    ]);
    // The settlement row comes first, so the run's last row is never an open choice.
    const settledAt = harness.deliveries.findIndex(
      (delivery) =>
        delivery.kind === "unstamped_row" && delivery.row.type === "run.refusal_choice_resolved",
    );
    const endedAt = harness.deliveries.findIndex(
      (delivery) => delivery.kind === "run_lifecycle" && delivery.change.newState === "failed",
    );
    expect(settledAt).toBeGreaterThanOrEqual(0);
    expect(settledAt).toBeLessThan(endedAt);
    // A second answer finds the choice settled.
    await expect(
      harness.lifecycle.answerProviderChoice({
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        answer: { dialog: "refusal", choice: "retry_fallback" },
      }),
    ).resolves.toStrictEqual({ status: "not_pending" });
  });
});
