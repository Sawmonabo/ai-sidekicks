// SessionService over SQLite: the read `session.read` answers from the session's row with its
// cursors, the rebuild from the log in sequence order and across a restart, and schema
// idempotency including a concurrent-boot race across worker threads. Each test gets its own
// database file under os.tmpdir(), opened as the daemon opens it: writes through the database
// writer, reads on a read-only connection.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import {
  encodeEventCursor,
  START_OF_LOG_POSITION,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";

import {
  closeDatabaseConnections,
  openDatabaseConnections,
  type DatabaseConnections,
} from "../../database/connections.js";
import { EventLogService } from "../../events/log-service.js";
import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { directoryStatementsFor } from "../directory/row.js";
import { applyMigrations, applyPragmas } from "../migration-runner.js";
import { SessionService } from "../service.js";
import {
  insertStoredEvent,
  makeCreatedEvent,
  OWNER_ACTOR_ID,
} from "../__fixtures__/stored-event.js";
import type { StoredEvent } from "../records.js";

const SESSION_ID = "0190f9b0-1c2d-7e3f-8a4b-5c6d7e8f9a01" as SessionId;
const UNKNOWN_SESSION_ID = "0190f9b0-1c2d-7e3f-8a4b-5c6d7e8f9aff" as SessionId;

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

function storedCreatedEvent(monotonicNs: bigint): StoredEvent {
  const created = makeCreatedEvent();
  return {
    ...created,
    sessionId: SESSION_ID,
    monotonicNs,
    payload: { ...created.payload, sessionId: SESSION_ID },
  };
}

