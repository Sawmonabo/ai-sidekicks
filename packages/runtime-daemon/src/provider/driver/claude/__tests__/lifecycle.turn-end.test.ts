// `lifecycle.ts` turn ends: the `result` that confirms an interrupt is never a second end of the
// run the driver delivers, whether the daemon writes the end (a refusal settled as cancelled) or
// the turn ends `interrupted` (the driver's own interrupt or an intervention's); and the turn
// Claude Code starts by itself once a run's turn ended gets a run of its own.

import { describe, expect, it, vi } from "vitest";

import { ClaudeDriver } from "../index.js";
import { CLAUDE_HOOK_CALLBACK_IDS } from "../hooks/registration.js";
import {
  buildCreateSessionParams,
  buildInterruptParams,
  buildStartRunParams,
  buildSteerParams,
  type FakeClaudeProviderProcess,
  TEST_RUN_ID,
  TEST_SESSION_ID,
} from "../__fixtures__/transport-doubles.js";
import {
  armRunDispatch,
  buildHarness,
  createLiveSession,
  daemonTurnRunId,
  openGate,
  SANDBOXED_POSTURE,
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
  // Mutation: delivering the held end unmarked has the daemon record it as a late event when its
  // own verdict landed first.
  it("delivers an intervention's held turn end as interrupted once it is answered", async () => {
    const harness = buildHarness();
    const driver = new ClaudeDriver({
      ...harness.dependencies,
      readBuild: () => Promise.reject(new Error("no build is read here")),
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
    // The run ends whichever of this end and the daemon's own verdict lands first, and lands
    // second as the interrupt's own end, which the daemon absorbs without a diagnostic.
    expect(runEnds(harness)).toStrictEqual([{ runId: TEST_RUN_ID, newState: "interrupted" }]);
    expect(harness.deliveries.find((delivery) => delivery.kind === "run_lifecycle")).toMatchObject({
      isDaemonInterruptEnd: true,
    });
  });

  it("delivers the turn end held for an interrupt that never reached Claude Code", async () => {
    const harness = buildHarness();
    const driver = new ClaudeDriver({
      ...harness.dependencies,
      readBuild: () => Promise.reject(new Error("no build is read here")),
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

  // Mutation: dropping the frames of a turn no run holds leaves the kept message untaken and the
  // turn's reply off the record.
  it("opens the session's own run for the turn Claude Code starts by itself with a kept message", async () => {
    const taken: { readonly messageId: string; readonly runId: string }[] = [];
    const harness = buildHarness({
      onMessageTaken: (_sessionId, messageId, runId) => {
        taken.push({ messageId, runId });
      },
    });
    const starts = vi.spyOn(harness.dependencies.runEngine, "startDaemonTurn");
    const channel = await createLiveSession(harness, { executionPosture: SANDBOXED_POSTURE });
    armRunDispatch(harness);
    await harness.lifecycle.startRun(buildStartRunParams());
    channel.emitStreamFrame("system/init");
    channel.emitStreamFrame("result/error_during_execution", undefined, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "the model's service failed",
    });

    // Claude Code starts its next turn with the message the failed turn left it.
    const keptMessageId = "6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    channel.emitStreamFrame("system/init");
    channel.emitStreamFrame("user", undefined, {
      type: "user",
      isReplay: true,
      uuid: keptMessageId,
      message: { role: "user", content: "also run the tests" },
    });
    await vi.waitFor(() => {
      expect(taken).toStrictEqual([{ messageId: keptMessageId, runId: daemonTurnRunId(1) }]);
    });
    channel.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });

    expect(starts.mock.calls.map(([request]) => request.isProviderStarted)).toStrictEqual([true]);
    expect(harness.runMoves.map((change) => [change.runId, change.newState])).toStrictEqual([
      [TEST_RUN_ID, "failed"],
      [daemonTurnRunId(1), "completed"],
    ]);
  });

  // Mutations: opening a run of its own for the turn, or ending the paused run with that turn,
  // each fail it.
  it("keeps a paused run paused through the turn Claude Code starts by itself, which it takes", async () => {
    const taken: { readonly messageId: string; readonly runId: string }[] = [];
    const harness = buildHarness({
      onMessageTaken: (_sessionId, messageId, runId) => {
        taken.push({ messageId, runId });
      },
    });
    const starts = vi.spyOn(harness.dependencies.runEngine, "startDaemonTurn");
    const channel = await createLiveSession(harness, { executionPosture: SANDBOXED_POSTURE });
    armRunDispatch(harness);
    await harness.lifecycle.startRun(buildStartRunParams());
    channel.emitStreamFrame("system/init");
    harness.lifecycle.pauseRun({ sessionId: TEST_SESSION_ID, runId: TEST_RUN_ID });
    channel.emitInboundRequest({
      kind: "request",
      request: {
        requestId: "pause-1",
        subtype: "hook_callback",
        request: {
          subtype: "hook_callback",
          callback_id: CLAUDE_HOOK_CALLBACK_IDS.pauseAfterBatch,
          input: {},
        },
      },
    });
    channel.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });

    const keptMessageId = "6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    channel.emitStreamFrame("system/init");
    channel.emitStreamFrame("user", undefined, {
      type: "user",
      isReplay: true,
      uuid: keptMessageId,
      message: { role: "user", content: "also run the tests" },
    });
    channel.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });

    await vi.waitFor(() => {
      expect(taken).toStrictEqual([{ messageId: keptMessageId, runId: TEST_RUN_ID }]);
    });
    expect(starts).not.toHaveBeenCalled();
    expect(harness.runMoves.map((change) => [change.runId, change.newState])).toStrictEqual([
      [TEST_RUN_ID, "paused"],
    ]);
  });

  // Mutations: leaving the run carried after its steer was taken back, or reading the turn as
  // completed before its refusal, each fail one leg.
  it.each([
    {
      leg: "a run that went on for a steer ends once that steer is taken back",
      act: async (driver: ClaudeDriver, channel: FakeClaudeProviderProcess) => {
        channel.emitStreamFrame("result/success", undefined, {
          type: "result",
          subtype: "success",
        });
        channel.controlResponse = { subtype: "success", response: { cancelled: true } };
        await expect(
          driver.withdrawQueuedMessage({
            sessionId: TEST_SESSION_ID,
            runId: TEST_RUN_ID,
            clientIdempotencyKey: buildSteerParams("").clientIdempotencyKey,
          }),
        ).resolves.toStrictEqual({ status: "withdrawn" });
      },
      end: { runId: TEST_RUN_ID, newState: "completed", completionKind: "turn" },
    },
    {
      leg: "a refused turn with a steer waiting ends refused",
      act: async (_driver: ClaudeDriver, channel: FakeClaudeProviderProcess) => {
        channel.emitStreamFrame("assistant", undefined, {
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: "refusal",
            model: "claude-fable-5",
            content: [],
          },
        });
        channel.emitStreamFrame("result/success", undefined, {
          type: "result",
          subtype: "success",
        });
        await Promise.resolve();
      },
      end: {
        runId: TEST_RUN_ID,
        newState: "failed",
        failureCategory: "refused",
        failureCause: { cause: "refused", origin: "provider", model: "claude-fable-5" },
      },
    },
  ])("$leg", async ({ act, end }) => {
    const harness = buildHarness();
    const driver = new ClaudeDriver({
      ...harness.dependencies,
      readBuild: () => Promise.reject(new Error("no build is read here")),
    });
    await driver.createSession(buildCreateSessionParams());
    const channel = spawnedChannel(harness);
    armRunDispatch(harness);
    await driver.startRun(buildStartRunParams());
    channel.emitStreamFrame("system/init");
    await driver.applyIntervention(buildSteerParams("also run the tests"));

    await act(driver, channel);

    await vi.waitFor(() => {
      expect(runEnds(harness)).toStrictEqual([end]);
    });
  });
});
