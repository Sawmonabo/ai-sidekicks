// `subagent-policy.ts`: the concurrency gate that holds a session's subagents to their cap.

import { describe, expect, it } from "vitest";

import { makeSilentDriverDiagnostics } from "../../../../__fixtures__/silent-driver-diagnostics.js";
import { ClaudeSessionUnavailableError } from "../session/errors.js";
import { ClaudeSubagentConcurrencyGate } from "../subagent-policy.js";
import { TEST_SESSION_ID } from "./test-doubles.js";

function buildGate(maxConcurrent: number): ClaudeSubagentConcurrencyGate {
  return new ClaudeSubagentConcurrencyGate({
    sessionId: TEST_SESSION_ID,
    diagnostics: makeSilentDriverDiagnostics(),
    maxConcurrent,
  });
}

describe("ClaudeSubagentConcurrencyGate", () => {
  it("never admits beyond the cap, across a hand-over race and a double release", async () => {
    // A release that woke its waiter in a later microtask would leave a window in which a third
    // caller takes the slot the waiter was promised.
    const gate = buildGate(1);
    const releaseFirst = await gate.admit("subagent-a");
    const secondAdmission = gate.admit("subagent-b");
    releaseFirst();
    const thirdAdmission = gate.admit("subagent-c");
    expect(gate.heldSlotCount).toBe(1);
    const releaseSecond = await secondAdmission;
    releaseSecond();
    releaseSecond();
    await thirdAdmission;
    expect(gate.heldSlotCount).toBe(1);

    // A cap below one is floored at one rather than deadlocking every call.
    const flooredGate = buildGate(0);
    await flooredGate.admit("subagent-a");
    expect(flooredGate.heldSlotCount).toBe(1);
  });

  it("fails every waiter and every later admission once disposed", async () => {
    // A waiter left pending on a gone process would hang the provider turn.
    const gate = buildGate(1);
    await gate.admit("holder");
    const waiting = gate.admit("waiter");

    gate.dispose();

    await expect(waiting).rejects.toBeInstanceOf(ClaudeSessionUnavailableError);
    await expect(gate.admit("later")).rejects.toBeInstanceOf(ClaudeSessionUnavailableError);
  });
});
