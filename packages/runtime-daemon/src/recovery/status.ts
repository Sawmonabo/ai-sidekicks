// The node's recovery state as the status read serves it: `rebuilding` while the restart's pass
// runs, `blocked` once the local store has failed, and `degraded` while a session's history is
// damaged. The whole node refuses writes until the pass has listed what it must rebuild, and a
// call that names no session until the pass ends; from then a session it is still rebuilding
// refuses every write but the pass's own, as a damaged
// session, open at its last good point or unreadable, refuses its writes. The pass's writes are
// told apart by the asynchronous context it runs in. Sessions are keyed by their canonical id, so
// a call that spells one in capitals meets the same refusal.

import { AsyncLocalStorage } from "node:async_hooks";

import {
  DAEMON_RECOVERY_STATES,
  type DaemonRecoverySession,
  type DaemonRecoveryState,
  type DaemonRecoveryStatus,
} from "@ai-sidekicks/contracts/daemon/recovery";
import { type SessionId } from "@ai-sidekicks/contracts/session/id";
import { START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/event-cursor";
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
  | { readonly state: "degraded"; readonly point: LastGoodPoint }
  | { readonly state: "damaged" };

/** Holds the node's recovery state as the restart's pass and the person's repairs move it. */
export class RecoveryStatusTracker {
  // Nothing is trusted until the first pass ends, so a status read before it says rebuilding.
  #isPassRunning = true;
  // No write is taken until the pass knows which sessions it must rebuild.
  #isPassListing = true;
  #hasStoreFailed = false;
  readonly #sessions = new Map<SessionId, SessionRecovery>();
  // The sessions the pass has yet to rebuild, kept apart from the listed ones: after a repair of
  // the file that is every session, too many for each status read to carry.
  readonly #rebuildingSessions = new Set<SessionId>();
  // Set within the pass, whose appends reach the sessions it is rebuilding.
  readonly #passWrites = new AsyncLocalStorage<true>();

  /** Runs the restart's pass, so the events it appends reach the sessions it is rebuilding. */
  runPass<T>(pass: () => Promise<T>): Promise<T> {
    return this.#passWrites.run(true, pass);
  }

  /**
   * Marks the pass's sessions listed, each one it must rebuild marked rebuilding: the node then
   * takes writes, but for those sessions'.
   */
  markPassListed(): void {
    this.#isPassListing = false;
  }

  /** Marks the pass ended; the node then reads as its store and its sessions stand. */
  markPassEnded(): void {
    this.#isPassListing = false;
    this.#isPassRunning = false;
  }

  /** Marks the local store failed: the node reads blocked from then on. */
  markStoreFailed(): void {
    this.#hasStoreFailed = true;
  }

  /** Marks a session the pass must rebuild before it takes a write. */
  markSessionRebuilding(sessionId: SessionId): void {
    this.#rebuildingSessions.add(canonicalizeUuid(sessionId));
  }

  /** Marks a session's projections current, or the session deleted, so it is no longer listed. */
  markSessionHealthy(sessionId: SessionId): void {
    this.#rebuildingSessions.delete(canonicalizeUuid(sessionId));
    this.#sessions.delete(canonicalizeUuid(sessionId));
  }

  /** Marks a session whose history is damaged after `point`, which it opens at read-only. */
  markSessionAtLastGoodPoint(sessionId: SessionId, point: LastGoodPoint): void {
    this.#rebuildingSessions.delete(canonicalizeUuid(sessionId));
    this.#sessions.set(canonicalizeUuid(sessionId), { state: "degraded", point });
  }

  /** Marks a session none of whose events can be read. */
  markSessionUnreadable(sessionId: SessionId): void {
    this.#rebuildingSessions.delete(canonicalizeUuid(sessionId));
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

  /**
   * Why the session takes no appended event: its history is damaged, or the pass is still
   * rebuilding it and the append is not the pass's own; `undefined` when it takes the event.
   */
  readSessionAppendRefusal(sessionId: SessionId): SessionWriteRefusedDetails | undefined {
    if (this.#passWrites.getStore() === true) {
      return this.readSessionWriteRefusal(sessionId);
    }
    return this.readSessionCallRefusal(sessionId);
  }

  /**
   * Why the session takes no call that names it: the pass is still rebuilding it, or its history
   * is damaged; `undefined` when it takes them.
   */
  readSessionCallRefusal(sessionId: SessionId): SessionWriteRefusedDetails | undefined {
    return this.#rebuildingSessions.has(canonicalizeUuid(sessionId))
      ? { sessionId, recovery: "rebuilding" }
      : this.readSessionWriteRefusal(sessionId);
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
   * Why the whole node takes no write of a call: its store has failed, its pass has not yet listed
   * the sessions it must rebuild, or the call names no session while the pass runs, since it may
   * reach any session; `undefined` when it takes the write.
   */
  readNodeWriteRefusal(namesSession: boolean): "rebuilding" | "blocked" | undefined {
    if (this.#hasStoreFailed) {
      return "blocked";
    }
    return this.#isPassListing || (this.#isPassRunning && !namesSession) ? "rebuilding" : undefined;
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

  /**
   * The `recovery` field of the status read: the overall state and every damaged session. The
   * sessions the pass has yet to rebuild are left out; the node reads rebuilding while it runs.
   */
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
