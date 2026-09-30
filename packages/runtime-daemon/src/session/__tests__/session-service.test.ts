// SessionService — append + replay over Local SQLite.
//
//   * Replay reads events by sequence ASC and reproduces the snapshot
//     deterministically.
//   * Replay uses sequence not monotonic_ns even when monotonic_ns is
//     non-monotonic across rows (clock-skew defense).
//   * The snapshot survives a daemon restart and yields an identical
//     projection on rehydrate.
//
//   * `append()` refuses on a default-constructed service; reads need
//     no opt-in. The `beforeEach` fixture opts in explicitly
//     (`allowTestSeedingAppend`) so the D2/D3/D4 blocks can
//     seed rows; see the append-guard describe block.
//
// Migration runner coverage:
//   * `openDatabase` factory: idempotent reopen test.
//   * `applyMigrations` sequential idempotency on a second handle.
//
// Concurrency coverage (see "Concurrent-boot migration race" block below):
//   * Concurrent-boot via `worker_threads` proves `BEGIN IMMEDIATE`
//     serializes the migration without loss or duplicate.
//   * Negative-control on the same workers using the default
//     `db.transaction(...)()` (BEGIN DEFERRED) reproduces the
//     writer-vs-writer SQLITE_BUSY contention — empirical proof
//     `.immediate()` is the load-bearing seam.
//   * D3 includes a `monotonic_ns > 2^53` round-trip to prove the
//     bigint annotations on `SessionEventRow.monotonic_ns` hold under
//     boundary input.
//
// Database lifecycle: each test gets a unique file under os.tmpdir().
// `afterEach` closes any open handle and unlinks the file (the WAL/SHM
// sidecars are removed too — better-sqlite3 names them <db>-wal and
// <db>-shm). This avoids cross-test bleed and disk-leak under test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations, applyPragmas, openDatabase } from "../migration-runner.js";
import { SessionService, TestSeedingAppendToken } from "../session-service.js";
import type { AppendableEvent } from "../types.js";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

const SESSION_ID: string = "01J0SE5510NN5J5J5J5J5J5J5J";
const OWNER_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";

