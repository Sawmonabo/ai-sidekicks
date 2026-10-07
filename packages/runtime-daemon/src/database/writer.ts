// The database writer: every write the daemon makes goes through it to the one read-write
// connection, which a worker thread of its own holds, so a commit's disk sync never stalls the
// main thread. Writes wait in a bounded queue and go to the worker in batches of up to 50 entries,
// or after 10 ms, whichever comes first. Each batch commits as one transaction and each write in
// it runs under a savepoint of its own, so a refused write rolls back alone while a batch-level
// failure fails every write in the batch. A write is never split across batches, so the events one
// write carries, such as a workflow tick's, commit together. At the queue's cap a write waits for
// the next batch to commit, except an assistant's thinking update, which is dropped and counted.

import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

import { waitWithin } from "../bounded-wait.js";
import type { ServiceLogWriter } from "../daemon/service-log.js";
import type { SessionEventRow } from "../events/session/insert.js";
import { workerModuleUrlBeside } from "../worker-url.js";
import type { CheckpointMode, CheckpointOptions, CheckpointResult } from "./checkpoint.js";
import type {
  CarriedError,
  WriteJob,
  WriteJobOutcome,
  WriterReply,
  WriterRequest,
  WriterWorkerData,
} from "./messages.js";
import type { StatementResult, WriteStatement } from "./statement.js";

/** The most entries the queue holds; each event is one entry, and a write with none is one. */
export const WRITE_QUEUE_CAPACITY = 10_000;
// A batch goes to the worker once it holds this many entries, or once its oldest has waited
// BATCH_WAIT_MS. A larger write goes alone.
const BATCH_ENTRY_LIMIT = 50;
const BATCH_WAIT_MS = 10;
// The queue's depth is sampled this often while it holds anything; at ALERT_DEPTH a warning goes
// to the service log.
const SAMPLE_INTERVAL_MS = 1_000;
const ALERT_DEPTH = 8_000;
// The one event type the queue may drop at its cap: narration a later event supersedes.
const DROPPABLE_EVENT_TYPE = "assistant.thinking_update" satisfies SessionEventType;

const WORKER_URL = workerModuleUrlBeside(import.meta.url);

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

/** How an assistant's thinking update ended: stored at its sequence, or dropped at the full queue. */
export type ThinkingUpdateOutcome =
  | { readonly isStored: true; readonly sequence: number }
  | { readonly isStored: false };

/** What the writer needs from the daemon. */
export interface DatabaseWriterOptions {
  /** The database file; created with its schema when absent. */
  readonly databasePath: string;
  /** Where the queue's backpressure warnings and drop counts go. */
  readonly writeServiceLog: ServiceLogWriter;
}

// The session and category a backpressure warning names: the latest event that joined the queue.
interface EventTags {
  readonly sessionId: string;
  readonly category: string;
}

interface QueueEntry {
  readonly job: WriteJob;
  /** The entries this write counts for against the cap and a batch. */
  readonly size: number;
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
   * Resolves with the reason if the worker fails; from then on every write fails with it. Never
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
  // Entries admitted, queued or at the worker; and those of them still queued.
  #depth = 0;
  #queuedSize = 0;

