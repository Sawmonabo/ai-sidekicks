// Contract coverage for `Compactor` — audit-log compaction behind anchors
// (Plan-006 T3.2).
//
// WHAT THE FIXTURES DO, and why they seed raw rows instead of appending through
// `EventLogService`. Compaction is a read-modify-write over ALREADY-STORED rows,
// and every arm here is about which rows are selected and what replaces their
// payloads. Seeding directly is what lets an arm place a row at an exact
// sequence with an exact `occurred_at` and an exact payload size — the three
// inputs the three triggers read. The integrity columns are fixture constants
// rather than real signatures, which is honest for this file: nothing here
// verifies a chain, and the one commitment that IS verified (the `stub_signature`
// the compactor mints over the projection) is checked against a real Ed25519
// public key.
//
// TWO FIXTURE LANDMINES worth knowing before adding an arm:
//
//   * The `category` column must hold a REAL member of the canonical
//     `EventCategory` enum. `#projectAuditStub` runs `EventCategorySchema.parse`
//     on the stored value, so an invented category makes every compaction arm
//     report `rowsStubbed: 0` behind a Zod refusal that looks like a threshold
//     that did not fire.
//   * `tick()` consumes `operationIdFactory()` BEFORE its re-entry check, so a
//     counting factory sees ids burn on re-entrant ticks. Never assert
//     factory-call-count equals passes-run.
//
// WHERE THE REAL-ANCHOR ARMS LIVE. The `MerkleAnchorService` integration block
// sits in THIS file rather than in `merkle-anchor-service.test.ts` because the
// property it pins belongs to the pairing: the compactor computes its span from
// LIVE COMPACTABLE rows while `anchorRange` reads a leaf per STORED row, and the
// density argument that reconciles them is static. A future row-removing path
// would invalidate it silently, so the arms live beside the code whose span
// computation they constrain.
//
// Spec coverage: `Spec-006 §Event Compaction Policy` (the three triggers and
// their candidate sets), `Spec-006 §Post-Compaction Integrity`
// (anchor-before-compaction), `Spec-006 §Run Lifecycle (run_lifecycle)` (the
// terminal keys a stub must preserve), `Spec-006 §Event Maintenance
// (event_maintenance)` (`event.compacted`). Refs: Plan-006 T3.2, T3.5,
// I-006-3-01, I-006-3-03.

import { ed25519 } from "@noble/curves/ed25519.js";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  NodeIdSchema,
  SessionIdSchema,
  type AnchorPayload,
  type NodeId,
  type RunId,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import {
  AUDIT_STUB_RETENTION_CLASS,
  Compactor,
  type CompactionAnchorSource,
  type CompactionEventLog,
  type CompactionPassResult,
  type RollbackAttribution,
  type RollbackAttributionSource,
} from "../compactor.js";
import { MerkleAnchorService } from "../merkle-anchor-service.js";
import { __resetSessionAppendLocksForTest, withSessionAppendLock } from "../session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../signer.js";
import type { DaemonSigningKeySource } from "../signing-key-source.js";

const SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555555");
const SECOND_SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555556");
const NODE: NodeId = NodeIdSchema.parse("node-compactor-01");
const PASS_INSTANT = "2026-08-04T12:00:00.000Z";

const DAEMON_PRIVATE_KEY = new Uint8Array(32).fill(7) as Ed25519PrivateKey;
const DAEMON_PUBLIC_KEY = ed25519.getPublicKey(DAEMON_PRIVATE_KEY) as Ed25519PublicKey;

// Answers for EVERY session id, the daemon-scope sentinel included — the
// `event.compacted` emission is sentinel-bound, so a map keyed only on the
// fixture's session would make the emission fail mid-pass and surface as a
// refusal rather than as a wiring error.
const keySource: DaemonSigningKeySource = {
  create: () => Promise.resolve({ publicKey: DAEMON_PUBLIC_KEY }),
  read: () => Promise.resolve(DAEMON_PRIVATE_KEY),
};

/** An anchor source that records its calls and can be told to misbehave. */
class RecordingAnchorSource implements CompactionAnchorSource {
  readonly calls: Array<{ readonly fromSeq: number; readonly toSeq: number }> = [];
  fail = false;
  /** Return an anchor that starts one sequence ABOVE the requested range. */
  narrow = false;

  anchorRange(request: {
    sessionId: SessionId;
    fromSeq: number;
    toSeq: number;
  }): Promise<AnchorPayload> {
    this.calls.push({ fromSeq: request.fromSeq, toSeq: request.toSeq });
    if (this.fail) return Promise.reject(new Error("force-fire failed"));
    // Base64 strings, which is what `AnchorPayload` declares — no cast, so the
    // literal is checked against the contract rather than asserted past it.
    const payload: AnchorPayload = {
      sessionId: request.sessionId,
      nodeId: NODE,
      startSequence: this.narrow ? request.fromSeq + 1 : request.fromSeq,
      endSequence: request.toSeq,
      merkleRoot: Buffer.alloc(32).toString("base64"),
      rootSignature: Buffer.alloc(64).toString("base64"),
      anchoredAt: PASS_INSTANT,
    };
    return Promise.resolve(payload);
  }
}

