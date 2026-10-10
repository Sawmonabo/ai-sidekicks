// Dispatching the provider's `/compact` command frame on a live Claude channel and waiting for the
// typed compaction frame that proves it ran. Claude Code runs the command as a turn of its own, so
// it holds the session's turn until that turn settles.

import type { DriverCompactionResult } from "@ai-sidekicks/contracts/provider/driver/compaction";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { mintUuidV7 } from "../../../uuid-v7.js";
import {
  COMPACTION_WAIT_FAILURE_DETAIL,
  type PendingCompactionRegistry,
} from "../../compaction-wait.js";
import type { DriverDiagnosticsEmitter } from "../diagnostics.js";
import { CLAUDE_COMPACTION_COMMAND_TEXT, type ClaudeProviderProcess } from "./session/transport.js";
import type { ClaudeRunRoutes } from "./run/routes.js";
import {
  ClaudeSessionUnavailableError,
  describeFailure,
  sanitizeFailureDetail,
} from "./session/errors.js";
import { attemptClaudeFrameWrite } from "./session/stdin-write.js";

/** The lifecycle's compaction waits and diagnostics the dispatch runs over. */
export interface ClaudeCompactionDispatchDependencies {
  readonly pendingCompactions: PendingCompactionRegistry;
  readonly runRoutes: ClaudeRunRoutes;
  readonly diagnostics: DriverDiagnosticsEmitter;
}

/**
 * Sends `/compact` on a channel whose binding lists the command and answers `applied` only on the
 * typed compaction frame, recording every other terminal as a diagnostic.
 */
export class ClaudeCompactionDispatch {
  readonly #pendingCompactions: PendingCompactionRegistry;
  readonly #runRoutes: ClaudeRunRoutes;
  readonly #diagnostics: DriverDiagnosticsEmitter;

  constructor(dependencies: ClaudeCompactionDispatchDependencies) {
    this.#pendingCompactions = dependencies.pendingCompactions;
    this.#runRoutes = dependencies.runRoutes;
    this.#diagnostics = dependencies.diagnostics;
  }

  /**
   * Holds the session's turn, arms the wait, writes the command and settles on the wait's
   * terminal. Throws `session_turn_in_flight` while a run or another command holds the turn.
   */
  async dispatchCompaction(
    sessionId: SessionId,
    channel: ClaudeProviderProcess,
  ): Promise<DriverCompactionResult> {
    if (this.#runRoutes.isTurnHeld(sessionId)) {
      throw new ClaudeSessionUnavailableError("session_turn_in_flight", { sessionId });
    }
    // Held before the write, so no run starts into the command's turn, whose `result` would end it.
    this.#runRoutes.holdTurnForCommand(sessionId);
    // Armed before dispatch so a fast compaction is not lost; any early exit withdraws it.
    const wait = this.#pendingCompactions.arm(sessionId);
    // A command for Claude Code to run, so it goes unmarked.
    const attempt = await attemptClaudeFrameWrite(
      channel,
      { text: CLAUDE_COMPACTION_COMMAND_TEXT, origin: "driver_command" },
      mintUuidV7(),
    );
    if (attempt.settled === "failed") {
      // Text that never left starts no turn to release the hold; bytes that may have been taken
      // can still start one, whose end releases it.
      if (attempt.delivery === "unsent") {
        this.#runRoutes.releaseCommandTurn(sessionId);
      }
      // `provider_error` for both deliveries: this frame opens no turn, so the driver cannot say a
      // compaction happened. Withdrawn, not settled: settling is per key and would report this
      // failure to a concurrent waiter.
      wait.abandon();
      // The delivery rides the diagnostic: `unsent` never reached the provider, while
      // `indeterminate` may have been applied with the acknowledgement lost.
      this.#diagnostics.emit({
        provider: "claude",
        kind: "compaction_wait_terminal",
        rawWireType: null,
        dispositionReason: sanitizeFailureDetail(describeFailure(attempt.cause)),
        details: {
          sessionId,
          terminal: "provider_error",
          delivery: attempt.delivery,
        },
      });
      return { status: "failed", reason: "provider_error" };
    }

    const observed = await wait.settled;
    if (observed.terminal === "observed") {
      return { status: "applied", boundaryPosition: observed.boundaryPosition };
    }
    // An applied compaction is ordinary success; every other end is recorded.
    this.#diagnostics.emit({
      provider: "claude",
      kind: "compaction_wait_terminal",
      rawWireType: null,
      dispositionReason: COMPACTION_WAIT_FAILURE_DETAIL[observed.terminal],
      details: { sessionId, terminal: observed.terminal },
    });
    return { status: "failed", reason: observed.terminal };
  }
}
