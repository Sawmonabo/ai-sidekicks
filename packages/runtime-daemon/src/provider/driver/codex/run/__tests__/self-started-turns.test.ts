// A turn Codex starts by itself: its run opens once, a failed open lets the turn's frames go on
// without trying again, and an ask raised while the run opens waits for it rather than being
// refused.

import { describe, expect, it } from "vitest";

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";

import { drainMicrotasks } from "../../../../__fixtures__/drain-microtasks.js";
import {
  AGENT_ID,
  createHarness,
  createdSession,
  deliveriesOf,
  type Harness,
  THREAD_ID,
} from "../../__fixtures__/app-server-doubles.js";

const GOAL_TURN_ID = "turn-goal";

function emitGoalTurnStarted(harness: Harness): void {
  harness.server.emitFrame({
    jsonrpc: "2.0",
    method: "turn/started",
    params: { threadId: THREAD_ID, turn: { id: GOAL_TURN_ID, status: "inProgress" } },
  });
}

describe("a turn Codex started by itself", () => {
  it("tries its run once when the open fails, and lets the turn's frames go on", async () => {
    // Trying again from the released `turn/started` would write a queued and a failed run forever.
    // A second open never settles, so a try again shows as a second run, not as a loop.
    let openCount = 0;
    const harness = createHarness({
      openDaemonTurnBinding: async () => {
        openCount += 1;
        if (openCount > 1) {
          return await new Promise<never>(() => undefined);
        }
        throw new Error("the run queue is not registered");
      },
    });
    await createdSession(harness);

    emitGoalTurnStarted(harness);
    await drainMicrotasks();

    expect(harness.daemonTurnRunIds).toHaveLength(1);
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "provider-turn-run-failed"),
    ).toHaveLength(1);
  });

  it("holds an approval raised while the run opens, then asks it on that run", async () => {
    const opened = Promise.withResolvers<{ bindingId: string; agentId: AgentId }>();
    const harness = createHarness({ openDaemonTurnBinding: async () => await opened.promise });
    await createdSession(harness);
    emitGoalTurnStarted(harness);
    await drainMicrotasks();

    const asked = harness.server.askProvider("item/commandExecution/requestApproval", {
      threadId: THREAD_ID,
      turnId: GOAL_TURN_ID,
    });
    // Not refused while the turn has no route yet: the ask waits for the run.
    await expect(asked).rejects.toThrow("never answered");
    expect(deliveriesOf(harness, "permission_ask")).toStrictEqual([]);

    opened.resolve({ bindingId: "binding-goal", agentId: AGENT_ID as AgentId });
    await drainMicrotasks();

    expect(deliveriesOf(harness, "permission_ask").map((ask) => ask.bindingId)).toStrictEqual([
      "binding-goal",
    ]);
  });
});
