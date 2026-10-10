// Starting a run on a Codex session: the run's binding becomes the session's, and a start that
// fails gives it back only while no later start has taken it since.

import { describe, expect, it } from "vitest";

import { drainMicrotasks } from "../../../../__fixtures__/drain-microtasks.js";
import type { RuntimeBindingRebind } from "../../../../runtime-binding-store.js";
import {
  createHarness,
  createdSession,
  RUN_ID,
  runConfig,
  SECOND_RUN_ID,
  SESSION_ID,
  turnCompletedFrame,
} from "../../__fixtures__/app-server-doubles.js";

describe("two starts on one binding", () => {
  it("keeps the binding the second start set when the first start fails after it", async () => {
    // Given back, the session would hold no binding, so its next fork would record nowhere and a
    // daemon restart would resume the conversation it left.
    const rebinds: RuntimeBindingRebind[] = [];
    const harness = createHarness({
      rebindRuntimeBinding: async (rebind) => {
        rebinds.push(rebind);
        await Promise.resolve();
      },
    });
    await createdSession(harness);
    let started = 0;
    harness.server.on("turn/start", () => {
      started += 1;
      return started === 1
        ? { error: { code: -32600, message: "turn refused" } }
        : { result: { turn: { id: `turn-${started}` } } };
    });
    const releaseStarts = harness.server.holdAnswers("turn/start");
    const refused = harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("first") });
    await drainMicrotasks();
    const second = harness.driver.startRun({
      runId: SECOND_RUN_ID,
      agentConfig: runConfig("second"),
    });
    await drainMicrotasks();

    releaseStarts();
    await expect(refused).rejects.toThrow("turn refused");
    await second;
    harness.server.emitFrame(turnCompletedFrame("turn-2", "completed"));
    await drainMicrotasks();
    // A level move forks the idle conversation onto the session's own binding.
    await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
    await drainMicrotasks();

    expect(rebinds.map((rebind) => rebind.bindingId)).toStrictEqual(["binding-abc"]);
  });
});
