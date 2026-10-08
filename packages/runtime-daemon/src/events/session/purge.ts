// The whole-session purge: for each session a person deletes, removes a chat's managed workspace
// folder, then deletes every row naming the session outright in one write, re-scores the related
// lists of the sessions it was linked to, appends one receipt naming every session that lost rows,
// then truncates the write-ahead log.
//
// It is the only operation in this package that removes a committed row of the append-only log.
// Nothing in the background calls it. The caller chooses the sessions and owns the precondition
// that each is marked for purging, which stops new work on it; this module does not read session
// state.
//
//   - `event_maintenance` rows are never purged: the delete excludes them in SQL, and they record
//     maintenance, this purge's own receipt included.
//   - The writer's connection runs with `secure_delete` on, so a freed page is overwritten with
//     zeros. The write-ahead log still holds the deleted pages' earlier images until a checkpoint,
//     so the purge ends with the writer's `TRUNCATE` checkpoint once its deletes and its receipt
//     have committed, even when nothing was deleted. While a reader keeps the log busy it tries
//     again a bounded number of times, then reports the log as left untruncated.
//   - The purge refuses to start inside an append-lock hold. The lock is reentrant per owner, so a
//     purge entered inside a hold would delete rows outside the serialization the hold provides.
//   - A refused session does not stop the deletion; the others are independent. Each session's
//     range read and deletes go in one write, so a refused session lost no row and the receipt
//     does not name it. Each refusal is on that session's outcome.
//   - Each session is purged under its session lock, so no conversion copies out of a folder being
//     removed, and its rows under one hold of its append lock. The receipt is appended after every
//     session, outside every hold, because the append takes its own lock.
//   - The folder goes before the rows: a removal that fails refuses the session with every row
//     kept, and a row write that fails after it keeps the rows naming a folder already gone, so
//     either way purging the session again finishes it.
//   - The live sessions list is told of each session whose rows went as soon as they commit, so a
//     receipt that fails after them never leaves a purged session on screen.
//   - The sessions a purged one was linked to are read in the write that deletes its links, and
//     re-scored once every session is done, so no stored score keeps a share of a gone session.