function makeCreatedEvent(): AppendableEvent {
  return {
    id: "01J0EV0000NN5J5J5J5J5J5J5J",
    sessionId: SESSION_ID,
    sequence: 0,
    occurredAt: "2026-04-27T12:00:00.000Z",
    monotonicNs: 1_000_000_000n,
    category: "session_lifecycle",
    type: "session.created",
    actor: OWNER_ID,
    payload: {
      sessionId: SESSION_ID,
      shape: "chat",
      mainAgent: {
        agentId: "44444444-4444-4444-8444-444444444444",
        name: "Implementer",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: "2026-04-27T12:00:00.000Z",
      },
    },
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

function makeRenamedEvent(sequence: number, monotonicNs: bigint, name: string): AppendableEvent {
  return {
    id: `01J0EV0002NN5J5J5J5J5J5J0${sequence.toString()}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-04-27T12:02:00.000Z",
    monotonicNs,
    category: "session_lifecycle",
    type: "session.renamed",
    actor: OWNER_ID,
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
  // Use the canonical factory — same code path daemon production code
  // takes — so the test exercise stays in lockstep with production
  // open semantics (pragmas + migrations, in that order).
  const db: DatabaseType = openDatabase(dbPath);
  ctx = {
    db,
    // Explicit test-only opt-in to the guarded append path — this suite's
    // D2/D3/D4 blocks seed rows through it (the append-guard
    // describe block pins the refusal on a default-constructed service).
    service: new SessionService(db, {
      allowTestSeedingAppend: TestSeedingAppendToken.forTestsOnly(),
    }),
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
    // Insert events in deliberately scrambled order. SQLite's
    // UNIQUE(session_id, sequence) constraint will tolerate any insert
    // order; the canonical ordering is established by the read path's
    // ORDER BY sequence ASC.
    const created: AppendableEvent = makeCreatedEvent();
    const firstRename: AppendableEvent = makeRenamedEvent(1, 2_000_000_000n, "Design Review");
    const secondRename: AppendableEvent = makeRenamedEvent(2, 3_000_000_000n, "Release Notes");

    // Append sequence=2 first, then 0, then 1.
    ctx.service.append(secondRename);
    ctx.service.append(created);
    ctx.service.append(firstRename);

    const events = ctx.service.readEvents(SESSION_ID);
    // Events come back in sequence-ASC order regardless of insert order.
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2]);

    const snapshot = ctx.service.replay(SESSION_ID);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(snapshot.asOfSequence).toBe(2);
    expect(snapshot.ownerActor).toBe(OWNER_ID);
  });
});

// ----------------------------------------------------------------------------
// Sequence, not monotonic_ns
// ----------------------------------------------------------------------------

describe("SessionService — replay uses sequence not monotonic_ns", () => {
  it("orders events by sequence even when monotonic_ns goes backwards across rows", () => {
    // Construct events where monotonic_ns is *deliberately non-
    // monotonic* relative to sequence:
    //   sequence=0 -> monotonic_ns = 5_000_000_000
    //   sequence=1 -> monotonic_ns = 1_000_000_000  (backwards!)
    //   sequence=2 -> monotonic_ns = 3_000_000_000  (forwards from 1, but still less than 0)
    //
    // The schema doc is unambiguous: monotonic_ns is within-daemon debug
    // data; sequence is the canonical replay key. Replay MUST produce
    // sequence=[0, 1, 2] regardless of monotonic_ns clock skew.
    const e0: AppendableEvent = { ...makeCreatedEvent(), monotonicNs: 5_000_000_000n };
    const e1: AppendableEvent = makeRenamedEvent(1, 1_000_000_000n, "Back Room");
    const e2: AppendableEvent = makeRenamedEvent(2, 3_000_000_000n, "Side Room");

    ctx.service.append(e0);
    ctx.service.append(e1);
    ctx.service.append(e2);

    const events = ctx.service.readEvents(SESSION_ID);
    // Verify: sequence is monotonic ASC, monotonic_ns is NOT monotonic ASC.
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.monotonicNs)).toEqual([
      5_000_000_000n,
      1_000_000_000n,
      3_000_000_000n,
    ]);
    // Sanity: a hypothetical sort by monotonic_ns ASC would produce
    // [1, 2, 0] — proving the read path is NOT using it as a key.
    const monotonicSorted = [...events].sort((a, b) => Number(a.monotonicNs - b.monotonicNs));
    expect(monotonicSorted.map((e) => e.sequence)).toEqual([1, 2, 0]);

    // Snapshot still bootstraps correctly because event[0] is
    // session.created — sequence-ASC ordering placed it first.
    const snapshot = ctx.service.replay(SESSION_ID);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(snapshot.sessionId).toBe(SESSION_ID);
    expect(snapshot.asOfSequence).toBe(2);
  });

  it("round-trips a monotonic_ns value above Number.MAX_SAFE_INTEGER as bigint without precision loss", () => {
    // D3's other fixtures (1e9, 3e9, 5e9) all sit below
    // Number.MAX_SAFE_INTEGER ≈ 9.007e15, so a regression that did
    // `Number(row.monotonic_ns)` in `hydrateRow` would not surface from
    // them alone. `process.hrtime.bigint()` legitimately exceeds 2^53
    // even on hosts booted well over a year — the relevant boundary is
    // exactly 2^53 + 1 = 9_007_199_254_740_993n, where double-precision
    // floats start losing the LSB. This test pins the boundary.
    const BIGINT_BOUNDARY: bigint = 9_007_199_254_740_993n; // 2^53 + 1
    const created: AppendableEvent = {
      ...makeCreatedEvent(),
      // Use the boundary value for the bootstrap event itself so the
      // assertion path exercises the full `readEvents` → `hydrateRow`
      // → projector pipeline at the boundary.
      monotonicNs: BIGINT_BOUNDARY,
    };
    ctx.service.append(created);

    const events = ctx.service.readEvents(SESSION_ID);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (event === undefined) return; // type guard for TS

    // Type discrimination: the field is declared `bigint` on
    // `StoredEvent.monotonicNs`. `typeof` is the runtime witness — a
    // regression to `Number(row.monotonic_ns)` would yield "number" and
    // fail this check before the value comparison.
    expect(typeof event.monotonicNs).toBe("bigint");
    // Equality at the boundary value — proves the LSB survived the
    // round-trip through SQLite INTEGER + better-sqlite3 safeIntegers
    // mode + the `hydrateRow` extraction. A `Number()` regression would
    // produce 9_007_199_254_740_992n on the round-trip (the floor of
    // the true value once cast to double).
    expect(event.monotonicNs).toBe(BIGINT_BOUNDARY);
    // Belt and braces: the regression path's value would equal
    // BIGINT_BOUNDARY - 1n. Asserting NOT-equal to that pins the
    // precision-loss failure mode explicitly.
    expect(event.monotonicNs).not.toBe(BIGINT_BOUNDARY - 1n);
  });
});

// ----------------------------------------------------------------------------
// Durability across daemon restart
// ----------------------------------------------------------------------------

describe("SessionService — snapshot survives daemon restart", () => {
  it("yields identical projection after closing and reopening the database file", () => {
    // First "process": create the session and rename it twice.
    const created: AppendableEvent = makeCreatedEvent();
    const firstRename: AppendableEvent = makeRenamedEvent(1, 2_000_000_000n, "Design Review");
    const secondRename: AppendableEvent = makeRenamedEvent(2, 3_000_000_000n, "Release Notes");

    ctx.service.append(created);
    ctx.service.append(firstRename);
    ctx.service.append(secondRename);

    const beforeRestart = ctx.service.replay(SESSION_ID);
    expect(beforeRestart).not.toBeNull();

    // Close the handle as if the daemon process exited.
    ctx.db.close();
    expect(ctx.db.open).toBe(false);

    // Reopen the SAME file (proves on-disk durability — not in-memory
    // pages — backs the projection). Re-uses the canonical factory.
    // Default construction (no append opt-in) is deliberate: the reopened
    // service only replays, and reads need no opt-in — this doubles as a
    // live proof of the guard's read-side contract.
    const reopenedDb: DatabaseType = openDatabase(ctx.dbPath);
    const reopenedService: SessionService = new SessionService(reopenedDb);

    // Stash the new handle so afterEach cleans it up.
    ctx.db = reopenedDb;
    ctx.service = reopenedService;

    const afterRestart = reopenedService.replay(SESSION_ID);
    expect(afterRestart).not.toBeNull();

    // Strict deep equality — same projection bytes, modulo the bigint
    // monotonic_ns roundtrip which happens identically on both sides.
    expect(afterRestart).toEqual(beforeRestart);

    if (afterRestart === null) return;
    expect(afterRestart.ownerActor).toBe(OWNER_ID);
    expect(afterRestart.asOfSequence).toBe(2);
  });

  it("openDatabase is idempotent on reopen (does not re-create the schema)", () => {
    // Reopening the same file must not throw and must leave the schema as the
    // first open created it.
    const tablesBefore: ReadonlyArray<string> = schemaObjectNames(ctx.db);
    ctx.db.close();
    const reopened: DatabaseType = openDatabase(ctx.dbPath);
    ctx.db = reopened;
    ctx.service = new SessionService(reopened);
    expect(schemaObjectNames(reopened)).toEqual(tablesBefore);
  });

  it("applyMigrations is idempotent against direct re-call on the same handle", () => {
    const objectsBefore: ReadonlyArray<string> = schemaObjectNames(ctx.db);
    applyMigrations(ctx.db);
    applyMigrations(ctx.db);
    expect(schemaObjectNames(ctx.db)).toEqual(objectsBefore);
  });

  it("applyMigrations on a second handle to the same file is a sequential no-op (read-after-write idempotency)", () => {
    // Sequential idempotency — NOT a concurrency test. The first handle
    // (ctx.db, opened in beforeEach) has already migrated; this test
    // opens a second handle AFTER the first commit is durable and asserts
    // that the second `applyMigrations` call finds the schema and returns.
    //
    // True concurrent-boot contention is exercised by the worker_threads
    // test below (`concurrent applyMigrations across worker_threads
    // serializes via BEGIN IMMEDIATE without losing any migration`). This
    // test remains as a cheap local proof that the in-process
    // sequential path stays idempotent — a regression here would surface
    // as "applyMigrations on a fresh handle re-runs CREATE TABLE and
    // throws 'table … already exists'", which the worker_threads test
    // would also catch but more expensively.
    const secondHandle: DatabaseType = new Database(ctx.dbPath);
    try {
      applyPragmas(secondHandle);
      // Should NOT throw — the first handle (ctx.db) already migrated.
      applyMigrations(secondHandle);
      expect(schemaObjectNames(secondHandle)).toEqual(schemaObjectNames(ctx.db));
    } finally {
      secondHandle.close();
    }
  });
});

