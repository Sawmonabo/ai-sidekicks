// D2/D3/D4: SessionService — append + replay over Local SQLite.
//
// D2: Replay reads events by sequence ASC and reproduces snapshot
//     deterministically (Spec-001 AC6).
// D3: Replay uses sequence not monotonic_ns even when monotonic_ns is
//     non-monotonic across rows (clock-skew defense; Spec-001 AC6).
// D4: Snapshot survives daemon restart and yields identical projection
//     on rehydrate (durability across restart; Spec-001 AC2 + AC6).
//
// Migration runner coverage:
//   * `openDatabase` factory: idempotent reopen test.
//   * `applyMigrations` sequential idempotency on a second handle.
//   * Integrity-column CHECK constraint rejection at INSERT time.
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
import { deriveMainChannelId } from "../session-projector.js";
import { SessionService } from "../session-service.js";
import type { AppendableEvent } from "../types.js";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

const SESSION_ID: string = "01J0SE5510NN5J5J5J5J5J5J5J";
const OWNER_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";
const SECOND_PARTICIPANT_ID: string = "01J0PA1111NN5J5J5J5J5J5J5J";

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
    payload: { sessionId: SESSION_ID, name: "test-session" },
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

function makeMembershipCreatedEvent(sequence: number, monotonicNs: bigint): AppendableEvent {
  return {
    id: `01J0EV0001NN5J5J5J5J5J5J0${sequence.toString()}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-04-27T12:01:00.000Z",
    monotonicNs,
    category: "membership_change",
    type: "membership.created",
    actor: OWNER_ID,
    // `role` is required by `MembershipRoleSchema` per the contracts —
    // the projection mirrors the full wire union (`MembershipRole` in
    // `@ai-sidekicks/contracts`), so fixtures must specify a real role.
    payload: { participantId: SECOND_PARTICIPANT_ID, role: "collaborator" },
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

function makeChannelCreatedEvent(
  sequence: number,
  monotonicNs: bigint,
  channelId: string,
  name: string,
): AppendableEvent {
  return {
    id: `01J0EV0002NN5J5J5J5J5J5J0${sequence.toString()}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-04-27T12:02:00.000Z",
    monotonicNs,
    category: "session_lifecycle",
    type: "channel.created",
    actor: OWNER_ID,
    payload: { channelId, name },
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
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
// D2 — sequence-ASC replay
// ----------------------------------------------------------------------------

describe("SessionService — D2 (replay reads events by sequence ASC)", () => {
  it("reproduces the snapshot deterministically when events are inserted in scrambled sequence order", () => {
    // Insert events in deliberately scrambled order. SQLite's
    // UNIQUE(session_id, sequence) constraint will tolerate any insert
    // order; the canonical ordering is established by the read path's
    // ORDER BY sequence ASC.
    const created: AppendableEvent = makeCreatedEvent();
    const joined: AppendableEvent = makeMembershipCreatedEvent(1, 2_000_000_000n);
    const channel: AppendableEvent = makeChannelCreatedEvent(
      2,
      3_000_000_000n,
      "01970000-0000-7000-8000-000000000001",
      "Design Review",
    );

    // Append sequence=2 first, then 0, then 1.
    ctx.service.append(channel);
    ctx.service.append(created);
    ctx.service.append(joined);

    const events = ctx.service.readEvents(SESSION_ID);
    // Events come back in sequence-ASC order regardless of insert order.
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2]);

    const snapshot = ctx.service.replay(SESSION_ID);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(snapshot.asOfSequence).toBe(2);
    expect(snapshot.memberships).toHaveLength(2); // owner + second participant
    expect(snapshot.memberships.map((m) => m.participantId).sort()).toEqual(
      [OWNER_ID, SECOND_PARTICIPANT_ID].sort(),
    );
    // Channels: synthesized "main" (UUIDv5-derived) + the explicit one above.
    expect(snapshot.channels).toHaveLength(2);
    expect(snapshot.channels.map((c) => c.channelId).sort()).toEqual(
      ["01970000-0000-7000-8000-000000000001", deriveMainChannelId(SESSION_ID)].sort(),
    );
  });
});