import { setTimeout as sleep } from "node:timers/promises";

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventEnvelopeVersionSchema,
} from "@ai-sidekicks/contracts/event/envelope";
import { EventCompactedPayloadSchema } from "@ai-sidekicks/contracts/event/declared-variants";
import type { EventCategory, EventEnvelopeVersion } from "@ai-sidekicks/contracts/event/envelope";
import type {
  EventCompactedEvent,
  EventCompactedPayload,
  EventCompactedRemovedSession,
} from "@ai-sidekicks/contracts/event/declared-variants";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { CheckpointResult } from "../../database/checkpoint.js";
import { sqlListOf } from "../../database/sql-list.js";
import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import type {
  EventLogAppendOptions,
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "../log-service.js";
import { sessionAppendLock } from "./append-lock.js";
import type { KeyedLock } from "../../keyed-lock.js";
import { RETRY_WAITS_MS } from "../../retry-waits.js";
import type { SessionListFeed } from "../../session/directory/list-feed.js";
import { removeEmptyGroupsOfSessionProjectStatement } from "../../session/groups/store.js";
import type { SessionRelatedRanking } from "../../session/related/ranking.js";
import { SESSION_RUN_IDS_SQL } from "../../session/run/ids.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import type { ManagedWorkspaceService } from "../../workspace/managed/service.js";
import { managedMountDeletionStatements } from "../../workspace/repo/mount-service.js";

/** The category a purge never touches: maintenance records, its own receipt included. */
const NEVER_PURGED_EVENT_CATEGORIES: readonly EventCategory[] = ["event_maintenance"];

// The same categories as a SQL literal list, interpolated rather than bound, so no statement's
// correctness depends on where the shared WHERE fragment sits among positional binds.
// `EventCategory` is a closed union of bare identifiers, so nothing needs escaping. Derived from
// the array so the two cannot drift.
const NEVER_PURGED_CATEGORY_SQL_LIST: string = sqlListOf(NEVER_PURGED_EVENT_CATEGORIES);

const PURGEABLE_WHERE = `session_id = ? AND category NOT IN (${NEVER_PURGED_CATEGORY_SQL_LIST})`;

/** The type of the purge's receipt, which names every session whose rows it deleted. */
export const PURGE_RECEIPT_TYPE: EventCompactedEvent["type"] = "event.compacted";

// The receipt's envelope category and version. The version is parsed through its schema, so a
// literal that stops satisfying the grammar throws at import rather than at the first receipt.
const EVENT_MAINTENANCE_CATEGORY: EventCategory = "event_maintenance";
const PURGE_RECEIPT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

/** What one deletion did to one of its sessions, or refused to do and why. */
export interface SessionPurgeOutcome {
  readonly sessionId: SessionId;
  /** Event rows deleted. */
  readonly rowsDeleted: number;
  /** The lowest and highest sequence deleted; absent when no row was. */
  readonly fromSequence?: number | undefined;
  readonly toSequence?: number | undefined;
  /**
   * Present iff this session was refused; a refused session lost no row, though a chat's managed
   * workspace folder may be gone, and purging it again finishes it.
   */
  readonly refusedReason?: string | undefined;
}

/** What one deletion did. */
export interface SessionPurgeResult {
  /** The receipt's `operationId`. */
  readonly operationId: string;
  /** One entry per session the deletion was asked to remove, in order. */
  readonly outcomes: readonly SessionPurgeOutcome[];
  /**
   * Present iff the deletion as a whole was refused or did not finish: before any session was
   * touched (the lock-hold check; `outcomes` is then empty), when the receipt could not be appended
   * after rows were deleted, or when the write-ahead log was left untruncated, by a failed
   * checkpoint or by a reader that kept it busy through every try. A purge of no session truncates
   * the log again.
   */
  readonly refusedReason?: string | undefined;
}

/** The durable append seam for the receipt; structural, so a test can pass a recording double. */
export interface SessionPurgeEventLog {
  append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt>;
}

/** Construction dependencies. */
export interface SessionPurgeDeps {
  /**
   * The writer every delete and the checkpoint go through; its connection has `secure_delete` on.
   */
  readonly writer: Pick<DatabaseWriter, "write" | "checkpoint">;
  /** This daemon's NodeId, attributed in every receipt. */
  readonly nodeId: NodeId;
  /** Where the receipt is appended. */
  readonly eventLog: SessionPurgeEventLog;
  /** Removes a chat's managed workspace folder; a session with none removes nothing. */
  readonly managedWorkspaces: Pick<ManagedWorkspaceService, "deleteFolder">;
  /**
   * The session lock every session-wide transition holds for its whole run, keyed by session id.
   */
  readonly sessionLock: Pick<KeyedLock<SessionId>, "run">;
  /** The live sessions list, told of each session whose rows went. */
  readonly sessionList: Pick<SessionListFeed, "refresh">;
  /** Re-scores, in the background, the related lists of the sessions a purged one was linked to. */
  readonly relatedRanking: Pick<SessionRelatedRanking, "rescoreAround">;
  /** The clock for the receipt's timestamps. */
  readonly now?: () => Date;
  /** Mints the receipt's `operationId`. Defaults to `mintUuidV7`. */
  readonly operationIdFactory?: () => string;
  /** Mints the receipt row's id. Defaults to `mintUuidV7`. */
  readonly newEventId?: () => string;
  /**
   * The waits, in milliseconds, between the truncation's tries while a reader keeps the log busy;
   * one retry follows each. Defaults to the daemon's retry waits.
   */
  readonly checkpointRetryDelaysMs?: readonly number[];
}

// The range read's row once rows were deleted: its guard returns it only when both ends are safe
// integers.
interface PurgeRangeRow {
  readonly fromSequence: number;
  readonly toSequence: number;
}

// One session's outcome, and the sessions it was linked to when its rows were deleted.
interface SessionRowsDeletion {
  readonly outcome: SessionPurgeOutcome;
  readonly linkedSessionIds: readonly SessionId[];
}

// Thrown to refuse one session. Caught in `purge` and turned into its `refusedReason`; never
// escapes it.
class SessionPurgeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPurgeRefusal";
  }
}

/** Deletes the sessions one deletion removes. */
export class SessionPurge {
  readonly #writer: Pick<DatabaseWriter, "write" | "checkpoint">;
  readonly #nodeId: NodeId;
  readonly #eventLog: SessionPurgeEventLog;
  readonly #managedWorkspaces: Pick<ManagedWorkspaceService, "deleteFolder">;
  readonly #sessionLock: Pick<KeyedLock<SessionId>, "run">;
  readonly #sessionList: Pick<SessionListFeed, "refresh">;
  readonly #relatedRanking: Pick<SessionRelatedRanking, "rescoreAround">;
  readonly #now: () => Date;
  readonly #operationIdFactory: () => string;
  readonly #newEventId: () => string;
  readonly #checkpointRetryDelaysMs: readonly number[];

