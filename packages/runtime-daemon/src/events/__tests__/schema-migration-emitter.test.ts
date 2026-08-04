// Contract coverage for `SchemaMigrationEmitter` — the `schema.migrated`
// hybrid emitter (Plan-006 T3.4).
//
// HYBRID means two paths that must not double-record the same migration: the
// PRIMARY one records a batch the caller just committed, and the FALLBACK one
// gap-fills at startup what a crash between commit and emit lost. The pair is
// the whole design, so most arms here run both in sequence and assert on what
// the log holds afterwards.
//
// THE SERVICE-LEVEL ARMS RUN AGAINST THE REAL `EventLogService`, not a recording
// stub. `schema.migrated` is a sentinel-bound row and the emitter's own gap
// query reads it back OUT of `session_events` by parsing the stored payload — so
// a stub that merely collected envelopes would leave the reconcile path
// untested, and its most important property (that a recorded batch is not
// re-recorded) unassertable.
//
// WHAT IS DELIBERATELY NOT HERE: a total-failure-emits-a-row arm.
// `MigrationBatchResult` carries only COMMITTED migrations, so a batch that
// applied nothing has no honest `migrationId` and no honest checksum; the
// partial case — some migrations committed, then a throw — is the one that
// produces a `success: false` row, and it is covered below.
//
// Spec coverage: `Spec-006 §Event Maintenance (event_maintenance)`
// (`schema.migrated`, and why these rows are never compacted or shredded),
// `Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring` (the sentinel
// this event binds to). Refs: Plan-006 T3.4, T3.5.

import { blake3 } from "@noble/hashes/blake3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  NodeIdSchema,
  SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN,
  type NodeId,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import { EventLogService } from "../event-log-service.js";
import {
  RECONCILE_OPERATION_ID_PREFIX,
  SCHEMA_MIGRATION_UNLABELLED_DESCRIPTION,
  SchemaMigrationEmitter,
  buildMigrationBatchDescription,
  computeMigrationBatchChecksum,
  type MigrationBatchResult,
  type MigrationSource,
  type SchemaMigrationReconcileOutcome,
} from "../schema-migration-emitter.js";
import { __resetSessionAppendLocksForTest } from "../session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../signer.js";
import type { DaemonSigningKeySource } from "../signing-key-source.js";

const NODE: NodeId = NodeIdSchema.parse("node-migrate-0001");
const APPLIED_BY = "runtime-daemon@test";
const EMIT_INSTANT = "2026-08-04T12:00:00.000Z";

const DAEMON_PRIVATE_KEY = new Uint8Array(32).fill(5) as Ed25519PrivateKey;
const DAEMON_PUBLIC_KEY = ed25519.getPublicKey(DAEMON_PRIVATE_KEY) as Ed25519PublicKey;

const keySource: DaemonSigningKeySource = {
  create: () => Promise.resolve({ publicKey: DAEMON_PUBLIC_KEY }),
  read: () => Promise.resolve(DAEMON_PRIVATE_KEY),
};

/**
 * A migration registry keyed the way the emitter expects.
 *
 * The versions here (101, 102, 103) sit deliberately ABOVE the real migration
 * set's range, so nothing in an arm can be confused with a version the
 * production runner applied to the fixture database.
 */
function source(version: number, overrides?: Partial<MigrationSource>): MigrationSource {
  return {
    version,
    migrationId: `${String(version).padStart(4, "0")}-fixture-migration`,
    sql: `-- fixture SQL for version ${String(version)}\nSELECT ${String(version)};`,
    ...overrides,
  };
}

const REGISTRY: ReadonlyMap<number, MigrationSource> = new Map([
  [101, source(101)],
  [102, source(102)],
  [103, source(103)],
]);

let database: DatabaseType;
let eventIdCounter: number;
let operationIdCounter: number;

beforeEach(() => {
  database = openDatabase(":memory:");
  eventIdCounter = 0;
  operationIdCounter = 0;
  __resetSessionAppendLocksForTest();
});

afterEach(() => {
  __resetSessionAppendLocksForTest();
  database.close();
});