// ----------------------------------------------------------------------------
// Concurrent-boot migration race
// ----------------------------------------------------------------------------
//
// Production must serialize concurrent `openDatabase(sharedPath)` calls
// without losing or duplicating the schema. The bug class this block defends
// against is writer-vs-writer SQLITE_BUSY: when two daemons race to
// migrate the same file under `db.transaction(...)` invoked WITHOUT
// `.immediate()`, better-sqlite3 dispatches `BEGIN` (DEFERRED). Both
// racers begin as readers; the inside-tx schema-probe SELECT
// succeeds without a lock upgrade; the subsequent `db.exec(SQL)`
// requires a writer lock; in WAL mode two DEFERRED transactions
// attempting to upgrade hit `SQLITE_BUSY_SNAPSHOT`, which
// `busy_timeout` cannot resolve (the busy-handler only retries while
// no transaction is held). The fix is `.immediate()` — BEGIN IMMEDIATE
// takes the RESERVED writer-intent lock at BEGIN time, so racers
// serialize at BEGIN (which `busy_timeout` CAN absorb) and the loser's
// inside-tx re-check sees the winner's committed schema.
//
// Concurrency note: better-sqlite3 is fully synchronous. A single
// process cannot exercise this contention from one event loop. The
// tests here use `node:worker_threads` to spawn N parallel openers
// against a shared file path — each worker has its own libuv event loop
// AND its own native better-sqlite3 handle, so SQLite sees N independent
// processes-on-same-file racers (the realistic daemon-restart scenario).
//
// Both tests in this section use a multi-trial threshold structure
// (4-8 workers × 5 trials), NOT single-trial deterministic assertions.
// The bug class (writer-vs-writer SQLITE_BUSY) is statistically
// distributed under contention — single-trial assertions cannot
// distinguish a host-environmental flake from a real `.immediate()`
// regression because the error class is identical. The wide gap in
// per-attempt failure rate between working production (~10-25 % on
// WSL2, ~0 % on Linux bare-metal) and broken production (~95 % on
// Linux bare-metal) makes the population-level threshold reliable even
// in the presence of host noise. See per-test docstrings for the
// binomial-tail math.
//
// Worker fixture rationale lives in
// `./migration-race-worker.mjs` header — TL;DR `.mjs` is required
// because Node's native TS-stripping doesn't rewrite `.js`-extension
// imports (which the production code uses per nodenext convention) and
// vitest's loader hooks aren't inherited by `worker_threads.Worker`
// children.

