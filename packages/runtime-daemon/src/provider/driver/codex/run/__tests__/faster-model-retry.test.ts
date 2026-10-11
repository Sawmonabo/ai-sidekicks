// An interrupt of a run retrying on a faster model goes out at once and stops the retry, wherever
// the retry is: waiting for its held turn to end, forking, or with its new turn already sent. A
// retry stopped once its fork began leaves the session on the fork, and a fork that fails leaves
// the session on its own conversation and model.

import { describe, expect, it } from "vitest";

import { drainMicrotasks } from "../../../../__fixtures__/drain-microtasks.js";
import type { FasterModelRetryOutcome } from "../../../run-control.js";
import {
  createHarness,
  createdSession,
  deliveriesOf,
  type Harness,
  RUN_ID,
  runConfig,
  SECOND_RUN_ID,
  SESSION_ID,
  TEST_MODEL,
  THREAD_ID,
  turnCompletedFrame,
} from "../../__fixtures__/app-server-doubles.js";

// A live session whose turn starts answer `turn-1`, `turn-2` and on, running `turn-1` for the run.
async function runningSession(): Promise<Harness> {
  const harness = createHarness();
  let started = 0;
  harness.server.on("turn/start", () => {
    started += 1;
    return { result: { turn: { id: `turn-${started}` } } };
  });
  harness.server.on("turn/interrupt", () => ({ result: {} }));
  await createdSession(harness);
  await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
  return harness;
}

function retryOnFasterModel(harness: Harness): Promise<FasterModelRetryOutcome> {
  return harness.driver.retryTurnOnFasterModel({
    sessionId: SESSION_ID,
    runId: RUN_ID,
    expectedTurnId: "turn-1",
    model: "gpt-5.5-mini",
  });
}

function failedRunDeliveries(harness: Harness): unknown[] {
  return deliveriesOf(harness, "run_lifecycle").filter(
    (delivery) => delivery.change.newState === "failed",
  );
}

describe("an interrupt of a run retrying on a faster model", () => {
  // Mutations: leaving the retry out of the interrupt refuses it with no live turn; going on after
  // the held turn's end forks and sends the message again into the interrupted run; answering the
  // interrupt before the held turn's commands stop leaves them running.
  it("stops a retry waiting for its held turn to end, which then forks and sends nothing", async () => {
    const harness = await runningSession();
    harness.server.on("thread/backgroundTerminals/list", () => ({
      result: { data: [{ processId: 41 }], nextCursor: null },
    }));
    const retried = retryOnFasterModel(harness);
    await drainMicrotasks();

    await harness.driver.interruptRun({ runId: RUN_ID });
    harness.server.emitFrame(turnCompletedFrame("turn-1", "interrupted"));

    await expect(retried).resolves.toStrictEqual({
      state: "rejected",
      rejectionReason: "The run was interrupted.",
    });
    expect(harness.server.framesForMethod("turn/interrupt")).toHaveLength(1);
    expect(harness.server.paramsFor("thread/backgroundTerminals/terminate")).toStrictEqual([
      { threadId: THREAD_ID, processId: 41 },
    ]);
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(0);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
    expect(failedRunDeliveries(harness)).toStrictEqual([]);
    // The interrupted run continues on the conversation it had.
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go on") });
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(2);
  });

  // Mutations: sending the retry's turn whatever an interrupt asked meanwhile runs the message
  // again in a run the interrupt ended; answering the interrupt before the fork settles lets a
  // continue race the session's move onto the fork.
  it("withdraws the turn of a retry still forking, leaving the session on the fork", async () => {
    const harness = await runningSession();
    harness.server.on("turn/interrupt", () => ({
      result: {},
      trailingFrames: [turnCompletedFrame("turn-1", "interrupted")],
    }));
    const releaseFork = harness.server.holdAnswers("thread/fork");
    const retried = retryOnFasterModel(harness);
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(1);

    let isInterruptAnswered = false;
    const interrupted = harness.driver.interruptRun({ runId: RUN_ID }).then(() => {
      isInterruptAnswered = true;
    });
    await drainMicrotasks();
    expect(isInterruptAnswered).toBe(false);
    releaseFork();
    await interrupted;

    await expect(retried).resolves.toMatchObject({ state: "rejected" });
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
    expect(failedRunDeliveries(harness)).toStrictEqual([]);
    expect(
      harness.server.framesForMethod("thread/unsubscribe").map((frame) => frame["params"]),
    ).toContainEqual({ threadId: THREAD_ID });
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go on") });
    const continued = harness.server.framesForMethod("turn/start").at(-1)?.["params"];
    expect(continued).toMatchObject({ collaborationMode: { settings: { model: "gpt-5.5-mini" } } });
    expect(continued).not.toMatchObject({ threadId: THREAD_ID });
  });

  // Mutation: keeping the faster model once its fork failed sends every later turn on a model the
  // session never moved to.
  it("leaves the session on its own model when the retry's fork fails", async () => {
    const harness = await runningSession();
    harness.server.on("turn/interrupt", () => ({
      result: {},
      trailingFrames: [turnCompletedFrame("turn-1", "interrupted")],
    }));
    harness.server.on("thread/fork", () => ({ error: { code: -32600, message: "fork refused" } }));

    await expect(retryOnFasterModel(harness)).rejects.toThrow(
      "Failed to retry with a faster model",
    );
    await harness.driver.startRun({ runId: SECOND_RUN_ID, agentConfig: runConfig("next") });

    expect(harness.server.framesForMethod("turn/start").at(-1)?.["params"]).toMatchObject({
      threadId: THREAD_ID,
      collaborationMode: { settings: { model: TEST_MODEL } },
    });
  });

  // Mutation: taking the retry as stopped once its turn is sent leaves that turn running in a run
  // the interrupt ended.
  it("stops the turn a retry already sent once Codex answers it", async () => {
    const harness = await runningSession();
    harness.server.on("turn/interrupt", () => ({
      result: {},
      trailingFrames: [turnCompletedFrame("turn-1", "interrupted")],
    }));
    const releaseStart = harness.server.holdAnswers("turn/start");
    const retried = retryOnFasterModel(harness);
    await drainMicrotasks();
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(2);

    const interrupted = harness.driver.interruptRun({ runId: RUN_ID });
    await drainMicrotasks();
    releaseStart();
    await interrupted;

    await expect(retried).resolves.toStrictEqual({ state: "applied" });
    expect(
      harness.server.framesForMethod("turn/interrupt").map((frame) => frame["params"]),
    ).toMatchObject([{ turnId: "turn-1" }, { turnId: "turn-2" }]);
  });
});
