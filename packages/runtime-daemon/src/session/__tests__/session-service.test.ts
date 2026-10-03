// SessionService over SQLite: replay order, restart durability, schema idempotency including a
// concurrent-boot race across worker threads, the append guard and the read-side payload check.
// Each test gets its own database file under os.tmpdir().

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, applyPragmas, openDatabase } from "../migration-runner.js";
import { SessionService } from "../session-service.js";
import {
  insertStoredEvent,
  makeCreatedEvent,
  OWNER_ACTOR_ID,
  SESSION_ID,
} from "./stored-event.test-support.js";
import type { StoredEvent } from "../types.js";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

function makeRenamedEvent(sequence: number, monotonicNs: bigint, name: string): StoredEvent {
  return {
    id: `01J0EV0002NN5J5J5J5J5J5J0${sequence.toString()}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-04-27T12:02:00.000Z",
    monotonicNs,
    category: "session_lifecycle",
    type: "session.renamed",
    actor: OWNER_ACTOR_ID,
    payload: { sessionId: SESSION_ID, name },
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
  db: DatabaseType;
  service: SessionService;
  dbPath: string;
  tmpDir: string;
}

let ctx: TestContext;

beforeEach(() => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-daemon-test-"));
  const dbPath: string = join(tmpDir, "test.db");
  // The production factory, so the test opens the database exactly as the daemon does.
  const db: DatabaseType = openDatabase(dbPath);
  ctx = {
    db,
    service: new SessionService(db),
    dbPath,
    tmpDir,
  };
});

afterEach(() => {
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// Sequence-ASC replay
// ----------------------------------------------------------------------------

describe("SessionService — replay reads events by sequence ASC", () => {
  it("reproduces the snapshot deterministically when events are inserted in scrambled sequence order", () => {
    // UNIQUE(session_id, sequence) tolerates any insert order; the read path's ORDER BY
    // sequence ASC establishes the order.
    const created: StoredEvent = makeCreatedEvent();
    const firstRename: StoredEvent = makeRenamedEvent(1, 2_000_000_000n, "Design Review");
    const secondRename: StoredEvent = makeRenamedEvent(2, 3_000_000_000n, "Release Notes");

    insertStoredEvent(ctx.db, secondRename);
    insertStoredEvent(ctx.db, created);
    insertStoredEvent(ctx.db, firstRename);

    const events = ctx.service.readEvents(SESSION_ID);
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2]);

    const snapshot = ctx.service.replay(SESSION_ID);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(snapshot.asOfSequence).toBe(2);
    expect(snapshot.ownerActor).toBe(OWNER_ACTOR_ID);
  });
});
// ----------------------------------------------------------------------------
// Sequence, not monotonic_ns
// ----------------------------------------------------------------------------

describe("SessionService — replay uses sequence not monotonic_ns", () => {
  it("orders events by sequence even when monotonic_ns goes backwards across rows", () => {
    // monotonic_ns is in-daemon debug data; sequence is the replay key, so clock skew in
    // monotonic_ns must not reorder replay.
    const e0: StoredEvent = { ...makeCreatedEvent(), monotonicNs: 5_000_000_000n };
    const e1: StoredEvent = makeRenamedEvent(1, 1_000_000_000n, "Back Room");
    const e2: StoredEvent = makeRenamedEvent(2, 3_000_000_000n, "Side Room");

    insertStoredEvent(ctx.db, e0);
    insertStoredEvent(ctx.db, e1);
    insertStoredEvent(ctx.db, e2);

    const events = ctx.service.readEvents(SESSION_ID);
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.monotonicNs)).toEqual([
      5_000_000_000n,
      1_000_000_000n,
      3_000_000_000n,
    ]);
    // Sorting by monotonic_ns would give [1, 2, 0], so the read path is not using it.
    const monotonicSorted = [...events].sort((a, b) => Number(a.monotonicNs - b.monotonicNs));
    expect(monotonicSorted.map((e) => e.sequence)).toEqual([1, 2, 0]);

    // Sequence order puts `session.created` first, so the snapshot still bootstraps.
    const snapshot = ctx.service.replay(SESSION_ID);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(snapshot.sessionId).toBe(SESSION_ID);
    expect(snapshot.asOfSequence).toBe(2);
  });

  it("round-trips a monotonic_ns value above Number.MAX_SAFE_INTEGER as bigint without precision loss", () => {
    // The other fixtures sit below Number.MAX_SAFE_INTEGER, so a `Number(row.monotonic_ns)`
    // regression in `hydrateRow` would not show. 2^53 + 1 is the first value a double cannot hold.
    const BIGINT_BOUNDARY: bigint = 9_007_199_254_740_993n; // 2^53 + 1
    const created: StoredEvent = {
      ...makeCreatedEvent(),
      monotonicNs: BIGINT_BOUNDARY,
    };
    insertStoredEvent(ctx.db, created);

    const events = ctx.service.readEvents(SESSION_ID);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (event === undefined) return; // type guard for TS

    expect(typeof event.monotonicNs).toBe("bigint");
    // A `Number()` regression would come back as 2^53, one below the boundary.
    expect(event.monotonicNs).toBe(BIGINT_BOUNDARY);
    expect(event.monotonicNs).not.toBe(BIGINT_BOUNDARY - 1n);
  });
});

// ----------------------------------------------------------------------------
// Durability across daemon restart
// ----------------------------------------------------------------------------

describe("SessionService — snapshot survives daemon restart", () => {
  it("yields identical projection after closing and reopening the database file", () => {
    const created: StoredEvent = makeCreatedEvent();
    const firstRename: StoredEvent = makeRenamedEvent(1, 2_000_000_000n, "Design Review");
    const secondRename: StoredEvent = makeRenamedEvent(2, 3_000_000_000n, "Release Notes");

    insertStoredEvent(ctx.db, created);
    insertStoredEvent(ctx.db, firstRename);
    insertStoredEvent(ctx.db, secondRename);

    const beforeRestart = ctx.service.replay(SESSION_ID);
    expect(beforeRestart).not.toBeNull();

    // Closing the handle stands in for the daemon process exiting.
    ctx.db.close();
    expect(ctx.db.open).toBe(false);

    // Reopening the same file proves on-disk durability backs the projection. The reopened
    // service has no append opt-in on purpose: it only replays, which reads allow.
    const reopenedDb: DatabaseType = openDatabase(ctx.dbPath);
    const reopenedService: SessionService = new SessionService(reopenedDb);

    // afterEach closes whichever handle `ctx` holds.
    ctx.db = reopenedDb;
    ctx.service = reopenedService;

    const afterRestart = reopenedService.replay(SESSION_ID);
    expect(afterRestart).not.toBeNull();

    expect(afterRestart).toEqual(beforeRestart);

    if (afterRestart === null) return;
    expect(afterRestart.ownerActor).toBe(OWNER_ACTOR_ID);
    expect(afterRestart.asOfSequence).toBe(2);
  });

  it("openDatabase is idempotent on reopen (does not re-create the schema)", () => {
    const tablesBefore: ReadonlyArray<string> = schemaObjectNames(ctx.db);
    ctx.db.close();
    const reopened: DatabaseType = openDatabase(ctx.dbPath);
    ctx.db = reopened;
    ctx.service = new SessionService(reopened);
    expect(schemaObjectNames(reopened)).toEqual(tablesBefore);
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
    // The worker strips TypeScript natively; its loader hook (`migration-race-loader.mjs`)
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
  it("4 workers × 5 trials of concurrent first boots under .immediate() stay below the SQLITE_BUSY failure threshold", async () => {
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
      `expected ≤${FAILURE_THRESHOLD.toString()} failures across ${TRIAL_COUNT.toString()} trials × ${WORKER_COUNT.toString()} workers (=${(TRIAL_COUNT * WORKER_COUNT).toString()} attempts); a broken DEFERRED pattern produces ~19 BUSY failures across 20 attempts on Linux bare-metal (threshold set well below this; WSL2 detection ~35 % due to fcntl-on-9p reducing contention saturation, see test docstring). Got ${totalFailures.toString()}. Detail: ${JSON.stringify(allResults)}`,
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
  }, 60_000);

  // The 60_000 trailing argument is headroom: a DEFERRED loser fails immediately, so the slowest
  // case is the barrier's 3 s deadline on a degraded trial, 5 × 3 s plus worker spawns.
  it("the SAME race pattern using BEGIN DEFERRED across multiple trials reproduces writer-vs-writer contention at least once — empirical proof .immediate() is load-bearing", async () => {
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
      `expected at least one DEFERRED failure across ${TRIAL_COUNT.toString()} trials of ${WORKER_COUNT.toString()} workers as evidence of contention; got ${JSON.stringify(allTrialResults)}`,
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
        `expected a SQLITE_BUSY-class failure as proof of writer-vs-writer contention; got ${JSON.stringify(f)}`,
      ).toBe(true);
    }
  }, 60_000);

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

// ----------------------------------------------------------------------------
// Read-side payload trust boundary (parsePayload)
// ----------------------------------------------------------------------------
//
// `readEvents` parses each row's `payload` as JSON and requires a plain object, matching the wire
// schema's object payloads. A writer that stores malformed JSON or a
// non-object value would otherwise surface as a misleading `TypeError` in the projector.
//
// The tests write through a raw statement: the `payload` column is `TEXT NOT NULL`, so SQLite
// accepts any string and the check must happen at hydration.

describe("SessionService — read-side payload validation", () => {
  function appendRaw(payloadText: string, sequence: number, id: string): void {
    ctx.db
      .prepare(
        `INSERT INTO session_events (
           id, session_id, sequence, occurred_at, monotonic_ns,
           category, type, payload
         ) VALUES (
           @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
           @category, @type, @payload
         )`,
      )
      .run({
        id,
        session_id: SESSION_ID,
        sequence,
        occurred_at: "2026-04-27T12:00:00.000Z",
        monotonic_ns: 1n,
        category: "session_lifecycle",
        type: "session.created",
        payload: payloadText,
      });
  }

  it.each([
    ["null", "01J0EV8881NN5J5J5J5J5J5J5J", /payload must be a JSON object .* \(got null\)/],
    ['["a","b"]', "01J0EV8882NN5J5J5J5J5J5J5J", /payload must be a JSON object .* \(got array\)/],
    [
      '"plain string"',
      "01J0EV8883NN5J5J5J5J5J5J5J",
      /payload must be a JSON object .* \(got string\)/,
    ],
    ["{not valid json", "01J0EV8884NN5J5J5J5J5J5J5J", /payload is not valid JSON/],
  ])("throws a structured error for the stored payload %s", (payloadText, id, refusal) => {
    appendRaw(payloadText, 0, id);
    expect(() => ctx.service.readEvents(SESSION_ID)).toThrow(refusal);
  });
});