/** The `event.compacted` payload members these arms read back. */
interface EventCompactedPayloadShape {
  readonly sessionId?: string;
  readonly compactionReason?: string;
  readonly tombstoneCount?: number;
  readonly eventsBefore?: number;
  readonly eventsAfter?: number;
  readonly fromSeq?: number;
  readonly toSeq?: number;
}

interface RecordedEnvelope {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly category: string;
  readonly type: string;
  readonly payload: EventCompactedPayloadShape;
}

class RecordingEventLog implements CompactionEventLog {
  readonly appended: RecordedEnvelope[] = [];

  append(envelope: {
    id: string;
    sessionId: SessionId;
    category: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<{ id: string; sequence: number; rowHash: Uint8Array }> {
    this.appended.push({ ...envelope, payload: envelope.payload as EventCompactedPayloadShape });
    return Promise.resolve({ id: envelope.id, sequence: 0, rowHash: new Uint8Array(32) });
  }
}

/** One macrotask — later than every pending microtask. */
function nextMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

let database: DatabaseType;
let nextSequence: number;

beforeEach(() => {
  database = openDatabase(":memory:");
  nextSequence = 0;
  __resetSessionAppendLocksForTest();
});

afterEach(() => {
  __resetSessionAppendLocksForTest();
  database.close();
});

interface SeedOptions {
  readonly category: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt?: string;
  readonly actor?: string | null;
  readonly sessionId?: unknown;
  readonly sequence?: number;
}

function seed(options: SeedOptions): { readonly id: string; readonly sequence: number } {
  const sequence = options.sequence ?? nextSequence++;
  const id = `evt-${String(options.sessionId ?? SESSION).slice(-4)}-${String(sequence)}`;
  database
    .prepare(
      `INSERT INTO session_events
         (id, session_id, sequence, occurred_at, monotonic_ns, category, type, actor, payload,
          pii_payload, correlation_id, causation_id, version, prev_hash, row_hash,
          daemon_signature, pii_participant_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      options.sessionId ?? SESSION,
      sequence,
      options.occurredAt ?? "2026-08-01T00:00:00.000Z",
      BigInt(sequence + 1),
      options.category,
      options.type,
      options.actor ?? null,
      JSON.stringify(options.payload),
      Buffer.from([1, 2, 3]),
      "corr-1",
      "caus-1",
      "1.0",
      Buffer.alloc(32),
      Buffer.alloc(32, sequence + 1),
      Buffer.alloc(64, 9),
      "participant-abc",
    );
  return { id, sequence };
}

/** The stored columns these arms read back. */
interface StoredEventRow {
  readonly id: string;
  readonly payload: string;
  readonly retention_class: string | null;
  readonly stub_signature: Uint8Array | null;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly pii_payload: Uint8Array | null;
  readonly pii_participant_id: string | null;
  readonly prev_hash: Uint8Array;
  readonly row_hash: Uint8Array;
  readonly daemon_signature: Uint8Array;
  readonly monotonic_ns: number;
  readonly version: string;
}

/**
 * The audit-stub projection as STORED. Every member is optional because the
 * whole question these arms ask is which keys a projection kept and which it
 * dropped — a required member would make "was it preserved?" untypeable.
 */
interface StoredStubProjection {
  readonly id?: string;
  readonly sessionId?: string;
  readonly sequence?: number;
  readonly occurredAt?: string;
  readonly category?: string;
  readonly type?: string;
  readonly actor?: string | null;
  readonly retentionClass?: string;
  readonly compactedAt?: string;
  readonly summary?: string;
  readonly runId?: string;
  readonly runVersion?: number;
  readonly targetPosition?: number;
  readonly sourceEpoch?: number;
  readonly sourcePosition?: number;
  readonly originPosition?: number;
  readonly extra?: unknown;
}

function readRow(id: string): StoredEventRow {
  return database.prepare("SELECT * FROM session_events WHERE id = ?").get(id) as StoredEventRow;
}

function stubProjection(id: string): StoredStubProjection {
  return JSON.parse(readRow(id).payload) as StoredStubProjection;
}

function anchorRows(): ReadonlyArray<{ start_sequence: number; end_sequence: number }> {
  return database
    .prepare(
      "SELECT start_sequence, end_sequence FROM pending_anchor_uploads ORDER BY start_sequence",
    )
    .all() as ReadonlyArray<{ start_sequence: number; end_sequence: number }>;
}

interface BuildOptions {
  readonly anchorSource?: CompactionAnchorSource;
  readonly eventLog?: CompactionEventLog;
  readonly rollbackAttributionSource?: RollbackAttributionSource;
  readonly eventCountThreshold?: number;
  readonly ageThresholdDays?: number;
  readonly storageThresholdBytes?: number;
}

function buildCompactor(options?: BuildOptions): Compactor {
  return new Compactor({
    db: database,
    nodeId: NODE,
    signingKeySource: keySource,
    eventLog: options?.eventLog ?? new RecordingEventLog(),
    anchorSource: options?.anchorSource ?? new RecordingAnchorSource(),
    now: () => new Date(PASS_INSTANT),
    ...(options?.rollbackAttributionSource !== undefined
      ? { rollbackAttributionSource: options.rollbackAttributionSource }
      : {}),
    ...(options?.eventCountThreshold !== undefined
      ? { eventCountThreshold: options.eventCountThreshold }
      : {}),
    ...(options?.ageThresholdDays !== undefined
      ? { ageThresholdDays: options.ageThresholdDays }
      : {}),
    ...(options?.storageThresholdBytes !== undefined
      ? { storageThresholdBytes: options.storageThresholdBytes }
      : {}),
  });
}

// ----------------------------------------------------------------------------
// The three triggers — `Spec-006 §Event Compaction Policy`
// ----------------------------------------------------------------------------

describe("Compactor — compaction triggers", () => {
  it("fires on the count threshold, spares never-compacted categories, and mints a verifiable stub", async () => {
    const first = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "hi" },
    });
    const audit = seed({
      category: "audit_integrity",
      type: "audit_integrity_verified",
      payload: { ok: true },
    });
    const maintenance = seed({
      category: "event_maintenance",
      type: "schema.migrated",
      payload: { ok: true },
    });
    const newest = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "yo" },
    });

    const anchorSource = new RecordingAnchorSource();
    const eventLog = new RecordingEventLog();
    const result: CompactionPassResult = await buildCompactor({
      anchorSource,
      eventLog,
      eventCountThreshold: 1,
    }).tick();

    expect(result.rowsStubbed).toBe(1);
    expect(result.outcomes[0]?.reason).toBe("count_threshold");
    // Anchored over the candidate span BEFORE any row was mutated.
    expect(anchorSource.calls).toEqual([{ fromSeq: first.sequence, toSeq: first.sequence }]);

    const stubbed = readRow(first.id);
    expect(stubbed.retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(stubbed.correlation_id).toBeNull();
    expect(stubbed.causation_id).toBeNull();
    expect(stubbed.pii_payload).toBeNull();
    expect(stubbed.pii_participant_id).toBeNull();

    // The chain commitments are FROZEN — compaction rewrites the payload, and a
    // stub whose `row_hash` moved would break every anchor that already
    // committed to it.
    expect(stubbed.prev_hash).toEqual(Buffer.alloc(32));
    expect(stubbed.row_hash).toEqual(Buffer.alloc(32, first.sequence + 1));
    expect(stubbed.daemon_signature).toEqual(Buffer.alloc(64, 9));
    expect(stubbed.monotonic_ns).toBe(first.sequence + 1);
    expect(stubbed.version).toBe("1.0");

    // `stub_signature` verifies over the EXACT stored bytes — rule 4's per-row
    // commitment. Re-serializing the parsed projection would be a different
    // check with a different failure mode.
    expect(stubbed.stub_signature).not.toBeNull();
    const storedBytes = new TextEncoder().encode(stubbed.payload);
    expect(
      ed25519.verify(
        new Uint8Array(stubbed.stub_signature ?? new Uint8Array()),
        storedBytes,
        DAEMON_PUBLIC_KEY,
      ),
    ).toBe(true);

    const projection = stubProjection(first.id);
    expect(projection.id).toBe(first.id);
    expect(projection.sessionId).toBe(SESSION);
    expect(projection.sequence).toBe(first.sequence);
    expect(projection.occurredAt).toBe("2026-08-01T00:00:00.000Z");
    expect(projection.category).toBe("session_lifecycle");
    expect(projection.type).toBe("session.updated");
    expect(projection.actor).toBeNull();
    expect(projection.retentionClass).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(projection.compactedAt).toBe(PASS_INSTANT);
    expect(typeof projection.summary).toBe("string");

    // The two never-compacted categories and the newest live row are untouched.
    expect(readRow(audit.id).retention_class).toBeNull();
    expect(readRow(maintenance.id).retention_class).toBeNull();
    expect(readRow(newest.id).retention_class).toBeNull();

    // ONE `event.compacted`, bound to the daemon-scope sentinel, naming the real
    // session in its payload.
    expect(eventLog.appended).toHaveLength(1);
    expect(eventLog.appended[0]?.sessionId).toBe(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    expect(eventLog.appended[0]?.type).toBe("event.compacted");
    const emitted = eventLog.appended[0]?.payload ?? {};
    expect(emitted.sessionId).toBe(SESSION);
    expect(emitted.compactionReason).toBe("count_threshold");
    expect(emitted.tombstoneCount).toBe(1);
    expect(emitted.eventsBefore).toBe(2);
    expect(emitted.eventsAfter).toBe(1);
    expect(emitted.fromSeq).toBe(first.sequence);
    expect(emitted.toSeq).toBe(first.sequence);
  });

  it("fires on the age threshold independently of the count", async () => {
    seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "old" },
      occurredAt: "2020-01-01T00:00:00.000Z",
    });
    seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "new" },
      occurredAt: "2026-08-03T00:00:00.000Z",
    });

    const result = await buildCompactor().tick();

    expect(result.rowsStubbed).toBe(1);
    expect(result.outcomes[0]?.reason).toBe("age_threshold");
  });

  it("stubs only the OVERAGE on the storage threshold, sparing the newest row", async () => {
    // The bound is exact, and a hedged `>= 1` would be the wrong assertion to
    // make here: the trigger reclaims `liveBytes - threshold`, so an arithmetic
    // slip that dropped the subtraction reaches the whole partition and destroys
    // the newest row's payload irreversibly. One row over, one row under.
    seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "x".repeat(400) },
    });
    const survivor = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "y".repeat(400) },
    });
    const survivorBefore = readRow(survivor.id);
    const anchorSource = new RecordingAnchorSource();

    const result = await buildCompactor({ storageThresholdBytes: 500, anchorSource }).tick();

    expect(result.rowsStubbed).toBe(1);
    expect(result.outcomes[0]?.reason).toBe("storage_threshold");

    // The survivor is byte-identical: not merely un-stubbed, but untouched.
    const survivorAfter = readRow(survivor.id);
    expect(survivorAfter.retention_class).toBeNull();
    expect(survivorAfter.stub_signature).toBeNull();
    expect(survivorAfter.payload).toBe(survivorBefore.payload);

    // And the anchor span matches the reclaimed range rather than the partition:
    // a widened span would anchor rows the pass never stubbed.
    expect(anchorSource.calls).toEqual([{ fromSeq: 0, toSeq: 0 }]);
  });

  it("reports storage ahead of count when both thresholds fire on the same session", async () => {
    // PRECEDENCE, not exclusivity: both triggers are over their limits here, and
    // the reported reason is the one an operator should act on first.
    seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "x".repeat(400) },
    });
    seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "y".repeat(400) },
    });

    const result = await buildCompactor({
      storageThresholdBytes: 500,
      eventCountThreshold: 1,
    }).tick();

    expect(result.outcomes[0]?.reason).toBe("storage_threshold");
  });

  it("leaves a YOUNG row beneath an aged one byte-identical through an age pass", async () => {
    // The retention floor is per-ROW for the age trigger, deliberately: a prefix
    // cutoff would drag this row into irreversible payload destruction purely
    // because its sequence sits below an older row's.
    const aged = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "aged" },
      occurredAt: "2020-01-01T00:00:00.000Z",
    });
    const youngBeneath = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "young but low-sequence" },
      occurredAt: "2026-08-03T00:00:00.000Z",
    });
    seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "aged too" },
      occurredAt: "2020-01-02T00:00:00.000Z",
    });
    const before = readRow(youngBeneath.id).payload;

    const result = await buildCompactor().tick();

    expect(result.outcomes[0]?.reason).toBe("age_threshold");
    expect(readRow(aged.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(readRow(youngBeneath.id).retention_class).toBeNull();
    expect(readRow(youngBeneath.id).payload).toBe(before);
  });
});

// ----------------------------------------------------------------------------
// Anchor-before-compaction — `Spec-006 §Post-Compaction Integrity`
// ----------------------------------------------------------------------------

describe("Compactor — anchor-before-compaction", () => {
  it("refuses the whole session pass when the force-fire fails, mutating nothing", async () => {
    const row = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "hi" },
    });
    const anchorSource = new RecordingAnchorSource();
    anchorSource.fail = true;

    const result = await buildCompactor({ anchorSource, eventCountThreshold: 0 }).tick();

    expect(result.rowsStubbed).toBe(0);
    expect(result.sessionsRefused).toBe(1);
    expect(readRow(row.id).retention_class).toBeNull();
    expect(readRow(row.id).correlation_id).toBe("corr-1");
  });

  it("refuses when the returned anchor does not cover the whole compaction range", async () => {
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "hi" } });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "ho" } });
    const anchorSource = new RecordingAnchorSource();
    anchorSource.narrow = true;

    const result = await buildCompactor({ anchorSource, eventCountThreshold: 0 }).tick();

    expect(result.sessionsRefused).toBe(1);
    expect(result.outcomes[0]?.refusedReason).toContain("does not cover");
  });
});

// ----------------------------------------------------------------------------
// The compactor against the REAL `MerkleAnchorService`
// ----------------------------------------------------------------------------

function realAnchorService(): MerkleAnchorService {
  return new MerkleAnchorService({
    db: database,
    nodeId: NODE,
    signingKeySource: keySource,
    now: () => new Date(PASS_INSTANT),
  });
}

describe("Compactor — against the real MerkleAnchorService", () => {
  it("anchors a span containing an interleaved never-compacted row", async () => {
    const first = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "a" },
    });
    const audit = seed({
      category: "audit_integrity",
      type: "audit_integrity_verified",
      payload: { ok: true },
    });
    const second = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "b" },
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "keep" } });

    // Live compactable rows = 3 (the audit row is excluded); threshold 1 leaves
    // an excess of 2, so the cutoff is the second compactable sequence and the
    // span [0, 2] CONTAINS the audit row: three leaves for a three-wide span.
    const result = await buildCompactor({
      anchorSource: realAnchorService(),
      eventCountThreshold: 1,
    }).tick();

    expect(result.sessionsRefused).toBe(0);
    expect(result.outcomes[0]?.refusedReason).toBeUndefined();
    expect(result.outcomes[0]?.fromSequence).toBe(0);
    expect(result.outcomes[0]?.toSequence).toBe(second.sequence);
    expect(result.rowsStubbed).toBe(2);
    expect(readRow(first.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(readRow(second.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(readRow(audit.id).retention_class).toBeNull();
    expect(anchorRows()).toEqual([{ start_sequence: 0, end_sequence: second.sequence }]);
  });

  it("anchors a later span whose low end sits above already-stubbed rows", async () => {
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "a" } });
    const second = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "b" },
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "c" } });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "d" } });

    const firstPass = await buildCompactor({
      anchorSource: realAnchorService(),
      eventCountThreshold: 3,
    }).tick();
    expect(firstPass.sessionsRefused).toBe(0);
    expect(firstPass.rowsStubbed).toBe(1);
    expect(anchorRows()).toEqual([{ start_sequence: 0, end_sequence: 0 }]);

    // Live compactable rows are now [1..3]; threshold 2 leaves an excess of 1,
    // so the span [1, 1] starts ABOVE a stubbed row whose frozen `row_hash` is
    // still a readable leaf.
    const secondPass = await buildCompactor({
      anchorSource: realAnchorService(),
      eventCountThreshold: 2,
    }).tick();
    expect(secondPass.sessionsRefused).toBe(0);
    expect(secondPass.outcomes[0]?.fromSequence).toBe(second.sequence);
    expect(secondPass.rowsStubbed).toBe(1);
    expect(readRow(second.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(anchorRows()).toEqual([
      { start_sequence: 0, end_sequence: 0 },
      { start_sequence: 1, end_sequence: 1 },
    ]);
  });

  it("refuses the pass when a row inside the span is missing (density broken on purpose)", async () => {
    // NEGATIVE CONTROL for the two arms above. They pass because the span is
    // dense — sequence allocation is head+1 and compaction rewrites rather than
    // deletes. Break that and the real `anchorRange` must refuse, which is what
    // proves those arms exercise a check that CAN fail.
    const first = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "a" },
    });
    const hole = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "b" },
    });
    const third = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "c" },
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "keep" } });

    database.prepare("DELETE FROM session_events WHERE id = ?").run(hole.id);

    const result = await buildCompactor({
      anchorSource: realAnchorService(),
      eventCountThreshold: 1,
    }).tick();

    expect(result.sessionsRefused).toBe(1);
    expect(result.rowsStubbed).toBe(0);
    expect(result.outcomes[0]?.refusedReason).toContain("expected");
    expect(readRow(first.id).retention_class).toBeNull();
    expect(readRow(third.id).retention_class).toBeNull();
    expect(anchorRows()).toHaveLength(0);
  });

  it("leaves already-stubbed rows byte-identical when a LATER pass fires again", async () => {
    // The second pass has to genuinely FIRE. Re-running at the first pass's own
    // threshold self-extinguishes — the stub drops the live count to the
    // threshold, so the trigger returns before the anchor step and before the
    // candidate scan, and neither the coverage pre-check nor the
    // `retention_class IS NULL` skip-filter is reached at all. An arm built that
    // way credits two mechanisms for a pass that did nothing.
    for (const label of ["a", "b", "c", "d"]) {
      seed({ category: "session_lifecycle", type: "session.updated", payload: { text: label } });
    }
    const anchorService = realAnchorService();

    const first = await buildCompactor({
      anchorSource: anchorService,
      eventCountThreshold: 3,
    }).tick();
    expect(first.rowsStubbed).toBe(1);
    const stubbedByFirstPass = readRow("evt-5555-0");

    const second = await buildCompactor({
      anchorSource: anchorService,
      eventCountThreshold: 1,
    }).tick();
    expect(second.rowsStubbed).toBe(2);

    // The first pass's stub was SKIPPED, not re-stubbed: both the projection and
    // the signature over it are the bytes the first pass minted. Re-stubbing
    // would re-sign a projection built from an already-projected payload.
    const afterSecondPass = readRow("evt-5555-0");
    expect(afterSecondPass.payload).toBe(stubbedByFirstPass.payload);
    expect(afterSecondPass.stub_signature).toEqual(stubbedByFirstPass.stub_signature);
    // Newly eligible rows stubbed; the newest stayed live.
    expect(readRow("evt-5555-1").retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(readRow("evt-5555-2").retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(readRow("evt-5555-3").retention_class).toBeNull();
    // Each firing pass anchored its own span before mutating anything, and the
    // second span opens ABOVE the first pass's stub rather than re-covering it:
    // the span is computed from live compactable rows, which the stub is no
    // longer one of.
    expect(anchorRows()).toEqual([
      { start_sequence: 0, end_sequence: 0 },
      { start_sequence: 1, end_sequence: 2 },
    ]);
  });
});

// ----------------------------------------------------------------------------
// Audit-stub projection — preserved keys and rollback attribution
// ----------------------------------------------------------------------------

describe("Compactor — audit-stub projection", () => {
  it("preserves terminal run_lifecycle keys past the UPDATE trigger and the rolled_back cutoff", async () => {
    const terminal = seed({
      category: "run_lifecycle",
      type: "run.completed",
      payload: { runId: "run-1", runVersion: 3, extra: "dropped" },
    });
    const rolledBack = seed({
      category: "run_lifecycle",
      type: "run.rolled_back",
      payload: { runId: "run-1", runVersion: 4, targetPosition: 12 },
    });
    const stamped = seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { runId: "run-1", sourceEpoch: 2, sourcePosition: 5 },
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "keep" } });

    const result = await buildCompactor({ eventCountThreshold: 1 }).tick();

    expect(result.rowsStubbed).toBe(3);
    const terminalStub = stubProjection(terminal.id);
    expect(terminalStub.runId).toBe("run-1");
    expect(terminalStub.runVersion).toBe(3);
    expect(terminalStub.extra).toBeUndefined();
    expect(stubProjection(rolledBack.id).targetPosition).toBe(12);
    const stampedStub = stubProjection(stamped.id);
    expect(stampedStub.sourceEpoch).toBe(2);
    expect(stampedStub.sourcePosition).toBe(5);
    expect(stampedStub.runId).toBe("run-1");
  });

  it("keeps a deferred row live, and stamps it on a later superseded pass", async () => {
    const deferred = seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { runId: "run-9" },
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "keep" } });

    let answer: RollbackAttribution = { disposition: "defer" };
    const attributionSource: RollbackAttributionSource = {
      attributeAtCompaction: () => Promise.resolve(answer),
    };

    const first = await buildCompactor({
      rollbackAttributionSource: attributionSource,
      eventCountThreshold: 1,
    }).tick();
    expect(first.rowsDeferred).toBe(1);
    expect(first.rowsStubbed).toBe(0);
    expect(readRow(deferred.id).retention_class).toBeNull();

    answer = {
      disposition: "superseded",
      sourceEpoch: 1,
      sourcePosition: 4,
      runId: "run-9" as RunId,
    };
    const second = await buildCompactor({
      rollbackAttributionSource: attributionSource,
      eventCountThreshold: 1,
    }).tick();

    expect(second.rowsStubbed).toBe(1);
    const stub = stubProjection(deferred.id);
    expect(stub.sourceEpoch).toBe(1);
    expect(stub.sourcePosition).toBe(4);
    expect(stub.runId).toBe("run-9");
    expect(stub.originPosition).toBeUndefined();
  });

  it("holds the session append lock across a row's attribute-and-stub", async () => {
    // The `Spec-004 §Required Behavior` admission-serialization reciprocal. The
    // admission side checks a rewind span and writes an intervention under this
    // same lock; if the compactor could attribute-and-stub outside it, the two
    // interleave and a row gets stubbed against attribution the intervention is
    // about to invalidate.
    seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { runId: "run-lock" },
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "keep" } });

    let releaseAttribution!: () => void;
    const attributionParked = new Promise<void>((resolve) => {
      releaseAttribution = resolve;
    });
    const pass = buildCompactor({
      eventCountThreshold: 1,
      rollbackAttributionSource: {
        attributeAtCompaction: async (): Promise<RollbackAttribution> => {
          await attributionParked;
          return { disposition: "current" };
        },
      },
    }).tick();
    await nextMacrotask();

    let contenderEntered = false;
    const contender = withSessionAppendLock(SESSION, () => {
      contenderEntered = true;
      return Promise.resolve();
    });
    await nextMacrotask();
    expect(contenderEntered).toBe(false);

    releaseAttribution();
    await pass;
    await contender;
    expect(contenderEntered).toBe(true);
  });

  it("stamps a superseded row and leaves a CURRENT sibling unstamped in the SAME pass", async () => {
    // The contrast has to occur WITHIN one pass. Split across two passes with
    // two attribution sources, a compactor that stamped the triple onto every
    // stub it wrote would satisfy both halves — each pass would see only rows it
    // was supposed to stamp, or only rows it was not.
    const superseded = seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { runId: "run-7" },
    });
    const current = seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { runId: "run-7" },
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "keep" } });

    const pass = await buildCompactor({
      eventCountThreshold: 1,
      rollbackAttributionSource: {
        attributeAtCompaction: (request) =>
          Promise.resolve<RollbackAttribution>(
            request.eventId === superseded.id
              ? {
                  disposition: "superseded",
                  sourceEpoch: 3,
                  sourcePosition: 8,
                  runId: "run-7" as RunId,
                }
              : { disposition: "current" },
          ),
      },
    }).tick();

    expect(pass.rowsStubbed).toBe(2);
    const supersededStub = stubProjection(superseded.id);
    expect(supersededStub.sourceEpoch).toBe(3);
    expect(supersededStub.sourcePosition).toBe(8);
    expect(supersededStub.runId).toBe("run-7");

    const currentStub = stubProjection(current.id);
    expect(currentStub.sourceEpoch).toBeUndefined();
    expect(currentStub.sourcePosition).toBeUndefined();
    // The run scope is preserved either way — only the epoch triple is
    // attribution-conditional.
    expect(currentStub.runId).toBe("run-7");
  });

  it("writes originPosition for a current attribution with a resolved position", async () => {
    const withPosition = seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { runId: "run-3" },
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "keep" } });

    await buildCompactor({
      rollbackAttributionSource: {
        attributeAtCompaction: () => Promise.resolve({ disposition: "current", position: 11 }),
      },
      eventCountThreshold: 1,
    }).tick();

    const stub = stubProjection(withPosition.id);
    expect(stub.originPosition).toBe(11);
    expect(stub.runId).toBe("run-3");
    expect(stub.sourceEpoch).toBeUndefined();
  });

  it("writes no originPosition under the vacuous default attribution source", async () => {
    const row = seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { runId: "run-4" },
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "keep" } });

    await buildCompactor({ eventCountThreshold: 1 }).tick();

    const stub = stubProjection(row.id);
    expect(stub.originPosition).toBeUndefined();
    expect(stub.sourceEpoch).toBeUndefined();
  });

  it("self-extinguishes once the live count falls to the threshold", async () => {
    // Named for what it actually shows. The second tick returns because the
    // TRIGGER no longer fires, not because the skip-filter rejected a candidate
    // — the skip-filter's own proof lives in the anchor block's re-fire arm,
    // where a later pass genuinely fires over a partition that already holds a
    // stub.
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "a" } });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "b" } });

    expect((await buildCompactor({ eventCountThreshold: 1 }).tick()).rowsStubbed).toBe(1);
    const second = await buildCompactor({ eventCountThreshold: 1 }).tick();
    expect(second.rowsStubbed).toBe(0);
    expect(second.outcomes).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Terminal-key backstop, POST-COMPACTION — migration 0006 against a stub
// ----------------------------------------------------------------------------

describe("Compactor — the terminal-key backstop survives compaction", () => {
  it("still refuses a second terminal for a run whose first terminal is now a stub", async () => {
    // THE POST-COMPACTION RE-RUN. The stub's projection preserves `runId` and
    // `runVersion` precisely so the partial unique index keeps indexing the row.
    // A projection that dropped either would silently free the key and let a
    // second terminal for the same run land.
    const terminal = seed({
      category: "run_lifecycle",
      type: "run.completed",
      payload: { runId: "run-terminal", runVersion: 1, extra: "dropped" },
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "keep" } });

    const pass = await buildCompactor({ eventCountThreshold: 1 }).tick();

    // The row must ACTUALLY be a stub. A refused pass leaves the original
    // payload in place — which still carries the run key — so the refusal below
    // would then prove nothing about the projection.
    expect(pass.rowsStubbed).toBe(1);
    expect(readRow(terminal.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);

    expect(() =>
      seed({
        category: "run_lifecycle",
        type: "run.completed",
        payload: { runId: "run-terminal", runVersion: 1 },
      }),
    ).toThrow(/UNIQUE/i);
  });

  it("refuses an UPDATE that rewrites a compacted terminal row's run identity", async () => {
    const terminal = seed({
      category: "run_lifecycle",
      type: "run.completed",
      payload: { runId: "run-terminal", runVersion: 1 },
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "keep" } });
    const pass = await buildCompactor({ eventCountThreshold: 1 }).tick();

    expect(pass.rowsStubbed).toBe(1);
    expect(readRow(terminal.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);

    expect(() =>
      database
        .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
        .run(JSON.stringify({ runId: "run-other", runVersion: 1 }), terminal.id),
    ).toThrow(/preserve runId/);
  });
});

// ----------------------------------------------------------------------------
// Pass-result census — `CompactionPassResult`'s three disjoint buckets
// ----------------------------------------------------------------------------

describe("Compactor — pass-result census", () => {
  it("counts a partition whose session_id is not TEXT as unreadable, and compacts the rest", async () => {
    // `session_events.session_id` is TEXT-affinity, and TEXT affinity does NOT
    // coerce a BLOB — so this really is a stored non-string, which is the shape
    // `#readSessionSummaries` skips before it ever reaches the branded parse.
    seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "corrupt" },
      sessionId: Buffer.from([0xde, 0xad]),
      sequence: 0,
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "a" } });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "b" } });

    const result = await buildCompactor({ eventCountThreshold: 1 }).tick();

    expect(result.sessionsUnreadable).toBe(1);
    // `sessionsExamined` counts READABLE partitions only — the unreadable one is
    // additive to it, not a member of it.
    expect(result.sessionsExamined).toBe(1);
    expect(result.rowsStubbed).toBe(1);
  });

  it("counts a partition whose MIN(sequence) is not a number as unreadable", async () => {
    // THE THIRD BRANCH — the aggregate guard, not the id guard. `sequence` is
    // INTEGER affinity with no `typeof` CHECK, so a corrupt write stores TEXT
    // verbatim; TEXT sorts above INTEGER in SQLite's type ordering, so on a
    // SINGLE-row partition `MIN(sequence)` is itself non-numeric and the summary
    // is unreadable even though its `session_id` parses cleanly.
    const corrupt = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "corrupt" },
      sessionId: SECOND_SESSION,
      sequence: 0,
    });
    database.prepare("UPDATE session_events SET sequence = 'corrupt' WHERE id = ?").run(corrupt.id);

    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "a" } });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "b" } });

    const result = await buildCompactor({ eventCountThreshold: 1 }).tick();

    expect(result.sessionsUnreadable).toBe(1);
    expect(result.sessionsExamined).toBe(1);
    expect(result.rowsStubbed).toBe(1);
  });

  it("counts a partition whose session_id is not a valid SessionId as unreadable", async () => {
    seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "corrupt" },
      sessionId: "not-a-uuid",
      sequence: 0,
    });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "a" } });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "b" } });

    const result = await buildCompactor({ eventCountThreshold: 1 }).tick();

    expect(result.sessionsUnreadable).toBe(1);
    expect(result.sessionsExamined).toBe(1);
    expect(result.rowsStubbed).toBe(1);
  });

  it("emits event.compacted over the stubbed prefix even when the pass then refuses", async () => {
    // A mid-loop failure after rows were already stubbed is exactly the case
    // where payloads were destroyed. Skipping the emission there would leave
    // that destruction unrecorded.
    //
    // The rows carry a `runId` on purpose: attribution is a RUN-scoped question,
    // so a row with no run identity is never asked about — and an injected
    // attribution failure over run-less rows would never fire.
    for (const text of ["a", "b", "c", "keep"]) {
      seed({
        category: "assistant_output",
        type: "assistant.message",
        payload: { runId: "run-partial", text },
      });
    }

    let attributionCalls = 0;
    const eventLog = new RecordingEventLog();
    const result = await buildCompactor({
      eventLog,
      eventCountThreshold: 1,
      rollbackAttributionSource: {
        attributeAtCompaction: () => {
          attributionCalls += 1;
          if (attributionCalls > 2) {
            return Promise.reject(new Error("attribution source went away mid-pass"));
          }
          return Promise.resolve({ disposition: "current" });
        },
      },
    }).tick();

    expect(result.rowsStubbed).toBe(2);
    expect(result.sessionsRefused).toBe(1);
    // Disjoint by construction: a session that stubbed rows and THEN refused is
    // a refusal, not a completion.
    expect(result.sessionsCompacted).toBe(0);
    expect(result.outcomes[0]?.refusedReason).toContain("went away mid-pass");
    expect(eventLog.appended).toHaveLength(1);
    const emitted = eventLog.appended[0]?.payload ?? {};
    expect(emitted.tombstoneCount).toBe(2);
    expect(emitted.fromSeq).toBe(0);
    expect(emitted.toSeq).toBe(1);
  });

  it("emits ONE event.compacted per compacted session per pass", async () => {
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "a" } });
    seed({ category: "session_lifecycle", type: "session.updated", payload: { text: "b" } });
    seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "c" },
      sessionId: SECOND_SESSION,
      sequence: 0,
    });
    seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "d" },
      sessionId: SECOND_SESSION,
      sequence: 1,
    });

    const eventLog = new RecordingEventLog();
    const result = await buildCompactor({ eventLog, eventCountThreshold: 1 }).tick();

    expect(result.sessionsExamined).toBe(2);
    expect(result.sessionsCompacted).toBe(2);
    expect(eventLog.appended).toHaveLength(2);
    const sessionsNamed = eventLog.appended.map((envelope) => envelope.payload.sessionId);
    expect(new Set(sessionsNamed)).toEqual(new Set([SESSION, SECOND_SESSION]));
  });

  it("returns an empty result from a tick entered while another is in flight", async () => {
    // Run-scoped, so the parked attribution source is actually consulted.
    seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { runId: "run-reentry", text: "a" },
    });
    seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { runId: "run-reentry", text: "b" },
    });

    let releaseAttribution!: () => void;
    const attributionParked = new Promise<void>((resolve) => {
      releaseAttribution = resolve;
    });
    const compactor = buildCompactor({
      eventCountThreshold: 1,
      rollbackAttributionSource: {
        attributeAtCompaction: async () => {
          await attributionParked;
          return { disposition: "current" };
        },
      },
    });

    const firstTick = compactor.tick();
    await nextMacrotask();

    const reentrant = await compactor.tick();
    expect(reentrant.sessionsExamined).toBe(0);
    expect(reentrant.rowsStubbed).toBe(0);
    // The re-entrant tick still carries an operation id — `tick()` consumes the
    // factory BEFORE the guard, so an id is legitimately burned here.
    expect(typeof reentrant.operationId).toBe("string");

    releaseAttribution();
    expect((await firstTick).rowsStubbed).toBe(1);
  });
});