function buildEmitter(): SchemaMigrationEmitter {
  return new SchemaMigrationEmitter({
    db: database,
    nodeId: NODE,
    // The REAL append path — see the file header for why a stub would leave the
    // reconcile leg untested.
    eventLog: new EventLogService({ db: database, signingKeySource: keySource }),
    appliedBy: APPLIED_BY,
    migrationSources: REGISTRY,
    now: () => new Date(EMIT_INSTANT),
    eventIdFactory: () => `migration-event-${String(++eventIdCounter)}`,
    operationIdFactory: () => `operation-${String(++operationIdCounter)}`,
  });
}

/** Record an applied version in the durable table the emitter reads. */
function recordAppliedVersion(version: number, description: string | null): void {
  database
    .prepare("INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)")
    .run(version, "2026-08-01T00:00:00.000Z", description);
}

function batch(overrides?: Partial<MigrationBatchResult>): MigrationBatchResult {
  return {
    fromVersion: 100,
    toVersion: 102,
    applied: [source(101), source(102)],
    executionMs: 42,
    success: true,
    ...overrides,
  };
}

interface EmittedRow {
  readonly id: string;
  readonly sequence: number;
  readonly session_id: string;
  readonly category: string;
  readonly type: string;
  readonly payload: string;
}

function emittedRows(): ReadonlyArray<EmittedRow> {
  return database
    .prepare("SELECT * FROM session_events WHERE type = ? ORDER BY sequence ASC")
    .all("schema.migrated") as ReadonlyArray<EmittedRow>;
}

/** The `schema.migrated` payload members these arms read back. */
interface SchemaMigratedPayloadShape {
  readonly nodeId?: string;
  readonly operationId?: string;
  readonly occurredAt?: string;
  readonly fromVersion?: string;
  readonly toVersion?: string;
  readonly migrationId?: string;
  readonly description?: string;
  readonly checksum?: string;
  readonly appliedBy?: string;
  readonly executionMs?: number;
  readonly success?: boolean;
}

function emittedPayloads(): ReadonlyArray<SchemaMigratedPayloadShape> {
  return emittedRows().map((row) => JSON.parse(row.payload) as SchemaMigratedPayloadShape);
}

// ----------------------------------------------------------------------------
// The primary path — `emitBatchCompletion`
// ----------------------------------------------------------------------------

