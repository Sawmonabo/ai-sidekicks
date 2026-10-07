// Reads a run's current state and version from its `runs` row.

import type { Database, Statement } from "better-sqlite3";

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/**
 * A run as it stands now. `version` counts every progression of the run, state changes and
 * applied interventions alike; a decision taken from it is guarded again inside the write it
 * decides, since another write may land between the read and that write.
 */
export type RunRead = { version: number; sessionId: SessionId; state: RunState };

interface RunRow {
  readonly session_id: SessionId;
  readonly state: RunState;
  readonly run_version: number;
}

/** Reads runs on the daemon's read-only connection, which sees each write once it has committed. */
export class RunStateReader {
  readonly #selectRun: Statement<[RunId], RunRow>;

  constructor(reader: Database) {
    this.#selectRun = reader.prepare(
      "SELECT session_id, state, run_version FROM runs WHERE run_id = ?",
    );
  }

  /** The run's current state and version, or `undefined` for a run the daemon has no row for. */
  getRun(runId: RunId): RunRead | undefined {
    const row = this.#selectRun.get(runId);
    if (row === undefined) {
      return undefined;
    }
    return { version: row.run_version, sessionId: row.session_id, state: row.state };
  }
}
