// A session's goal on Codex's own thread goal. The goal is the person's own `/goal`, so it goes
// out as `origin: "user"`: Codex records only such a goal in the model's history as the person's
// instruction, which its automatic reviewer reads as authorization. Codex may work on the goal in a
// turn of its own, whose run opens when that turn starts. Setting or clearing one records a
// message in the conversation, and setting one can start that turn, so each waits for a turn the
// daemon is stopping to end and goes apart from the session's turn starts.

import type {
  ClearSessionGoalParams,
  DriverGoalResult,
  SetSessionGoalParams,
} from "../contract.js";
import type { CodexRunStart } from "./run/start.js";
import type { CodexTurnEndWaiters } from "./run/turn-end-waiters.js";
import type { CodexConfigForks } from "./session/config-fork.js";
import { CodexTransportError } from "./session/errors.js";
import { type CodexSessionRecord, isTurnInFlight } from "./session/state.js";

/** Sets and clears each session's goal on its conversation. */
export class CodexSessionGoals {
  readonly #configForks: Pick<CodexConfigForks, "requireAfterForks">;
  readonly #turnEnds: Pick<CodexTurnEndWaiters, "waitForStoppedTurns">;
  readonly #runStart: Pick<CodexRunStart, "sendApartFromTurnStarts">;

  constructor(
    configForks: Pick<CodexConfigForks, "requireAfterForks">,
    turnEnds: Pick<CodexTurnEndWaiters, "waitForStoppedTurns">,
    runStart: Pick<CodexRunStart, "sendApartFromTurnStarts">,
  ) {
    this.#configForks = configForks;
    this.#turnEnds = turnEnds;
    this.#runStart = runStart;
  }

  /**
   * Binds the session's goal natively and resolves once Codex accepts it. Only `objective` is
   * sent; `status` and `tokenBudget` are provider-side state the daemon does not own. Goes as
   * {@link clear} does, and throws `session_turn_in_flight`, nothing sent, while a turn runs too.
   */
  async set(params: SetSessionGoalParams): Promise<DriverGoalResult> {
    return await this.#send(params.sessionId, async (record) => {
      if (isTurnInFlight(record)) {
        throw turnRunning(record);
      }
      await record.service.request("thread/goal/set", {
        threadId: record.threadId,
        origin: "user",
        objective: params.goalText,
      });
    });
  }

  /**
   * Clears the session's goal natively; a `cleared: false` answer is still `applied`. A turn the
   * daemon is stopping is waited on to end first, within the request deadline, past which it
   * throws `session_turn_in_flight` with nothing sent, and no turn start goes out until Codex
   * answers.
   */
  async clear(params: ClearSessionGoalParams): Promise<DriverGoalResult> {
    return await this.#send(params.sessionId, async (record) => {
      await record.service.request("thread/goal/clear", {
        threadId: record.threadId,
        origin: "user",
      });
    });
  }

  async #send(
    sessionId: SetSessionGoalParams["sessionId"],
    request: (record: CodexSessionRecord) => Promise<void>,
  ): Promise<DriverGoalResult> {
    const record = await this.#configForks.requireAfterForks(sessionId);
    await this.#runStart.sendApartFromTurnStarts(record, async () => {
      if (!(await this.#turnEnds.waitForStoppedTurns(record))) {
        throw turnRunning(record);
      }
      await request(record);
    });
    return { status: "applied" };
  }
}

function turnRunning(record: CodexSessionRecord): CodexTransportError {
  return new CodexTransportError(
    `Codex session "${record.sessionId}" has a turn running, so its goal was not changed.`,
    { sessionId: record.sessionId, reason: "session_turn_in_flight" },
  );
}