  constructor(deps: SessionPurgeDeps) {
    this.#writer = deps.writer;
    this.#nodeId = deps.nodeId;
    this.#eventLog = deps.eventLog;
    this.#managedWorkspaces = deps.managedWorkspaces;
    this.#sessionLock = deps.sessionLock;
    this.#sessionList = deps.sessionList;
    this.#relatedRanking = deps.relatedRanking;
    this.#now = deps.now ?? ((): Date => new Date());
    this.#operationIdFactory = deps.operationIdFactory ?? mintUuidV7;
    this.#newEventId = deps.newEventId ?? mintUuidV7;
    // The truncation's first try, right after the deletes commit, waits out the writer
    // connection's busy timeout for a reader, holding every write behind it that long; each retry
    // answers busy at once, so a reader that stays open costs the writer only that first wait.
    this.#checkpointRetryDelaysMs = deps.checkpointRetryDelaysMs ?? RETRY_WAITS_MS;
  }

  /**
   * Removes a chat's managed workspace folder and deletes every purgeable row of each session in
   * `sessionIds`, queues the related lists of the sessions they were linked to for re-scoring,
   * appends one receipt naming every session that lost rows, and truncates the write-ahead log.
   * With the default retry waits, a reader that keeps the log busy holds the purge about 70 s at
   * most: the first try's busy timeout, then 63 s of waits.
   *
   * Never throws: every failure becomes a `refusedReason`, on the session it belongs to or on the
   * deletion.
   */
  async purge(sessionIds: readonly SessionId[]): Promise<SessionPurgeResult> {
    const operationId: string = this.#operationIdFactory();
    const purgeInstant: Date = this.#now();

    if (sessionAppendLock.isHeldHere()) {
      return {
        operationId,
        outcomes: [],
        refusedReason:
          "a purge entered inside a session append-lock hold would delete rows outside the " +
          "hold's serialization; refusing to delete any row.",
      };
    }

    const outcomes: SessionPurgeOutcome[] = [];
    const failures: string[] = [];
    const formerlyLinkedSessionIds = new Set<SessionId>();
    for (const sessionId of sessionIds) {
      const { outcome, linkedSessionIds } = await this.#purgeSession(sessionId);
      outcomes.push(outcome);
      for (const linkedSessionId of linkedSessionIds) {
        formerlyLinkedSessionIds.add(linkedSessionId);
      }
    }
    for (const outcome of outcomes) {
      if (outcome.refusedReason === undefined) {
        formerlyLinkedSessionIds.delete(outcome.sessionId);
      }
    }
    if (formerlyLinkedSessionIds.size > 0) {
      this.#relatedRanking.rescoreAround([...formerlyLinkedSessionIds]);
    }

    // Destruction must never go unrecorded: the receipt names every session that lost rows.
    const removedSessions: EventCompactedRemovedSession[] = outcomes.flatMap((outcome) =>
      outcome.fromSequence !== undefined && outcome.toSequence !== undefined
        ? [
            {
              sessionId: outcome.sessionId,
              fromSeq: outcome.fromSequence,
              toSeq: outcome.toSequence,
            },
          ]
        : [],
    );
    if (removedSessions.length > 0) {
      try {
        await this.#appendReceipt(operationId, purgeInstant, removedSessions);
      } catch (error) {
        failures.push(
          `purge receipt append failed after rows of ${String(removedSessions.length)} ` +
            `sessions were deleted: ${describeError(error)}`,
        );
      }
    }
    // Even when nothing was deleted: an earlier purge's truncation may not have finished.
    const checkpointFailure: string | undefined = await this.#truncateWriteAheadLog();
    if (checkpointFailure !== undefined) {
      failures.push(checkpointFailure);
    }

    return {
      operationId,
      outcomes,
      refusedReason: failures.length > 0 ? failures.join("; ") : undefined,
    };
  }

