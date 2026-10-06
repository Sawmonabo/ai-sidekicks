// The run-to-session routes of the Codex leg: which session each run's live turns are on, and the
// lookups that turn a frame's join key back into its run.

import type { RunId } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { type CodexSessionRecord, newestActiveTurnForRun } from "./session/state.js";

/** The run-to-session routes of one `CodexLifecycleManager`. */
export class CodexRunRoutes {
  readonly #sessionIdByRunId = new Map<RunId, SessionId>();

  /** Routes a run to the session whose turn it just started. */
  bindRun(runId: RunId, sessionId: SessionId): void {
    this.#sessionIdByRunId.set(runId, sessionId);
  }

  /** The session a run is routed to, or `undefined` once its last route is retired. */
  sessionIdFor(runId: RunId): SessionId | undefined {
    return this.#sessionIdByRunId.get(runId);
  }

  /** The run a join key names when there is no record, if it is routed to `sessionId`. */
  runIdBoundToSession(joinKey: string, sessionId: SessionId): RunId | undefined {
    // Looked up as a plain string: a key found in the map is a run id by construction.
    const sessionIdByRunKey: ReadonlyMap<string, SessionId> = this.#sessionIdByRunId;
    return sessionIdByRunKey.get(joinKey) === sessionId ? (joinKey as RunId) : undefined;
  }

  /**
   * The run an abandoned frame's join key names: a live turn's route, an interrupted turn's
   * correlation, or the run id the frame was registered under when the provider never named a
   * turn.
   */
  runIdForAbandonedFrame(record: CodexSessionRecord, joinKey: string): RunId | undefined {
    const routed = record.runIdByActiveTurnId.get(joinKey);
    if (routed !== undefined) {
      return routed;
    }
    const interrupted = record.interruptedRunIdByTurnId.get(joinKey);
    if (interrupted !== undefined) {
      return interrupted;
    }
    return this.runIdBoundToSession(joinKey, record.sessionId);
  }

  /**
   * Retires one turn's route, and the run's session binding only when that turn was the run's
   * last: dropping it earlier would strand the steer and interrupt paths of the run's other live
   * turn.
   */
  retireTurnRoute(record: CodexSessionRecord, turnId: string): void {
    const runId = record.runIdByActiveTurnId.get(turnId);
    if (runId === undefined) {
      return;
    }
    record.runIdByActiveTurnId.delete(turnId);
    if (newestActiveTurnForRun(record, runId) === undefined) {
      this.#sessionIdByRunId.delete(runId);
    }
  }

  /**
   * Drops every run route bound to a session, scanning by value: the record that could enumerate
   * them is gone or replaced by the time a sweep is owed.
   */
  forgetRunRoutes(sessionId: SessionId): void {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (boundSessionId === sessionId) {
        this.#sessionIdByRunId.delete(runId);
      }
    }
  }
}
