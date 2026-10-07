// Reads a run's current state and version from its `runs` row, and the runs not yet ended.

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

// Spelled as the partial index on live runs spells it, so the scan reads that index.
const SELECT_LIVE_RUNS_SQL = `SELECT run_id, session_id, state, run_version, parent_run_id, reached_by
  FROM runs
  WHERE state NOT IN (${RUN_TERMINAL_STATES.map((state) => `'${state}'`).join(", ")})`;

/** Reads runs on the daemon's read-only connection, which sees each write once it has committed. */
export class RunStateReader {
  readonly #selectRun: Statement<[RunId], RunRow>;
  readonly #selectLiveRuns: Statement<[], LiveRunRow>;

  constructor(reader: Database) {
    this.#selectRun = reader.prepare(
      "SELECT session_id, state, run_version FROM runs WHERE run_id = ?",
    );
    this.#selectLiveRuns = reader.prepare(SELECT_LIVE_RUNS_SQL);
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
}
