// D2/D3/D4: SessionService — append + replay over Local SQLite.
//
// D2: Replay reads events by sequence ASC and reproduces snapshot
//     deterministically (Spec-001 AC6).
// D3: Replay uses sequence not monotonic_ns even when monotonic_ns is
//     non-monotonic across rows (clock-skew defense; Spec-001 AC6).
// D4: Snapshot survives daemon restart and yields identical projection
//     on rehydrate (durability across restart; Spec-001 AC2 + AC6).
//
// Plus Round 2 additions:
//   * `openDatabase` factory: idempotent reopen test (code-reviewer F5).
//   * `applyMigrations` migration race / read-after-write (code-reviewer F2).
//   * Integrity-column CHECK constraint rejection (code-reviewer F3).
//
// Database lifecycle: each test gets a unique file under os.tmpdir().
// `afterEach` closes any open handle and unlinks the file (the WAL/SHM
// sidecars are removed too — better-sqlite3 names them <db>-wal and
// <db>-shm). This avoids cross-test bleed and disk-leak under test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

function makeMembershipJoinedEvent(sequence: number, monotonicNs: bigint): AppendableEvent {
  return {
    id: `01J0EV0001NN5J5J5J5J5J5J0${sequence.toString()}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-04-27T12:01:00.000Z",
    monotonicNs,
    category: "membership_change",
    type: "membership.joined",
    actor: OWNER_ID,
    // `role` is required by `MembershipRoleSchema` per the contracts —
    // Round 2 widens the projection from "owner" | "member" to the full
    // wire union, so fixtures must specify a real role.
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
  // takes. Round 1's test-only helper has been removed in favor of this.
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
    const joined: AppendableEvent = makeMembershipJoinedEvent(1, 2_000_000_000n);
    const channel: AppendableEvent = makeChannelCreatedEvent(2, 3_000_000_000n, "01970000-0000-7000-8000-000000000001", "Design Review");

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
    const e1: AppendableEvent = makeMembershipJoinedEvent(1, 1_000_000_000n);
    const e2: AppendableEvent = makeChannelCreatedEvent(2, 3_000_000_000n, "01970000-0000-7000-8000-000000000002", "Side Channel");

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
});

// ----------------------------------------------------------------------------
// D4 — durability across daemon restart
// ----------------------------------------------------------------------------

describe("SessionService — D4 (snapshot survives daemon restart)", () => {
  it("yields identical projection after closing and reopening the database file", () => {
    // First "process": create session, add a member and a channel.
    const created: AppendableEvent = makeCreatedEvent();
    const joined: AppendableEvent = makeMembershipJoinedEvent(1, 2_000_000_000n);
    const channel: AppendableEvent = makeChannelCreatedEvent(2, 3_000_000_000n, "01970000-0000-7000-8000-000000000003", "Design Review");

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
    // applyMigrations, so this also covers code-reviewer F2's
    // read-after-write idempotency: the second open sees the first's
    // committed schema_version row and short-circuits.
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

  it("applyMigrations is idempotent across two handles to the same file (read-after-write)", () => {
    // Round 1's runner used `hasMigrationApplied` then `db.exec(sql)`
    // without atomicity — two daemons racing on first-boot would both
    // see `false` and both attempt to CREATE TABLE, with the loser
    // surfacing "table session_events already exists".
    //
    // Round 2 wraps the migration in db.transaction(...) which uses
    // BEGIN immediately. better-sqlite3 is fully synchronous so true
    // concurrency isn't reachable from a single process, but the
    // realistic interleaving is "handle A commits, handle B's
    // hasMigrationApplied sees the committed schema_version row and
    // short-circuits to a no-op idempotent reapply." This test pins
    // that read-after-write visibility.
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
// Integrity-column CHECK constraints (code-reviewer F3)
// ----------------------------------------------------------------------------
//
// The Plan-001 migration declares CHECK(length(prev_hash) = 32 AND
// length(row_hash) = 32 AND length(daemon_signature) = 64 AND
// (participant_signature IS NULL OR length(participant_signature) = 64))
// on session_events. Round 1 had no constraint — wrong-length placeholder
// bytes (e.g. Buffer.alloc(0)) silently succeeded and surfaced as a
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
