// The `queue_items` rows: the statements that write them, each guarded so a change decided from a
// stale read is refused whole, and the reads of a queue in its order. A row is never deleted while
// its session is kept; a message's words ride its payload beside its `user.message` row.

import type { Database, Statement } from "better-sqlite3";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type { PickedSkill } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { ChildHandle } from "@ai-sidekicks/contracts/agent/tree";
import type { QuestionId } from "@ai-sidekicks/contracts/question";
import type { WorkspaceId } from "@ai-sidekicks/contracts/repo/mount";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type {
  QueueItemId,
  QueueItemNotDeliveredReason,
  QueueItemState,
  QueueItemSummary,
} from "@ai-sidekicks/contracts/run/queue";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionState } from "@ai-sidekicks/contracts/session/methods";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { sqlListOf } from "../database/sql-list.js";
import type { WriteStatement } from "../database/statement.js";
import { RUN_TERMINAL_STATES } from "../session/run/transitions.js";

/** What a queued message carries, as its payload stores it: the words and what rides with them. */
export interface QueueItemBody {
  readonly content: string;
  readonly attachments?: readonly ArtifactId[] | undefined;
  readonly skills?: readonly PickedSkill[] | undefined;
  readonly answersQuestionId?: QuestionId | undefined;
  readonly outputSpeedForTurn?: string | undefined;
  readonly workspaceId?: WorkspaceId | undefined;
}