  #batchTimer: ReturnType<typeof setTimeout> | undefined;
  #isBatchDue = false;
  #flushCount = 0;
  #sampleTimer: ReturnType<typeof setInterval> | undefined;
  #latestEventTags: EventTags | undefined;
  readonly #droppedBySession = new Map<string, number>();
  #failure: Error | undefined;
  #closing: Promise<number> | undefined;

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
      const pendingReply = this.#pendingReplies.shift();
      if (pendingReply === undefined) {
        this.#fail(
          new Error(
            `The database writer's worker answered "${reply.type}" with no request waiting`,
          ),
        );
        return;
      }
      pendingReply.accept(reply);
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
    if (reply.type === "opened") {
      return writer;
    }
    // The writer never opened, so its worker's end is no failure to report.
    writer.#closing = writer.#exited.then(() => 0);
    if (reply.type === "open-failed") {
      // The worker ends itself after a failed open.
      await writer.#exited;
      throw rebuildError(reply.error);
    }
    await worker.terminate();
    throw unexpectedReply(reply);
  }

  /**
   * Runs `statements` in order as one write and resolves with what each did once it has
   * committed. Rejects with {@link WriteRefusedError} when a statement's row count is not the one
   * it expected, and with SQLite's error when a statement fails; either way none of it is kept.
   */
  async write(statements: readonly WriteStatement[]): Promise<readonly StatementResult[]> {
    const outcome = await this.#enqueue({ statements, events: [] }, false);
    return outcome.statementResults;
  }

  /**
   * Appends `events` in order, each at its session's next sequence, after `statements`, all as one
   * write that never splits across batches; resolves with each event's sequence once committed.
   * Throws for a thinking update, which goes through {@link appendThinkingUpdate}, and for a write
   * larger than the queue; rejects as {@link write} does.
   */
  async appendEvents(
    events: readonly SessionEventRow[],
    statements: readonly WriteStatement[] = [],
  ): Promise<readonly number[]> {
    if (events.some((event) => event.type === DROPPABLE_EVENT_TYPE)) {
      throw new Error(
        `An ${DROPPABLE_EVENT_TYPE} event goes through appendThinkingUpdate, which may drop it`,
      );
    }
    const outcome = await this.#enqueue({ statements, events }, false);
    return outcome.sequences;
  }

  /**
   * Appends one assistant thinking update. Resolves once committed, or at once when the queue is
   * full, which drops it. Throws for any other event type; rejects as {@link write} does.
   */
  async appendThinkingUpdate(event: SessionEventRow): Promise<ThinkingUpdateOutcome> {
    if (event.type !== DROPPABLE_EVENT_TYPE) {
      throw new Error(`appendThinkingUpdate takes only ${DROPPABLE_EVENT_TYPE}, not ${event.type}`);
    }
    const outcome = await this.#enqueue({ statements: [], events: [event] }, true);
    if (outcome === undefined) {
      return { isStored: false };
    }
    const [sequence] = outcome.sequences;
    if (sequence === undefined) {
      throw new Error("The database writer's worker answered an append with no sequence");
    }
    return { isStored: true, sequence };
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

  /**
   * Runs a WAL checkpoint in `mode` on the writer's connection, between batches; every write waits
   * behind it, a busy one included unless it skips the wait for readers. Throws once the writer is
   * closing or closed.
   */
  async checkpoint(
    mode: CheckpointMode,
    options: CheckpointOptions = {},
  ): Promise<CheckpointResult> {
    if (this.#closing !== undefined) {
      throw new Error("The database writer is closed; the checkpoint did not run");
    }
    const reply = await this.#request({
      type: "checkpoint",
      mode,
      shouldWaitForReaders: options.shouldWaitForReaders ?? true,
    });
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
   * and ends the worker; resolves with the number of writes left unfinished. Given `drainWithinMs`,
   * waits that long at most: the writes still unfinished then fail, the worker is ended, and a
   * batch it had not committed rolls back whole. Repeated calls share the first close.
   */
  close(drainWithinMs?: number): Promise<number> {
    this.#closing ??= this.#runClose(drainWithinMs);
    return this.#closing;
  }

  async #runClose(drainWithinMs: number | undefined): Promise<number> {
    const isDrained = await this.#drainWithin(drainWithinMs);
    this.#stopSampling();
    if (this.#failure !== undefined) {
      await this.#exited;
      return 0;
    }
    if (!isDrained) {
      const unfinishedCount =
        this.#waiting.length + this.#queued.length + (this.#inFlight?.length ?? 0);
      this.#endWorker(
        new Error("The database writer closed at its drain bound; this write was not committed"),
      );
      await this.#exited;
      return unfinishedCount;
    }
    const reply = await this.#request({ type: "close" });
    if (reply.type !== "closed") {
      throw unexpectedReply(reply);
    }
    await this.#exited;
    return 0;
  }

  // Whether every write taken has settled within `boundMs`; with no bound, waits until they have.
  async #drainWithin(boundMs: number | undefined): Promise<boolean> {
    if (boundMs === undefined) {
      await this.flush();
      return true;
    }
    return waitWithin(this.flush(), boundMs);
  }

  // Resolves with the write's outcome once committed, or `undefined` when it was dropped.
  #enqueue(job: WriteJob, isDroppable: true): Promise<CommittedOutcome | undefined>;
  #enqueue(job: WriteJob, isDroppable: false): Promise<CommittedOutcome>;
  async #enqueue(job: WriteJob, isDroppable: boolean): Promise<CommittedOutcome | undefined> {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#closing !== undefined) {
      throw new Error("The database writer is closed; the write was not taken");
    }
    const size = Math.max(1, job.events.length);
    if (size > WRITE_QUEUE_CAPACITY) {
      throw new Error(
        `A write of ${String(size)} events is larger than the write queue's ` +
          `${String(WRITE_QUEUE_CAPACITY)}; it was not taken`,
      );
    }
    const { promise, resolve, reject } = Promise.withResolvers<WriteJobOutcome>();
    const entry: QueueEntry = { job, size, outcome: promise, resolve, reject };
    if (this.#waiting.length === 0 && this.#depth + size <= WRITE_QUEUE_CAPACITY) {
      this.#queued.push(entry);
      this.#depth += size;
      this.#queuedSize += size;
    } else if (isDroppable) {
      const sessionId = job.events[0]?.session_id ?? "";
      this.#droppedBySession.set(sessionId, (this.#droppedBySession.get(sessionId) ?? 0) + 1);
      this.#startSampling();
      return undefined;
    } else {
      this.#waiting.push(entry);
    }
    const lastEvent = job.events.at(-1);
    if (lastEvent !== undefined) {
      this.#latestEventTags = { sessionId: lastEvent.session_id, category: lastEvent.category };
    }
    this.#startSampling();
    this.#pump();
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

  // Sends the next batch when none is at the worker and the queued writes are due: the batch is
  // full, its wait has passed, or a flush is waiting.
  #pump(): void {
    if (this.#inFlight !== undefined || this.#queued.length === 0) {
      return;
    }
    const isDue = this.#queuedSize >= BATCH_ENTRY_LIMIT || this.#isBatchDue || this.#flushCount > 0;
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
    const batch = this.#takeBatch();
    this.#inFlight = batch;
    void this.#sendBatch(batch);
  }

  // The oldest queued writes up to the batch limit, and always at least one, so a write larger
  // than the limit goes whole and alone.
  #takeBatch(): QueueEntry[] {
    const batch: QueueEntry[] = [];
    let batchSize = 0;
    for (const entry of this.#queued) {
      if (batch.length > 0 && batchSize + entry.size > BATCH_ENTRY_LIMIT) {
        break;
      }
      batch.push(entry);
      batchSize += entry.size;
    }
    this.#queued.splice(0, batch.length);
    this.#queuedSize -= batchSize;
    return batch;
  }

  async #sendBatch(batch: readonly QueueEntry[]): Promise<void> {
    let reply: WriterReply;
    try {
      reply = await this.#request({ type: "batch", jobs: batch.map((entry) => entry.job) });
    } catch (error) {
      // A failed worker has already failed this batch with every other write.
      if (error === this.#failure) {
        return;
      }
      // The batch never reached the worker, since it held a value a thread cannot carry: only
      // its own writes fail.
      const sendFailure = error instanceof Error ? error : new Error(String(error));
      this.#finishBatch(batch, (entry) => {
        entry.reject(sendFailure);
      });
      return;
    }
    switch (reply.type) {
      case "batch-committed":
        this.#finishBatch(batch, (entry, index) => {
          const outcome = reply.outcomes[index];
          if (outcome === undefined) {
            entry.reject(new Error("The database writer's worker answered too few writes"));
          } else {
            entry.resolve(outcome);
          }
        });
        return;
      case "batch-failed": {
        const batchFailure = rebuildError(reply.error);
        this.#finishBatch(batch, (entry) => {
          entry.reject(batchFailure);
        });
        return;
      }
      default: {
        const outOfTurn = unexpectedReply(reply);
        this.#finishBatch(batch, (entry) => {
          entry.reject(outOfTurn);
        });
      }
    }
  }

  // Settles the batch's writes, then lets the writes waiting at the cap in, oldest first, and
  // sends what is due.
  #finishBatch(
    batch: readonly QueueEntry[],
    settle: (entry: QueueEntry, index: number) => void,
  ): void {
    this.#inFlight = undefined;
    batch.forEach((entry, index) => {
      this.#depth -= entry.size;
      settle(entry, index);
    });
    for (let next = this.#waiting[0]; next !== undefined; next = this.#waiting[0]) {
      if (this.#depth + next.size > WRITE_QUEUE_CAPACITY) {
        break;
      }
      this.#waiting.shift();
      this.#queued.push(next);
      this.#depth += next.size;
      this.#queuedSize += next.size;
    }
    if (this.#depth === 0 && this.#waiting.length === 0) {
      this.#latestEventTags = undefined;
    }
    if (this.#queued.length > 0) {
      // Writes queued while the batch was out have waited long enough.
      this.#isBatchDue = true;
    }
    this.#pump();
  }

  // Sends `request`; a value the thread boundary cannot carry throws here, with no reply owed.
  #request(request: WriterRequest): Promise<WriterReply> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    const reply = this.#awaitReply();
    try {
      this.#worker.postMessage(request);
    } catch (error) {
      this.#pendingReplies.pop();
      throw error;
    }
    return reply;
  }

  #awaitReply(): Promise<WriterReply> {
    const { promise, resolve, reject } = Promise.withResolvers<WriterReply>();
    this.#pendingReplies.push({ accept: resolve, reject });
    return promise;
  }

  // The worker has failed: it is ended, every write waiting and every later one fails, and the
  // daemon is told.
  #fail(error: Error): void {
    if (this.#failure !== undefined) {
      return;
    }
    this.#endWorker(error);
    this.#workerFailure.resolve(error);
  }

  // Ends the worker, failing every write taken, every request awaiting a reply and every later
  // write with `error`.
  #endWorker(error: Error): void {
    this.#failure = error;
    void this.#worker.terminate();
    clearTimeout(this.#batchTimer);
    this.#stopSampling();
    for (const entry of [...this.#waiting, ...this.#queued, ...(this.#inFlight ?? [])]) {
      entry.reject(error);
    }
    this.#waiting.length = 0;
    this.#queued.length = 0;
    this.#inFlight = undefined;
    this.#depth = 0;
    this.#queuedSize = 0;
    this.#latestEventTags = undefined;
    for (const pendingReply of this.#pendingReplies.splice(0)) {
      pendingReply.reject(error);
    }
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
    const depth = this.#waiting.reduce((total, entry) => total + entry.size, this.#depth);
    if (depth >= ALERT_DEPTH) {
      this.#writeServiceLog(
        `persistence_backpressure: the write queue holds ${String(depth)} of ` +
          `${String(WRITE_QUEUE_CAPACITY)} entries${describeTags(this.#latestEventTags)}.`,
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

function describeTags(tags: EventTags | undefined): string {
  return tags === undefined ? "" : `; session_id=${tags.sessionId} event_category=${tags.category}`;
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
