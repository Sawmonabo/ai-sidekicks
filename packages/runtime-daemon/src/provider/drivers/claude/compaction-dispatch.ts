// Dispatching the provider's `/compact` command frame on a live Claude channel and waiting for the
// typed compaction frame that proves it ran.

import type { DriverCompactionResult, SessionId } from "@ai-sidekicks/contracts";
import type { PendingCompactionRegistry } from "../../compaction-wait.js";
import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import type { OutboundTextFrameWriter } from "../../outbound-frame.js";
import {
  CLAUDE_COMPACTION_COMMAND_TEXT,
  CLAUDE_COMPACTION_FRAME_ORIGIN,
  CLAUDE_COMPACTION_WAIT_MS,
  type ClaudeSessionChannel,
  type ClaudeUserTextWriteAttempt,
} from "./session-transport.js";
import { describeFailure, sanitizeFailureDetail } from "./session-errors.js";
import { attemptClaudeFrameWrite } from "./text-neutralization.js";

/** The lifecycle's compaction waits, frame writer and diagnostics the dispatch runs over. */
export interface ClaudeCompactionDispatchDependencies {
  readonly pendingCompactions: PendingCompactionRegistry;
  readonly outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly diagnostics: DriverDiagnosticsEmitter;
}

/**
 * Sends `/compact` on a channel whose binding lists the command and answers `applied` only on the
 * typed compaction frame, recording every other terminal as a diagnostic.
 */
export class ClaudeCompactionDispatch {
  readonly #pendingCompactions: PendingCompactionRegistry;
  readonly #outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly #diagnostics: DriverDiagnosticsEmitter;

  constructor(dependencies: ClaudeCompactionDispatchDependencies) {
    this.#pendingCompactions = dependencies.pendingCompactions;
    this.#outboundTextFrameWriter = dependencies.outboundTextFrameWriter;
    this.#diagnostics = dependencies.diagnostics;
  }

  /** Arms the wait, writes the command frame and settles on the wait's terminal. */
  async dispatchCompaction(
    sessionId: SessionId,
    channel: ClaudeSessionChannel,
  ): Promise<DriverCompactionResult> {
    // Armed before dispatch so a fast compaction is not lost; any early exit withdraws it.
    const wait = this.#pendingCompactions.arm(sessionId, CLAUDE_COMPACTION_WAIT_MS);
    let attempt: ClaudeUserTextWriteAttempt;
    try {
      // Not registered with the tripwire: a pending frame would make `startRun` refuse until a
      // terminal that never comes.
      const frame = this.#outboundTextFrameWriter.compose({
        text: CLAUDE_COMPACTION_COMMAND_TEXT,
        // A literal: a forwarded value could carry user words under the tripwire exemption.
        origin: CLAUDE_COMPACTION_FRAME_ORIGIN,
      });
      attempt = await attemptClaudeFrameWrite(channel, frame);
    } catch (cause) {
      // Withdraw first, or the armed timer outlives the caller. Composition calls an injected
      // minter that may throw; rethrown, since nothing was refused or dispatched.
      wait.abandon();
      throw cause;
    }
    if (attempt.settled === "failed") {
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
    // Only the two non-observed terminals are recorded; an applied compaction is ordinary success.
    this.#diagnostics.emit({
      provider: "claude",
      kind: "compaction_wait_terminal",
      rawWireType: null,
      dispositionReason:
        observed.terminal === "wait_expired"
          ? "the declared compaction bound elapsed with no typed compaction frame; a later boundary still projects"
          : "the provider binding was lost while a compaction wait was armed",
      details: { sessionId, terminal: observed.terminal },
    });
    return { status: "failed", reason: observed.terminal };
  }
}