  async #purgeSession(sessionId: SessionId): Promise<SessionRowsDeletion> {
    try {
      return await this.#sessionLock.run(sessionId, async () => {
        await this.#managedWorkspaces.deleteFolder({ sessionId }).catch((error: unknown) => {
          throw new SessionPurgeRefusal(
            "the managed workspace could not be removed, so no row was deleted: " +
              describeError(error),
          );
        });
        const deletion = await sessionAppendLock.run(sessionId, () =>
          this.#deleteSessionRows(sessionId),
        );
        this.#sessionList.refresh([sessionId]);
        return deletion;
      });
    } catch (error) {
      return {
        outcome: { sessionId, rowsDeleted: 0, refusedReason: describeError(error) },
        linkedSessionIds: [],
      };
    }
  }

  // One write: the range read, the linked sessions' read and every delete commit or roll back
  // together.
  async #deleteSessionRows(sessionId: SessionId): Promise<SessionRowsDeletion> {
    const results = await this.#writer
      .write(deleteSessionRowsStatements(sessionId))
      .catch((error: unknown) => {
        throw error instanceof WriteRefusedError
          ? new SessionPurgeRefusal(
              "the session's stored sequences are not safe integers; refusing to delete rows " +
                "whose range the receipt could not name.",
            )
          : error;
      });
    const [rangeResult, linkedResult] = results;
    const linkedRows = (linkedResult?.rows ?? []) as readonly { readonly sessionId: SessionId }[];
    const linkedSessionIds = linkedRows.map((row) => row.sessionId);
    const rowsDeleted: number = results[EVENTS_DELETE_INDEX]?.rowCount ?? 0;
    if (rowsDeleted === 0) {
      return { outcome: { sessionId, rowsDeleted }, linkedSessionIds };
    }
    const range = rangeResult?.rows[0] as PurgeRangeRow | undefined;
    return {
      outcome: {
        sessionId,
        rowsDeleted,
        fromSequence: range?.fromSequence,
        toSequence: range?.toSequence,
      },
      linkedSessionIds,
    };
  }

  /**
   * Truncates the log, trying again after each retry wait while another connection's older
   * snapshot keeps it busy; only the first try waits for the reader. Returns why the log is left
   * untruncated: the checkpoint failed, or the reader outlasted every try.
   */
  async #truncateWriteAheadLog(): Promise<string | undefined> {
    for (let retry = 0; ; retry += 1) {
      let checkpoint: CheckpointResult;
      try {
        checkpoint = await this.#writer.checkpoint("TRUNCATE", {
          shouldWaitForReaders: retry === 0,
        });
      } catch (error) {
        return (
          "the write-ahead log could not be truncated after the purge: " + describeError(error)
        );
      }
      if (!checkpoint.isBusy) {
        return undefined;
      }
      const delayMs = this.#checkpointRetryDelaysMs[retry];
      if (delayMs === undefined) {
        const waitedMs = this.#checkpointRetryDelaysMs.reduce((total, wait) => total + wait, 0);
        return (
          `a reader kept the write-ahead log busy through ${String(retry + 1)} truncation tries ` +
          `over ${String(waitedMs)} ms of retry waits, so it still holds ` +
          `${String(checkpoint.logFrames)} frames, the deleted rows' earlier pages among them; ` +
          "the rows and the receipt are done, and a purge of no session truncates the log once " +
          "the reader ends"
        );
      }
      // Unreferenced, so a retry pending at shutdown never holds the daemon open.
      await sleep(delayMs, undefined, { ref: false });
    }
  }

  /** Appends one receipt per deletion on the daemon-scope sentinel, naming each emptied session. */
  async #appendReceipt(
    operationId: string,
    purgeInstant: Date,
    removedSessions: EventCompactedRemovedSession[],
  ): Promise<void> {
    const occurredAt: string = purgeInstant.toISOString();
    const payload: EventCompactedPayload = EventCompactedPayloadSchema.parse({
      nodeId: this.#nodeId,
      operationId,
      occurredAt,
      removedSessions,
    });

    await this.#eventLog.append({
      id: this.#newEventId(),
      sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
      occurredAt,
      category: EVENT_MAINTENANCE_CATEGORY,
      type: PURGE_RECEIPT_TYPE,
      actor: null,
      payload,
      version: PURGE_RECEIPT_VERSION,
    });
  }
}

// The session's workspaces, on its project's mount and on its own managed one.
const SESSION_WORKSPACE_IDS_SQL = "SELECT id FROM workspaces WHERE session_id = ?";

// The worktrees the session made whose folder is gone: retired and cleaned off disk, or failed at
// creation, whose recovery removed the attempt. A worktree still on disk is the project's file and
// keeps its row, which its removal needs; a row another session still names stays too.
const DELETE_GONE_SESSION_WORKTREES_SQL = `DELETE FROM worktrees
     WHERE created_by_session_id = ?
       AND ((state = 'retired' AND cleaned_at IS NOT NULL) OR state = 'failed')
       AND NOT EXISTS (SELECT 1 FROM branch_contexts WHERE worktree_id = worktrees.id)
       AND NOT EXISTS (SELECT 1 FROM run_execution_contexts WHERE worktree_id = worktrees.id)`;

// The rows keyed by one of the session's runs, each up to the run id it is matched on.
const DELETE_BY_SESSION_RUN_SQL: readonly string[] = [
  "DELETE FROM interventions WHERE target_run_id",
  "DELETE FROM runtime_bindings WHERE run_id",
  "DELETE FROM command_receipts WHERE run_id",
];

