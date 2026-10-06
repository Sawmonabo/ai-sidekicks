// The database writer's worker thread: the one read-write connection to the daemon's database. It
// opens the file with the connection pragmas and the schema, then runs each batch it is sent as one
// transaction, each write in it under a savepoint of its own, so a refused or failed write rolls
// back alone while the batch commits whole or not at all.

import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import type { Database, Statement } from "better-sqlite3";
import { LRUCache } from "lru-cache";

import { prepareSessionEventInsert } from "../events/session/insert.js";
import { openDatabase } from "../session/migration-runner.js";
import type {
  CarriedError,
  CheckpointMode,
  CheckpointResult,
  StatementResult,
  WriteJob,
  WriteJobOutcome,
  WriterReply,
  WriterRequest,
  WriterWorkerData,
  WriteStatement,
} from "./messages.js";

// Prepared statements kept per SQL text; bounded, since a caller may build its SQL.
const PREPARED_STATEMENT_LIMIT = 256;

// Thrown inside a write's savepoint so the rollback undoes every statement it ran.
class WriteRefusal extends Error {
  readonly statementIndex: number;
  readonly rowCount: number;

  constructor(statementIndex: number, rowCount: number) {
    super(`Statement ${String(statementIndex)} matched ${String(rowCount)} rows`);
    this.statementIndex = statementIndex;
    this.rowCount = rowCount;
  }
}

interface WalCheckpointRow {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

if (parentPort === null) {
  throw new Error("The database writer's worker runs only as a worker thread");
}
const port: MessagePort = parentPort;
const post = (reply: WriterReply): void => {
  port.postMessage(reply);
};

const { databasePath } = workerData as WriterWorkerData;
let database: Database | undefined;
try {
  database = openDatabase(databasePath);
} catch (error) {
  post({ type: "open-failed", error: carryError(error) });
  port.close();
}
if (database !== undefined) {
  serve(database);
  post({ type: "opened" });
}

function serve(connection: Database): void {
  const preparedStatements = new LRUCache<string, Statement>({ max: PREPARED_STATEMENT_LIMIT });
  const insertSessionEvent = prepareSessionEventInsert(connection);

  const runStatement = (statement: WriteStatement, statementIndex: number): StatementResult => {
    let prepared = preparedStatements.get(statement.sql);
    if (prepared === undefined) {
      prepared = connection.prepare(statement.sql);
      preparedStatements.set(statement.sql, prepared);
    }
    const bindings = statement.bindings ?? [];
    let result: StatementResult;
    if (prepared.reader) {
      const rows: unknown[] = Array.isArray(bindings)
        ? prepared.all(...bindings)
        : prepared.all(bindings);
      result = { rowCount: rows.length, rows };
    } else {
      const info = Array.isArray(bindings) ? prepared.run(...bindings) : prepared.run(bindings);
      result = { rowCount: info.changes, rows: [] };
    }
    if (
      statement.expectedRowCount !== undefined &&
      result.rowCount !== statement.expectedRowCount
    ) {
      throw new WriteRefusal(statementIndex, result.rowCount);
    }
    return result;
  };

  // Called inside the batch's transaction, so better-sqlite3 runs it as a savepoint.
  const runJobInSavepoint = connection.transaction(
    (job: WriteJob): WriteJobOutcome => ({
      status: "committed",
      statementResults: job.statements.map(runStatement),
      sequence: job.event === undefined ? undefined : insertSessionEvent(job.event),
    }),
  );

  const runJob = (job: WriteJob): WriteJobOutcome => {
    try {
      return runJobInSavepoint(job);
    } catch (error) {
      // SQLite ends the whole transaction on some errors (a full disk, an I/O error); the writes
      // after this one would then commit one by one, so the batch fails instead.
      if (!connection.inTransaction) {
        throw error;
      }
      if (error instanceof WriteRefusal) {
        return {
          status: "refused",
          statementIndex: error.statementIndex,
          rowCount: error.rowCount,
        };
      }
      return { status: "failed", error: carryError(error) };
    }
  };

  const runBatch = connection.transaction((jobs: readonly WriteJob[]) => jobs.map(runJob));

  const checkpoint = (mode: CheckpointMode): CheckpointResult => {
    const rows = connection.pragma(`wal_checkpoint(${mode})`) as readonly WalCheckpointRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`wal_checkpoint(${mode}) returned no row`);
    }
    return { isBusy: row.busy !== 0, logFrames: row.log, checkpointedFrames: row.checkpointed };
  };

  port.on("message", (request: WriterRequest) => {
    switch (request.type) {
      case "batch":
        try {
          post({ type: "batch-committed", outcomes: runBatch.immediate(request.jobs) });
        } catch (error) {
          post({ type: "batch-failed", error: carryError(error) });
        }
        return;
      case "checkpoint":
        try {
          post({ type: "checkpointed", result: checkpoint(request.mode) });
        } catch (error) {
          post({ type: "checkpoint-failed", error: carryError(error) });
        }
        return;
      case "close":
        connection.close();
        post({ type: "closed" });
        port.close();
        return;
    }
  });
}

// A thread boundary keeps only plain data, so an error travels as its message, stack and code.
function carryError(error: unknown): CarriedError {
  if (!(error instanceof Error)) {
    return { message: String(error), stack: undefined, sqliteCode: undefined };
  }
  const code: unknown = "code" in error ? error.code : undefined;
  return {
    message: error.message,
    stack: error.stack,
    sqliteCode: typeof code === "string" && code.startsWith("SQLITE_") ? code : undefined,
  };
}