describe("SchemaMigrationEmitter — emitBatchCompletion", () => {
  it("emits ONE sentinel-bound row for a multi-migration batch", async () => {
    recordAppliedVersion(101, "adds the widget table");
    recordAppliedVersion(102, "adds the widget index");

    await buildEmitter().emitBatchCompletion(batch());

    const rows = emittedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_id).toBe(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    expect(rows[0]?.category).toBe("event_maintenance");

    const [payload] = emittedPayloads();
    expect(payload?.fromVersion).toBe("100");
    expect(payload?.toVersion).toBe("102");
    // The batch's TERMINAL migration names the row; `description` carries the
    // roster, because a joined list of a full-history batch would blow the
    // 256-character field cap.
    expect(payload?.migrationId).toBe("0102-fixture-migration");
    expect(payload?.description).toBe("101: adds the widget table; 102: adds the widget index");
    expect(payload?.appliedBy).toBe(APPLIED_BY);
    expect(payload?.executionMs).toBe(42);
    expect(payload?.success).toBe(true);
    expect(payload?.checksum).toBe(computeMigrationBatchChecksum([source(101), source(102)]));
  });

  it("emits a success:false row over what COMMITTED when a batch partly failed", async () => {
    // The plan's "rollback path" for schema migrations: some migrations
    // committed, then a throw. The row records the committed prefix and reports
    // the batch as unsuccessful — a partial migration that left no audit record
    // is the outcome this emitter exists to prevent.
    recordAppliedVersion(101, "adds the widget table");

    await buildEmitter().emitBatchCompletion(
      batch({ toVersion: 101, applied: [source(101)], success: false }),
    );

    const [payload] = emittedPayloads();
    expect(payload?.success).toBe(false);
    expect(payload?.toVersion).toBe("101");
    expect(payload?.description).toBe("101: adds the widget table");
  });

  it("emits NOTHING for a successful batch that applied nothing", async () => {
    // A row per daemon start would be unbounded permanent growth:
    // `event_maintenance` rows are never compacted and never shredded.
    await buildEmitter().emitBatchCompletion(
      batch({ fromVersion: 102, toVersion: 102, applied: [] }),
    );

    expect(emittedRows()).toHaveLength(0);
  });

  it("refuses a batch whose endpoints disagree with the migrations it lists", async () => {
    recordAppliedVersion(101, "adds the widget table");
    const emitter = buildEmitter();

    await expect(
      emitter.emitBatchCompletion(batch({ toVersion: 103, applied: [source(101)] })),
    ).rejects.toThrow(/highest applied migration is 101/);
    await expect(
      emitter.emitBatchCompletion(
        batch({ fromVersion: 101, toVersion: 101, applied: [source(101)] }),
      ),
    ).rejects.toThrow(/which it should already have/);
    await expect(
      emitter.emitBatchCompletion(
        batch({ fromVersion: 103, toVersion: 101, applied: [source(101)] }),
      ),
    ).rejects.toThrow(/runs backwards/);
    expect(emittedRows()).toHaveLength(0);
  });

  it("refuses a batch listing a version twice", async () => {
    recordAppliedVersion(101, "adds the widget table");

    await expect(
      buildEmitter().emitBatchCompletion(
        batch({ toVersion: 101, applied: [source(101), source(101)] }),
      ),
    ).rejects.toThrow(/lists version 101 twice/);
  });

  it("refuses a batch whose SQL disagrees with the registered migration", async () => {
    // The checksum commits to migration BYTES. A batch reporting different bytes
    // than the registry holds would sign an audit record naming one migration
    // and committing to another's content.
    recordAppliedVersion(101, "adds the widget table");

    await expect(
      buildEmitter().emitBatchCompletion(
        batch({
          toVersion: 101,
          applied: [source(101, { sql: "-- something else entirely" })],
        }),
      ),
    ).rejects.toThrow(/the registry and the executed migration must be the same bytes/);
  });

  it("refuses a batch reporting a non-duration executionMs", async () => {
    recordAppliedVersion(101, "adds the widget table");

    await expect(
      buildEmitter().emitBatchCompletion(
        batch({ toVersion: 101, applied: [source(101)], executionMs: -1 }),
      ),
    ).rejects.toThrow(/non-duration executionMs/);
  });

  it("refuses when schema_version has no row for a version reported as applied", async () => {
    // The durable table contradicts the claim. Integrity-bearing, so it
    // propagates rather than substituting a placeholder label.
    await expect(
      buildEmitter().emitBatchCompletion(batch({ toVersion: 101, applied: [source(101)] })),
    ).rejects.toThrow(/schema_version has no row for version 101/);
  });

  it("substitutes a label for a blank or NUL-bearing stored description", async () => {
    recordAppliedVersion(101, "   ");
    recordAppliedVersion(102, "widget\u0000index");

    await buildEmitter().emitBatchCompletion(batch());

    const [payload] = emittedPayloads();
    expect(payload?.description).toBe(
      `101: ${SCHEMA_MIGRATION_UNLABELLED_DESCRIPTION}; 102: ${SCHEMA_MIGRATION_UNLABELLED_DESCRIPTION}`,
    );
  });
});

// ----------------------------------------------------------------------------
// The fallback path — `reconcileOnStartup`
// ----------------------------------------------------------------------------

