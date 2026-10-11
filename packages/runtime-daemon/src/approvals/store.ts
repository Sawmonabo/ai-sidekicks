// The approval tables' statements and reads. Every write is a statement in the event's own write,
// guarded so a write decided from a stale read is refused whole; every read runs on the read-only
// connection, which sees each write once it has committed.

import type { Database, Statement } from "better-sqlite3";

import {
  SENSE_BY_DECISION,
  type ApprovalCategory,
  type ApprovalDecision,
  type ApprovalRequestId,
  type ApprovalState,
  type RememberedScope,
  type RememberedScopeKind,
} from "@ai-sidekicks/contracts/approval";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionState } from "@ai-sidekicks/contracts/session/methods";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { sqlListOf } from "../database/sql-list.js";
import type { WriteStatement } from "../database/statement.js";
import { RUN_TERMINAL_STATES } from "../session/run/transitions.js";
import type { ApprovalResourceDescriptor } from "./request-create.js";

/**
 * An ask as its rows hold it, with the answers its card may offer and its answer once it has one.
 */
export interface StoredApprovalRequest {
  readonly approvalRequestId: ApprovalRequestId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly requestedBy: string;
  readonly category: ApprovalCategory;
  readonly scope: string;
  readonly resourceDescriptor: ApprovalResourceDescriptor;
  /** The daemon's own id of the provider ask the request was minted for; absent on its own card. */
  readonly askId: string | undefined;
  readonly state: ApprovalState;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Whether an answer may make a rule: never on an ask the provider forbids one on. */
  readonly standingAllowOffered: boolean;
  /**
   * Whether that rule may be the project's: never on a chat, which has no project, on a card the
   * daemon raised itself, which no provider relayed, nor on an ask its provider keeps no project
   * rule for.
   */
  readonly projectScopeOffered: boolean;
  readonly resolution: StoredApprovalResolution | undefined;
}

/** The one answer an ask received. */
interface StoredApprovalResolution {
  readonly deviceId: DeviceId;
  readonly clientResolutionId: string;
  readonly decision: ApprovalDecision;
  readonly effectiveScope: string;
  /** The rule the answer handed to the provider; absent for a one-time answer. */
  readonly rememberedScope: RememberedScope | undefined;
  readonly resolvedAt: string;
}

/** A new ask as its row records it, pending from `createdAt`. */
interface InsertedApprovalRequest {
  readonly approvalRequestId: ApprovalRequestId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly requestedBy: string;
  readonly category: ApprovalCategory;
  readonly scope: string;
  readonly resourceDescriptor: ApprovalResourceDescriptor;
  readonly askId: string | undefined;
  readonly createdAt: string;
}

/** An answer as its resolution row records it. */
interface InsertedApprovalResolution {
  readonly approvalRequestId: ApprovalRequestId;
  readonly deviceId: DeviceId;
  readonly clientResolutionId: string;
  readonly decision: ApprovalDecision;
  readonly effectiveScope: string;
  readonly rememberedScope: RememberedScope | undefined;
  readonly resolvedAt: string;
}

/** The narrowing of one session's asks a read may ask for. */
interface ApprovalRequestFilter {
  readonly sessionId: SessionId;
  readonly state?: ApprovalState | undefined;
  readonly category?: ApprovalCategory | undefined;
}

// The session states that take no new ask and cancel those still open.
const ENDED_SESSION_STATES: readonly SessionState[] = ["closed", "purge_requested"];
const ENDED_SESSION_STATES_SQL = sqlListOf(ENDED_SESSION_STATES);

const SESSION_OPEN_SQL = `SELECT 1 FROM sessions
  WHERE id = @session_id
    AND state NOT IN (${ENDED_SESSION_STATES_SQL})`;

const RUN_LIVE_SQL = `SELECT 1 FROM runs
  WHERE run_id = @run_id
    AND session_id = @session_id
    AND state NOT IN (${sqlListOf(RUN_TERMINAL_STATES)})`;

const INSERT_REQUEST_SQL = `INSERT INTO approval_requests
    (id, session_id, run_id, requested_by, category, scope, resource_descriptor, ask_id, state,
     created_at, updated_at)
  VALUES (@id, @session_id, @run_id, @requested_by, @category, @scope, @resource_descriptor,
          @ask_id, 'pending', @created_at, @created_at)`;

const SETTLE_PENDING_SQL = `UPDATE approval_requests
    SET state = @state, updated_at = @updated_at
  WHERE id = @id
    AND state = 'pending'`;

const INSERT_RESOLUTION_SQL = `INSERT INTO approval_resolutions
    (request_id, device_id, client_resolution_id, decision, effective_scope,
     remembered_scope_kind, remembered_scope_pattern, resolved_at)
  VALUES (@request_id, @device_id, @client_resolution_id, @decision, @effective_scope,
          @remembered_scope_kind, @remembered_scope_pattern, @resolved_at)`;

