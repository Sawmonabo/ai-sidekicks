// The `interventions` row: the statements that write it, each guarded so a write decided from a
// stale read is refused whole, and the read of a row saved under a reused idempotency key.

import type { Database, Statement } from "better-sqlite3";

import type { InterventionId, InterventionState } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { InterventionType } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { DATABASE_NOW_SQL, type WriteStatement } from "../database/statement.js";

/** A new intervention as its `requested` row records it; `payload` is its type's own fields. */
export interface RequestedIntervention {
  readonly interventionId: InterventionId;
  readonly targetRunId: RunId;
  readonly type: InterventionType;
  readonly payload: string;
  readonly expectedRunVersion: number;
  readonly clientIdempotencyKey: string;
  readonly deviceId: DeviceId | null;
}

/**
 * One move of an intervention's row. Each leaves exactly the state its `from` names; only a
 * `rejected` or `failed` row carries a reason and only a `degraded` one a fallback. A request
 * expires only before dispatch: once dispatched, the driver's verdict stands. Only a restart that
 * ends the run for a stop still pending moves a `requested` row to `applied`.
 */
export type InterventionTransition =
  | { readonly from: "requested"; readonly to: "accepted" }
  | { readonly from: "requested" | "accepted"; readonly to: "expired" }
  | { readonly from: "requested" | "accepted"; readonly to: "rejected"; readonly reason: string }
  | { readonly from: "accepted"; readonly to: "failed"; readonly reason: string }
  | { readonly from: "requested" | "accepted"; readonly to: "applied" }
  | {
      readonly from: "accepted";
      readonly to: "degraded";
      readonly fallbackAction: string | undefined;
    };

/** An intervention as saved, read back for a request that reused its idempotency key. */
export interface SavedIntervention {
  readonly interventionId: InterventionId;
  readonly type: InterventionType;
  readonly state: InterventionState;
  readonly payload: string;
  readonly rejectionReason: string | null;
  readonly failureReason: string | null;
}

// Changes no row when the key was already spent on this run, so the write that carries it is
// refused and nothing saved is replaced.
const INSERT_REQUESTED_SQL = `INSERT INTO interventions
    (id, target_run_id, type, state, payload, expected_run_version, client_idempotency_key,
     device_id, created_at)
  VALUES (@id, @target_run_id, @type, 'requested', @payload, @expected_run_version,
          @client_idempotency_key, @device_id, ${DATABASE_NOW_SQL})
  ON CONFLICT (target_run_id, client_idempotency_key) DO NOTHING`;

const MOVE_SQL = `UPDATE interventions
    SET state = @to,
        rejection_reason = @rejection_reason,
        failure_reason = @failure_reason,
        fallback_action = @fallback_action,
        resolved_at = CASE WHEN @to = 'accepted' THEN NULL ELSE ${DATABASE_NOW_SQL} END
  WHERE id = @id
    AND state = @from`;

const RUN_AT_VERSION_SQL = `SELECT 1 FROM runs
  WHERE run_id = @run_id
    AND run_version = @run_version`;

const RUN_IN_STATES_SQL = `SELECT 1 FROM runs
  WHERE run_id = @run_id
    AND state IN (SELECT value FROM json_each(@states))`;

/** The statement that records a new intervention, refused when its key is already spent. */
export function insertRequestedInterventionStatement(
  intervention: RequestedIntervention,
): WriteStatement {
  return {
    sql: INSERT_REQUESTED_SQL,
    bindings: {
      id: intervention.interventionId,
      target_run_id: intervention.targetRunId,
      type: intervention.type,
      payload: intervention.payload,
      expected_run_version: intervention.expectedRunVersion,
      client_idempotency_key: intervention.clientIdempotencyKey,
      device_id: intervention.deviceId,
    },
    expectedRowCount: 1,
  };
}

/**
 * The statement that moves an intervention's row, refused unless the row is still in `from`.
 * Every move but the one to `accepted` is an outcome and stamps when it was reached.
 */
export function moveInterventionStatement(
  interventionId: InterventionId,
  transition: InterventionTransition,
): WriteStatement {
  return {
    sql: MOVE_SQL,
    bindings: {
      id: interventionId,
      from: transition.from,
      to: transition.to,
      rejection_reason: transition.to === "rejected" ? transition.reason : null,
      failure_reason: transition.to === "failed" ? transition.reason : null,
      fallback_action: transition.to === "degraded" ? (transition.fallbackAction ?? null) : null,
    },
    expectedRowCount: 1,
  };
}

/** A guard that refuses its write unless the run is still at `runVersion`. */
export function runAtVersionStatement(runId: RunId, runVersion: number): WriteStatement {
  return {
    sql: RUN_AT_VERSION_SQL,
    bindings: { run_id: runId, run_version: runVersion },
    expectedRowCount: 1,
  };
}

/** A guard that refuses its write unless the run is in one of `states`. */
export function runInStatesStatement(runId: RunId, states: readonly RunState[]): WriteStatement {
  return {
    sql: RUN_IN_STATES_SQL,
    bindings: { run_id: runId, states: JSON.stringify(states) },
    expectedRowCount: 1,
  };
}

interface SavedInterventionRow {
  readonly id: InterventionId;
  readonly type: InterventionType;
  readonly state: InterventionState;
  readonly payload: string;
  readonly rejection_reason: string | null;
  readonly failure_reason: string | null;
}

/** Reads saved interventions on the daemon's read-only connection. */
export class InterventionReader {
  readonly #selectByIdempotencyKey: Statement<[RunId, string], SavedInterventionRow>;

  constructor(reader: Database) {
    this.#selectByIdempotencyKey = reader.prepare(
      `SELECT id, type, state, payload, rejection_reason, failure_reason FROM interventions
        WHERE target_run_id = ? AND client_idempotency_key = ?`,
    );
  }

  /** The intervention saved on `targetRunId` under `clientIdempotencyKey`, if one is. */
  getByIdempotencyKey(
    targetRunId: RunId,
    clientIdempotencyKey: string,
  ): SavedIntervention | undefined {
    const row = this.#selectByIdempotencyKey.get(targetRunId, clientIdempotencyKey);
    if (row === undefined) {
      return undefined;
    }
    return {
      interventionId: row.id,
      type: row.type,
      state: row.state,
      payload: row.payload,
      rejectionReason: row.rejection_reason,
      failureReason: row.failure_reason,
    };
  }
}