describe("SchemaMigrationEmitter — reconcileOnStartup", () => {
  it("reports no_migrations_applied when BOTH sides are empty", async () => {
    // Both, not just `schema_version`: judging the durable table alone would
    // report a stripped schema beside a signed audit row as a fresh database.
    database.exec("DELETE FROM schema_version");

    const outcome = await buildEmitter().reconcileOnStartup();

    expect(outcome).toEqual({ emitted: false, reason: "no_migrations_applied" });
    expect(emittedRows()).toHaveLength(0);
  });

  it("gap-fills every applied version the log never recorded", async () => {
    database.exec("DELETE FROM schema_version");
    recordAppliedVersion(101, "adds the widget table");
    recordAppliedVersion(102, "adds the widget index");

    const outcome: SchemaMigrationReconcileOutcome = await buildEmitter().reconcileOnStartup();

    expect(outcome).toEqual({
      emitted: true,
      fromVersion: 0,
      toVersion: 102,
      versions: [101, 102],
    });
    const [payload] = emittedPayloads();
    expect(payload?.fromVersion).toBe("0");
    expect(payload?.toVersion).toBe("102");
    expect(String(payload?.operationId)).toMatch(new RegExp(`^${RECONCILE_OPERATION_ID_PREFIX}`));
    expect(payload?.description).toBe(
      "[reconciled] 101: adds the widget table; 102: adds the widget index",
    );
    // UNKNOWN, not instantaneous: the batch that applied these left no duration
    // behind, and 0 is the only non-negative integer that invents nothing.
    expect(payload?.executionMs).toBe(0);
    expect(payload?.success).toBe(true);
  });

  it("does NOT re-emit for a batch the primary path already recorded", async () => {
    // THE NO-DOUBLE-EMIT PROPERTY, and the reason the service-level arms run
    // against a real append path: the gap query reads the recorded `toVersion`
    // back out of the stored payload.
    database.exec("DELETE FROM schema_version");
    recordAppliedVersion(101, "adds the widget table");
    recordAppliedVersion(102, "adds the widget index");
    await buildEmitter().emitBatchCompletion(batch());

    const outcome = await buildEmitter().reconcileOnStartup();

    expect(outcome).toEqual({ emitted: false, reason: "already_recorded" });
    expect(emittedRows()).toHaveLength(1);
  });

  it("fills only the versions BEYOND the newest recorded one", async () => {
    database.exec("DELETE FROM schema_version");
    recordAppliedVersion(101, "adds the widget table");
    recordAppliedVersion(102, "adds the widget index");
    await buildEmitter().emitBatchCompletion(batch());
    recordAppliedVersion(103, "adds the widget trigger");

    const outcome = await buildEmitter().reconcileOnStartup();

    expect(outcome).toEqual({ emitted: true, fromVersion: 102, toVersion: 103, versions: [103] });
    expect(emittedRows()).toHaveLength(2);
  });

  it("reports durable_state_behind_log when schema_version was emptied", async () => {
    database.exec("DELETE FROM schema_version");
    recordAppliedVersion(101, "adds the widget table");
    recordAppliedVersion(102, "adds the widget index");
    await buildEmitter().emitBatchCompletion(batch());
    database.exec("DELETE FROM schema_version");

    const outcome = await buildEmitter().reconcileOnStartup();

    expect(outcome).toEqual({
      emitted: false,
      reason: "durable_state_behind_log",
      recordedVersion: 102,
      durableVersion: undefined,
    });
    // REPORTED, NOT THROWN: a daemon that refuses to start cannot serve the log
    // that recorded the divergence, and the emitter has no repair to offer.
    expect(emittedRows()).toHaveLength(1);
  });

  it("reports durable_state_behind_log when the durable max is behind the log", async () => {
    database.exec("DELETE FROM schema_version");
    recordAppliedVersion(101, "adds the widget table");
    recordAppliedVersion(102, "adds the widget index");
    await buildEmitter().emitBatchCompletion(batch());
    database.prepare("DELETE FROM schema_version WHERE version = ?").run(102);

    const outcome = await buildEmitter().reconcileOnStartup();

    expect(outcome).toEqual({
      emitted: false,
      reason: "durable_state_behind_log",
      recordedVersion: 102,
      durableVersion: 101,
    });
  });

  it("refuses a recorded toVersion past the safe-integer bound rather than reading it as newest", async () => {
    // `/^\d+$/` alone admits digit strings past `Number.MAX_SAFE_INTEGER`, which
    // coerce to a float no migration can ever exceed — silently disabling
    // reconcile for as long as that row is the newest.
    database.exec("DELETE FROM schema_version");
    recordAppliedVersion(101, "adds the widget table");
    await buildEmitter().emitBatchCompletion(batch({ toVersion: 101, applied: [source(101)] }));
    const [row] = emittedRows();
    expect(row).toBeDefined();
    if (row === undefined) return;
    const tampered = { ...(JSON.parse(row.payload) as Record<string, unknown>) };
    tampered["toVersion"] = "99999999999999999999";
    database
      .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
      .run(JSON.stringify(tampered), row.id);

    await expect(buildEmitter().reconcileOnStartup()).rejects.toThrow(/recorded toVersion/);
  });

  it("refuses a stored payload that is not an object", async () => {
    database.exec("DELETE FROM schema_version");
    recordAppliedVersion(101, "adds the widget table");
    await buildEmitter().emitBatchCompletion(batch({ toVersion: 101, applied: [source(101)] }));
    const [row] = emittedRows();
    expect(row).toBeDefined();
    if (row === undefined) return;
    database
      .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
      .run(JSON.stringify("not an object"), row.id);

    await expect(buildEmitter().reconcileOnStartup()).rejects.toThrow(/is not an object/);
  });

  it("refuses to gap-fill a version this daemon has no registered migration for", async () => {
    // On the reconcile path the registry is the ONLY source of migration bytes,
    // so an unregistered version cannot be committed to at all.
    database.exec("DELETE FROM schema_version");
    recordAppliedVersion(777, "a migration from a future daemon");

    await expect(buildEmitter().reconcileOnStartup()).rejects.toThrow(
      /no registered migration for schema version 777/,
    );
  });

  it("refuses a MIS-KEYED registry entry rather than signing the wrong migration", async () => {
    database.exec("DELETE FROM schema_version");
    recordAppliedVersion(101, "adds the widget table");
    const misKeyed = new SchemaMigrationEmitter({
      db: database,
      nodeId: NODE,
      eventLog: new EventLogService({ db: database, signingKeySource: keySource }),
      appliedBy: APPLIED_BY,
      // The KEY and the entry's own `version` are two independent claims about
      // the same migration, and nothing downstream would notice them disagree.
      migrationSources: new Map([[101, source(102)]]),
      now: () => new Date(EMIT_INSTANT),
    });

    await expect(misKeyed.reconcileOnStartup()).rejects.toThrow(/mis-keyed registry entry/);
  });
});

