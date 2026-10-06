// The messages between the database writer on the daemon's main thread and its worker thread. Each
// request is answered once, in the order it was sent.

import type { SessionEventRow } from "../events/session/insert.js";

/** A statement's bound values: positional, or named by `@name`. */
type StatementBindings = readonly unknown[] | Readonly<Record<string, unknown>>;

/** One SQL statement for the writer to run. */
export interface WriteStatement {
  readonly sql: string;
  readonly bindings?: StatementBindings;
  /**
   * The rows the statement must change, or return when it reads; any other count refuses the
   * write and rolls it back whole.
   */
  readonly expectedRowCount?: number;
}

/** What one statement did: the rows it changed, or returned when it reads, and those rows. */
export interface StatementResult {
  readonly rowCount: number;
  readonly rows: readonly unknown[];
}

/** One write: its statements and then, for an append, its event row, run as one unit. */
export interface WriteJob {
  readonly statements: readonly WriteStatement[];
  readonly event?: SessionEventRow;
}

/** An error carried across the thread boundary, which keeps only plain data. */
export interface CarriedError {
  readonly message: string;
  readonly stack: string | undefined;
  /** The SQLite result code, present when SQLite raised it. */
  readonly sqliteCode: string | undefined;
}

/** How one write in a committed batch ended. */
export type WriteJobOutcome =
  | {
      readonly status: "committed";
      readonly statementResults: readonly StatementResult[];
      /** The appended event's sequence; absent for a write with no event. */
      readonly sequence: number | undefined;
    }
  | { readonly status: "refused"; readonly statementIndex: number; readonly rowCount: number }
  | { readonly status: "failed"; readonly error: CarriedError };

/** A WAL checkpoint mode the writer runs. */
export type CheckpointMode = "PASSIVE" | "TRUNCATE";

/** What a WAL checkpoint reports, in SQLite's own terms. */
export interface CheckpointResult {
  /** Whether another connection kept the checkpoint from finishing. */
  readonly isBusy: boolean;
  /** Frames in the write-ahead log. */
  readonly logFrames: number;
  /** Frames moved into the database file. */
  readonly checkpointedFrames: number;
}

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
