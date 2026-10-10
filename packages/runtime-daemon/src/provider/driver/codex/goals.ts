// A session's goal on Codex's own thread goal. The goal is the person's own `/goal`, so it goes
// out as `origin: "user"`: Codex records only such a goal in the model's history as the person's
// instruction, which its automatic reviewer reads as authorization. Codex may work on the goal in a
// turn of its own, whose run opens when that turn starts.

import type { DriverGoalResult } from "../contract.js";
import { CodexTransportError } from "./session/errors.js";
import { type CodexSessionRecord, isTurnInFlight } from "./session/state.js";

/**
 * Binds the session's goal natively and resolves once Codex accepts it. Only `objective` is sent;
 * `status` and `tokenBudget` are provider-side state the daemon does not own. Throws
 * `session_turn_in_flight`, before anything is sent, while a turn runs: the queue holds the goal.
 */
export async function setCodexSessionGoal(
  record: CodexSessionRecord,
  goalText: string,
): Promise<DriverGoalResult> {
  if (isTurnInFlight(record)) {
    throw new CodexTransportError(
      `Codex session "${record.sessionId}" has a turn running, so its goal waits.`,
      { sessionId: record.sessionId, reason: "session_turn_in_flight" },
    );
  }
  await record.service.request("thread/goal/set", {
    threadId: record.threadId,
    origin: "user",
    objective: goalText,
  });
  return { status: "applied" };
}

/** Clears the session's goal natively; a `cleared: false` answer is still `applied`. */
export async function clearCodexSessionGoal(record: CodexSessionRecord): Promise<DriverGoalResult> {
  await record.service.request("thread/goal/clear", { threadId: record.threadId, origin: "user" });
  return { status: "applied" };
}