// ----------------------------------------------------------------------------
// `computeMigrationBatchChecksum` — the ordering guarantee and its two refusals
// ----------------------------------------------------------------------------

describe("computeMigrationBatchChecksum", () => {
  it("digests SQL bytes in ASCENDING version order regardless of input order", () => {
    const ascending = computeMigrationBatchChecksum([source(101), source(102), source(103)]);
    const shuffled = computeMigrationBatchChecksum([source(103), source(101), source(102)]);

    expect(shuffled).toBe(ascending);
    // Against a hand-derived expectation rather than a recorded golden: the
    // value IS the concatenation, and an implementation that concatenated in
    // input order would still agree with a golden captured from itself.
    const encoder = new TextEncoder();
    const parts = [source(101).sql, source(102).sql, source(103).sql].map((sql) =>
      encoder.encode(sql),
    );
    const concatenated = new Uint8Array(parts.reduce((width, part) => width + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      concatenated.set(part, offset);
      offset += part.length;
    }
    expect(ascending).toBe(Buffer.from(blake3(concatenated)).toString("base64"));
  });

  it("distinguishes two batches whose SQL differs only in order", () => {
    // The reason ordering is normative at all: a digest over an unordered set
    // would report two genuinely different batches as the same bytes.
    const forward = computeMigrationBatchChecksum([source(101), source(102)]);
    const swappedBodies = computeMigrationBatchChecksum([
      source(101, { sql: source(102).sql }),
      source(102, { sql: source(101).sql }),
    ]);

    expect(swappedBodies).not.toBe(forward);
  });

  it("refuses an empty batch", () => {
    expect(() => computeMigrationBatchChecksum([])).toThrow(/at least one migration source/);
  });

  it("refuses a duplicate version", () => {
    expect(() => computeMigrationBatchChecksum([source(101), source(101)])).toThrow(
      /refuses duplicate migration version 101/,
    );
  });
});

// ----------------------------------------------------------------------------
// `buildMigrationBatchDescription` — the ceiling arithmetic
// ----------------------------------------------------------------------------

describe("buildMigrationBatchDescription", () => {
  it("joins entries verbatim when they fit", () => {
    expect(buildMigrationBatchDescription(["101: a", "102: b"])).toBe("101: a; 102: b");
  });

  it("labels an empty entry list rather than emitting an empty description", () => {
    expect(buildMigrationBatchDescription([])).toBe(SCHEMA_MIGRATION_UNLABELLED_DESCRIPTION);
    expect(buildMigrationBatchDescription([], "[reconciled] ")).toBe(
      `[reconciled] ${SCHEMA_MIGRATION_UNLABELLED_DESCRIPTION}`,
    );
  });

  it("drops WHOLE entries past the ceiling and says how many", () => {
    // A description ending mid-word reads like corruption where a count reads
    // like a bound.
    const entries = Array.from(
      { length: 40 },
      (_unused, index) => `1${String(index)}: ${"x".repeat(30)}`,
    );

    const built = buildMigrationBatchDescription(entries);

    expect(built.length).toBeLessThanOrEqual(SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN);
    expect(built).toMatch(/ \[\+\d+ more\]$/);
    expect(built).not.toMatch(/x{30}x/);
  });

  it("marks a SINGLE over-long entry as truncated even though nothing was dropped", () => {
    const built = buildMigrationBatchDescription(["101: " + "y".repeat(1000)]);

    expect(built.length).toBeLessThanOrEqual(SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN);
    // A bounded string that does not say it was bounded is exactly the failure
    // the whole-entry rule exists to avoid.
    expect(built.endsWith(" [truncated]")).toBe(true);
  });

  it("never cuts between the halves of a surrogate pair", () => {
    // A lone surrogate has no Unicode scalar value and encodes to U+FFFD, which
    // would put a replacement character into a signed, un-shreddable row.
    const built = buildMigrationBatchDescription(["101: " + "\u{1F600}".repeat(400)]);

    expect(built.length).toBeLessThanOrEqual(SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN);
    for (let index = 0; index < built.length; index += 1) {
      const code = built.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = built.charCodeAt(index + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
    }
    expect(built).not.toContain("�");
  });

  it("charges the prefix against the same budget", () => {
    const entries = Array.from(
      { length: 40 },
      (_unused, index) => `1${String(index)}: ${"x".repeat(30)}`,
    );

    const built = buildMigrationBatchDescription(entries, "[reconciled] ");

    expect(built.startsWith("[reconciled] ")).toBe(true);
    expect(built.length).toBeLessThanOrEqual(SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN);
  });
});

// ----------------------------------------------------------------------------
// The emitted row is a first-class audit row
// ----------------------------------------------------------------------------

describe("SchemaMigrationEmitter — the emitted row joins the sentinel chain", () => {
  it("chains and signs like any other append", async () => {
    recordAppliedVersion(101, "adds the widget table");
    recordAppliedVersion(102, "adds the widget index");
    await buildEmitter().emitBatchCompletion(batch());
    recordAppliedVersion(103, "adds the widget trigger");
    await buildEmitter().emitBatchCompletion(
      batch({ fromVersion: 102, toVersion: 103, applied: [source(103)] }),
    );

    const rows = database
      .prepare(
        "SELECT sequence, prev_hash, row_hash FROM session_events WHERE session_id = ? ORDER BY sequence",
      )
      .all(DAEMON_SCOPE_SENTINEL_SESSION_ID) as ReadonlyArray<{
      sequence: number;
      prev_hash: Uint8Array;
      row_hash: Uint8Array;
    }>;

    expect(rows.map((row) => row.sequence)).toEqual([0, 1]);
    // The second row links to the first — the sentinel partition is a real hash
    // chain, not a bag of daemon-scope rows.
    expect(Buffer.from(rows[1]?.prev_hash ?? new Uint8Array())).toEqual(
      Buffer.from(rows[0]?.row_hash ?? new Uint8Array([1])),
    );
  });
});
