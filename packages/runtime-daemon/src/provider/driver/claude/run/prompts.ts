// The newest message the daemon sent each Claude session: a conversation cut names it as the last
// one Claude Code saw, and a turn too long for the context window hands it back to the person.
// With it, each run's steers Claude Code has not yet replayed as taken: Claude Code starts its next
// turn with a message a turn ended without taking, so the run those steers went to goes on into it.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

// One run's steers Claude Code has not replayed, and the session they were written to.
interface UntakenSteers {
  readonly sessionId: SessionId;
  readonly messageUuids: Set<string>;
}

/** The newest message sent to each session's live process, by the uuid its user frame carried. */
export class ClaudeSentPrompts {
  readonly #newestBySession: Map<SessionId, string> = new Map();
  readonly #untakenSteersByRun: Map<RunId, UntakenSteers> = new Map();

  /** Records a message written to the session's process as its newest. */
  recordSent(sessionId: SessionId, messageUuid: string): void {
    this.#newestBySession.set(sessionId, messageUuid);
  }

  /** Records a steer written into `runId`'s turn as its newest message, not yet taken. */
  recordSteer(sessionId: SessionId, runId: RunId, messageUuid: string): void {
    this.recordSent(sessionId, messageUuid);
    const untaken = this.#untakenSteersByRun.get(runId) ?? { sessionId, messageUuids: new Set() };
    untaken.messageUuids.add(messageUuid);
    this.#untakenSteersByRun.set(runId, untaken);
  }

  /** Claude Code replayed `messageUuid`: it took that message off its input. */
  recordTaken(messageUuid: string): void {
    for (const untaken of this.#untakenSteersByRun.values()) {
      untaken.messageUuids.delete(messageUuid);
    }
  }

  /** Whether a steer written into `runId`'s turn waits in Claude Code's input, not yet taken. */
  hasUntakenSteer(runId: RunId): boolean {
    return (this.#untakenSteersByRun.get(runId)?.messageUuids.size ?? 0) > 0;
  }

  /**
   * Forgets a message taken back before Claude Code read it, the newest no more, and answers the
   * run it was a steer into, if any.
   */
  forgetSent(sessionId: SessionId, messageUuid: string): RunId | undefined {
    if (this.#newestBySession.get(sessionId) === messageUuid) {
      this.#newestBySession.delete(sessionId);
    }
    for (const [runId, untaken] of this.#untakenSteersByRun) {
      if (untaken.messageUuids.delete(messageUuid)) {
        return runId;
      }
    }
    return undefined;
  }

  /** The newest message sent to the session's process, if one is known. */
  newestFor(sessionId: SessionId): string | undefined {
    return this.#newestBySession.get(sessionId);
  }

  /** Forgets the steers of a run that has ended. */
  forgetRun(runId: RunId): void {
    this.#untakenSteersByRun.delete(runId);
  }

  /**
   * Forgets the session's newest message and its runs' steers, cut from its conversation or gone
   * with its process.
   */
  forgetSession(sessionId: SessionId): void {
    this.#newestBySession.delete(sessionId);
    for (const [runId, untaken] of this.#untakenSteersByRun) {
      if (untaken.sessionId === sessionId) {
        this.#untakenSteersByRun.delete(runId);
      }
    }
  }
}
