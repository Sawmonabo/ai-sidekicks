// Reads a run's current state and version from its `runs` row, the runs not yet ended, and the
// live provider subagents beneath one run.

import type { Database, Statement } from "better-sqlite3";

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { ChildRunProvenance } from "@ai-sidekicks/contracts/run/queued";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { RUN_TERMINAL_STATES } from "./transitions.js";

/**
 * A run as it stands now. `version` counts every progression of the run, state changes and
 * applied interventions alike; a decision taken from it is guarded again inside the write it
 * decides, since another write may land between the read and that write.
 */
export type RunRead = { version: number; sessionId: SessionId; state: RunState };

/** A run not yet ended, with the parent it was reached from and how; both absent on a lead run. */
export interface LiveRun extends RunRead {
  readonly runId: RunId;
  readonly parentRunId: RunId | undefined;
  readonly reachedBy: ChildRunProvenance | undefined;
}

interface RunRow {
  readonly session_id: SessionId;
  readonly state: RunState;
  readonly run_version: number;
}

interface LiveRunRow extends RunRow {
  readonly run_id: RunId;
  readonly parent_run_id: RunId | null;
  readonly reached_by: ChildRunProvenance | null;
}

const TERMINAL_STATES_SQL = RUN_TERMINAL_STATES.map((state) => `'${state}'`).join(", ");

// Walks down `idx_runs_parent` through live provider subagents only, so the read scales with the
// one run's tree and a subagent that has ended cuts its branch off.
const SELECT_LIVE_PROVIDER_SUBAGENTS_SQL = `WITH RECURSIVE subagents(run_id) AS (
    SELECT run_id FROM runs
      WHERE parent_run_id = @run_id AND reached_by = 'provider_subagent'
        AND state NOT IN (${TERMINAL_STATES_SQL})
    UNION ALL
    SELECT runs.run_id FROM runs JOIN subagents ON runs.parent_run_id = subagents.run_id
      WHERE runs.reached_by = 'provider_subagent'
        AND runs.state NOT IN (${TERMINAL_STATES_SQL})
  )
  SELECT run_id FROM subagents`;

// Spelled as the partial index on live runs spells it, so the scan reads that index.
const SELECT_LIVE_RUNS_SQL = `SELECT run_id, session_id, state, run_version, parent_run_id, reached_by
  FROM runs
  WHERE state NOT IN (${TERMINAL_STATES_SQL})`;

/** Reads runs on the daemon's read-only connection, which sees each write once it has committed. */
export class RunStateReader {
  readonly #selectRun: Statement<[RunId], RunRow>;
  readonly #selectLiveRuns: Statement<[], LiveRunRow>;
  readonly #selectLiveProviderSubagents: Statement<[{ run_id: RunId }], { run_id: RunId }>;

  constructor(reader: Database) {
    this.#selectRun = reader.prepare(
      "SELECT session_id, state, run_version FROM runs WHERE run_id = ?",
    );
    this.#selectLiveRuns = reader.prepare(SELECT_LIVE_RUNS_SQL);
    this.#selectLiveProviderSubagents = reader.prepare(SELECT_LIVE_PROVIDER_SUBAGENTS_SQL);
  }

  /** The run's current state and version, or `undefined` for a run the daemon has no row for. */
  getRun(runId: RunId): RunRead | undefined {
    const row = this.#selectRun.get(runId);
    if (row === undefined) {
      return undefined;
    }
    return { version: row.run_version, sessionId: row.session_id, state: row.state };
  }

  /** Every run in every session that has not ended, queued runs included. */
  listLiveRuns(): LiveRun[] {
    return this.#selectLiveRuns.all().map((row) => ({
      runId: row.run_id,
      version: row.run_version,
      sessionId: row.session_id,
      state: row.state,
      parentRunId: row.parent_run_id ?? undefined,
      reachedBy: row.reached_by ?? undefined,
    }));
  }

  /**
   * The live runs `runId`'s provider dispatched beneath it as its own subagents, at any depth
   * through live ones; they share its process. A child reached any other way is not one.
   */
  listLiveProviderSubagents(runId: RunId): RunId[] {
    return this.#selectLiveProviderSubagents.all({ run_id: runId }).map((row) => row.run_id);
  }
}