interface RaceWorkerResult {
  readonly ok: boolean;
  readonly code: string | null;
  readonly message: string;
}

async function runMigrationRace(
  dbPath: string,
  workerCount: number,
  useDeferred: boolean,
  // Supplied by the DEFERRED negative control only: a shared arrival counter
  // that rendezvouses every worker inside its open transaction, between the
  // read that pins its WAL snapshot and the write that upgrades it. The
  // IMMEDIATE detector passes nothing — see the worker fixture's header for why
  // a barrier is meaningless (and would merely stall) on that path.
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
  // Spawn ALL workers up-front so they start in parallel — the
  // `Promise.all` then awaits each result. The point is to maximize the
  // chance the workers reach `BEGIN ...` simultaneously. SQLite's
  // file-locking will then serialize them; the assertion is on the
  // exit shape (all OK + the expected schema), not on the order.
  //
  // The outer `workers` array tracks every spawned Worker so the
  // `finally` block can terminate any sibling that's still alive when
  // one rejects. Without this fleet-wide terminate, a worker that
  // rejected before its peers post-message would leave them holding
  // file handles on the test DB path, racing the `afterEach` cleanup
  // (EBUSY-prone on Windows). The `exit` handler complements the
  // `error` handler: a fatal V8 crash, OOM, or pre-try-block error
  // can exit the worker without emitting a JS `error` event, which
  // would otherwise hang the promise until vitest's test timeout. The
  // `exit` listener also clears `settled` so the late-arriving paths
  // do not double-resolve.
  const workers: Worker[] = [];
  const promises: Array<Promise<RaceWorkerResult>> = [];
  for (let i = 0; i < workerCount; i++) {
    // The worker child strips TypeScript natively (on by default on every Node
    // this package supports); its loader hook (`migration-race-loader.mjs`)
    // rewrites `.js` specifiers to `.ts`, because vitest's loader is not
    // inherited by `worker_threads.Worker` children.
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
  // Per-test fresh tmp directory: this block doesn't use the outer
  // `ctx` because `beforeEach` already opened a handle on `ctx.dbPath`
  // and migrated it (via `openDatabase`) — for the concurrent-boot
  // tests we need never-yet-migrated files so the race is "first
  // boot", not "verify-already-migrated". Both tests below construct
  // per-trial DB paths inside `raceTmpDir` so trials don't bleed into
  // each other (a leftover schema would let later trials' probe
  // short-circuit before any write-lock is attempted, masking the
  // contention behavior the tests are pinning).
  let raceTmpDir: string;

  beforeEach(() => {
    raceTmpDir = mkdtempSync(join(tmpdir(), "ai-sidekicks-daemon-race-"));
  });

  afterEach(() => {
    rmSync(raceTmpDir, { recursive: true, force: true });
  });

  // Per-test timeout (the 60_000 trailing argument): vitest's 5 s default
  // is itself a flake source here — the 5 sequential trials each spawn 4
  // --experimental-strip-types worker threads, and spawn+compile overhead
  // alone has exceeded 5 s on a contended CI runner (observed 2×). 60 s is
  // pure headroom for the detector; the oracle is FAILURE_THRESHOLD below,
  // never elapsed time.
  it("4 workers × 5 trials with .immediate() stays well below the BUSY-saturation threshold of broken production (regression detector)", async () => {
    // Why this shape (multi-trial threshold, NOT retry):
    //
    // Both the WSL2-host environmental flake AND a real `.immediate()`
    // regression manifest as `SQLITE_BUSY: database is locked` on the
    // worker — the error class is identical. Single-trial assertions
    // (or per-test retries) cannot tell them apart: tightening the
    // assertion makes WSL2 flake leak through; loosening it lets a
    // real regression silently pass. Empirically verified: with
    // `retry: 5` at WORKER_COUNT=2, broken production (`db.transaction
    // (...)()` → DEFERRED) passes 5/5 runs because per-attempt failure
    // rate (~25-95%) is below the cumulative-retry threshold.
    //
    // The discriminator IS available — but at the population level,
    // not the per-attempt level. Empirical per-attempt failure rates
    // at WORKER_COUNT=4:
    //
    //   * Working production (`.immediate()`), Linux bare-metal CI:
    //     ~0 % failure rate (writer-intent lock + busy_timeout fully
    //     resolves contention). Threshold-margin ≈ 100 %.
    //   * Working production, WSL2 dev: ~10-25 % per attempt — the
    //     fcntl-on-9p emulation surfaces SQLITE_BUSY at BEGIN
    //     IMMEDIATE without engaging busy_timeout retry (the WSL2
    //     lock-error code isn't in SQLite's "retryable" set on this
    //     fs). Multi-trial expected total: 2-5 / 20.
    //   * Broken production (`tx()` → DEFERRED), Linux bare-metal
    //     baseline: ~95 % per attempt (multi-trial expected total
    //     ~19 / 20).
    //   * Broken production, WSL2 dev: 0-60 % per attempt due to
    //     fcntl-on-9p reducing contention saturation (some trials
    //     happen to fully serialize cleanly even with DEFERRED).
    //     Multi-trial expected total: 0-12 / 20 — overlaps with
    //     working-production WSL2 distribution.
    //
    // Threshold = 10 (50 % of attempts) is calibrated against the
    // Linux bare-metal CI gap (~0 % working vs ~95 % broken). On
    // Linux CI the threshold discriminates with binomial-tail
    // probability ≈ 0 of false alarm. On WSL2 dev the distributions
    // overlap heavily — bug-detection sensitivity is reduced (~35 %
    // detection rate observed locally for the broken DEFERRED
    // pattern), but false-positive risk against WORKING production
    // stays low because the working-production WSL2 distribution
    // sits well under threshold (E[failures] ≈ 5, threshold = 10).
    // The CI run is the load-bearing assertion; WSL2 dev runs are
    // correctness smoke-tests that ALSO run the deterministic
    // negative control below (which is environment-independent
    // because it pins the existence of contention, not its absence).
    //
    // TODO: the threshold is calibrated to the
    // ".immediate()-dropped" regression class (~95 % per-attempt
    // saturation on Linux). A future regression that produced a
    // smaller per-attempt failure rate (say 30 %) would not cross
    // 10/20 and would pass silently — the negative control below
    // catches "DEFERRED-shaped contention exists" but not
    // intermediate failure rates. When adds further
    // migration-related concurrency invariants (snapshot-write
    // coupling, say), revisit this
    // threshold and add bug-class-specific assertions for any
    // regression class that wouldn't surface here at the existing
    // 50 % threshold.
    //
    // The `runMigrationRace` helper, the worker fixture
    // (`./migration-race-worker.mjs`), and the multi-trial loop
    // structure are shared with the negative control below: both
    // tests use the same shape (one validates working production
    // stays under the threshold, the other proves the broken pattern
    // crosses a different threshold deterministically). NO
    // PER-TEST `retry` is used — retries cannot distinguish flake-
    // class from regression-class failures (both surface as
    // SQLITE_BUSY); only the population-level threshold can.
    //
    // Verification recipe (manual, ad-hoc):
    //   * Confirm `.immediate()` is in migration-runner.ts.
    //   * Run this test 30× → 30/30 pass on WSL2 (observed locally).
    //   * Temporarily revert `.immediate()` → `()`; run 10× → at
    //     least 3-4 trials cross threshold on WSL2 (~35 % WSL2-only
    //     detection rate; ~100 % on Linux CI per binomial math).
    //   * Restore `.immediate()` before commit.
    const WORKER_COUNT: number = 4;
    const TRIAL_COUNT: number = 5;
    const FAILURE_THRESHOLD: number = 10; // out of 20 attempts (50%)

    let totalFailures: number = 0;
    const allResults: RaceWorkerResult[][] = [];
    for (let trial = 0; trial < TRIAL_COUNT; trial++) {
      // Fresh DB path per trial — leftover state would mask contention
      // by letting later trials' schema probe short-circuit
      // before any write-lock is attempted (just like the negative
      // control loop below).
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

    // Every trial's file must hold exactly the schema a single in-process
    // apply creates, however many workers won or blocked. The whole schema
    // commits in one transaction, so a torn or doubled apply shows up either
    // here or as a worker failure above.
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

  // Same per-test timeout class as the detector above (60_000 trailing
  // argument). The bound used to be busy-wait dominated — DEFERRED losers
  // blocking up to busy_timeout=5000 ms per attempt, so 5 trials × (busy-wait +
  // 8 worker spawns) could legitimately approach ~30-40 s under CI contention.
  // Under the snapshot barrier a loser takes SQLITE_BUSY_SNAPSHOT immediately
  // (a snapshot conflict does not invoke the busy handler), so the dominant
  // term is now the barrier's own 3 s deadline, and only on a degraded trial
  // where some sibling never arrives: 5 × 3 s worst case, plus worker spawns.
  // 60 s still keeps margin without masking a genuine hang.
  it("the SAME race pattern using BEGIN DEFERRED across multiple trials reproduces writer-vs-writer contention at least once — empirical proof .immediate() is load-bearing", async () => {
    // Negative control: this test intentionally exercises the broken
    // pattern (`tx()` → BEGIN DEFERRED) to prove (a) the workers are
    // genuinely contending and (b) `.immediate()` is the load-bearing
    // seam, NOT some other change.
    //
    // Reliability: the collision is made STRUCTURAL by the worker's snapshot
    // barrier rather than left to SQLite's non-deterministic busy resolution.
    // Each DEFERRED worker parks inside its open transaction — after the read
    // that pins its WAL snapshot, before the write that upgrades it — until
    // every sibling has arrived. No racer can commit while the others are
    // parked, so none can arrive late enough to see an already-migrated
    // database and skip the transaction. On release one wins the write lock
    // and the other WORKER_COUNT-1 hold snapshots that are now stale, which is
    // SQLITE_BUSY_SNAPSHOT by construction.
    //
    // This replaced a purely probabilistic rationale (per-trial "luck" of ~0.2,
    // so 5 trials gave a 3.2e-4 false-negative bound). That model was
    // calibrated on an unloaded machine and did not survive a busier suite: a
    // saturated host serializes worker spawns, the DEFERRED snapshots stop
    // overlapping, every racer passes cleanly, and the control false-negatives.
    // Observed on this package's own suite once real-process fixtures joined
    // it — 1 failure in 2 of ~5 full-suite runs while the file alone stayed
    // 6/6 green.
    //
    // The barrier carries a deadline and proceeds regardless once it expires,
    // so a sibling that is merely SLOW — still spawning on a saturated host —
    // degrades this test to the old probabilistic behavior instead of hanging
    // it. A worker that actually DIES is a different path and not a degraded
    // one: `runMigrationRace`'s `exit` handler rejects, failing the test
    // outright rather than quietly weakening it. TRIAL_COUNT therefore stays at
    // 5 — the trials are far cheaper now that losers fail immediately instead
    // of busy-waiting out `busy_timeout`, and the repetition still covers the
    // degraded path.
    //
    // The assertion below stays "at least one", deliberately weaker than the
    // WORKER_COUNT-1 the barrier makes typical: a deadline-expiry trial is a
    // legitimate degraded run, not a regression, and the point of the control
    // is evidence of contention rather than a count of it. If it ever fails —
    // zero observed BUSY across all trials — the negative-control mechanism is
    // broken: either the workers are not actually concurrent, or SQLite's
    // behavior changed in a way that makes `.immediate()` unnecessary. Either
    // case warrants a code review, not a silent green-CI pass. Under the
    // barrier that statement is now structurally true rather than
    // statistically true.
    const WORKER_COUNT: number = 8;
    const TRIAL_COUNT: number = 5;
    const allTrialResults: RaceWorkerResult[][] = [];
    for (let trial = 0; trial < TRIAL_COUNT; trial++) {
      // Fresh DB path per trial — leftover state would mask contention
      // by letting the second trial's schema probe short-circuit before
      // any write-lock is attempted.
      const trialPath: string = join(raceTmpDir, `trial-${trial.toString()}.db`);
      // Fresh counter per trial too, rather than resetting one buffer: a
      // straggler from a terminated trial cannot then bump the next trial's
      // counter and release its barrier early.
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

    // Every observed failure must be a SQLITE_BUSY-class error. Any
    // other error class (e.g. constraint violation, syntax error) means
    // the test is exercising the wrong failure mode and the fix is
    // sealing a different bug than we claimed.
    for (const f of allFailures) {
      const isBusyClass: boolean =
        f.code === "SQLITE_BUSY" ||
        f.code === "SQLITE_BUSY_SNAPSHOT" ||
        // better-sqlite3 surfaces "table … already exists" as a generic
        // SQLITE_ERROR when the racer DID upgrade past BEGIN but lost
        // at the CREATE TABLE step — also valid evidence of the same
        // writer-vs-writer race.
        /already exists/i.test(f.message) ||
        /SQLITE_BUSY/i.test(f.message);
      expect(
        isBusyClass,
        `expected a SQLITE_BUSY-class failure as proof of writer-vs-writer contention; got ${JSON.stringify(f)}`,
      ).toBe(true);
    }
  }, 60_000);

  it("refuses a snapshot barrier on the IMMEDIATE path instead of ignoring it", async () => {
    // The guard is what makes the barrier trustworthy. An IMMEDIATE racer
    // serializes at BEGIN and never reaches an in-transaction rendezvous, so a
    // barrier handed to it could only ever be dead weight — and accepting it
    // would disable the mechanism SILENTLY, leaving a green suite that proves
    // nothing. The worker therefore rejects the combination at startup, and
    // this pins that refusal so the guard cannot rot into a no-op unnoticed.
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
// openDatabase failure-mode cleanup
// ----------------------------------------------------------------------------
//
// `openDatabase` is the canonical handle factory. Production callers
// have NO reference to the half-initialized handle if either
// `applyPragmas` or `applyMigrations` throws — without an explicit
// cleanup branch, the OS-level lock + WAL file descriptor stay held
// until V8 garbage-collects the wrapper, racing the next retry. The
// fix wraps init in try/catch + db.close() before rethrowing.
//
// The test makes `applyMigrations` throw deterministically by pre-creating a
// conflicting `session_snapshots` table on the target file. The schema probe
// looks for `session_events`, finds none, and the schema script then hits
// "table session_snapshots already exists".
// We spy on `Database.prototype.close` to assert the cleanup branch
// fires exactly once. Spy-based verification is the load-bearing
// witness — a regression that removed the try/catch but happened to
// not leak file descriptors on Linux (because GC eventually fires)
// would still fail this assertion, which is the right discriminator.

describe("openDatabase — failure-mode cleanup (closes handle if init throws)", () => {
  let cleanupTmpDir: string;

  beforeEach(() => {
    cleanupTmpDir = mkdtempSync(join(tmpdir(), "ai-sidekicks-daemon-cleanup-"));
  });

  afterEach(() => {
    rmSync(cleanupTmpDir, { recursive: true, force: true });
  });

  it("calls db.close() on the half-initialized handle before rethrowing if applyMigrations throws", () => {
    const dbPath: string = join(cleanupTmpDir, "init-fail.db");

    // Pre-stage the file with a conflicting `session_snapshots` table so the
    // schema script inside applyMigrations throws "table session_snapshots
    // already exists" — the cleanup branch's failure-mode trigger.
    const seedHandle: DatabaseType = new Database(dbPath);
    try {
      seedHandle.exec("CREATE TABLE session_snapshots (placeholder TEXT)");
    } finally {
      seedHandle.close();
    }

    // Spy on `Database.prototype.close` BEFORE openDatabase is called so
    // every close invocation across this test (including the
    // cleanup-branch close) is counted. The spy preserves the original
    // implementation so the OS-level handle still releases.
    const closeSpy = vi.spyOn(Database.prototype, "close");
    try {
      // Assert openDatabase rethrows the underlying init error verbatim.
      // The exact phrasing comes from better-sqlite3's SQLite error
      // surface — match the error class, not the literal text, so a
      // future better-sqlite3 phrasing change does not break the test.
      expect(() => openDatabase(dbPath)).toThrow(/already exists/i);

      // Cleanup-branch witness: the failed `openDatabase` call MUST
      // have invoked `db.close()` exactly once on the half-initialized
      // handle before rethrowing. A regression that removed the
      // try/catch wrapper would leave this call count at 0.
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("rethrows the original init error when db.close() itself throws (close-error suppression preserves diagnostic)", () => {
    // The cleanup branch must prefer the original init error over a
    // teardown-time close error: a close failure on an already-broken
    // handle is strictly less informative than the underlying init
    // failure. Force `db.close()` to throw via the spy so we can
    // verify the rethrow surface keeps the init context.
    const dbPath: string = join(cleanupTmpDir, "init-fail-close-throws.db");

    // Same pre-stage trick to force applyMigrations to throw.
    const seedHandle: DatabaseType = new Database(dbPath);
    try {
      seedHandle.exec("CREATE TABLE session_snapshots (placeholder TEXT)");
    } finally {
      seedHandle.close();
    }

    // Replace `Database.prototype.close` with a spy that always throws.
    // The cleanup branch must swallow the close-error and rethrow the
    // ORIGINAL init error.
    const closeSpy = vi.spyOn(Database.prototype, "close").mockImplementation(function () {
      throw new Error("simulated close failure");
    });
    try {
      // The rethrown error must be the init error ("already exists"),
      // NOT the simulated close error. This proves the cleanup branch
      // suppresses close-time failures rather than masking the init
      // diagnostic.
      expect(() => openDatabase(dbPath)).toThrow(/already exists/i);
      expect(() => openDatabase(dbPath)).not.toThrow(/simulated close failure/);
    } finally {
      // Restore the real close implementation BEFORE the seed-handle
      // cleanup in afterEach reattempts close on any handles the test
      // somehow leaked.
      closeSpy.mockRestore();
    }
  });
});

// ----------------------------------------------------------------------------
// Append guard
// ----------------------------------------------------------------------------
//
// A default-constructed service is read-only: a composition root wiring a
// real database cannot reach the test-seeding append path by accident. The
// refusal test below is the guard's own negative control — it proves the
// guard fires, so the opted-in green suite is not vacuous evidence.

// The guard's negative controls' titles, bound to exported identifiers so a
// rename or deletion is a compile-time change rather than a silent one.
export const DEFAULT_CONSTRUCTED_APPEND_REFUSAL_TEST: string =
  "refuses append on a default-constructed service, naming the replacement writer and the opt-in";
export const FORGED_TOKEN_REFUSAL_TEST: string =
  "refuses a FORGED token — the guard checks identity against the module-private singleton, not structure";

describe("SessionService — append guard (test-seeding writes are opt-in)", () => {
  it(DEFAULT_CONSTRUCTED_APPEND_REFUSAL_TEST, () => {
    const guardedService: SessionService = new SessionService(ctx.db);
    expect(() => guardedService.append(makeCreatedEvent())).toThrow(
      /SessionService\.append is guarded/,
    );
    // The refusal names where durable writes belong and how tests opt in —
    // the diagnostic is the contract, not just the throw.
    expect(() => guardedService.append(makeCreatedEvent())).toThrow(/EventLogService\.append/);
    expect(() => guardedService.append(makeCreatedEvent())).toThrow(
      /allowTestSeedingAppend.*TestSeedingAppendToken\.forTestsOnly\(\)/s,
    );
    // The refusal happens before any INSERT — nothing was persisted.
    expect(guardedService.readEvents(SESSION_ID)).toHaveLength(0);
  });

  it(FORGED_TOKEN_REFUSAL_TEST, () => {
    // A boolean opt-in (even the literal `true`) can be threaded from
    // configuration (`condition ? true : undefined` typechecks; an `if`
    // narrows `boolean` to `true`). The token
    // closes that: deserialized or hand-built data can never BE the
    // singleton, so even a cast-through structural lookalike still throws.
    const forgedToken = Object.freeze({
      brand: "test-seeding-append",
    }) as unknown as TestSeedingAppendToken;
    const forgedService: SessionService = new SessionService(ctx.db, {
      allowTestSeedingAppend: forgedToken,
    });
    expect(() => forgedService.append(makeCreatedEvent())).toThrow(
      /SessionService\.append is guarded/,
    );
    expect(forgedService.readEvents(SESSION_ID)).toHaveLength(0);
  });

  it("reads need no opt-in — a default-constructed service replays rows an opted-in writer seeded", () => {
    ctx.service.append(makeCreatedEvent());
    const readOnlyService: SessionService = new SessionService(ctx.db);
    expect(readOnlyService.readEvents(SESSION_ID)).toHaveLength(1);
    const snapshot = readOnlyService.replay(SESSION_ID);
    expect(snapshot).not.toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Read-side payload trust boundary (parsePayload)
// ----------------------------------------------------------------------------
//
// `SessionService.readEvents` parses each row's `payload` blob as JSON and
// asserts the result is a plain object (not null, not an array, not a
// primitive). The wire-layer `SessionEventSchema` constrains every V1
// variant's payload to an object schema, so this read-side guard mirrors
// the wire contract at the storage seam. A defective writer that bypasses
// `SessionService.append()` and stores a non-object JSON value (or
// malformed JSON) would otherwise surface as a misleading downstream
// `TypeError` from the projector — these tests pin the actual diagnostic.
//
// The tests bypass `SessionService.append` by writing through a raw
// prepared statement; the table's `payload` column is `TEXT NOT NULL`,
// so SQLite accepts arbitrary strings and the validation must happen at
// hydration.

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

  it("throws a structured error when payload deserializes to null", () => {
    appendRaw("null", 0, "01J0EV8881NN5J5J5J5J5J5J5J");
    expect(() => ctx.service.readEvents(SESSION_ID)).toThrow(
      /payload must be a JSON object .* \(got null\)/,
    );
  });

  it("throws a structured error when payload deserializes to a JSON array", () => {
    appendRaw('["a","b"]', 0, "01J0EV8882NN5J5J5J5J5J5J5J");
    expect(() => ctx.service.readEvents(SESSION_ID)).toThrow(
      /payload must be a JSON object .* \(got array\)/,
    );
  });

  it("throws a structured error when payload deserializes to a JSON primitive", () => {
    appendRaw('"plain string"', 0, "01J0EV8883NN5J5J5J5J5J5J5J");
    expect(() => ctx.service.readEvents(SESSION_ID)).toThrow(
      /payload must be a JSON object .* \(got string\)/,
    );
  });

  it("throws a structured error when payload is not valid JSON at all", () => {
    appendRaw("{not valid json", 0, "01J0EV8884NN5J5J5J5J5J5J5J");
    expect(() => ctx.service.readEvents(SESSION_ID)).toThrow(/payload is not valid JSON/);
  });
});
