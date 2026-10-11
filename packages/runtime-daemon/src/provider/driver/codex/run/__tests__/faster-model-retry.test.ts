// An interrupt of a run retrying on a faster model goes out at once and stops the retry, wherever
// the retry is: waiting for its held turn to end, forking, or with its new turn already sent.

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
  SESSION_ID,
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
  // the held turn's end forks and sends the message again into the interrupted run.
  it("stops a retry waiting for its held turn to end, which then forks and sends nothing", async () => {
    const harness = await runningSession();
    const retried = retryOnFasterModel(harness);
    await drainMicrotasks();

    await harness.driver.interruptRun({ runId: RUN_ID });
    harness.server.emitFrame(turnCompletedFrame("turn-1", "interrupted"));

    await expect(retried).resolves.toStrictEqual({
      state: "rejected",
      rejectionReason: "The run was interrupted.",
    });
    expect(harness.server.framesForMethod("turn/interrupt")).toHaveLength(1);
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(0);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
    expect(failedRunDeliveries(harness)).toStrictEqual([]);
    // The interrupted run continues on the conversation it had.
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go on") });
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(2);
  });

  // Mutation: sending the retry's turn whatever an interrupt asked meanwhile runs the message again
  // in a run the interrupt ended.
  it("withdraws the turn of a retry still forking", async () => {
    const harness = await runningSession();
    harness.server.on("turn/interrupt", () => ({
      result: {},
      trailingFrames: [turnCompletedFrame("turn-1", "interrupted")],
    }));
    const releaseFork = harness.server.holdAnswers("thread/fork");
    const retried = retryOnFasterModel(harness);
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(1);

    await harness.driver.interruptRun({ runId: RUN_ID });
    releaseFork();

    await expect(retried).resolves.toMatchObject({ state: "rejected" });
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
    expect(failedRunDeliveries(harness)).toStrictEqual([]);
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