const SELECT_REQUESTS_SQL = `SELECT request.id, request.session_id, request.run_id,
       request.requested_by, request.category, request.scope, request.resource_descriptor,
       request.ask_id, request.state, request.created_at, request.updated_at,
       resolution.device_id, resolution.client_resolution_id, resolution.decision,
       resolution.effective_scope, resolution.remembered_scope_kind,
       resolution.remembered_scope_pattern, resolution.resolved_at,
       session.shape AS session_shape
  FROM approval_requests AS request
  LEFT JOIN approval_resolutions AS resolution ON resolution.request_id = request.id
  LEFT JOIN sessions AS session ON session.id = request.session_id`;

const SELECT_REQUEST_SQL = `${SELECT_REQUESTS_SQL} WHERE request.id = ?`;

const SELECT_ASK_REQUEST_SQL = `${SELECT_REQUESTS_SQL}
  WHERE request.run_id = @run_id AND request.ask_id = @ask_id`;

const SELECT_SESSION_REQUESTS_SQL = `${SELECT_REQUESTS_SQL}
  WHERE request.session_id = @session_id
    AND (@state IS NULL OR request.state = @state)
    AND (@category IS NULL OR request.category = @category)
  ORDER BY request.created_at, request.id`;

const SELECT_PENDING_FOR_RUN_SQL = `${SELECT_REQUESTS_SQL}
  WHERE request.run_id = ? AND request.state = 'pending'
  ORDER BY request.created_at, request.id`;

const SELECT_PENDING_FOR_SESSION_SQL = `${SELECT_REQUESTS_SQL}
  WHERE request.session_id = ? AND request.state = 'pending'
  ORDER BY request.created_at, request.id`;

const SELECT_ENDED_SESSIONS_WITH_PENDING_SQL = `SELECT DISTINCT request.session_id
  FROM approval_requests AS request
  JOIN sessions AS session ON session.id = request.session_id
  WHERE request.state = 'pending'
    AND session.state IN (${ENDED_SESSION_STATES_SQL})`;

const SELECT_SESSION_ENDED_SQL = `SELECT 1 AS is_ended FROM sessions
  WHERE id = ? AND state IN (${ENDED_SESSION_STATES_SQL})`;

interface ApprovalRequestRow {
  readonly id: ApprovalRequestId;
  readonly session_id: SessionId;
  readonly run_id: RunId;
  readonly requested_by: string;
  readonly category: ApprovalCategory;
  readonly scope: string;
  readonly resource_descriptor: string;
  readonly ask_id: string | null;
  readonly state: ApprovalState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly device_id: DeviceId | null;
  readonly client_resolution_id: string | null;
  readonly decision: ApprovalDecision | null;
  readonly effective_scope: string | null;
  readonly remembered_scope_kind: RememberedScopeKind | null;
  readonly remembered_scope_pattern: string | null;
  readonly resolved_at: string | null;
  readonly session_shape: string | null;
}

/** A guard that refuses its write once the session is closed or being deleted. */
export function sessionOpenStatement(sessionId: SessionId): WriteStatement {
  return { sql: SESSION_OPEN_SQL, bindings: { session_id: sessionId }, expectedRowCount: 1 };
}

/** A guard that refuses its write unless the run is the session's and has not ended. */
export function runLiveStatement(sessionId: SessionId, runId: RunId): WriteStatement {
  return {
    sql: RUN_LIVE_SQL,
    bindings: { session_id: sessionId, run_id: runId },
    expectedRowCount: 1,
  };
}

/** The statement that records a new pending ask. */
export function insertRequestStatement(request: InsertedApprovalRequest): WriteStatement {
  return {
    sql: INSERT_REQUEST_SQL,
    bindings: {
      id: request.approvalRequestId,
      session_id: request.sessionId,
      run_id: request.runId,
      requested_by: request.requestedBy,
      category: request.category,
      scope: request.scope,
      resource_descriptor: JSON.stringify(request.resourceDescriptor),
      ask_id: request.askId ?? null,
      created_at: request.createdAt,
    },
    expectedRowCount: 1,
  };
}

/** The statement that settles an ask, refused unless it is still pending. */
export function settlePendingStatement(
  approvalRequestId: ApprovalRequestId,
  state: Exclude<ApprovalState, "pending">,
  settledAt: string,
): WriteStatement {
  return {
    sql: SETTLE_PENDING_SQL,
    bindings: { id: approvalRequestId, state, updated_at: settledAt },
    expectedRowCount: 1,
  };
}

/** The statement that records an ask's one answer. */
export function insertResolutionStatement(resolution: InsertedApprovalResolution): WriteStatement {
  return {
    sql: INSERT_RESOLUTION_SQL,
    bindings: {
      request_id: resolution.approvalRequestId,
      device_id: resolution.deviceId,
      client_resolution_id: resolution.clientResolutionId,
      decision: resolution.decision,
      effective_scope: resolution.effectiveScope,
      remembered_scope_kind: resolution.rememberedScope?.kind ?? null,
      remembered_scope_pattern: resolution.rememberedScope?.pattern ?? null,
      resolved_at: resolution.resolvedAt,
    },
    expectedRowCount: 1,
  };
}

