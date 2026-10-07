// The `runs` row each run event writes in its own write, so the row always equals a rebuild from
// the log and every later write can guard against it; the rebuild folds the log through the same
// statements.

import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunStateChangeEvent } from "@ai-sidekicks/contracts/run/control";
import {
  RUN_STATE_CHANGE_PAYLOAD_SCHEMAS,
  type RunStateChangeState,
} from "@ai-sidekicks/contracts/run/events";
import type { RunQueuedPayload } from "@ai-sidekicks/contracts/run/queued";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../../database/statement.js";
import {
  ProjectionFailureError,
  type SessionProjection,
  type SessionProjectionFold,
} from "../../recovery/projection-rebuild.js";
import { isTerminalState, RUN_TERMINAL_STATES } from "./transitions.js";

/**
 * One run state change as its stored event carries it: the state it leaves, the state it enters,
 * and the run version after the change advanced it by one.
 */
export type RunStateSwap = Pick<
  RunStateChangeEvent,
  "runId" | "runVersion" | "previousState" | "newState"
> & { sessionId: SessionId };

/** A progression that changes no state, advanced from whatever version the run is at. */
export interface RunVersionAdvance {
  readonly sessionId: SessionId;
  readonly runId: RunId;
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

// An ended run keeps its version: nothing moves a run past its end event.
const ADVANCE_RUN_VERSION_SQL = `UPDATE runs
    SET run_version = run_version
      + CASE WHEN state IN (${RUN_TERMINAL_STATES.map((state) => `'${state}'`).join(", ")})
          THEN 0 ELSE 1 END
  WHERE run_id = @run_id
    AND session_id = @session_id`;

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
 * The statement that advances a live run's version by one from its current value with no state
 * change, as a dispatched intervention's verdict does, and leaves an ended run's as it is. It
 * holds no stale comparand, because no earlier read decides it; it refuses the write only when
 * the run is not under `sessionId`.
 */
export function advanceRunVersionStatement(advance: RunVersionAdvance): WriteStatement {
  return {
    sql: ADVANCE_RUN_VERSION_SQL,
    bindings: { run_id: advance.runId, session_id: advance.sessionId },
    expectedRowCount: 1,
  };
}

// A stored `run.<state>` event, whose payload is the change the swap writes.
type RunStateChangeSessionEvent = Extract<SessionEvent, { type: `run.${RunStateChangeState}` }>;

const RUN_STATE_CHANGE_EVENT_TYPES: ReadonlySet<string> = new Set(
  (Object.keys(RUN_STATE_CHANGE_PAYLOAD_SCHEMAS) as RunStateChangeState[]).map(
    (state) => `run.${state}`,
  ),
);

function isRunStateChangeEvent(event: SessionEvent): event is RunStateChangeSessionEvent {
  return RUN_STATE_CHANGE_EVENT_TYPES.has(event.type);
}

function foldRuns(): SessionProjectionFold {
  // Each terminal event already folded, by its run and run version, with its envelope id.
  const terminalEventIdByRunVersion = new Map<string, string>();
  return {
    apply(event) {
      if (event.type === "run.queued") {
        return [insertQueuedRunStatement(event.payload)];
      }
      if (event.type === "intervention.applied" || event.type === "intervention.degraded") {
        // An interrupt's verdict ends its run in the same write, which the run's own end event
        // moves, or finds the run already ended; neither advances the version.
        if (event.payload.type === "interrupt") {
          return [];
        }
        return [
          advanceRunVersionStatement({
            sessionId: event.payload.sessionId,
            runId: event.payload.targetRunId,
          }),
        ];
      }
      if (!isRunStateChangeEvent(event)) {
        return [];
      }
      const change = event.payload;
      if (isTerminalState(change.newState)) {
        const key = `${change.runId} ${String(change.runVersion)}`;
        const foldedEventId = terminalEventIdByRunVersion.get(key);
        // The same terminal seen again changes nothing; a different one contradicts the first.
        if (foldedEventId === event.id) {
          return [];
        }
        if (foldedEventId !== undefined) {
          throw new ProjectionFailureError(
            `Run ${change.runId} has two terminal events at run version ` +
              `${String(change.runVersion)}: ${foldedEventId} and ${event.id}`,
          );
        }
        terminalEventIdByRunVersion.set(key, event.id);
      }
      return [swapRunStateStatement(change)];
    },
  };
}

/** The `runs` rows as a rebuild replaces them: one per run, at its last state and version. */
export const RUNS_PROJECTION: SessionProjection = {
  name: "runs",
  eventTypes: new Set([
    "run.queued",
    "intervention.applied",
    "intervention.degraded",
    ...RUN_STATE_CHANGE_EVENT_TYPES,
  ]),
  clearStatements: (sessionId) => [
    { sql: "DELETE FROM runs WHERE session_id = ?", bindings: [sessionId] },
  ],
  createFold: foldRuns,
};
