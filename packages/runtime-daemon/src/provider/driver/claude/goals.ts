// A session goal on Claude Code is its own `/goal` command, sent as a command message for Claude
// Code to run as the session's own run: `/goal <condition>` sets or replaces the goal and
// `/goal clear` removes it. The goal is applied once Claude Code answers the command: its command
// output, or a `result` that reports no error.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { mintUuidV7 } from "../../../uuid-v7.js";
import type { DriverGoalResult } from "../contract.js";
import type { ClaudeHandshakeRegister } from "./handshake-register.js";
import type { ClaudeDaemonTurnOpening } from "./run/start.js";
import type { LiveClaudeSession } from "./session/state.js";
import { CLAUDE_REQUEST_DEADLINE_MS } from "./session/transport.js";

// Bare, as `system/init` lists `slash_commands`.
const CLAUDE_GOAL_COMMAND_NAME = "goal";

// The frame a local command answers with on the stream.
const CLAUDE_COMMAND_OUTPUT_FRAME_KIND = "system/local_command_output";

/** How Claude Code answered one goal command, or `timed_out` when it sent nothing in time. */
type ClaudeGoalReply = "applied" | "refused" | "timed_out";

/** Starts a turn the daemon starts on a session itself as the session's own run. */
type ClaudeDaemonTurnStarter = (
  live: LiveClaudeSession,
  opening: ClaudeDaemonTurnOpening,
) => Promise<void>;

/** Sends goal commands and reads each one's answer off the session's own stream. */
export class ClaudeGoalCommands {
  readonly #startDaemonTurn: ClaudeDaemonTurnStarter;
  readonly #waitingBySession: Map<SessionId, (reply: ClaudeGoalReply) => void> = new Map();

  constructor(startDaemonTurn: ClaudeDaemonTurnStarter) {
    this.#startDaemonTurn = startDaemonTurn;
  }

  /**
   * Sends `/goal <goalText>`, or `/goal clear` when `goalText` is `undefined`, as the session's
   * own run and resolves once Claude Code answers it: `applied`, or `degraded` when it reported an
   * error, sent no answer within the request deadline, or its handshake lists no `goal` command, in
   * which case nothing is sent. Throws as the run's start throws, `session_turn_in_flight` while
   * another run holds the session's turn.
   */
  async send(
    live: LiveClaudeSession,
    handshakes: ClaudeHandshakeRegister,
    goalText: string | undefined,
  ): Promise<DriverGoalResult> {
    const held = handshakes.heldHandshakeFor(live.sessionId, live.providerSessionId);
    if (held === undefined || !held.invocableCommandNames.has(CLAUDE_GOAL_COMMAND_NAME)) {
      return { status: "degraded" };
    }
    const reply = this.#awaitReply(live.sessionId);
    try {
      await this.#startDaemonTurn(live, {
        kind: "text",
        text: {
          text: `/${CLAUDE_GOAL_COMMAND_NAME} ${goalText ?? "clear"}`,
          origin: "driver_command",
        },
        messageId: mintUuidV7(),
      });
    } catch (error) {
      this.#settle(live.sessionId, "refused");
      throw error;
    }
    return (await reply) === "applied" ? { status: "applied" } : { status: "degraded" };
  }

  /** Reads one frame of a session's own thread for the goal command it is waiting on. */
  observeLeadFrame(
    sessionId: SessionId,
    frameKind: string,
    frame: Readonly<Record<string, unknown>>,
  ): void {
    if (frameKind === CLAUDE_COMMAND_OUTPUT_FRAME_KIND) {
      this.#settle(sessionId, "applied");
    } else if (frame["type"] === "result") {
      this.#settle(sessionId, frame["is_error"] === true ? "refused" : "applied");
    }
  }

  /** Settles a goal command waiting on a session whose process is gone. */
  forgetSession(sessionId: SessionId): void {
    this.#settle(sessionId, "timed_out");
  }

  // One command waits per session; a second replaces the first, which reads as unanswered.
  #awaitReply(sessionId: SessionId): Promise<ClaudeGoalReply> {
    this.#settle(sessionId, "timed_out");
    return new Promise<ClaudeGoalReply>((resolve) => {
      const timer = setTimeout(() => {
        this.#settle(sessionId, "timed_out");
      }, CLAUDE_REQUEST_DEADLINE_MS);
      timer.unref();
      this.#waitingBySession.set(sessionId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  #settle(sessionId: SessionId, reply: ClaudeGoalReply): void {
    const waiting = this.#waitingBySession.get(sessionId);
    this.#waitingBySession.delete(sessionId);
    waiting?.(reply);
  }
}
