// The node's recovery state as the status read serves it: `rebuilding` while the restart's pass
// runs, `blocked` once the local store has failed, and each session the pass could not rebuild
// `degraded`. The overall state is the most severe of these.

import {
  DAEMON_RECOVERY_STATES,
  type DaemonRecoverySession,
  type DaemonRecoveryState,
  type DaemonRecoveryStatus,
} from "@ai-sidekicks/contracts/daemon/recovery";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/** Holds the node's recovery state as the restart's pass moves it. */
export class RecoveryStatusTracker {
  // Nothing is trusted until the first pass ends, so a status read before it says rebuilding.
  #isPassRunning = true;
  #hasStoreFailed = false;
  readonly #sessions = new Map<SessionId, DaemonRecoverySession>();

  /** Marks the pass ended; the node then reads as its store and its sessions stand. */
  markPassEnded(): void {
    this.#isPassRunning = false;
  }

  /** Marks the local store failed: the node reads blocked from then on. */
  markStoreFailed(): void {
    this.#hasStoreFailed = true;
  }

  /** Marks a session's projections as being rebuilt. */
  markSessionRebuilding(sessionId: SessionId): void {
    this.#sessions.set(sessionId, { sessionId, state: "rebuilding" });
  }

  /** Marks a session's projections current, so it is no longer listed. */
  markSessionHealthy(sessionId: SessionId): void {
    this.#sessions.delete(sessionId);
  }

  /**
   * Marks a session whose log could not be folded into rows the daemon can trust;
   * `lastAppliedSequence` is the last event its rows reflect, `undefined` when they reflect none.
   */
  markSessionDegraded(sessionId: SessionId, lastAppliedSequence: number | undefined): void {
    this.#sessions.set(sessionId, {
      sessionId,
      state: "degraded",
      failureCategory: "projection failure",
      ...(lastAppliedSequence === undefined ? {} : { lastAppliedSequence }),
    });
  }

  /** Whether the session's projections could not be rebuilt. */
  isSessionDegraded(sessionId: SessionId): boolean {
    return this.#sessions.get(sessionId)?.state === "degraded";
  }

  /** The node's overall state: the most severe of its own and every listed session's. */
  readOverall(): DaemonRecoveryState {
    const states: DaemonRecoveryState[] = [...this.#sessions.values()].map(
      (session) => session.state,
    );
    if (this.#isPassRunning) {
      states.push("rebuilding");
    }
    if (this.#hasStoreFailed) {
      states.push("blocked");
    }
    return states.reduce<DaemonRecoveryState>(
      (worst, state) =>
        DAEMON_RECOVERY_STATES.indexOf(state) > DAEMON_RECOVERY_STATES.indexOf(worst)
          ? state
          : worst,
      "healthy",
    );
  }

  /** The `recovery` field of the status read: the overall state and every session not healthy. */
  read(): DaemonRecoveryStatus {
    return { overall: this.readOverall(), sessions: [...this.#sessions.values()] };
  }
}
