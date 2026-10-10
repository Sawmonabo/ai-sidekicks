// The messages between the database writer on the daemon's main thread and its worker thread. Each
// request is answered once, in the order it was sent.

import type { SessionEventRow } from "../events/session/insert.js";
import type { CarriedError } from "../worker/carried-error.js";
import type { CheckpointMode, CheckpointResult } from "./checkpoint.js";
import type { StatementResult, WriteStatement } from "./statement.js";

/** One write: its statements, then its event rows in order, run as one unit. */
export interface WriteJob {
  readonly statements: readonly WriteStatement[];
  readonly events: readonly SessionEventRow[];
}

/** How one write in a committed batch ended. */
export type WriteJobOutcome =
  | {
      readonly status: "committed";
      readonly statementResults: readonly StatementResult[];
      /** Each event row's sequence, in the order the rows were given. */
      readonly sequences: readonly number[];
    }
  | { readonly status: "refused"; readonly statementIndex: number; readonly rowCount: number }
  | { readonly status: "failed"; readonly error: CarriedError };

/** What the main thread asks of the worker. */
export type WriterRequest =
  | { readonly type: "batch"; readonly jobs: readonly WriteJob[] }
  | { readonly type: "checkpoint"; readonly mode: CheckpointMode }
  | { readonly type: "close" };

/** What the worker answers: once when its connection is open, then once per request. */
export type WriterReply =
  | { readonly type: "opened" }
  | { readonly type: "open-failed"; readonly error: CarriedError }
  | { readonly type: "batch-committed"; readonly outcomes: readonly WriteJobOutcome[] }
  | { readonly type: "batch-failed"; readonly error: CarriedError }
  | { readonly type: "checkpointed"; readonly result: CheckpointResult }
  | { readonly type: "checkpoint-failed"; readonly error: CarriedError }
  | { readonly type: "closed" };

/** What the worker is started with. */
export interface WriterWorkerData {
  readonly databasePath: string;
}
