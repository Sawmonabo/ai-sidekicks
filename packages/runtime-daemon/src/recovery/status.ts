// The node's recovery state as the status read serves it: `rebuilding` while the restart's pass
// runs, `blocked` once the local store has failed, and `degraded` while a session's history is
// damaged. A damaged session is listed, open at its last good point or unreadable, and only it
// refuses writes. Sessions are keyed by their canonical id, so a call that spells one in capitals
// meets the same refusal.

import {
  DAEMON_RECOVERY_STATES,
  type DaemonRecoverySession,
  type DaemonRecoveryState,
  type DaemonRecoveryStatus,
} from "@ai-sidekicks/contracts/daemon/recovery";
import { START_OF_LOG_POSITION, type SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionWriteRefusedDetails } from "@ai-sidekicks/contracts/session/recovery";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

/** A session's last good point: the last event it opens at, and the first one that is damaged. */
export interface LastGoodPoint {
  readonly lastSequence: number;
  /** When the event at `lastSequence` happened. */
  readonly lastOccurredAt: string;
  readonly damagedFromSequence: number;
}

// Where one listed session stands, with what each state carries.
type SessionRecovery =
  | { readonly state: "rebuilding" }
  | { readonly state: "degraded"; readonly point: LastGoodPoint }
  | { readonly state: "damaged" };

/** Holds the node's recovery state as the restart's pass and the person's repairs move it. */
export class RecoveryStatusTracker {
  // Nothing is trusted until the first pass ends, so a status read before it says rebuilding.
  #isPassRunning = true;
  #hasStoreFailed = false;
  readonly #sessions = new Map<SessionId, SessionRecovery>();

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
    this.#sessions.set(canonicalizeUuid(sessionId), { state: "rebuilding" });
  }

  /** Marks a session's projections current, or the session deleted, so it is no longer listed. */
  markSessionHealthy(sessionId: SessionId): void {
    this.#sessions.delete(canonicalizeUuid(sessionId));
  }

  /** Marks a session whose history is damaged after `point`, which it opens at read-only. */
  markSessionAtLastGoodPoint(sessionId: SessionId, point: LastGoodPoint): void {
    this.#sessions.set(canonicalizeUuid(sessionId), { state: "degraded", point });
  }

  /** Marks a session none of whose events can be read. */
  markSessionUnreadable(sessionId: SessionId): void {
    this.#sessions.set(canonicalizeUuid(sessionId), { state: "damaged" });
  }

  /**
   * Why the session takes no write: its history is damaged, read-only at its last good point or
   * unreadable; `undefined` when it takes writes.
   */
  readSessionWriteRefusal(sessionId: SessionId): SessionWriteRefusedDetails | undefined {
    const state = this.#sessions.get(canonicalizeUuid(sessionId))?.state;
    return state === "degraded" || state === "damaged" ? { sessionId, recovery: state } : undefined;
  }

  /** The session's last good point while it opens read-only at one, `undefined` otherwise. */
  readLastGoodPoint(sessionId: SessionId): LastGoodPoint | undefined {
    const session = this.#sessions.get(canonicalizeUuid(sessionId));
    return session?.state === "degraded" ? session.point : undefined;
  }

  /**
   * The sequence a read of the session stops before while its history is damaged: its first
   * damaged event, or the start of its log when none can be read; `undefined` when it reads
   * whole.
   */
  readDamagedFromSequence(sessionId: SessionId): number | undefined {
    const session = this.#sessions.get(canonicalizeUuid(sessionId));
    if (session?.state === "degraded") {
      return session.point.damagedFromSequence;
    }
    return session?.state === "damaged" ? START_OF_LOG_POSITION : undefined;
  }

  /**
   * Why the whole node takes no write: its pass is still running, or its store has failed;
   * `undefined` when it takes writes.
   */
  readNodeWriteRefusal(): "rebuilding" | "blocked" | undefined {
    if (this.#hasStoreFailed) {
      return "blocked";
    }
    return this.#isPassRunning ? "rebuilding" : undefined;
  }

  /** The node's overall state: the most severe of its own and every listed session's. */
  readOverall(): DaemonRecoveryState {
    const states: DaemonRecoveryState[] = [...this.#sessions.values()].map((session) =>
      session.state === "damaged" ? "degraded" : session.state,
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
    return {
      overall: this.readOverall(),
      sessions: [...this.#sessions].map(([sessionId, session]) =>
        describeSession(sessionId, session),
      ),
    };
  }
}

function describeSession(sessionId: SessionId, session: SessionRecovery): DaemonRecoverySession {
  switch (session.state) {
    case "rebuilding":
      return { sessionId, state: "rebuilding" };
    case "degraded":
      return {
        sessionId,
        state: "degraded",
        failureCategory: "projection failure",
        lastAppliedSequence: session.point.lastSequence,
        lastAppliedAt: session.point.lastOccurredAt,
        damagedFromSequence: session.point.damagedFromSequence,
      };
    case "damaged":
      return { sessionId, state: "damaged", failureCategory: "projection failure" };
  }
}