/** One queued message as its row holds it. */
export interface QueueItemRecord {
  readonly id: QueueItemId;
  readonly sessionId: SessionId;
  readonly state: QueueItemState;
  readonly notDeliveredReason: QueueItemNotDeliveredReason | undefined;
  readonly body: QueueItemBody;
  /** The run the message goes to; absent on an orchestration-authored item. */
  readonly targetRunId: RunId | undefined;
  /** The child whose queue holds it; absent on the lead's queue. */
  readonly childHandle: ChildHandle | undefined;
  readonly position: number;
  readonly clientIdempotencyKey: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A message to insert. It takes the place of `replacesQueueItemId` when it is an edit, else the
 * place after every item its queue has held.
 */
export interface NewQueueItem {
  readonly id: QueueItemId;
  readonly sessionId: SessionId;
  readonly body: QueueItemBody;
  readonly targetRunId: RunId;
  readonly deviceId: DeviceId | undefined;
  readonly clientIdempotencyKey: string;
  readonly replacesQueueItemId: QueueItemId | undefined;
  readonly now: string;
}

/**
 * Where a waiting message goes once it leaves `queued` other than by an edit: taken, by the run
 * named, removed, or never delivered, with the reason.
 */
export type QueueItemOutcome =
  | { readonly to: "admitted"; readonly runId: RunId }
  | { readonly to: "canceled" }
  | { readonly to: "not_delivered"; readonly reason: QueueItemNotDeliveredReason };

/** One item a queue's stream replays, and the sequence of its newest change after the cursor. */
export interface QueueItemChange {
  readonly item: QueueItemRecord;
  /** `undefined` for a waiting item no event changed after the cursor. */
  readonly sequence: number | undefined;
}

/** The state a waiting message leaves `queued` for: an outcome, or replaced by an edit. */
export type QueueItemExit = QueueItemOutcome | { readonly to: "superseded" };

interface QueueItemRow {
  readonly id: QueueItemId;
  readonly session_id: SessionId;
  readonly state: QueueItemState;
  readonly not_delivered_reason: QueueItemNotDeliveredReason | null;
  readonly payload: string;
  readonly target_run_id: RunId | null;
  readonly child_handle: ChildHandle | null;
  readonly position: number;
  readonly client_idempotency_key: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS = `id, session_id, state, not_delivered_reason, payload, target_run_id, child_handle,
  position, client_idempotency_key, created_at, updated_at`;

// An item's order within its queue: by place, and an edit's superseded item after its replacement.
const QUEUE_ORDER = "ORDER BY position, created_at DESC, id";

// Changes no row when the send's key was already spent in the session, so the write that carries
// it is refused and nothing saved is replaced. Only a person's send reaches here, so the queue is
// the lead's.
const INSERT_SQL = `INSERT INTO queue_items
    (id, session_id, state, payload, target_run_id, device_id, child_handle, position,
     client_idempotency_key, created_at, updated_at)
  VALUES (@id, @session_id, 'queued', @payload, @target_run_id, @device_id, NULL,
    COALESCE(
      (SELECT position FROM queue_items WHERE id = @replaces_id),
      (SELECT MAX(position) + 1 FROM queue_items
        WHERE session_id = @session_id AND child_handle IS NULL),
      0),
    @client_idempotency_key, @now, @now)
  ON CONFLICT (session_id, client_idempotency_key) DO NOTHING`;

const LEAVE_QUEUED_SQL = `UPDATE queue_items
    SET state = @to, not_delivered_reason = @reason, updated_at = @now
  WHERE id = @id AND state = 'queued'`;

// A message read not delivered that the agent took after all.
const ADMIT_UNDELIVERED_SQL = `UPDATE queue_items
    SET state = 'admitted', not_delivered_reason = NULL, updated_at = @now
  WHERE id = @id AND state = 'not_delivered'`;

const RETARGET_SQL = `UPDATE queue_items SET target_run_id = @run_id, updated_at = @now
  WHERE id = @id AND state = 'queued'`;

const PLACE_SQL = `UPDATE queue_items SET position = @position, updated_at = @now
  WHERE id = @id AND state = 'queued'`;

const RUN_LIVE_SQL = `SELECT 1 FROM runs
  WHERE run_id = @run_id AND state NOT IN (${sqlListOf(RUN_TERMINAL_STATES)})`;

// Matches the session while it takes messages: neither closed nor being purged.
const SESSION_TAKES_MESSAGES_SQL = `SELECT 1 FROM sessions
  WHERE id = @session_id AND state NOT IN ('closed', 'purge_requested')`;

// Matches the session's lead runs that have not ended; a send that starts one expects none.
const LIVE_LEAD_RUNS_SQL = `SELECT 1 FROM runs
  WHERE session_id = @session_id AND parent_run_id IS NULL
    AND state NOT IN (${sqlListOf(RUN_TERMINAL_STATES)})`;

// The sessions with a lead message waiting for a run that ended or has not started.
const SESSIONS_WITH_UNSTARTED_WAITING_SQL = `SELECT DISTINCT queue_items.session_id AS sessionId
  FROM queue_items JOIN runs ON runs.run_id = queue_items.target_run_id
  WHERE queue_items.state = 'queued' AND queue_items.child_handle IS NULL
    AND runs.state IN ('queued', ${sqlListOf(RUN_TERMINAL_STATES)})`;

// A queue's items that a `queue_item.*` event changed after a sequence, with the newest such
// sequence, and every item still waiting, which a reorder moves with no event.
const CHANGED_AFTER_SQL = `SELECT ${COLUMNS}, changed.sequence AS changed_sequence
  FROM queue_items
  LEFT JOIN (
    SELECT json_extract(payload, '$.queueItemId') AS queue_item_id, MAX(sequence) AS sequence
    FROM session_events
    WHERE session_id = @session_id AND sequence > @after
      AND type IN ('queue_item.created', 'queue_item.admitted', 'queue_item.superseded',
        'queue_item.canceled', 'queue_item.not_delivered')
    GROUP BY queue_item_id
  ) AS changed ON changed.queue_item_id = queue_items.id
  WHERE queue_items.session_id = @session_id AND child_handle IS @child_handle
    AND (changed.sequence IS NOT NULL OR state = 'queued')
  ${QUEUE_ORDER}`;

// The condition that the lead run `alias` names counts as its session's current one: any but one
// whose start failed before it ever ran, such as the run of a turn Codex started itself that failed
// to open, which never stood in for the run before it.
function composeCurrentLeadRunPredicate(alias: string): string {
  return `(${alias}.state <> 'failed'
    OR EXISTS (SELECT 1 FROM session_events
      WHERE session_events.session_id = ${alias}.session_id AND session_events.type = 'run.running'
        AND session_events.run_id = ${alias}.run_id))`;
}

// The session's current lead run, whatever its state: its newest but those whose start failed. Run
// ids are minted in time order.
const CURRENT_LEAD_RUN_SQL = `SELECT run_id AS runId, state FROM runs
  WHERE session_id = ? AND parent_run_id IS NULL AND ${composeCurrentLeadRunPredicate("runs")}
  ORDER BY run_id DESC LIMIT 1`;

// No lead run of the session of the `runs` row is newer and counts as current.
const NO_NEWER_CURRENT_LEAD_RUN_SQL = `NOT EXISTS (SELECT 1 FROM runs AS newer
      WHERE newer.session_id = runs.session_id AND newer.parent_run_id IS NULL
        AND newer.run_id > runs.run_id AND ${composeCurrentLeadRunPredicate("newer")})`;

// The interrupted lead run a send continues, while it is its session's current lead run.
const CURRENT_INTERRUPTED_LEAD_RUN_SQL = `SELECT 1 FROM runs
  WHERE run_id = @run_id AND state = 'interrupted' AND parent_run_id IS NULL
    AND ${NO_NEWER_CURRENT_LEAD_RUN_SQL}`;

// A lead message waiting for the session's current lead run while it rests interrupted, which the
// run's continue takes as the session's next turn.
const CONTINUE_WAITING_SQL = `SELECT 1 FROM queue_items JOIN runs ON runs.run_id = queue_items.target_run_id
  WHERE queue_items.session_id = @session_id AND queue_items.child_handle IS NULL
    AND queue_items.state = 'queued' AND runs.state = 'interrupted' AND runs.parent_run_id IS NULL
    AND ${NO_NEWER_CURRENT_LEAD_RUN_SQL}
  LIMIT 1`;

// Points the lead messages waiting for the session's interrupted lead runs at the run that takes
// over from them; their places, and so their order, stay as they are.
const TAKE_OVER_INTERRUPTED_SQL = `UPDATE queue_items
    SET target_run_id = @run_id, updated_at = @now
  WHERE session_id = @session_id AND child_handle IS NULL AND state = 'queued'
    AND target_run_id IN (SELECT run_id FROM runs
      WHERE session_id = @session_id AND parent_run_id IS NULL AND state = 'interrupted')`;

// The session's newest lead run that has not ended.
const LIVE_LEAD_RUN_SQL = `SELECT run_id AS runId FROM runs
  WHERE session_id = ? AND parent_run_id IS NULL
    AND state NOT IN (${sqlListOf(RUN_TERMINAL_STATES)})
  ORDER BY run_id DESC LIMIT 1`;

/** The statement that inserts `item` as `queued`; refused when its key was already spent. */
export function insertQueueItemStatement(item: NewQueueItem): WriteStatement {
  return {
    sql: INSERT_SQL,
    bindings: {
      id: item.id,
      session_id: item.sessionId,
      payload: JSON.stringify(item.body),
      target_run_id: item.targetRunId,
      device_id: item.deviceId ?? null,
      replaces_id: item.replacesQueueItemId ?? null,
      client_idempotency_key: item.clientIdempotencyKey,
      now: item.now,
    },
    expectedRowCount: 1,
  };
}

/** The statement that moves a waiting item out of `queued`; refused once it has left. */
export function leaveQueuedStatement(
  id: QueueItemId,
  exit: QueueItemExit,
  now: string,
): WriteStatement {
  return {
    sql: LEAVE_QUEUED_SQL,
    bindings: {
      id,
      to: exit.to,
      reason: exit.to === "not_delivered" ? exit.reason : null,
      now,
    },
    expectedRowCount: 1,
  };
}

/** The statement that admits an item read not delivered; refused unless it reads not delivered. */
export function admitUndeliveredStatement(id: QueueItemId, now: string): WriteStatement {
  return { sql: ADMIT_UNDELIVERED_SQL, bindings: { id, now }, expectedRowCount: 1 };
}

/** The statement that points a waiting item at the run it now goes to; refused once it has left. */
export function retargetStatement(id: QueueItemId, runId: RunId, now: string): WriteStatement {
  return { sql: RETARGET_SQL, bindings: { id, run_id: runId, now }, expectedRowCount: 1 };
}

/**
 * The statements that give the waiting items `ordered` the places they hold between them, in that
 * order; each is refused once its item has left the queue.
 */
export function placementStatements(
  ordered: readonly QueueItemRecord[],
  now: string,
): WriteStatement[] {
  const positions = ordered.map((item) => item.position).sort((left, right) => left - right);
  return ordered.map((item, index) => ({
    sql: PLACE_SQL,
    bindings: { id: item.id, position: positions[index] ?? item.position, now },
    expectedRowCount: 1,
  }));
}

/** Holds only while `runId` has not ended, so a message never goes to a run that ended first. */
export function runLiveStatement(runId: RunId): WriteStatement {
  return { sql: RUN_LIVE_SQL, bindings: { run_id: runId }, expectedRowCount: 1 };
}

/** Holds only while the session takes messages: it is neither closed nor being purged. */
export function sessionTakesMessagesStatement(sessionId: SessionId): WriteStatement {
  return {
    sql: SESSION_TAKES_MESSAGES_SQL,
    bindings: { session_id: sessionId },
    expectedRowCount: 1,
  };
}

/** Holds only while the session has no lead run that has not ended. */
export function noLiveLeadRunStatement(sessionId: SessionId): WriteStatement {
  return { sql: LIVE_LEAD_RUNS_SQL, bindings: { session_id: sessionId }, expectedRowCount: 0 };
}

/** Holds only while `runId` reads interrupted and is its session's current lead run. */
export function currentInterruptedLeadRunStatement(runId: RunId): WriteStatement {
  return {
    sql: CURRENT_INTERRUPTED_LEAD_RUN_SQL,
    bindings: { run_id: runId },
    expectedRowCount: 1,
  };
}

/**
 * Holds only while no lead message waits for the session's current lead run as it rests
 * interrupted, so no continue of that run holds the session's next turn.
 */
export function noContinueWaitingStatement(sessionId: SessionId): WriteStatement {
  return { sql: CONTINUE_WAITING_SQL, bindings: { session_id: sessionId }, expectedRowCount: 0 };
}

/**
 * The statement that moves the lead messages waiting for the session's interrupted lead runs to
 * `runId`, a newer lead run that takes over from them, in their order. Written with that run's
 * `running`, so a run that never runs leaves them for the interrupted run's continue.
 */
export function takeOverInterruptedStatement(
  sessionId: SessionId,
  runId: RunId,
  now: string,
): WriteStatement {
  return {
    sql: TAKE_OVER_INTERRUPTED_SQL,
    bindings: { session_id: sessionId, run_id: runId, now },
  };
}

/** The pending row a screen draws for `record`. */
export function summaryOf(record: QueueItemRecord): QueueItemSummary {
  return {
    id: record.id,
    state: record.state,
    position: record.position,
    content: record.body.content,
    ...(record.body.attachments === undefined ? {} : { attachments: [...record.body.attachments] }),
    ...(record.childHandle === undefined ? {} : { childHandle: record.childHandle }),
    ...(record.notDeliveredReason === undefined
      ? {}
      : { notDeliveredReason: record.notDeliveredReason }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Reads queue rows on the daemon's read-only connection. */
export class QueueItemReader {
  readonly #selectById: Statement<[string], QueueItemRow>;
  readonly #selectByKey: Statement<[string, string], QueueItemRow>;
  readonly #selectQueue: Statement<
    { session_id: string; child_handle: string | null; state: string | null },
    QueueItemRow
  >;
  readonly #selectWaitingForRun: Statement<[string], QueueItemRow>;
  readonly #selectLiveLeadRun: Statement<[string], { readonly runId: RunId }>;
  readonly #selectCurrentLeadRun: Statement<
    [string],
    { readonly runId: RunId; readonly state: RunState }
  >;
  readonly #selectSessionState: Statement<[string], { readonly state: SessionState }>;
  readonly #selectSessionsWithUnstartedWaiting: Statement<[], { readonly sessionId: SessionId }>;
  readonly #selectChangedAfter: Statement<
    { session_id: string; child_handle: string | null; after: number },
    QueueItemRow & { readonly changed_sequence: number | null }
  >;

  constructor(reader: Database) {
    this.#selectById = reader.prepare(`SELECT ${COLUMNS} FROM queue_items WHERE id = ?`);
    this.#selectByKey = reader.prepare(
      `SELECT ${COLUMNS} FROM queue_items WHERE session_id = ? AND client_idempotency_key = ?`,
    );
    this.#selectQueue = reader.prepare(
      `SELECT ${COLUMNS} FROM queue_items
        WHERE session_id = @session_id AND child_handle IS @child_handle
          AND (state = @state OR (@state IS NULL AND state IN ('queued', 'not_delivered')))
        ${QUEUE_ORDER}`,
    );
    this.#selectWaitingForRun = reader.prepare(
      `SELECT ${COLUMNS} FROM queue_items
        WHERE target_run_id = ? AND state = 'queued'
        ${QUEUE_ORDER}`,
    );
    this.#selectLiveLeadRun = reader.prepare(LIVE_LEAD_RUN_SQL);
    this.#selectCurrentLeadRun = reader.prepare(CURRENT_LEAD_RUN_SQL);
    this.#selectSessionState = reader.prepare("SELECT state FROM sessions WHERE id = ?");
    this.#selectSessionsWithUnstartedWaiting = reader.prepare(SESSIONS_WITH_UNSTARTED_WAITING_SQL);
    this.#selectChangedAfter = reader.prepare(CHANGED_AFTER_SQL);
  }

  /** The item `id`, or `undefined` for one the daemon has no row for. */
  get(id: QueueItemId): QueueItemRecord | undefined {
    const row = this.#selectById.get(id);
    return row === undefined ? undefined : recordOf(row);
  }

  /** The item a send under `clientIdempotencyKey` saved in the session, or `undefined`. */
  getByIdempotencyKey(
    sessionId: SessionId,
    clientIdempotencyKey: string,
  ): QueueItemRecord | undefined {
    const row = this.#selectByKey.get(sessionId, clientIdempotencyKey);
    return row === undefined ? undefined : recordOf(row);
  }

  /**
   * A queue, the lead's or a child's, in its order: the items in `state` when it is given, else
   * every item waiting or not delivered.
   */
  list(
    sessionId: SessionId,
    childHandle: ChildHandle | undefined,
    state?: QueueItemState,
  ): QueueItemRecord[] {
    return this.#selectQueue
      .all({ session_id: sessionId, child_handle: childHandle ?? null, state: state ?? null })
      .map(recordOf);
  }

  /** The messages still waiting for `runId`, in their queue's order. */
  listWaitingForRun(runId: RunId): QueueItemRecord[] {
    return this.#selectWaitingForRun.all(runId).map(recordOf);
  }

  /** The session's newest lead run that has not ended, or `undefined` while none is live. */
  readLiveLeadRun(sessionId: SessionId): RunId | undefined {
    return this.#selectLiveLeadRun.get(sessionId)?.runId;
  }

  /**
   * The session's current lead run and its state: its newest, but one whose start failed before it
   * ran leaves the run before it current; `undefined` before its first run.
   */
  readCurrentLeadRun(
    sessionId: SessionId,
  ): { readonly runId: RunId; readonly state: RunState } | undefined {
    return this.#selectCurrentLeadRun.get(sessionId);
  }

  /** The session's state, or `undefined` for a session the daemon has no row for. */
  readSessionState(sessionId: SessionId): SessionState | undefined {
    return this.#selectSessionState.get(sessionId)?.state;
  }

  /** The sessions with a lead message waiting for a run that ended or has not started. */
  listSessionsWithUnstartedWaiting(): SessionId[] {
    return this.#selectSessionsWithUnstartedWaiting.all().map((row) => row.sessionId);
  }

  /**
   * A queue's items that changed after the session's event `afterSequence`, each with its newest
   * change, and every item still waiting, in the queue's order.
   */
  listChangedAfter(
    sessionId: SessionId,
    childHandle: ChildHandle | undefined,
    afterSequence: number,
  ): QueueItemChange[] {
    return this.#selectChangedAfter
      .all({ session_id: sessionId, child_handle: childHandle ?? null, after: afterSequence })
      .map((row) => ({ item: recordOf(row), sequence: row.changed_sequence ?? undefined }));
  }
}

// The payload is written only by `insertQueueItemStatement`, from a typed body.
function recordOf(row: QueueItemRow): QueueItemRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    state: row.state,
    notDeliveredReason: row.not_delivered_reason ?? undefined,
    body: JSON.parse(row.payload) as QueueItemBody,
    targetRunId: row.target_run_id ?? undefined,
    childHandle: row.child_handle ?? undefined,
    position: row.position,
    clientIdempotencyKey: row.client_idempotency_key ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