// ----------------------------------------------------------------------------
// D3 — sequence not monotonic_ns
// ----------------------------------------------------------------------------

describe("SessionService — D3 (replay uses sequence not monotonic_ns)", () => {
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
    const e1: AppendableEvent = makeMembershipCreatedEvent(1, 1_000_000_000n);
    const e2: AppendableEvent = makeChannelCreatedEvent(
      2,
      3_000_000_000n,
      "01970000-0000-7000-8000-000000000002",
      "Side Channel",
    );

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
// D4 — durability across daemon restart
// ----------------------------------------------------------------------------

describe("SessionService — D4 (snapshot survives daemon restart)", () => {
  it("yields identical projection after closing and reopening the database file", () => {
    // First "process": create session, add a member and a channel.
    const created: AppendableEvent = makeCreatedEvent();
    const joined: AppendableEvent = makeMembershipCreatedEvent(1, 2_000_000_000n);
    const channel: AppendableEvent = makeChannelCreatedEvent(
      2,
      3_000_000_000n,
      "01970000-0000-7000-8000-000000000003",
      "Design Review",
    );

    ctx.service.append(created);
    ctx.service.append(joined);
    ctx.service.append(channel);

    const beforeRestart = ctx.service.replay(SESSION_ID);
    expect(beforeRestart).not.toBeNull();

    // Close the handle as if the daemon process exited.
    ctx.db.close();
    expect(ctx.db.open).toBe(false);

    // Reopen the SAME file (proves on-disk durability — not in-memory
    // pages — backs the projection). Re-uses the canonical factory.
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

    // Spot-check the membership & channel content survived. (Belt &
    // braces — toEqual would already catch a divergence.)
    if (afterRestart === null) return;
    expect(afterRestart.memberships.map((m) => m.participantId).sort()).toEqual(
      [OWNER_ID, SECOND_PARTICIPANT_ID].sort(),
    );
    expect(afterRestart.channels.map((c) => c.channelId).sort()).toEqual(
      ["01970000-0000-7000-8000-000000000003", deriveMainChannelId(SESSION_ID)].sort(),
    );
    expect(afterRestart.asOfSequence).toBe(2);
  });

  it("openDatabase is idempotent on reopen (does not re-run version=1)", () => {
    // Reopening the SAME file via the factory must not throw, must not
    // duplicate the schema_version row. The factory internally calls
    // applyMigrations, so this also covers read-after-write
    // idempotency: the second open sees the first's committed
    // schema_version row and short-circuits.
    ctx.db.close();
    const reopened: DatabaseType = openDatabase(ctx.dbPath);
    ctx.db = reopened;
    ctx.service = new SessionService(reopened);
    const versions = reopened
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as ReadonlyArray<{ version: number }>;
    expect(versions).toEqual([{ version: 1 }]);
  });

  it("applyMigrations is idempotent against direct re-call on the same handle", () => {
    // Reapplying migrations on an already-migrated DB must not throw,
    // must not duplicate the schema_version row.
    applyMigrations(ctx.db);
    applyMigrations(ctx.db);
    const versions = ctx.db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as ReadonlyArray<{ version: number }>;
    expect(versions).toEqual([{ version: 1 }]);
  });

  it("applyMigrations on a second handle to the same file is a sequential no-op (read-after-write idempotency)", () => {
    // Sequential idempotency — NOT a concurrency test. The first handle
    // (ctx.db, opened in beforeEach) has already migrated; this test
    // opens a second handle AFTER the first commit is durable and asserts
    // that the second `applyMigrations` call short-circuits via
    // `hasMigrationApplied` returning true.
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
      const versions = secondHandle
        .prepare("SELECT version FROM schema_version ORDER BY version")
        .all() as ReadonlyArray<{ version: number }>;
      expect(versions).toEqual([{ version: 1 }]);
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
// without losing any migration. The bug class this block defends
// against is writer-vs-writer SQLITE_BUSY: when two daemons race to
// migrate the same file under `db.transaction(...)` invoked WITHOUT
// `.immediate()`, better-sqlite3 dispatches `BEGIN` (DEFERRED). Both
// racers begin as readers; the inside-tx `hasMigrationApplied` SELECT
// succeeds without a lock upgrade; the subsequent `db.exec(SQL)`
// requires a writer lock; in WAL mode two DEFERRED transactions
// attempting to upgrade hit `SQLITE_BUSY_SNAPSHOT`, which
// `busy_timeout` cannot resolve (the busy-handler only retries while
// no transaction is held). The fix is `.immediate()` — BEGIN IMMEDIATE
// takes the RESERVED writer-intent lock at BEGIN time, so racers
// serialize at BEGIN (which `busy_timeout` CAN absorb) and the loser's
// inside-tx re-check sees the winner's committed schema_version row.
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
): Promise<ReadonlyArray<RaceWorkerResult>> {
  const workerUrl: URL = new URL("./migration-race-worker.mjs", import.meta.url);
  // Spawn ALL workers up-front so they start in parallel — the
  // `Promise.all` then awaits each result. The point is to maximize the
  // chance the workers reach `BEGIN ...` simultaneously. SQLite's
  // file-locking will then serialize them; the assertion is on the
  // exit shape (all OK + single schema_version row), not on the order.
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
    const w: Worker = new Worker(workerUrl, {
      workerData: { dbPath, useDeferred },
      // Force Node's native TypeScript-stripping in the worker child. This
      // flag was added in Node 22.6.0 (within our `engines.node: >=22.12.0`
      // floor) and promoted to default-on in Node 22.18.0 — see
      // https://nodejs.org/docs/latest-v22.x/api/typescript.html. The
      // worker's loader hook (`migration-race-loader.mjs`) rewrites
      // `.js` import specifiers to `.ts` so production source can be
      // imported directly, but Node 22.12-22.17 will not strip the
      // resulting `.ts` files unless this flag is present, and vitest's
      // loader is not inherited by `worker_threads.Worker` children
      // (the loader is registered programmatically by vite-node, not
      // via process.execArgv). Suppress the ExperimentalWarning so the
      // pre-22.18 leg of the matrix has clean stderr; the flag becomes
      // a no-op once the daemon's floor moves to >=22.18.0.
      execArgv: ["--experimental-strip-types", "--no-warnings=ExperimentalWarning"],
    });
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
  // each other (a leftover schema_version row would let later trials'
  // `hasMigrationApplied` short-circuit before any write-lock is
  // attempted, masking the contention behavior the tests are pinning).
  let raceTmpDir: string;

  beforeEach(() => {
    raceTmpDir = mkdtempSync(join(tmpdir(), "ai-sidekicks-daemon-race-"));
  });

  afterEach(() => {
    rmSync(raceTmpDir, { recursive: true, force: true });
  });

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
    // TODO(Plan-006): the threshold is calibrated to the
    // ".immediate()-dropped" regression class (~95 % per-attempt
    // saturation on Linux). A future regression that produced a
    // smaller per-attempt failure rate (say 30 %) would not cross
    // 10/20 and would pass silently — the negative control below
    // catches "DEFERRED-shaped contention exists" but not
    // intermediate failure rates. When Plan-006 adds further
    // migration-related concurrency invariants (per-event
    // hash-chain commit, snapshot-write coupling), revisit this
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
      // by letting later trials' `hasMigrationApplied` short-circuit
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

    // Belt-and-braces verification: every trial's database file must
    // contain exactly ONE schema_version row regardless of how many
    // workers succeeded vs blocked. If two racers both ran the
    // migration on a trial, the row-count assertion catches the
    // duplicate (or the racing CREATE TABLE would surface as a
    // failure already counted above). Loop over EVERY trial path so
    // a partial regression that only corrupts one trial still surfaces.
    for (let trial = 0; trial < TRIAL_COUNT; trial++) {
      const trialPath: string = join(raceTmpDir, `imm-trial-${trial.toString()}.db`);
      const verifier: DatabaseType = new Database(trialPath);
      try {
        applyPragmas(verifier);
        const rows = verifier
          .prepare("SELECT version FROM schema_version ORDER BY version")
          .all() as ReadonlyArray<{ version: number }>;
        expect(
          rows,
          `trial ${trial.toString()} expected exactly one schema_version row; got ${JSON.stringify(rows)}`,
        ).toEqual([{ version: 1 }]);
      } finally {
        verifier.close();
      }
    }
  });

  it("the SAME race pattern using BEGIN DEFERRED across multiple trials reproduces writer-vs-writer contention at least once — empirical proof .immediate() is load-bearing", async () => {
    // Negative control: this test intentionally exercises the broken
    // pattern (`tx()` → BEGIN DEFERRED) to prove (a) the workers are
    // genuinely contending and (b) `.immediate()` is the load-bearing
    // seam, NOT some other change. If this assertion ever fails (zero
    // observed BUSY across all trials), the negative-control mechanism
    // is broken — either the workers aren't actually concurrent, or
    // SQLite's behavior changed in a way that makes `.immediate()`
    // unnecessary. Either case warrants a code review, not a silent
    // green-CI pass.
    //
    // Reliability: SQLite's busy resolution is non-deterministic under
    // concurrent contention. In local-dev observation across 10 runs at
    // 4 workers/trial, ~8/10 trials produced at least one BUSY — the
    // remaining 2/10 had all racers serialize cleanly by luck. To make
    // the assertion reliably positive while keeping the test cheap, we
    // run multiple TRIALS (each on a fresh DB) and assert AT LEAST ONE
    // trial showed contention. The probability of all trials being
    // "lucky" decays exponentially: at p=0.2 per-trial luck, 5 trials
    // gives p=3.2e-4 false-negative — small enough that a future
    // failure here is real signal.
    const WORKER_COUNT: number = 8;
    const TRIAL_COUNT: number = 5;
    const allTrialResults: RaceWorkerResult[][] = [];
    for (let trial = 0; trial < TRIAL_COUNT; trial++) {
      // Fresh DB path per trial — leftover state would mask contention
      // by letting the second trial's `hasMigrationApplied` short-
      // circuit before any write-lock is attempted.
      const trialPath: string = join(raceTmpDir, `trial-${trial.toString()}.db`);
      const trialResults: ReadonlyArray<RaceWorkerResult> = await runMigrationRace(
        trialPath,
        WORKER_COUNT,
        /* useDeferred */ true,
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
  });
});

// ----------------------------------------------------------------------------
// P2 — openDatabase failure-mode cleanup
// ----------------------------------------------------------------------------
//
// `openDatabase` is the canonical handle factory. Production callers
// have NO reference to the half-initialized handle if either
// `applyPragmas` or `applyMigrations` throws — without an explicit
// cleanup branch, the OS-level lock + WAL file descriptor stay held
// until V8 garbage-collects the wrapper, racing the next retry. The
// fix wraps init in try/catch + db.close() before rethrowing.
//
// The test makes `applyMigrations` throw deterministically by pre-
// creating a conflicting `session_events` table on the target file
// (without a `schema_version` row), so `INITIAL_MIGRATION_SQL.exec()`
// hits "table session_events already exists" inside `applyMigrations`.
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

    // Pre-stage the file with a conflicting `session_events` table so
    // INITIAL_MIGRATION_SQL.exec() inside applyMigrations throws
    // "table session_events already exists" — the cleanup branch's
    // failure-mode trigger.
    const seedHandle: DatabaseType = new Database(dbPath);
    try {
      seedHandle.exec("CREATE TABLE session_events (placeholder TEXT)");
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
      seedHandle.exec("CREATE TABLE session_events (placeholder TEXT)");
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
// Integrity-column CHECK constraints
// ----------------------------------------------------------------------------
//
// The Plan-001 migration declares CHECK(length(prev_hash) = 32 AND
// length(row_hash) = 32 AND length(daemon_signature) = 64 AND
// (participant_signature IS NULL OR length(participant_signature) = 64))
// on session_events. Without these CHECKs, wrong-length placeholder
// bytes (e.g. Buffer.alloc(0)) would silently succeed and surface as a
// chain-recompute failure later, in Plan-006 verification territory.
// These tests pin the constraints at INSERT time.

describe("session_events integrity-column CHECK constraints", () => {
  it("rejects an INSERT with a wrong-length prev_hash (must be 32 bytes)", () => {
    const stmt = ctx.db.prepare(
      `INSERT INTO session_events (
        id, session_id, sequence, occurred_at, monotonic_ns,
        category, type, payload,
        prev_hash, row_hash, daemon_signature
      ) VALUES (
        @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
        @category, @type, @payload,
        @prev_hash, @row_hash, @daemon_signature
      )`,
    );
    expect(() =>
      stmt.run({
        id: "01J0EV9990NN5J5J5J5J5J5J5J",
        session_id: SESSION_ID,
        sequence: 0,
        occurred_at: "2026-04-27T12:00:00.000Z",
        monotonic_ns: 1n,
        category: "session_lifecycle",
        type: "session.created",
        payload: "{}",
        prev_hash: Buffer.alloc(31), // Wrong: 31 bytes instead of 32.
        row_hash: Buffer.alloc(32),
        daemon_signature: Buffer.alloc(64),
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it("rejects an INSERT with a wrong-length daemon_signature (must be 64 bytes)", () => {
    const stmt = ctx.db.prepare(
      `INSERT INTO session_events (
        id, session_id, sequence, occurred_at, monotonic_ns,
        category, type, payload,
        prev_hash, row_hash, daemon_signature
      ) VALUES (
        @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
        @category, @type, @payload,
        @prev_hash, @row_hash, @daemon_signature
      )`,
    );
    expect(() =>
      stmt.run({
        id: "01J0EV9991NN5J5J5J5J5J5J5J",
        session_id: SESSION_ID,
        sequence: 0,
        occurred_at: "2026-04-27T12:00:00.000Z",
        monotonic_ns: 1n,
        category: "session_lifecycle",
        type: "session.created",
        payload: "{}",
        prev_hash: Buffer.alloc(32),
        row_hash: Buffer.alloc(32),
        daemon_signature: Buffer.alloc(63), // Wrong: 63 bytes instead of 64.
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it("rejects an INSERT with an empty Buffer for participant_signature (NULL or 64 bytes only)", () => {
    const stmt = ctx.db.prepare(
      `INSERT INTO session_events (
        id, session_id, sequence, occurred_at, monotonic_ns,
        category, type, payload,
        prev_hash, row_hash, daemon_signature, participant_signature
      ) VALUES (
        @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
        @category, @type, @payload,
        @prev_hash, @row_hash, @daemon_signature, @participant_signature
      )`,
    );
    expect(() =>
      stmt.run({
        id: "01J0EV9992NN5J5J5J5J5J5J5J",
        session_id: SESSION_ID,
        sequence: 0,
        occurred_at: "2026-04-27T12:00:00.000Z",
        monotonic_ns: 1n,
        category: "session_lifecycle",
        type: "session.created",
        payload: "{}",
        prev_hash: Buffer.alloc(32),
        row_hash: Buffer.alloc(32),
        daemon_signature: Buffer.alloc(64),
        participant_signature: Buffer.alloc(0), // Wrong: empty buffer is neither NULL nor 64 bytes.
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it("accepts an INSERT with the canonical placeholder bytes (the SessionService default)", () => {
    // Belt-and-braces: a normal SessionService.append() must succeed.
    // This is already covered by D2/D3/D4 but pinning it here makes the
    // CHECK-constraint test block read as a self-contained proof.
    expect(() => ctx.service.append(makeCreatedEvent())).not.toThrow();
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
           category, type, payload,
           prev_hash, row_hash, daemon_signature
         ) VALUES (
           @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
           @category, @type, @payload,
           @prev_hash, @row_hash, @daemon_signature
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
        prev_hash: Buffer.alloc(32),
        row_hash: Buffer.alloc(32),
        daemon_signature: Buffer.alloc(64),
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
