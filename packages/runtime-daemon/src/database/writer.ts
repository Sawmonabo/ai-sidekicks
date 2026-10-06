// The database writer: every write the daemon makes goes through it to the one read-write
// connection, which a worker thread of its own holds, so a commit's disk sync never stalls the
// main thread. Writes wait in a bounded queue and go to the worker in batches of up to 50 events,
// or after 10 ms, whichever comes first; each batch commits as one transaction, so the writes of
// one turn of the event loop commit together. At the queue's cap a write waits for the next batch
// to commit, except an assistant's thinking update, which is dropped and counted.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

import type { ServiceLogWriter } from "../daemon/service-log.js";
import type { SessionEventRow } from "../events/session/insert.js";
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

/** The most entries the queue holds; an event, or a write with no event, is one entry. */
export const WRITE_QUEUE_CAPACITY = 10_000;
// A batch goes to the worker once it holds this many entries, or once its oldest has waited
// BATCH_WAIT_MS.
const BATCH_ENTRY_LIMIT = 50;
const BATCH_WAIT_MS = 10;
// The queue's depth is sampled this often while it holds anything; at ALERT_DEPTH a warning goes
// to the service log.
const SAMPLE_INTERVAL_MS = 1_000;
const ALERT_DEPTH = 8_000;
// The one event type the queue may drop at its cap: narration a later event supersedes.
const DROPPABLE_EVENT_TYPE = "assistant.thinking_update" satisfies SessionEventType;