// Where the event delete sits in the write: after the range read, the linked sessions' read, the
// run-keyed deletes and the snapshots.
const EVENTS_DELETE_INDEX: number = 2 + DELETE_BY_SESSION_RUN_SQL.length + 1;

/**
 * The range read, the read of the sessions linked to it, and the deletes of one session. The range
 * read returns its row only while the stored sequences are safe integers, so a range the receipt
 * could not name refuses the write before anything is deleted. A run's interventions, bindings and
 * command receipts are found through the session's runs and log, so they go before the runs and
 * the events; a snapshot names the event it reflects, so snapshots go before the events too. The
 * run rows and the projection cursor are built from the events, so they go with them, and a
 * restart never settles a run of a purged session. A link or a related-list entry goes whichever
 * side names the session.
 * The group the session leaves empty goes after the session's row and before its workspaces,
 * through which its project is found; no other group is ever empty, because each group write
 * keeps at least one session in it. Every row naming a workspace goes before the workspace, and
 * the workspaces before the chat's managed mount, because foreign keys hold on DELETE too.
 */
function deleteSessionRowsStatements(sessionId: SessionId): readonly WriteStatement[] {
  return [
    {
      sql: `SELECT MIN(sequence) AS fromSequence, MAX(sequence) AS toSequence
              FROM session_events
             WHERE ${PURGEABLE_WHERE}
            HAVING MIN(sequence) IS NULL
                OR (typeof(MIN(sequence)) = 'integer' AND typeof(MAX(sequence)) = 'integer'
                    AND MIN(sequence) >= 0
                    AND MAX(sequence) <= ${String(Number.MAX_SAFE_INTEGER)})`,
      bindings: [sessionId],
      expectedRowCount: 1,
    },
    {
      sql: `SELECT target_session_id AS sessionId FROM session_links WHERE source_session_id = ?
            UNION
            SELECT source_session_id FROM session_links WHERE target_session_id = ?`,
      bindings: [sessionId, sessionId],
    },
    ...DELETE_BY_SESSION_RUN_SQL.map((deleteByRun) => ({
      sql: `${deleteByRun} IN (${SESSION_RUN_IDS_SQL})`,
      bindings: { sessionId },
    })),
    { sql: "DELETE FROM session_snapshots WHERE session_id = ?", bindings: [sessionId] },
    { sql: `DELETE FROM session_events WHERE ${PURGEABLE_WHERE}`, bindings: [sessionId] },
    { sql: "DELETE FROM session_drafts WHERE session_id = ?", bindings: [sessionId] },
    { sql: "DELETE FROM runs WHERE session_id = ?", bindings: [sessionId] },
    { sql: "DELETE FROM projection_cursors WHERE session_id = ?", bindings: [sessionId] },
    { sql: "DELETE FROM session_console_state WHERE session_id = ?", bindings: [sessionId] },
    {
      sql: "DELETE FROM session_links WHERE source_session_id = ? OR target_session_id = ?",
      bindings: [sessionId, sessionId],
    },
    { sql: "DELETE FROM session_tags WHERE session_id = ?", bindings: [sessionId] },
    {
      sql: "DELETE FROM session_related WHERE session_id = ? OR related_session_id = ?",
      bindings: [sessionId, sessionId],
    },
    { sql: "DELETE FROM sessions WHERE id = ?", bindings: [sessionId] },
    removeEmptyGroupsOfSessionProjectStatement(sessionId),
    { sql: "DELETE FROM session_create_requests WHERE session_id = ?", bindings: [sessionId] },
    { sql: "DELETE FROM session_convert_requests WHERE session_id = ?", bindings: [sessionId] },
    { sql: "DELETE FROM session_convert_files WHERE session_id = ?", bindings: [sessionId] },
    { sql: "DELETE FROM queue_items WHERE session_id = ?", bindings: [sessionId] },
    {
      sql: `DELETE FROM run_execution_contexts
             WHERE session_id = ? OR workspace_id IN (${SESSION_WORKSPACE_IDS_SQL})`,
      bindings: [sessionId, sessionId],
    },
    {
      sql: `DELETE FROM branch_contexts WHERE workspace_id IN (${SESSION_WORKSPACE_IDS_SQL})`,
      bindings: [sessionId],
    },
    { sql: DELETE_GONE_SESSION_WORKTREES_SQL, bindings: [sessionId] },
    { sql: "DELETE FROM workspaces WHERE session_id = ?", bindings: [sessionId] },
    ...managedMountDeletionStatements(sessionId),
  ];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