function storedRenamedEvent(sequence: number, monotonicNs: bigint, name: string): StoredEvent {
  return {
    id: `0190f9b0-1c2d-7e3f-8a4b-5c6d7e8f9b0${sequence.toString()}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-04-27T12:02:00.000Z",
    monotonicNs,
    category: "session_lifecycle",
    type: "session.renamed",
    actor: OWNER_ACTOR_ID,
    payload: { sessionId: SESSION_ID, name, origin: "user" },
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

// Every table, index and trigger name in the database, sorted.
function schemaObjectNames(db: DatabaseType): ReadonlyArray<string> {
  const rows = db
    .prepare("SELECT type || ':' || name AS entry FROM sqlite_master ORDER BY type, name")
    .all() as ReadonlyArray<{ entry: string }>;
  return rows.map((row) => row.entry);
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  connections: DatabaseConnections;
  service: SessionService;
  dbPath: string;
  tmpDir: string;
}

let ctx: TestContext;

// The production opening, so the test reaches the database exactly as the daemon does.
function openConnections(dbPath: string): Promise<DatabaseConnections> {
  return openDatabaseConnections({ databasePath: dbPath, writeServiceLog: () => {} });
}

// Closing both connections stands in for the daemon process exiting; reopening the same file
// proves on-disk durability backs what is read.
async function reopenConnections(): Promise<DatabaseConnections> {
  await closeDatabaseConnections(ctx.connections);
  ctx.connections = await openConnections(ctx.dbPath);
  ctx.service = new SessionService(ctx.connections.reader);
  return ctx.connections;
}

beforeEach(async () => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-daemon-test-"));
  const dbPath: string = join(tmpDir, "test.db");
  const connections = await openConnections(dbPath);
  ctx = {
    connections,
    service: new SessionService(connections.reader),
    dbPath,
    tmpDir,
  };
});

afterEach(async () => {
  await closeDatabaseConnections(ctx.connections);
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// session.read
// ----------------------------------------------------------------------------

describe("SessionService — readSession", () => {
  it("answers the session's row with the start of the log as earliest and its head as latest", async () => {
    const events = new EventLogService({
      writer: ctx.connections.writer,
      reader: ctx.connections.reader,
      projectionStatements: directoryStatementsFor,
    });
    const version = EventEnvelopeVersionSchema.parse("1.0");
    const created = storedCreatedEvent(1n);
    await events.append({
      id: randomUUID(),
      sessionId: SESSION_ID,
      occurredAt: created.occurredAt,
      category: "session_lifecycle",
      type: "session.created",
      actor: null,
      payload: created.payload,
      version,
    });
    await events.append({
      id: randomUUID(),
      sessionId: SESSION_ID,
      occurredAt: "2026-04-27T12:05:00.000Z",
      category: "session_lifecycle",
      type: "session.muted",
      actor: null,
      payload: { sessionId: SESSION_ID, at: "2026-04-27T12:05:00.000Z" },
      version,
    });

    expect(ctx.service.readSession({ sessionId: SESSION_ID })).toStrictEqual({
      session: {
        id: SESSION_ID,
        state: "provisioning",
        shape: "chat",
        muted: true,
        pendingWorkingFolder: null,
        createdAt: created.occurredAt,
        updatedAt: "2026-04-27T12:05:00.000Z",
      },
      transcriptCursors: {
        earliest: encodeEventCursor(START_OF_LOG_POSITION),
        latest: encodeEventCursor(1),
      },
    });
  });

  it("refuses a session this daemon holds no row for with session.not_found", () => {
    expect(() => ctx.service.readSession({ sessionId: UNKNOWN_SESSION_ID })).toThrow(
      SessionNotFoundError,
    );
  });
});

// ----------------------------------------------------------------------------
// Sequence-ASC rebuild
// ----------------------------------------------------------------------------

describe("SessionService — rebuildSession", () => {
  it("folds the log in sequence order, whatever the insert order and monotonic_ns say", async () => {
    // UNIQUE(session_id, sequence) tolerates any insert order and monotonic_ns runs backwards, so
    // only an ORDER BY sequence leaves the second rename as the name.
    await insertStoredEvent(
      ctx.connections.writer,
      storedRenamedEvent(2, 1_000_000_000n, "Release Notes"),
    );
    await insertStoredEvent(ctx.connections.writer, storedCreatedEvent(5_000_000_000n));
    await insertStoredEvent(
      ctx.connections.writer,
      storedRenamedEvent(1, 3_000_000_000n, "Design Review"),
    );

    const snapshot = ctx.service.rebuildSession(SESSION_ID);
    expect(snapshot).toMatchObject({
      sessionId: SESSION_ID,
      name: "Release Notes",
      asOfSequence: 2,
      ownerActor: OWNER_ACTOR_ID,
    });
  });

  it("answers null for a session with no events", () => {
    expect(ctx.service.rebuildSession(UNKNOWN_SESSION_ID)).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Durability across daemon restart
// ----------------------------------------------------------------------------

describe("SessionService — snapshot survives daemon restart", () => {
  it("yields identical projection after closing and reopening the database file", async () => {
    await insertStoredEvent(ctx.connections.writer, storedCreatedEvent(1_000_000_000n));
    await insertStoredEvent(
      ctx.connections.writer,
      storedRenamedEvent(1, 2_000_000_000n, "Design Review"),
    );
    await insertStoredEvent(
      ctx.connections.writer,
      storedRenamedEvent(2, 3_000_000_000n, "Release Notes"),
    );

    const beforeRestart = ctx.service.rebuildSession(SESSION_ID);
    expect(beforeRestart).not.toBeNull();

    const closedReader: DatabaseType = ctx.connections.reader;
    await reopenConnections();
    expect(closedReader.open).toBe(false);

    const afterRestart = ctx.service.rebuildSession(SESSION_ID);
    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart).toMatchObject({ ownerActor: OWNER_ACTOR_ID, asOfSequence: 2 });
  });

  it("a reopen keeps the schema it finds (does not re-create it)", async () => {
    const tablesBefore: ReadonlyArray<string> = schemaObjectNames(ctx.connections.reader);
    const reopened: DatabaseConnections = await reopenConnections();
    expect(schemaObjectNames(reopened.reader)).toEqual(tablesBefore);
  });
});

// ----------------------------------------------------------------------------
// Concurrent-boot migration race
// ----------------------------------------------------------------------------
//
// Concurrent `openDatabase` calls on one file must serialize without losing or duplicating the
// schema. Under a plain `db.transaction(...)` (BEGIN DEFERRED) two racers both start as readers,
// then both try to upgrade to a writer; in WAL mode the loser gets SQLITE_BUSY_SNAPSHOT, which
// `busy_timeout` cannot retry. `.immediate()` takes the writer lock at BEGIN, where
// `busy_timeout` does absorb the wait, and the loser's re-check then sees the committed schema.
//
// better-sqlite3 is synchronous, so the race needs `worker_threads`: each worker has its own
// event loop and native handle, so SQLite sees independent openers on one file. The workers are
// `.mjs` because vitest's loader hooks are not inherited by `worker_threads` children.
//
// The tests assert on totals across several trials, not on a single trial: a host flake and a
// real `.immediate()` regression fail with the same SQLITE_BUSY error, so only the failure rate
// tells them apart.

interface RaceWorkerResult {
  readonly ok: boolean;
  readonly code: string | null;
  readonly message: string;
}

async function runMigrationRace(
  dbPath: string,
  workerCount: number,
  useDeferred: boolean,
  // Only the DEFERRED negative control passes this arrival counter, which holds every worker
  // inside its open transaction until all have arrived. An IMMEDIATE racer never reaches such a
  // rendezvous, so the detector passes none.
  snapshotBarrier?: SharedArrayBuffer,
): Promise<ReadonlyArray<RaceWorkerResult>> {
  const workerUrl: URL = new URL("./migration-race-worker.mjs", import.meta.url);
  const raceWorkerData: {
    dbPath: string;
    useDeferred: boolean;
    snapshotBarrier?: SharedArrayBuffer;
    barrierWorkerCount?: number;
  } = { dbPath, useDeferred };
  if (snapshotBarrier !== undefined) {
    raceWorkerData.snapshotBarrier = snapshotBarrier;
    raceWorkerData.barrierWorkerCount = workerCount;
  }
  // All workers spawn up front so they reach `BEGIN` together. `finally` terminates every
  // worker so a sibling cannot hold the database file open into `afterEach` (EBUSY on Windows).
  // The `exit` handler covers a worker that dies (V8 crash, OOM) without emitting `error`, which
  // would otherwise hang the promise until the test timeout.
  const workers: Worker[] = [];
  const promises: Array<Promise<RaceWorkerResult>> = [];
  for (let i = 0; i < workerCount; i++) {
    // The worker strips TypeScript natively; its loader hook (`typescript-source-loader.mjs`)
    // rewrites `.js` specifiers to `.ts`.
    const w: Worker = new Worker(workerUrl, { workerData: raceWorkerData });
    workers.push(w);
    promises.push(
      new Promise<RaceWorkerResult>((resolve, reject) => {
        let settled: boolean = false;
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };
        w.once("message", (msg: RaceWorkerResult) => {
          settle(() => resolve(msg));
        });
        w.once("error", (err: Error) => {
          settle(() => reject(err));
        });
        w.once("exit", (code: number) => {
          if (code !== 0) {
            settle(() =>
              reject(
                new Error(
                  `migration-race-worker exited with code ${code.toString()} without postMessage`,
                ),
              ),
            );
          }
        });
      }),
    );
  }
  try {
    return await Promise.all(promises);
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

describe("applyMigrations concurrent-boot race (BEGIN IMMEDIATE serialization)", () => {
  // The outer `ctx` database is already migrated, so this block uses fresh files: the race must
  // be a first boot. Each trial gets its own path, because a leftover schema would let the probe
  // short-circuit before any write lock is attempted.
  let raceTmpDir: string;

  beforeEach(() => {
    raceTmpDir = mkdtempSync(join(tmpdir(), "ai-sidekicks-daemon-race-"));
  });

  afterEach(() => {
    rmSync(raceTmpDir, { recursive: true, force: true });
  });

  // The 60_000 trailing argument is headroom: five trials each spawn four worker threads, and
  // spawn plus compile has exceeded vitest's 5 s default on a contended CI runner. The oracle is
  // FAILURE_THRESHOLD, never elapsed time.
  it(
    "4 workers × 5 trials of concurrent first boots under .immediate() stay below the " +
      "SQLITE_BUSY failure threshold",
    async () => {
      // A per-test retry cannot separate a host flake from a regression, since both fail as
      // SQLITE_BUSY: with `retry: 5` a broken DEFERRED run still passed 5 of 5 times. The rates
      // over 20 attempts (4 workers × 5 trials) do separate them:
      //   * `.immediate()` on Linux bare metal: about 0 % failures.
      //   * `.immediate()` on WSL2: 10-25 % per attempt (fcntl on 9p surfaces SQLITE_BUSY at
      //     BEGIN IMMEDIATE without engaging the busy handler), so 2-5 of 20.
      //   * DEFERRED on Linux bare metal: about 95 %, so about 19 of 20.
      //   * DEFERRED on WSL2: 0-60 %, overlapping the working WSL2 range.
      // The threshold of 10 is calibrated to the Linux gap. On WSL2 it detects a broken DEFERRED
      // only about a third of the time but stays clear of false alarms, so CI is the real
      // assertion. It would miss a regression with a much lower failure rate (around 30 %); the
      // negative control below shows that DEFERRED contention exists, not how often.
      const WORKER_COUNT: number = 4;
      const TRIAL_COUNT: number = 5;
      const FAILURE_THRESHOLD: number = 10; // out of 20 attempts (50%)

      let totalFailures: number = 0;
      const allResults: RaceWorkerResult[][] = [];
      for (let trial = 0; trial < TRIAL_COUNT; trial++) {
        const trialPath: string = join(raceTmpDir, `imm-trial-${trial.toString()}.db`);
        const trialResults: ReadonlyArray<RaceWorkerResult> = await runMigrationRace(
          trialPath,
          WORKER_COUNT,
          /* useDeferred */ false,
        );
        allResults.push([...trialResults]);
        totalFailures += trialResults.filter((r) => !r.ok).length;
      }

      expect(
        totalFailures,
        `expected ≤${FAILURE_THRESHOLD.toString()} failures across ${TRIAL_COUNT.toString()} ` +
          `trials × ${WORKER_COUNT.toString()} workers (=` +
          `${(TRIAL_COUNT * WORKER_COUNT).toString()} attempts); a broken DEFERRED pattern ` +
          `produces ~19 BUSY failures across 20 attempts on Linux bare-metal (threshold set well ` +
          `below this; WSL2 detection ~35 % due to fcntl-on-9p reducing contention saturation, ` +
          `see test docstring). Got ${totalFailures.toString()}. Detail: ` +
          `${JSON.stringify(allResults)}`,
      ).toBeLessThanOrEqual(FAILURE_THRESHOLD);

      // Every trial's file must hold exactly the schema one in-process apply creates; the schema
      // commits in one transaction, so a torn or doubled apply shows here or as a worker failure.
      const reference: DatabaseType = new Database(join(raceTmpDir, "reference.db"));
      let expectedObjects: ReadonlyArray<string>;
      try {
        applyPragmas(reference);
        applyMigrations(reference);
        expectedObjects = schemaObjectNames(reference);
      } finally {
        reference.close();
      }
      for (let trial = 0; trial < TRIAL_COUNT; trial++) {
        const trialPath: string = join(raceTmpDir, `imm-trial-${trial.toString()}.db`);
        const verifier: DatabaseType = new Database(trialPath);
        try {
          applyPragmas(verifier);
          expect(
            schemaObjectNames(verifier),
            `trial ${trial.toString()} expected exactly the reference schema`,
          ).toEqual(expectedObjects);
        } finally {
          verifier.close();
        }
      }
    },
    60_000,
  );

  // The 60_000 trailing argument is headroom: a DEFERRED loser fails immediately, so the slowest
  // case is the barrier's 3 s deadline on a degraded trial, 5 × 3 s plus worker spawns.
  it(
    "the SAME race pattern using BEGIN DEFERRED across multiple trials reproduces " +
      "writer-vs-writer contention at least once — empirical proof .immediate() is load-bearing",
    async () => {
      // Negative control: runs the broken BEGIN DEFERRED pattern to prove the workers really
      // contend and that `.immediate()` is the seam that fixes it.
      //
      // The worker's snapshot barrier makes the collision structural. Each DEFERRED worker parks
      // inside its open transaction, after the read that pins its WAL snapshot and before the write
      // that upgrades it, until every sibling has arrived. When released, one wins the write lock
      // and the other WORKER_COUNT-1 hold stale snapshots, which is SQLITE_BUSY_SNAPSHOT. Without
      // the barrier, a saturated host serializes worker spawns, the snapshots stop overlapping, and
      // the control passes cleanly by luck.
      //
      // The barrier's deadline lets a merely slow sibling degrade the test to that probabilistic
      // behavior instead of hanging it; a worker that dies makes `runMigrationRace` reject and
      // fails the test outright.
      //
      // The assertion is only "at least one" failure, weaker than the WORKER_COUNT-1 the barrier
      // makes typical, because a deadline-expiry trial is a legitimate degraded run. Zero BUSY
      // errors across all trials means the control is broken: the workers are not concurrent, or
      // SQLite changed so that `.immediate()` is unnecessary.
      const WORKER_COUNT: number = 8;
      const TRIAL_COUNT: number = 5;
      const allTrialResults: RaceWorkerResult[][] = [];
      for (let trial = 0; trial < TRIAL_COUNT; trial++) {
        const trialPath: string = join(raceTmpDir, `trial-${trial.toString()}.db`);
        // A fresh counter per trial, so a straggler from a terminated trial cannot release the
        // next trial's barrier early.
        const snapshotBarrier: SharedArrayBuffer = new SharedArrayBuffer(
          Int32Array.BYTES_PER_ELEMENT,
        );
        const trialResults: ReadonlyArray<RaceWorkerResult> = await runMigrationRace(
          trialPath,
          WORKER_COUNT,
          /* useDeferred */ true,
          snapshotBarrier,
        );
        allTrialResults.push([...trialResults]);
      }

      const allFailures: RaceWorkerResult[] = allTrialResults.flat().filter((r) => !r.ok);
      expect(
        allFailures.length,
        `expected at least one DEFERRED failure across ${TRIAL_COUNT.toString()} trials of ` +
          `${WORKER_COUNT.toString()} workers as evidence of contention; got ` +
          `${JSON.stringify(allTrialResults)}`,
      ).toBeGreaterThanOrEqual(1);

      // Any other error class (constraint violation, syntax error) would mean the control is
      // exercising a different failure than the race.
      for (const f of allFailures) {
        const isBusyClass: boolean =
          f.code === "SQLITE_BUSY" ||
          f.code === "SQLITE_BUSY_SNAPSHOT" ||
          // A racer that upgraded past BEGIN but lost at CREATE TABLE surfaces as a generic
          // SQLITE_ERROR "table … already exists": the same race.
          /already exists/i.test(f.message) ||
          /SQLITE_BUSY/i.test(f.message);
        expect(
          isBusyClass,
          `expected a SQLITE_BUSY-class failure as proof of writer-vs-writer contention; got ` +
            `${JSON.stringify(f)}`,
        ).toBe(true);
      }
    },
    60_000,
  );

  it("refuses a snapshot barrier on the IMMEDIATE path instead of ignoring it", async () => {
    // An IMMEDIATE racer never reaches the rendezvous, so accepting a barrier would silently
    // disable it and leave a green suite that proves nothing. The worker rejects the combination.
    const misusePath: string = join(raceTmpDir, "immediate-barrier-misuse.db");
    await expect(
      runMigrationRace(
        misusePath,
        1,
        /* useDeferred */ false,
        new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      ),
    ).rejects.toThrow(/DEFERRED replica path/);
  }, 30_000);
});