// The worker module sits beside this one, with this module's own extension, in the source tree
// and in the build alike.
const WORKER_URL = new URL(
  `./worker${path.extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
);

/** A write refused because a statement's row count was not the one it expected. */
export class WriteRefusedError extends Error {
  /** The position of the refused statement among the write's statements. */
  readonly statementIndex: number;
  /** The rows that statement changed, or returned when it reads. */
  readonly rowCount: number;

  constructor(statementIndex: number, rowCount: number) {
    super(
      `The write was refused: statement ${String(statementIndex)} matched ${String(rowCount)} ` +
        `rows, not the count it expected, so none of the write was kept.`,
    );
    this.name = "WriteRefusedError";
    this.statementIndex = statementIndex;
    this.rowCount = rowCount;
  }
}

/** How an event append ended: stored at its sequence, or dropped at the full queue. */
export type EventWriteOutcome =
  | { readonly isStored: true; readonly sequence: number }
  | { readonly isStored: false };

/** What the writer needs from the daemon. */
export interface DatabaseWriterOptions {
  /** The database file; created with its schema when absent. */
  readonly databasePath: string;
  /** Where the queue's backpressure warnings and drop counts go. */
  readonly writeServiceLog: ServiceLogWriter;
}

interface QueueEntry {
  readonly job: WriteJob;
  readonly sessionId: string | undefined;
  readonly eventCategory: string | undefined;
  /** Settles with the worker's answer for this write; what a flush waits on. */
  readonly outcome: Promise<WriteJobOutcome>;
  readonly resolve: (outcome: WriteJobOutcome) => void;
  readonly reject: (error: Error) => void;
}

type CommittedOutcome = Extract<WriteJobOutcome, { readonly status: "committed" }>;

interface PendingReply {
  readonly accept: (reply: WriterReply) => void;
  readonly reject: (error: Error) => void;
}

/**
 * The daemon's one way to write its database. Open it with {@link DatabaseWriter.open}; every
 * write resolves once committed and rejects with the reason it was not.
 */
export class DatabaseWriter {
  /**
   * Resolves with the reason if the worker dies; from then on every write fails with it. Never
   * settles otherwise.
   */
  readonly whenWorkerFailed: Promise<Error>;

  readonly #worker: Worker;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #workerFailure = Promise.withResolvers<Error>();
  readonly #exited: Promise<void>;
  // Replies come back in the order the requests went out.
  readonly #pendingReplies: PendingReply[] = [];

  // Admitted entries not yet sent, the batch at the worker, and the writes waiting at the cap.
  readonly #queued: QueueEntry[] = [];
  #inFlight: readonly QueueEntry[] | undefined;
  readonly #waiting: QueueEntry[] = [];

  #batchTimer: ReturnType<typeof setTimeout> | undefined;
  #isBatchDue = false;
  #flushCount = 0;
  #sampleTimer: ReturnType<typeof setInterval> | undefined;
  // The write most recently offered, whose tags a backpressure warning carries.
  #latestEntry: QueueEntry | undefined;
  readonly #droppedBySession = new Map<string, number>();
  #failure: Error | undefined;
  #closing: Promise<void> | undefined;

  private constructor(worker: Worker, options: DatabaseWriterOptions) {
    this.#worker = worker;
    this.#writeServiceLog = options.writeServiceLog;
    this.whenWorkerFailed = this.#workerFailure.promise;
    this.#exited = new Promise<void>((resolve) => {
      worker.once("exit", () => {
        resolve();
      });
    });
    worker.on("message", (reply: WriterReply) => {
      this.#pendingReplies.shift()?.accept(reply);
    });
    worker.on("error", (error) => {
      this.#fail(error);
    });
    worker.on("exit", (code) => {
      if (this.#closing === undefined || this.#pendingReplies.length > 0) {
        this.#fail(new Error(`The database writer's worker exited with code ${String(code)}`));
      }
    });
  }

  /**
   * Starts the worker, which opens the database with its pragmas and schema, and resolves once it
   * has. Throws what the open threw.
   */
  static async open(options: DatabaseWriterOptions): Promise<DatabaseWriter> {
    const workerData: WriterWorkerData = { databasePath: options.databasePath };
    const worker = new Worker(WORKER_URL, { workerData });
    const writer = new DatabaseWriter(worker, options);
    const reply = await writer.#awaitReply();
    if (reply.type === "open-failed") {
      // The worker ends itself after a failed open; its exit is no failure to report.
      writer.#closing = writer.#exited;
      await writer.#exited;
      throw rebuildError(reply.error);
    }
    return writer;
  }

  /**
   * Runs `statements` in order as one write and resolves with what each did once it has
   * committed. Rejects with {@link WriteRefusedError} when a statement's row count is not the one
   * it expected, and with SQLite's error when a statement fails; either way none of it is kept.
   */
  async write(statements: readonly WriteStatement[]): Promise<readonly StatementResult[]> {
    const outcome = await this.#enqueue({ statements }, undefined);
    return outcome.statementResults;
  }

  /**
   * Appends one event row at its session's next sequence, after `statements`, all as one write.
   * Resolves once committed, or at once when the queue is full and the event may be dropped.
   * Rejects as {@link write} does.
   */
  async appendEvent(
    event: SessionEventRow,
    statements: readonly WriteStatement[] = [],
  ): Promise<EventWriteOutcome> {
    const outcome = await this.#enqueue({ statements, event }, event);
    if (outcome === undefined) {
      return { isStored: false };
    }
    if (outcome.sequence === undefined) {
      throw new Error("The database writer's worker answered an append with no sequence");
    }
    return { isStored: true, sequence: outcome.sequence };
  }

  /**
   * Resolves once every write taken before this call has committed or failed; a write taken
   * afterward does not extend the wait.
   */
  async flush(): Promise<void> {
    const pending = [...this.#waiting, ...this.#queued, ...(this.#inFlight ?? [])].map(
      (entry) => entry.outcome,
    );
    this.#flushCount += 1;
    this.#pump();
    try {
      await Promise.allSettled(pending);
    } finally {
      this.#flushCount -= 1;
    }
  }

  /** Runs a WAL checkpoint in `mode` on the writer's connection, between batches. */
  async checkpoint(mode: CheckpointMode): Promise<CheckpointResult> {
    const reply = await this.#request({ type: "checkpoint", mode });
    switch (reply.type) {
      case "checkpointed":
        return reply.result;
      case "checkpoint-failed":
        throw rebuildError(reply.error);
      default:
        throw unexpectedReply(reply);
    }
  }

  /**
   * Takes no new write, waits for every write taken to commit or fail, then closes the connection
   * and ends the worker. Repeated calls share the first close.
   */
  close(): Promise<void> {
    this.#closing ??= this.#runClose();
    return this.#closing;
  }

  async #runClose(): Promise<void> {
    await this.flush();
    this.#stopSampling();
    if (this.#failure !== undefined) {
      await this.#exited;
      return;
    }
    const reply = await this.#request({ type: "close" });
    if (reply.type !== "closed") {
      throw unexpectedReply(reply);
    }
    await this.#exited;
  }

  // Resolves with the write's outcome once committed, or `undefined` when the event was dropped.
  #enqueue(job: WriteJob, event: SessionEventRow): Promise<CommittedOutcome | undefined>;
  #enqueue(job: WriteJob, event: undefined): Promise<CommittedOutcome>;
  async #enqueue(
    job: WriteJob,
    event: SessionEventRow | undefined,
  ): Promise<CommittedOutcome | undefined> {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#closing !== undefined) {
      throw new Error("The database writer is closed; the write was not taken");
    }
    const { promise, resolve, reject } = Promise.withResolvers<WriteJobOutcome>();
    const entry: QueueEntry = {
      job,
      sessionId: event?.session_id,
      eventCategory: event?.category,
      outcome: promise,
      resolve,
      reject,
    };
    this.#latestEntry = entry;
    if (this.#waiting.length === 0 && this.#hasRoom()) {
      this.#admit(entry);
    } else if (event?.type === DROPPABLE_EVENT_TYPE) {
      this.#droppedBySession.set(
        event.session_id,
        (this.#droppedBySession.get(event.session_id) ?? 0) + 1,
      );
      this.#startSampling();
      return undefined;
    } else {
      this.#waiting.push(entry);
      this.#startSampling();
    }
    const outcome = await promise;
    switch (outcome.status) {
      case "committed":
        return outcome;
      case "refused":
        throw new WriteRefusedError(outcome.statementIndex, outcome.rowCount);
      case "failed":
        throw rebuildError(outcome.error);
    }
  }

  get #depth(): number {
    return this.#queued.length + (this.#inFlight?.length ?? 0);
  }

  #hasRoom(): boolean {
    return this.#depth < WRITE_QUEUE_CAPACITY;
  }

  #admit(entry: QueueEntry): void {
    this.#queued.push(entry);
    this.#startSampling();
    this.#pump();
  }

  // Sends the next batch when none is at the worker and the queued writes are due: the batch is
  // full, its wait has passed, or a flush is waiting.
  #pump(): void {
    if (this.#inFlight !== undefined || this.#queued.length === 0) {
      return;
    }
    const isDue =
      this.#queued.length >= BATCH_ENTRY_LIMIT || this.#isBatchDue || this.#flushCount > 0;
    if (!isDue) {
      this.#batchTimer ??= setTimeout(() => {
        this.#batchTimer = undefined;
        this.#isBatchDue = true;
        this.#pump();
      }, BATCH_WAIT_MS);
      return;
    }
    clearTimeout(this.#batchTimer);
    this.#batchTimer = undefined;
    this.#isBatchDue = false;
    const batch = this.#queued.splice(0, BATCH_ENTRY_LIMIT);
    this.#inFlight = batch;
    void this.#sendBatch(batch);
  }

  async #sendBatch(batch: readonly QueueEntry[]): Promise<void> {
    let reply: WriterReply;
    try {
      reply = await this.#request({ type: "batch", jobs: batch.map((entry) => entry.job) });
    } catch {
      // Only a dead worker leaves a reply owed, and `#fail` has already rejected every write in
      // this batch with its reason.
      return;
    }
    this.#inFlight = undefined;
    switch (reply.type) {
      case "batch-committed":
        batch.forEach((entry, index) => {
          const outcome = reply.outcomes[index];
          if (outcome === undefined) {
            entry.reject(new Error("The database writer's worker answered too few writes"));
          } else {
            entry.resolve(outcome);
          }
        });
        break;
      case "batch-failed": {
        const error = rebuildError(reply.error);
        for (const entry of batch) {
          entry.reject(error);
        }
        break;
      }
      default: {
        const error = unexpectedReply(reply);
        for (const entry of batch) {
          entry.reject(error);
        }
      }
    }
    // A committed batch frees room: the writes waiting at the cap go in, oldest first.
    while (this.#waiting.length > 0 && this.#hasRoom()) {
      const next = this.#waiting.shift();
      if (next !== undefined) {
        this.#queued.push(next);
      }
    }
    if (this.#queued.length > 0) {
      // Writes queued while the batch was out have waited long enough.
      this.#isBatchDue = true;
    }
    this.#pump();
  }

  #request(request: WriterRequest): Promise<WriterReply> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    const reply = this.#awaitReply();
    this.#worker.postMessage(request);
    return reply;
  }

  #awaitReply(): Promise<WriterReply> {
    const { promise, resolve, reject } = Promise.withResolvers<WriterReply>();
    this.#pendingReplies.push({ accept: resolve, reject });
    return promise;
  }

  // The worker is gone: every write waiting and every later one fails, and the daemon is told.
  #fail(error: Error): void {
    if (this.#failure !== undefined) {
      return;
    }
    this.#failure = error;
    clearTimeout(this.#batchTimer);
    this.#stopSampling();
    for (const entry of [...this.#waiting, ...this.#queued, ...(this.#inFlight ?? [])]) {
      entry.reject(error);
    }
    this.#waiting.length = 0;
    this.#queued.length = 0;
    this.#inFlight = undefined;
    for (const pendingReply of this.#pendingReplies.splice(0)) {
      pendingReply.reject(error);
    }
    this.#workerFailure.resolve(error);
  }

  // Samples once a second while the queue holds anything or drops wait to be reported.
  #startSampling(): void {
    this.#sampleTimer ??= setInterval(() => {
      this.#sample();
    }, SAMPLE_INTERVAL_MS);
  }

  #stopSampling(): void {
    clearInterval(this.#sampleTimer);
    this.#sampleTimer = undefined;
  }

  #sample(): void {
    const depth = this.#depth + this.#waiting.length;
    if (depth >= ALERT_DEPTH) {
      this.#writeServiceLog(
        `persistence_backpressure: the write queue holds ${String(depth)} of ` +
          `${String(WRITE_QUEUE_CAPACITY)} entries${describeTags(this.#latestEntry)}.`,
      );
    }
    for (const [sessionId, count] of this.#droppedBySession) {
      this.#writeServiceLog(
        `event_dropped: ${String(count)} ${DROPPABLE_EVENT_TYPE} events were dropped at the full ` +
          `write queue in the last second; session_id=${sessionId} ` +
          `event_type=${DROPPABLE_EVENT_TYPE}.`,
      );
    }
    this.#droppedBySession.clear();
    if (depth === 0) {
      this.#stopSampling();
    }
  }
}

function describeTags(entry: QueueEntry | undefined): string {
  const tags = [
    entry?.sessionId === undefined ? undefined : `session_id=${entry.sessionId}`,
    entry?.eventCategory === undefined ? undefined : `event_category=${entry.eventCategory}`,
  ].filter((tag) => tag !== undefined);
  return tags.length === 0 ? "" : `; ${tags.join(" ")}`;
}

// A SQLite error comes back as better-sqlite3's own class, so a caller can test its code.
function rebuildError(carried: CarriedError): Error {
  const error =
    carried.sqliteCode === undefined
      ? new Error(carried.message)
      : new Database.SqliteError(carried.message, carried.sqliteCode);
  if (carried.stack !== undefined) {
    error.stack = carried.stack;
  }
  return error;
}

function unexpectedReply(reply: WriterReply): Error {
  return new Error(`The database writer's worker answered out of turn with "${reply.type}"`);
}