/** Reads asks and their answers on the daemon's read-only connection. */
export class ApprovalRequestReader {
  readonly #selectRequest: Statement<[ApprovalRequestId], ApprovalRequestRow>;
  readonly #selectAskRequest: Statement<{ run_id: RunId; ask_id: string }, ApprovalRequestRow>;
  readonly #selectSessionRequests: Statement<
    { session_id: SessionId; state: ApprovalState | null; category: ApprovalCategory | null },
    ApprovalRequestRow
  >;
  readonly #selectPendingForRun: Statement<[RunId], ApprovalRequestRow>;
  readonly #selectPendingForSession: Statement<[SessionId], ApprovalRequestRow>;
  readonly #selectEndedSessionsWithPending: Statement<[], { readonly session_id: SessionId }>;
  readonly #selectSessionEnded: Statement<[SessionId], { readonly is_ended: 1 }>;

  constructor(reader: Database) {
    this.#selectRequest = reader.prepare(SELECT_REQUEST_SQL);
    this.#selectAskRequest = reader.prepare(SELECT_ASK_REQUEST_SQL);
    this.#selectSessionRequests = reader.prepare(SELECT_SESSION_REQUESTS_SQL);
    this.#selectPendingForRun = reader.prepare(SELECT_PENDING_FOR_RUN_SQL);
    this.#selectPendingForSession = reader.prepare(SELECT_PENDING_FOR_SESSION_SQL);
    this.#selectEndedSessionsWithPending = reader.prepare(SELECT_ENDED_SESSIONS_WITH_PENDING_SQL);
    this.#selectSessionEnded = reader.prepare(SELECT_SESSION_ENDED_SQL);
  }

  /** The ask under `approvalRequestId`, or `undefined` when the daemon holds none. */
  readRequest(approvalRequestId: ApprovalRequestId): StoredApprovalRequest | undefined {
    const row = this.#selectRequest.get(approvalRequestId);
    return row === undefined ? undefined : storedRequestOf(row);
  }

  /** The request minted for the run's provider ask `askId`, or `undefined` when it has none. */
  readAskRequest(runId: RunId, askId: string): StoredApprovalRequest | undefined {
    const row = this.#selectAskRequest.get({ run_id: runId, ask_id: askId });
    return row === undefined ? undefined : storedRequestOf(row);
  }

  /** One session's asks, oldest first, narrowed as `filter` asks. */
  listSessionRequests(filter: ApprovalRequestFilter): StoredApprovalRequest[] {
    return this.#selectSessionRequests
      .all({
        session_id: filter.sessionId,
        state: filter.state ?? null,
        category: filter.category ?? null,
      })
      .map(storedRequestOf);
  }

  /** The run's asks still pending, oldest first. */
  listPendingForRun(runId: RunId): StoredApprovalRequest[] {
    return this.#selectPendingForRun.all(runId).map(storedRequestOf);
  }

  /** The session's asks still pending across all its runs, oldest first. */
  listPendingForSession(sessionId: SessionId): StoredApprovalRequest[] {
    return this.#selectPendingForSession.all(sessionId).map(storedRequestOf);
  }

  /** The closed sessions, or those being deleted, that still hold a pending ask. */
  listEndedSessionsWithPending(): SessionId[] {
    return this.#selectEndedSessionsWithPending.all().map((row) => row.session_id);
  }

  /** Whether the session is closed or being deleted. */
  isSessionEnded(sessionId: SessionId): boolean {
    return this.#selectSessionEnded.get(sessionId) !== undefined;
  }
}

function storedRequestOf(row: ApprovalRequestRow): StoredApprovalRequest {
  // Written by the create from a parsed descriptor, so it is read back as that.
  const resourceDescriptor = JSON.parse(row.resource_descriptor) as ApprovalResourceDescriptor;
  const standingAllowOffered = resourceDescriptor.standingAllowOffered;
  return {
    approvalRequestId: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    requestedBy: row.requested_by,
    category: row.category,
    scope: row.scope,
    resourceDescriptor,
    askId: row.ask_id ?? undefined,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    standingAllowOffered,
    projectScopeOffered:
      standingAllowOffered &&
      resourceDescriptor.projectScopeOffered &&
      row.ask_id !== null &&
      row.session_shape === "project",
    resolution: resolutionOf(row),
  };
}

// A resolution row's columns are all NOT NULL, so its required one tells whether it joined.
function resolutionOf(row: ApprovalRequestRow): StoredApprovalResolution | undefined {
  if (
    row.device_id === null ||
    row.client_resolution_id === null ||
    row.decision === null ||
    row.effective_scope === null ||
    row.resolved_at === null
  ) {
    return undefined;
  }
  return {
    deviceId: row.device_id,
    clientResolutionId: row.client_resolution_id,
    decision: row.decision,
    effectiveScope: row.effective_scope,
    rememberedScope:
      row.remembered_scope_kind === null || row.remembered_scope_pattern === null
        ? undefined
        : {
            kind: row.remembered_scope_kind,
            pattern: row.remembered_scope_pattern,
            sense: SENSE_BY_DECISION[row.decision],
          },
    resolvedAt: row.resolved_at,
  };
}
