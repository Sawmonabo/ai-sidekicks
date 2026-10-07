// The `runs` row each run event writes in its own write, so the row always equals a rebuild from
// the log and every later write can guard against it.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunStateChangeEvent } from "@ai-sidekicks/contracts/run/control";
import type { RunQueuedPayload } from "@ai-sidekicks/contracts/run/queued";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../../database/statement.js";

/**
 * One run state change as its stored event carries it: the state it leaves, the state it enters,
 * and the run version after the change advanced it by one.
 */
export type RunStateSwap = Pick<
  RunStateChangeEvent,
  "runId" | "runVersion" | "previousState" | "newState"
> & { sessionId: SessionId };

/** A progression that changes no state, advanced from the run version its caller read. */
export interface RunVersionAdvance {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly expectedRunVersion: number;
}

const INSERT_QUEUED_RUN_SQL = `INSERT INTO runs
    (run_id, session_id, parent_run_id, reached_by, state, run_version)
  VALUES (@run_id, @session_id, @parent_run_id, @reached_by, @state, @run_version)`;

// Matches only a row still in the state the change leaves, one version behind it.
const SWAP_RUN_STATE_SQL = `UPDATE runs
    SET state = @new_state,
        run_version = @run_version
  WHERE run_id = @run_id
    AND session_id = @session_id
    AND state = @previous_state
    AND run_version = @run_version - 1`;

const ADVANCE_RUN_VERSION_SQL = `UPDATE runs
    SET run_version = run_version + 1
  WHERE run_id = @run_id
    AND session_id = @session_id
    AND run_version = @expected_run_version`;

/** The statement that creates a run's row from its `run.queued` payload. */
export function insertQueuedRunStatement(payload: RunQueuedPayload): WriteStatement {
  return {
    sql: INSERT_QUEUED_RUN_SQL,
    bindings: {
      run_id: payload.runId,
      session_id: payload.sessionId,
      parent_run_id: payload.parentRunId ?? null,
      reached_by: payload.reachedBy ?? null,
      state: payload.newState,
      run_version: payload.runVersion,
    },
  };
}

/**
 * The statement that moves a run from `previousState` to `newState` at `runVersion`. It refuses
 * the write unless the row is in `previousState` at `runVersion - 1`, so of two changes decided
 * from the same read only the first commits.
 */
export function swapRunStateStatement(swap: RunStateSwap): WriteStatement {
  return {
    sql: SWAP_RUN_STATE_SQL,
    bindings: {
      run_id: swap.runId,
      session_id: swap.sessionId,
      previous_state: swap.previousState,
      new_state: swap.newState,
      run_version: swap.runVersion,
    },
    expectedRowCount: 1,
  };
}

/**
 * The statement that advances a run's version by one with no state change, as an applied
 * intervention does. It refuses the write unless the row is still at `expectedRunVersion`.
 */
export function advanceRunVersionStatement(advance: RunVersionAdvance): WriteStatement {
  return {
    sql: ADVANCE_RUN_VERSION_SQL,
    bindings: {
      run_id: advance.runId,
      session_id: advance.sessionId,
      expected_run_version: advance.expectedRunVersion,
    },
    expectedRowCount: 1,
  };
}
