// How a run a restart left live ends when recovery cannot resume it: interrupted when the person
// had asked to stop it or it was a child held when the daemon went down, failed otherwise.

import type { Database, Statement } from "better-sqlite3";

import type { InterventionId } from "@ai-sidekicks/contracts/run/control";
import {
  DAEMON_INTERVENTION_ACTOR,
  type InterventionActor,
} from "@ai-sidekicks/contracts/run/events";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import type { WriteStatement } from "../../database/statement.js";
import type { LiveRun } from "./read.js";

// An interrupt the person asked for that has no outcome yet. An applied one ends its run in the
// outcome's own write, so a live run never holds one.
const SELECT_PENDING_INTERRUPT_SQL = `SELECT id, state, device_id FROM interventions
  WHERE target_run_id = @run_id
    AND type = 'interrupt'
    AND state IN ('requested', 'accepted')
  LIMIT 1`;

/** The state a run a restart left live settles in, or `undefined` for a run left as it is. */
export type RestartSettlement = "interrupted" | "failed" | undefined;

/** The person's interrupt a restart found with no outcome: its row, its state and who asked. */
export interface PendingInterrupt {
  readonly interventionId: InterventionId;
  readonly state: "requested" | "accepted";
  readonly actor: InterventionActor;
}

interface PendingInterruptRow {
  readonly id: InterventionId;
  readonly state: "requested" | "accepted";
  readonly device_id: DeviceId | null;
}

/**
 * Decides how `run` settles. The person's pending interrupt comes first; a child held in a pause
 * the restart orphaned reads interrupted and continues from its own box; a queued run is left for
 * its queue item to start.
 */
export function decideRestartSettlement(
  run: LiveRun,
  pendingInterrupt: PendingInterrupt | undefined,
): RestartSettlement {
  if (run.state === "queued") {
    return undefined;
  }
  if (pendingInterrupt !== undefined) {
    return "interrupted";
  }
  if (run.parentRunId !== undefined && (run.state === "paused" || run.state === "pausing")) {
    return "interrupted";
  }
  return "failed";
}

/** Reads the person's interrupt of a live run that has no outcome yet. */
export class PendingInterruptReader {
  readonly #selectPendingInterrupt: Statement<[{ run_id: RunId }], PendingInterruptRow>;

  constructor(reader: Database) {
    this.#selectPendingInterrupt = reader.prepare(SELECT_PENDING_INTERRUPT_SQL);
  }

  readPendingInterrupt(runId: RunId): PendingInterrupt | undefined {
    const row = this.#selectPendingInterrupt.get({ run_id: runId });
    if (row === undefined) {
      return undefined;
    }
    return {
      interventionId: row.id,
      state: row.state,
      actor: row.device_id ?? DAEMON_INTERVENTION_ACTOR,
    };
  }
}

/**
 * The statement that refuses a settle decided with no pending interrupt once one has appeared, so
 * the settle never contradicts the person's last word.
 */
export function noPendingInterruptStatement(runId: RunId): WriteStatement {
  return {
    sql: SELECT_PENDING_INTERRUPT_SQL,
    bindings: { run_id: runId },
    expectedRowCount: 0,
  };
}
