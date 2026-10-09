// A session whose history cannot be rebuilt whole, and the two wire methods of its repair. Its
// last good point is every event before the first one that cannot be read: a row that is not a
// well-formed event, an event its registered shape refuses, or one the projections' fold cannot
// take. The session's projections are rebuilt through that point and it opens there, read-only.
// The person then continues from it, which appends one event naming the damaged range that every
// read and rebuild skips from then on and settles the runs the restart left live, or deletes the
// session. The damaged rows themselves are never moved, rewritten or deleted here.

import type { Database, Statement } from "better-sqlite3";

import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { type SessionId } from "@ai-sidekicks/contracts/session/id";
import { START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/event-cursor";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/methods";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";
import {
  SESSION_RECOVERY_REFUSED_CODE,
  type RecoveryDamagedEventsSkippedPayload,
  type SessionRecoveryRefusedDetails,
  type SessionRecoveryRefusedReason,
} from "@ai-sidekicks/contracts/session/recovery";

import { parsesAsRegisteredVariant } from "../events/content/append.js";
import { SessionEventAppender, type SessionEventLog } from "../events/session/appender.js";
import { sessionAppendLock } from "../events/session/append-lock.js";
import type { SessionPurge } from "../events/session/purge.js";
import type { RunEngine } from "../session/run/engine.js";
import type { RunStateReader } from "../session/run/read.js";
import {
  DAMAGED_EVENTS_SKIPPED_TYPE,
  outsideSkippedRangesSql,
} from "../events/session/skipped-ranges.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import { KeyedLock } from "../keyed-lock.js";
import { registerDescribedMethod } from "../ipc/handlers/register-described-method.js";
import { MalformedStoredEventError } from "../events/session/read.js";
import type { SessionService } from "../session/service.js";
import {
  ProjectionFailureError,
  REBUILD_PAGE_SIZE,
  type ProjectionRebuildService,
} from "./projection-rebuild.js";
import { RESTART_FAILURE_DETAIL } from "./startup.js";
import type { LastGoodPoint, RecoveryStatusTracker } from "./status.js";

/** What the damaged history reads, writes and reports through. */
export interface DamagedHistoryDeps {
  readonly reader: Database;
  readonly sessionEvents: Pick<SessionService, "readEventsAfterSequence">;
  readonly eventLog: SessionEventLog;
  readonly projectionRebuild: Pick<ProjectionRebuildService, "rebuild">;
  readonly purge: Pick<SessionPurge, "purge">;
  readonly runs: Pick<RunStateReader, "listLiveRuns">;
  readonly runEngine: Pick<RunEngine, "settleRunAfterRestart">;
  readonly status: RecoveryStatusTracker;
}

const SKIP_EVENT_VERSION = EventEnvelopeVersionSchema.parse("1.0");

// The last event the session opens at: the newest one before the first damaged event.
const SELECT_LAST_EVENT_BEFORE_SQL = `SELECT sequence, occurred_at FROM session_events AS event
  WHERE session_id = @session_id AND sequence < @before_sequence
    AND ${outsideSkippedRangesSql("event")}
  ORDER BY sequence DESC
  LIMIT 1`;

const SELECT_HEAD_SEQUENCE_SQL = `SELECT MAX(sequence) AS head_sequence FROM session_events
  WHERE session_id = ?`;

/** Finds a damaged session's last good point and carries out the person's two actions on it. */
export class DamagedHistory {
  readonly #deps: DamagedHistoryDeps;
  readonly #appender: SessionEventAppender;
  readonly #selectLastEventBefore: Statement<
    [{ session_id: SessionId; before_sequence: number }],
    { sequence: number; occurred_at: string }
  >;
  readonly #selectHeadSequence: Statement<[SessionId], { head_sequence: number }>;
  // Holds a session's continue and its delete apart, so a delete never meets a session a continue
  // has just opened to new work.
  readonly #recoveryActionLock = new KeyedLock<SessionId>(canonicalizeUuid);

  constructor(deps: DamagedHistoryDeps) {
    this.#deps = deps;
    this.#appender = new SessionEventAppender({ sessionEvents: deps.eventLog }, SKIP_EVENT_VERSION);
    this.#selectLastEventBefore = deps.reader.prepare(SELECT_LAST_EVENT_BEFORE_SQL);
    this.#selectHeadSequence = deps.reader.prepare(SELECT_HEAD_SEQUENCE_SQL);
  }

  /**
   * Rebuilds the session's projections through its last good point after `failure` stopped its
   * rebuild, and returns the point; `undefined` when no event of it can be read, or none can be
   * named as damaged. Throws the store's own failures as they come.
   */
  async rebuildThroughLastGoodPoint(
    sessionId: SessionId,
    failure: ProjectionFailureError,
  ): Promise<LastGoodPoint | undefined> {
    const firstUnreadable = this.#findFirstUnreadableSequence(sessionId);
    const namedSequences = [failure.sequence, firstUnreadable].filter(
      (sequence) => sequence !== undefined,
    );
    // With no event to name, the whole log counts as damaged and the session opens at none.
    let damagedFromSequence =
      namedSequences.length === 0 ? START_OF_LOG_POSITION : Math.min(...namedSequences);
    // An event before the damaged one can still contradict the fold; the point moves back to it.
    for (;;) {
      try {
        await this.#deps.projectionRebuild.rebuild({
          sessionId,
          force: true,
          beforeSequence: damagedFromSequence,
        });
        break;
      } catch (error) {
        if (
          !(error instanceof ProjectionFailureError) ||
          error.sequence === undefined ||
          error.sequence >= damagedFromSequence
        ) {
          throw error;
        }
        damagedFromSequence = error.sequence;
      }
    }
    const lastEvent = this.#selectLastEventBefore.get({
      session_id: sessionId,
      before_sequence: damagedFromSequence,
    });
    return lastEvent === undefined
      ? undefined
      : {
          lastSequence: lastEvent.sequence,
          lastOccurredAt: lastEvent.occurred_at,
          damagedFromSequence,
        };
  }

  /** The session's newest sequence; the session must hold an event. */
  readHeadSequence(sessionId: SessionId): number {
    // An aggregate answers one row, and the caller's session holds events.
    return (this.#selectHeadSequence.get(sessionId) as { head_sequence: number }).head_sequence;
  }

  /**
   * `Continue from here`: appends the event that skips the session's damaged events, from the
   * first damaged one to its head, lists it healthy so it takes new work again, rebuilds its
   * projections past the range and settles each run the restart left live, as the restart settles
   * a run nothing resumed. Throws `session.recovery_refused` when the session is not open at a
   * last good point; a rebuild or a settle that fails leaves it open at that point again.
   */
  async continueFromLastGoodPoint(sessionId: SessionId): Promise<void> {
    // Every append takes the append lock, so the head read here stays the head through the skip's
    // write.
    await this.#recoveryActionLock.run(sessionId, () =>
      sessionAppendLock.run(sessionId, async () => {
        const { status } = this.#deps;
        const point = status.readLastGoodPoint(sessionId);
        if (point === undefined) {
          throw this.#refusal(sessionId);
        }
        const payload: RecoveryDamagedEventsSkippedPayload = {
          sessionId,
          fromSequence: point.damagedFromSequence,
          toSequence: this.readHeadSequence(sessionId),
        };
        await this.#appender.append(DAMAGED_EVENTS_SKIPPED_TYPE, payload, {});
        status.markSessionHealthy(sessionId);
        try {
          await this.#deps.projectionRebuild.rebuild({ sessionId, force: true });
          for (const run of this.#deps.runs.listLiveRuns()) {
            if (run.sessionId === sessionId) {
              await this.#deps.runEngine.settleRunAfterRestart(run, RESTART_FAILURE_DETAIL);
            }
          }
        } catch (error) {
          status.markSessionAtLastGoodPoint(sessionId, point);
          throw error;
        }
      }),
    );
  }

  /**
   * `Delete session` on a session whose history is damaged: deletes every row of it through the
   * whole-session purge and stops listing it. Throws `session.recovery_refused` (`not_damaged`)
   * for a session whose history is not damaged, and the purge's refusal when it refused.
   */
  async deleteSession(sessionId: SessionId): Promise<void> {
    // Not under the append lock, which the purge takes per session and refuses to run inside.
    await this.#recoveryActionLock.run(sessionId, async () => {
      if (this.#deps.status.readSessionWriteRefusal(sessionId) === undefined) {
        throw this.#refusal(sessionId);
      }
      const result = await this.#deps.purge.purge([sessionId]);
      const refusedReason =
        result.refusedReason ??
        result.outcomes.find((outcome) => outcome.refusedReason)?.refusedReason;
      if (refusedReason !== undefined) {
        throw new Error(`Deleting session ${sessionId} failed: ${refusedReason}`);
      }
      this.#deps.status.markSessionHealthy(sessionId);
    });
  }

  // The first event of the session that is not a well-formed event or that its registered shape
  // refuses, read across every type; `undefined` when every event reads.
  #findFirstUnreadableSequence(sessionId: SessionId): number | undefined {
    let afterSequence = START_OF_LOG_POSITION;
    for (;;) {
      let page;
      try {
        page = this.#deps.sessionEvents.readEventsAfterSequence({
          sessionId,
          afterSequence,
          limit: REBUILD_PAGE_SIZE,
        });
      } catch (error) {
        if (error instanceof MalformedStoredEventError) {
          return error.sequence;
        }
        throw error;
      }
      const unreadable = page.events.find((envelope) => !parsesAsRegisteredVariant(envelope));
      if (unreadable !== undefined) {
        return unreadable.sequence;
      }
      if (!page.hasMore) {
        return undefined;
      }
      afterSequence = page.nextSequence;
    }
  }

  // Why the session does not offer the action asked: its history is not damaged, or none of it
  // can be read, so there is no point to continue from.
  #refusal(sessionId: SessionId): DaemonDomainError {
    const reason: SessionRecoveryRefusedReason =
      this.#deps.status.readSessionWriteRefusal(sessionId)?.recovery === "damaged"
        ? "no_readable_event"
        : "not_damaged";
    const detail: SessionRecoveryRefusedDetails = { sessionId, reason };
    return new DaemonDomainError(
      `Session ${sessionId} does not offer this recovery action: ${reason}`,
      {
        code: SESSION_RECOVERY_REFUSED_CODE,
        jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
        detail: { ...detail },
      },
    );
  }
}

/** Registers `session.recoveryContinue` and `session.recoveryDelete` over `damagedHistory`. */
export function registerDamagedHistoryMethods(
  registry: MethodRegistry,
  damagedHistory: DamagedHistory,
): void {
  registerDescribedMethod(
    registry,
    SESSION_METHOD_DESCRIPTORS["session.recoveryContinue"],
    async ({ sessionId }) => {
      await damagedHistory.continueFromLastGoodPoint(sessionId);
      return {};
    },
  );
  registerDescribedMethod(
    registry,
    SESSION_METHOD_DESCRIPTORS["session.recoveryDelete"],
    async ({ sessionId }) => {
      await damagedHistory.deleteSession(sessionId);
      return {};
    },
  );
}
