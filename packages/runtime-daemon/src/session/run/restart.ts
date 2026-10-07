// How a run a restart left live ends when recovery cannot resume it: interrupted when the person
// had asked to stop it or it was a child held when the daemon went down, failed otherwise.

import type { Database, Statement } from "better-sqlite3";

import type { RunId } from "@ai-sidekicks/contracts/run/id";

import type { WriteStatement } from "../../database/statement.js";
import type { LiveRun } from "./read.js";

// An interrupt the person asked for that has not ended the run: one with no outcome yet, or one
// whose outcome advanced the run to `@run_version`, the version read, and whose end never landed.
const SELECT_PENDING_INTERRUPT_SQL = `SELECT 1 FROM interventions
  WHERE target_run_id = @run_id
    AND type = 'interrupt'
    AND (state IN ('requested', 'accepted')
      OR (state IN ('applied', 'degraded') AND expected_run_version + 1 = @run_version))
  LIMIT 1`;

/** The state a run a restart left live settles in, or `undefined` for a run left as it is. */
export type RestartSettlement = "interrupted" | "failed" | undefined;

/**
 * Decides how `run` settles. The person's pending interrupt comes first; a child held in a pause
 * the restart orphaned reads interrupted and continues from its own box; a queued run is left for
 * its queue item to start.
 */
export function decideRestartSettlement(
  run: LiveRun,
  hasPendingInterrupt: boolean,
): RestartSettlement {
  if (run.state === "queued") {
    return undefined;
  }
  if (hasPendingInterrupt) {
    return "interrupted";
  }
  if (run.parentRunId !== undefined && (run.state === "paused" || run.state === "pausing")) {
    return "interrupted";
  }
  return "failed";
}

// A live run as the pending-interrupt read takes it: its id and the version it was read at.
type RunAtVersion = Pick<LiveRun, "runId" | "version">;

/**
 * Reads whether the person's interrupt of a live run is still to end it: waiting for its outcome,
 * or applied with the run's end not yet written.
 */
export class PendingInterruptReader {
  readonly #selectPendingInterrupt: Statement<[{ run_id: RunId; run_version: number }], unknown>;

  constructor(reader: Database) {
    this.#selectPendingInterrupt = reader.prepare(SELECT_PENDING_INTERRUPT_SQL);
  }

  hasPendingInterrupt(run: RunAtVersion): boolean {
    return (
      this.#selectPendingInterrupt.get({ run_id: run.runId, run_version: run.version }) !==
      undefined
    );
  }
}

/**
 * The statement that refuses the settle's write when the pending interrupt it was decided from
 * has since appeared or gone, so the settle never contradicts the person's last word. It reads
 * against the version `run` was read at, which the settle's own swap holds the row to.
 */
export function pendingInterruptStatement(
  run: RunAtVersion,
  hasPendingInterrupt: boolean,
): WriteStatement {
  return {
    sql: SELECT_PENDING_INTERRUPT_SQL,
    bindings: { run_id: run.runId, run_version: run.version },
    expectedRowCount: hasPendingInterrupt ? 1 : 0,
  };
}
