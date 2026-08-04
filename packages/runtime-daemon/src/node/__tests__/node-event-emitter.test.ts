// RuntimeNodeEventEmitter — Plan-003 Phase 2 (T2.3).
//
// Exercises the emission seam that routes `runtime_node.*` events through
// the injected `SessionEventLog` — implemented here by Plan-006 T3.1's
// `EventLogService`, the sole durable production writer — over a real test
// SQLite DB (mirrors `session-service.test.ts` lifecycle: `openDatabase`
// factory → per-test tmp file → `afterEach` close + unlink). The
// structural-seam block at the bottom proves the emitter also accepts a
// plain-object log implementation: the seam is ASYNC-TRANSACTIONAL post the
// T3.1 re-point, and that block pins the contract at BOTH enforcement
// layers (a synchronous `append` fails to compile AND is refused at runtime).
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * D5 (Plan-003 T2.3 required assertion / I-003-4): a persisted
//     `runtime_node.*` row carries a non-null `monotonic_ns` and REAL
//     integrity columns — a genuine BLAKE3 `row_hash` and Ed25519
//     `daemon_signature`, not the Plan-001 zero-fill placeholders (asserted
//     via a raw `session_events` query, since `readEvents`/`StoredEvent` do
//     not surface the integrity blobs). Proves `monotonic_ns` is debug data
//     the append path materializes, distinct from the `sequence` replay key.
//   * Emission boundary (CP-003-1): an out-of-bounds payload field makes the
//     emit throw via the T2.0 schema's `.parse()` — the validation seam
//     actually rejects, it is not an ad-hoc object.
//   * Sequence allocation: the append path derives every sequence from the
//     durable chain head (empty-log → 0, then head + 1, and the MAXIMUM
//     rather than the last-inserted row), including for CONCURRENT
//     same-session emits — the race the re-point closed.
//   * Determinism: injected `monotonicNow` / `now` / `newEventId` flow
//     through to the persisted row (what T2.6's D6 relies on to drive
//     non-monotonic `monotonic_ns` through the emitter).
//   * Per-event payload shapes (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`): each of the 5
//     daemon-reachable events persists with its Spec-006 payload shape and
//     its `runtime_node.*` type + `runtime_node_lifecycle` category.
//   * sessionId/actor reconciliation: one input value populates BOTH the
//     envelope and the payload (a caller cannot make them diverge).
//
// Spec coverage: `Spec-003 §State And Data Implications` (capability/trust changes emitted as
// session events); `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` (per-event payload shapes);
// `Spec-006 §Canonical Serialization Rules` (the two T2.1-inherited normalization obligations the
// Plan-006 T3.1 append path discharges — normalized `occurredAt` persisted, absent `actor` narrowed
// to null before canonicalization).
// Verifies invariant: I-003-4 (`monotonic_ns` is within-daemon debug data,
// not the replay key — the replay key is `sequence`).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EventEnvelopeSchema,
  EventEnvelopeVersionSchema,
  SessionIdSchema,
} from "@ai-sidekicks/contracts";
import type { EventEnvelope, SessionId } from "@ai-sidekicks/contracts";

import { canonicalizeEvent, isCanonicalOccurredAt } from "../../events/canonicalizer.js";
import { EventLogService } from "../../events/event-log-service.js";
import type {
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import { verifyRow } from "../../events/signer.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { openDatabase } from "../../session/migration-runner.js";
import { SessionService, UnsignedPlaceholderAppendToken } from "../../session/session-service.js";
import type { StoredEvent } from "../../session/types.js";
import { RuntimeNodeEventEmitter } from "../node-event-emitter.js";
import type { RuntimeNodeEventEmitterDeps, SessionEventLog } from "../node-event-emitter.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// `sessionId` is validated through the payload schema's `SessionIdSchema`,
// which is UUIDv7-format (contracts `session.ts`) — NOT an arbitrary string.
// (The Plan-001 `session-service.test.ts` uses ULID-shaped session ids only
// because `SessionService.append` takes a bare `string` and never `.parse()`s
// it; this emitter validates the payload, so the fixture must be a real UUID.)
const SESSION_ID: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
// `NodeId` is a daemon-minted opaque scalar (min 1, max 256), NOT a UUID
// (contracts `node-id.ts` header) — an arbitrary non-UUID string is valid.
const NODE_ID: string = "node-01J0ND0000NN5J5J5J5J5J5J";
// `actor` is the EventEnvelope free-form actor string (`wireFreeFormString`),
// NOT a branded ParticipantId — any bounded string (here a ULID) is valid.
const PARTICIPANT_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";

// The integrity-column widths (32/32/64 per 0001-initial.ts CHECK constraints).
// The emitter never touches these; D5 asserts the append path materialized REAL
// ones — Plan-006 T3.1's re-point replaced the Plan-001 zero-fill placeholders
// with a genuine BLAKE3 chain + Ed25519 signature.
const CHAIN_HASH_LEN: number = 32;
const DAEMON_SIGNATURE_LEN: number = 64;

// The compile-time async-append-rejection control's title, bound to an
// exported identifier so governance docs can cite the control durably (the
// docs-corpus gate's symbol matcher is identifier-shaped): renaming or
// deleting the test breaks the inbound cite instead of leaving it validating
// against nothing (same pattern as migration-shape.test.ts's exported titles).
export const COMPILE_TIME_ASYNC_APPEND_REJECTION_TEST: string =
  "rejects a synchronous append at COMPILE time (Promise return, not undefined)";

/**
 * A fixed-key {@link DaemonSigningKeySource} — enough for the emitter suite,
 * which is about EMISSION, not key custody (`signing-key-source.test.ts` owns
 * that). A 32-byte Ed25519 seed; `create` is unreachable here because these
 * tests only ever sign.
 */
const FIXED_DAEMON_PRIVATE_KEY: Ed25519PrivateKey = new Uint8Array(32).fill(7) as Ed25519PrivateKey;

// Derived, never hard-coded: the round-trip arm below verifies against the key
// the suite actually SIGNS with, so a fixture drift cannot make verification
// pass against the wrong key (the `signer.golden.test.ts` / `post-shred-verify`
// idiom).
const FIXED_DAEMON_PUBLIC_KEY: Ed25519PublicKey = ed25519.getPublicKey(
  FIXED_DAEMON_PRIVATE_KEY,
) as Ed25519PublicKey;

class FixedDaemonSigningKeySource implements DaemonSigningKeySource {
  readonly #privateKey: Ed25519PrivateKey = FIXED_DAEMON_PRIVATE_KEY;

  read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
    return Promise.resolve(this.#privateKey);
  }

  create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
    // Never called: this suite signs against a pre-existing key. Throwing keeps
    // an accidental provisioning call loud instead of returning a fake public
    // key that would silently pass a roster assertion.
    return Promise.reject(
      new Error("FixedDaemonSigningKeySource.create is not used by this suite"),
    );
  }
}

// Raw read shape for the integrity columns that `StoredEvent` does not expose.
interface IntegrityRow {
  readonly sequence: bigint;
  readonly type: string;
  readonly category: string;
  readonly version: string;
  readonly actor: string | null;
  readonly occurred_at: string;
  readonly monotonic_ns: bigint;
  readonly payload: string;
  readonly prev_hash: Buffer;
  readonly row_hash: Buffer;
  readonly daemon_signature: Buffer;
  readonly participant_signature: Buffer | null;
}

function readRawRows(db: DatabaseType, sessionId: string): ReadonlyArray<IntegrityRow> {
  return db
    .prepare(
      `SELECT sequence, type, category, version, actor, occurred_at, monotonic_ns,
              payload, prev_hash, row_hash, daemon_signature, participant_signature
         FROM session_events
        WHERE session_id = ?
        ORDER BY sequence ASC`,
    )
    .safeIntegers(true)
    .all(sessionId) as ReadonlyArray<IntegrityRow>;
}

// A deterministic, COLLISION-FREE id source: a constant id would violate the
// `TEXT PRIMARY KEY` on the second emit, so tests that emit more than once
// inject this counter.
function makeCounterIdSource(prefix: string): () => string {
  let counter: number = 0;
  return () => `${prefix}-${(counter++).toString()}`;
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle (mirrors session-service.test.ts)
// ----------------------------------------------------------------------------

interface TestContext {
  db: DatabaseType;
  // The production append path the emitter is re-pointed onto (Plan-006 T3.1).
  eventLog: EventLogService;
  // Retained for its READ side only (`readEvents`, which needs no opt-in) plus
  // the D6 seeding path. It is NOT the emitter's append seam any more.
  service: SessionService;
  tmpDir: string;
}

let ctx: TestContext;

beforeEach(() => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-node-emitter-test-"));
  const dbPath: string = join(tmpDir, "test.db");
  // Canonical factory — same open semantics (pragmas + migrations) as
  // production. No session row is seeded: the Plan-001 `session_events` table
  // has NO foreign key on `session_id` (0001-initial.ts:69 is plain
  // `TEXT NOT NULL`), so emitting against a bare session id is valid, exactly
  // as the existing append tests do.
  const db: DatabaseType = openDatabase(dbPath);
  // Test-only opt-in to the guarded append path — the emitter persists
  // through this service (session-service.test.ts pins the guard itself).
  ctx = {
    db,
    eventLog: new EventLogService({
      db,
      signingKeySource: new FixedDaemonSigningKeySource(),
    }),
    service: new SessionService(db, {
      allowUnsignedPlaceholderAppend: UnsignedPlaceholderAppendToken.forTestsOnly(),
    }),
    tmpDir,
  };
});

afterEach(() => {
  // The per-session append lock is a MODULE SINGLETON, so a case that left a
  // queue entry behind would stall the next case touching the same session id
  // — and the failure would present as an unrelated timeout. Reset between
  // cases, never during one.
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

function makeEmitter(
  overrides: Partial<RuntimeNodeEventEmitterDeps> = {},
): RuntimeNodeEventEmitter {
  return new RuntimeNodeEventEmitter({
    sessionEvents: ctx.eventLog,
    newEventId: makeCounterIdSource("evt"),
    ...overrides,
  });
}

// ----------------------------------------------------------------------------
// D5 — monotonic_ns persisted, integrity columns zero-filled (I-003-4)
// ----------------------------------------------------------------------------

describe("RuntimeNodeEventEmitter — D5 (monotonic_ns + materialized integrity columns)", () => {
  it("persists a runtime_node.* row with non-null monotonic_ns and REAL integrity columns", async () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter({
      monotonicNow: () => 7_000_000_000n,
    });

    await emitter.emitRegistered({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
      capabilities: { "provider-driver": { contractVersion: "1.0" } },
      nodeVersion: "1.4.2",
      platform: "darwin-arm64",
    });

    const rows: ReadonlyArray<IntegrityRow> = readRawRows(ctx.db, SESSION_ID);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    // monotonic_ns is present and non-null in the Plan-001 column shape.
    expect(row.monotonic_ns).toBe(7_000_000_000n);

    // Integrity columns are materialized by the append path (the emitter never
    // computes them). Buffers of the exact CHECK-constraint widths.
    expect(row.prev_hash.length).toBe(CHAIN_HASH_LEN);
    expect(row.row_hash.length).toBe(CHAIN_HASH_LEN);
    expect(row.daemon_signature.length).toBe(DAEMON_SIGNATURE_LEN);

    // `prev_hash` IS all-zero here, and for a reason that is the opposite of a
    // placeholder: this is the session's FIRST row, so its chain link is
    // GENESIS_PREV_HASH (`Spec-006 §Integrity Protocol` — zero-filled at
    // sequence 0). The two columns that would ALSO have been zero under the
    // Plan-001 placeholder append are the discriminating ones, and both are
    // asserted NON-zero — which is exactly what the T3.1 re-point changed, and
    // what a regression back to the guarded placeholder writer would break.
    expect(row.prev_hash.equals(Buffer.alloc(CHAIN_HASH_LEN))).toBe(true);
    expect(row.row_hash.equals(Buffer.alloc(CHAIN_HASH_LEN))).toBe(false);
    expect(row.daemon_signature.equals(Buffer.alloc(DAEMON_SIGNATURE_LEN))).toBe(false);
    // Still NULL: T3.1 mints no participant signature (the column is nullable
    // and no V1 producer supplies one).
    expect(row.participant_signature).toBeNull();

    // The row carries the runtime-node type + the Plan-001-owned category.
    expect(row.type).toBe("runtime_node.registered");
    expect(row.category).toBe("runtime_node_lifecycle");
    expect(row.version).toBe("1.0");
  });

  it("allocates a monotonic sequence even when monotonic_ns runs backwards — emission half of I-003-4 (D6 owns the replay-read proof)", async () => {
    // Drive monotonic_ns BACKWARDS relative to sequence through the emitter
    // (exactly the seam T2.6's D6 will use). Sequence must still advance.
    let monotonicValue: bigint = 9_000_000_000n;
    const emitter: RuntimeNodeEventEmitter = makeEmitter({
      monotonicNow: () => {
        const current: bigint = monotonicValue;
        monotonicValue -= 4_000_000_000n; // each call goes backwards
        return current;
      },
    });

    await emitter.emitRegistered({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "registering",
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });
    await emitter.emitCapabilityDeclared({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      capability: "provider-driver",
      capabilityDetails: { contractVersion: "1.0" },
    });

    const rows: ReadonlyArray<IntegrityRow> = readRawRows(ctx.db, SESSION_ID);
    // Sequence is monotonic ASC even though monotonic_ns went backwards.
    expect(rows.map((r) => r.sequence)).toEqual([0n, 1n]);
    expect(rows.map((r) => r.monotonic_ns)).toEqual([9_000_000_000n, 5_000_000_000n]);
  });
});

// ----------------------------------------------------------------------------
// D6 — replay-read composition guard (I-003-4): the production read path
// returns emitter-produced runtime_node.* events in sequence order under a
// non-monotonic monotonic_ns.
// ----------------------------------------------------------------------------
//
// The sequence-not-monotonic_ns BEHAVIOR is already pinned elsewhere: legacy
// Plan-001 D3 (session-service.test.ts) for the shared read over directly-
// appended generic events, and the emission-half test above for the sequence
// allocator (sequence advances while monotonic_ns regresses). D6 is the
// integration guard over the cell neither covers — events ROUTED THROUGH the
// T2.3 emitter AND read back through the production SessionService.readEvents —
// so the end-to-end emit→replay path cannot regress to a monotonic_ns key.
// Per Plan-003 T2.6 (§370-376) / invariant I-003-4. Behavioral by design: the
// non-monotonic clock is the proof; no structural "monotonic_ns is never read"
// assertion is added (one test is the right idiom for a negative).
//
// Two deliberate fixture choices make the guard fire cleanly and in BOTH
// directions (vs a merely-descending clock that would only catch a mono-ASC
// regression and would corrupt allocation before the assertion ran):
//   * `sequence` is allocated by `EventLogService.append` from the durable
//     CHAIN HEAD (`MAX(sequence)` under the append lock), NOT through the very
//     `readEvents` under test. That independence used to be bought with an
//     injected `nextSequence`; since the T3.1 re-point it is structural — the
//     allocator no longer goes anywhere near the read path this guard targets,
//     so a regression that reordered the read cannot mask itself behind a
//     write-time `UNIQUE(session_id, sequence)` collision.
//   * `monotonic_ns` is NON-monotonic (mirrors legacy D3's [5e9,1e9,3e9]): it
//     sorts to an order matching NEITHER the ascending nor descending sequence
//     direction, so a read keyed on monotonic_ns in either direction reorders
//     the events and trips the `sequence` assertion.

describe("RuntimeNodeEventEmitter — D6 (replay reads emitter-produced events by sequence, not monotonic_ns)", () => {
  it("readEvents returns runtime_node.* events in sequence order even when monotonic_ns sorts to neither direction", async () => {
    // monotonic_ns per emit, in emission order. Non-monotonic by construction:
    // ascending sort → sequence [1,3,0,2]; descending → [2,0,3,1]; neither is
    // the emission order [0,1,2,3]. So a read keyed on monotonic_ns (either
    // direction) is detectable.
    const monotonicByEmit: ReadonlyArray<bigint> = [
      5_000_000_000n, // registered          → seq 0
      1_000_000_000n, // capability_declared  → seq 1
      7_000_000_000n, // online              → seq 2
      3_000_000_000n, // offline             → seq 3
    ];
    let monotonicIndex: number = 0;
    const emitter: RuntimeNodeEventEmitter = makeEmitter({
      monotonicNow: () => {
        const value: bigint | undefined = monotonicByEmit[monotonicIndex];
        monotonicIndex += 1;
        return value ?? 0n;
      },
    });

    // A canonical node lifecycle, emitted in order through the T2.3 seam:
    // registered → capability_declared → online → offline.
    await emitter.emitRegistered({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "registering",
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });
    await emitter.emitCapabilityDeclared({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      capability: "provider-driver",
      capabilityDetails: { contractVersion: "1.0" },
    });
    await emitter.emitOnline({ sessionId: SESSION_ID, nodeId: NODE_ID, newState: "online" });
    await emitter.emitOffline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      previousState: "online",
      newState: "offline",
      lastHeartbeatAt: "2026-06-02T12:00:00.000Z",
      reason: "explicit_shutdown",
    });

    // The production replay-READ (SessionService.readEvents) — the surface a
    // real replay consumes, NOT the raw query the emission-half test uses.
    const replayed: ReadonlyArray<StoredEvent> = ctx.service.readEvents(SESSION_ID);

    // The read returns events in `sequence` order (= emission order), carrying
    // the non-monotonic monotonic_ns UNSORTED — direct proof the read did not
    // reorder by it. `sequence` hydrates to number; `monotonicNs` stays bigint.
    expect(replayed.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    expect(replayed.map((e) => e.type)).toEqual([
      "runtime_node.registered",
      "runtime_node.capability_declared",
      "runtime_node.online",
      "runtime_node.offline",
    ]);
    expect(replayed.map((e) => e.monotonicNs)).toEqual([
      5_000_000_000n,
      1_000_000_000n,
      7_000_000_000n,
      3_000_000_000n,
    ]);

    // Clincher (mirrors legacy D3, session-service.test.ts): a monotonic_ns
    // sort — in EITHER direction — yields a sequence order DIFFERENT from the
    // replay order, so the read path demonstrably keyed on sequence, not
    // monotonic_ns. This closes both regression directions, not just one.
    const byMonotonicAsc: ReadonlyArray<number> = [...replayed]
      .sort((a, b) => Number(a.monotonicNs - b.monotonicNs))
      .map((e) => e.sequence);
    const byMonotonicDesc: ReadonlyArray<number> = [...replayed]
      .sort((a, b) => Number(b.monotonicNs - a.monotonicNs))
      .map((e) => e.sequence);
    expect(byMonotonicAsc).toEqual([1, 3, 0, 2]);
    expect(byMonotonicDesc).toEqual([2, 0, 3, 1]);
  });
});

// ----------------------------------------------------------------------------
// Emission boundary — .parse() rejects an invalid payload (CP-003-1)
// ----------------------------------------------------------------------------

describe("RuntimeNodeEventEmitter — emission boundary (.parse rejects invalid payloads)", () => {
  it("throws and persists nothing when a payload field violates its schema (over-length nodeVersion)", async () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    // `nodeVersion` cap is RUNTIME_NODE_VERSION_MAX_LEN = 64; 65 chars trips
    // the schema's length bound. Type-`string`-valid, so this exercises the
    // RUNTIME `.parse()` validation seam (not a TypeScript error).
    const overLengthVersion: string = "9".repeat(65);

    await expect(
      emitter.emitRegistered({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        newState: "online",
        capabilities: {},
        nodeVersion: overLengthVersion,
        platform: "darwin-arm64",
      }),
    ).rejects.toThrow();

    // The throw happens at the emission boundary BEFORE the append, so no row
    // was persisted — the validation seam is a true gate, not post-hoc.
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects an invalid offline `reason` (not in the Spec-006 enum) at the emission boundary", async () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    await expect(
      emitter.emitOffline({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        newState: "offline",
        lastHeartbeatAt: "2026-06-02T12:00:00.000Z",
        // Force an out-of-enum value past the typed input via a narrow cast —
        // the schema enum is the runtime gate, and it must reject.
        reason: "bogus_reason" as "explicit_shutdown",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a non-ISO `lastHeartbeatAt` (the offline path's second validated field) at the emission boundary", async () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    await expect(
      emitter.emitOffline({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        newState: "offline",
        // The schema is `z.iso.datetime({ offset: true })` — a bare date with no
        // time or offset is not a valid RFC 3339 timestamp and must be rejected.
        lastHeartbeatAt: "2026-06-02",
        reason: "explicit_shutdown",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Sequence allocation — owned by EventLogService.append, off the chain head
// ----------------------------------------------------------------------------
//
// Plan-006 T3.1 MOVED allocation out of this emitter. The `nextSequence`
// injection seam and the `readEvents` log-derive default are both gone, so the
// tests that pinned them are re-pointed at the property that replaced them:
// `append` reads `MAX(sequence)` for the session under its own lock and returns
// the number it assigned. The old "injected allocator wins" and "a duplicate
// allocator collides on UNIQUE" arms are not merely deleted — the first pinned a
// seam that no longer exists, and the second's premise (a caller can hand out a
// colliding sequence) is now UNREACHABLE, which is exactly the improvement. The
// concurrency arm below is what stands in its place, and it is a stronger claim:
// two overlapping emits cannot collide in the first place.

describe("RuntimeNodeEventEmitter — sequence allocation (delegated to the append path)", () => {
  it("allocates consecutive sequences from the durable chain head (empty log → 0, then head + 1)", async () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();

    const first: EventLogAppendReceipt = await emitter.emitRegistered({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "registering",
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });
    const second: EventLogAppendReceipt = await emitter.emitCapabilityDeclared({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      capability: "provider-driver",
      capabilityDetails: { contractVersion: "1.0" },
    });

    // Both branches of the allocator: empty log → 0, then head + 1.
    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);

    const rows: ReadonlyArray<IntegrityRow> = readRawRows(ctx.db, SESSION_ID);
    expect(rows.map((r) => r.sequence)).toEqual([0n, 1n]);
  });

  it("continues the sequence from pre-existing durable events on the same session", async () => {
    // Seed two non-runtime-node events directly, so the allocator must start
    // AFTER them — proving it reads the durable log, not a counter.
    const seedEvent = (sequence: number): void => {
      ctx.service.append({
        id: `seed-${sequence.toString()}`,
        sessionId: SESSION_ID,
        sequence,
        occurredAt: "2026-06-02T12:00:00.000Z",
        monotonicNs: 1_000_000_000n,
        category: "session_lifecycle",
        type: "session.created",
        actor: null,
        payload: { sessionId: SESSION_ID },
        correlationId: null,
        causationId: null,
        version: "1.0",
      });
    };
    seedEvent(0);
    seedEvent(1);

    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const emitted: EventLogAppendReceipt = await emitter.emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
    });

    expect(emitted.sequence).toBe(2);
  });

  it("allocates from the MAXIMUM sequence, not the most recently inserted row", async () => {
    // Adversarial seeding: the HIGHEST sequence is inserted FIRST, so a reader
    // that took "the last row I can find" (or trusted physical/rowid order)
    // would allocate 8 and collide with the existing row 41. The allocator's
    // `ORDER BY sequence DESC LIMIT 1` is what makes 42 the answer.
    const seedEvent = (sequence: number): void => {
      ctx.service.append({
        id: `seed-${sequence.toString()}`,
        sessionId: SESSION_ID,
        sequence,
        occurredAt: "2026-06-02T12:00:00.000Z",
        monotonicNs: 1_000_000_000n,
        category: "session_lifecycle",
        type: "session.created",
        actor: null,
        payload: { sessionId: SESSION_ID },
        correlationId: null,
        causationId: null,
        version: "1.0",
      });
    };
    seedEvent(41);
    seedEvent(7);
    seedEvent(0);

    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const emitted: EventLogAppendReceipt = await emitter.emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
    });
    expect(emitted.sequence).toBe(42);
  });

  it("assigns distinct consecutive sequences to CONCURRENT same-session emits (the race the re-point closed)", async () => {
    // THE regression this whole allocation move exists to prevent. Plan-003's
    // log-derive allocator read the log and appended with no `await` between,
    // which was atomic only while the append path was synchronous. Now that it
    // is async, two overlapping emits would both read head = -1 and both
    // allocate 0 — one losing to `UNIQUE(session_id, sequence)` on a perfectly
    // legitimate write. `withSessionAppendLock` serializes them instead.
    //
    // Launched WITHOUT awaiting in between, so both are genuinely in flight
    // before either completes; `Promise.all` then settles them together.
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const receipts: ReadonlyArray<EventLogAppendReceipt> = await Promise.all([
      emitter.emitOnline({ sessionId: SESSION_ID, nodeId: NODE_ID, newState: "online" }),
      emitter.emitOnline({ sessionId: SESSION_ID, nodeId: NODE_ID, newState: "online" }),
      emitter.emitOnline({ sessionId: SESSION_ID, nodeId: NODE_ID, newState: "online" }),
    ]);

    // Sorted, because the lock guarantees DISTINCT consecutive numbers, not
    // which caller wins which — asserting an arrival order would pin scheduling
    // rather than the invariant.
    expect([...receipts.map((r) => r.sequence)].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(readRawRows(ctx.db, SESSION_ID).map((r) => r.sequence)).toEqual([0n, 1n, 2n]);
  });
});

// ----------------------------------------------------------------------------
// SessionEventLog seam — structural decoupling (the `Plan-006 §T3.1 — Append-path service writing integrity columns + Plan-022 Path 1 shred callback`
// precondition: the emitter names no concrete storage class)
// ----------------------------------------------------------------------------

describe("RuntimeNodeEventEmitter — SessionEventLog seam (structural, no EventLogService dependency)", () => {
  it("emits through a plain-object SessionEventLog implementation (no EventLogService, no database)", async () => {
    const appended: UnsequencedEventEnvelope[] = [];
    const inMemoryEventLog: SessionEventLog = {
      append: (envelope) => {
        appended.push(envelope);
        return Promise.resolve({
          id: envelope.id,
          sequence: appended.length - 1,
          rowHash: new Uint8Array(32),
        });
      },
    };
    const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
      sessionEvents: inMemoryEventLog,
      newEventId: makeCounterIdSource("structural"),
    });

    const first: EventLogAppendReceipt = await emitter.emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
    });
    const second: EventLogAppendReceipt = await emitter.emitCapabilityDeclared({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      capability: "provider-driver",
      capabilityDetails: { contractVersion: "1.0" },
    });

    // Both events landed in the fake, and the emitter surfaced the fake's
    // assigned sequences verbatim — no EventLogService (and no database)
    // anywhere in this path, and no sequence invented by the emitter.
    expect(appended).toHaveLength(2);
    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);
    expect(appended.map((envelope) => envelope.type)).toEqual([
      "runtime_node.online",
      "runtime_node.capability_declared",
    ]);
  });

  it("forwards a caller-supplied transactionalPrelude to the append verbatim", async () => {
    // The prelude is the producers' dual-write atomicity seam. The emitter's job
    // is to FORWARD it — not to wrap, re-order, or invoke it — so the identity
    // check is the assertion: anything the emitter did to the closure would
    // break the atomicity guarantee `EventLogService` provides around it.
    const forwardedOptions: Array<{ transactionalPrelude?: () => void }> = [];
    const capturingEventLog: SessionEventLog = {
      append: (envelope, options) => {
        forwardedOptions.push(options ?? {});
        return Promise.resolve({ id: envelope.id, sequence: 0, rowHash: new Uint8Array(32) });
      },
    };
    const prelude = (): void => {};
    await new RuntimeNodeEventEmitter({ sessionEvents: capturingEventLog }).emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
      transactionalPrelude: prelude,
    });

    expect(forwardedOptions).toHaveLength(1);
    expect(forwardedOptions[0]?.transactionalPrelude).toBe(prelude);
  });

  it("omits transactionalPrelude entirely when the caller supplies none", async () => {
    // Negative control for the arm above. `EventLogAppendOptions` declares the
    // member optional under `exactOptionalPropertyTypes`, so forwarding an
    // explicit `undefined` would be a type error at the emitter — this pins the
    // runtime half: the KEY is absent, not present-and-undefined.
    const forwardedOptions: Array<Record<string, unknown>> = [];
    const capturingEventLog: SessionEventLog = {
      append: (envelope, options) => {
        forwardedOptions.push((options ?? {}) as Record<string, unknown>);
        return Promise.resolve({ id: envelope.id, sequence: 0, rowHash: new Uint8Array(32) });
      },
    };
    await new RuntimeNodeEventEmitter({ sessionEvents: capturingEventLog }).emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
    });

    expect(forwardedOptions[0]).toBeDefined();
    expect(Object.hasOwn(forwardedOptions[0] ?? {}, "transactionalPrelude")).toBe(false);
  });

  // The seam is ASYNC-transactional BY CONTRACT since the Plan-006 T3.1
  // re-point — the INVERSE of the synchronous-transactional contract it shipped
  // with (PR #272 Codex rounds 1-2). The producers no longer own the
  // transaction; they hand their durable write down as `transactionalPrelude`
  // and `EventLogService.append` runs it inside the same transaction as the
  // event row. Both enforcement layers survive the inversion, negated: `append`
  // returns `Promise<EventLogAppendReceipt>` so a SYNCHRONOUS implementation
  // fails the ASSIGNMENT at compile time (the compile-time control below), and
  // the runtime non-thenable refusal backstops wiring the compiler never saw
  // (plain JS, `as unknown as` casts — which is why these fakes need exactly
  // such a cast to reach the runtime guard at all). These tests are the guard's
  // negative controls.
  describe("async-transactional contract — synchronous append refused fail-closed", () => {
    it(COMPILE_TIME_ASYNC_APPEND_REJECTION_TEST, async () => {
      // Layer 1: `undefined` is not assignable to `Promise<...>`, so the exact
      // synchronous shape the re-point outlawed no longer typechecks. Deleting
      // the directive below must yield the underlying assignment error — an
      // unused-directive TS2578 here would mean the compile-time layer silently
      // regressed to accepting synchronous appenders.
      const compileRejectedEventLog: SessionEventLog = {
        // @ts-expect-error — a synchronous `append` (returns `undefined`) does
        // not satisfy `append(envelope, options): Promise<EventLogAppendReceipt>`.
        append: (): undefined => undefined,
      };
      // The object still exists at runtime; the runtime tripwire covers it.
      await expect(
        new RuntimeNodeEventEmitter({ sessionEvents: compileRejectedEventLog }).emitOnline({
          sessionId: SESSION_ID,
          nodeId: NODE_ID,
          newState: "online",
        }),
      ).rejects.toThrow(/did not return a promise/);
    });

    it("refuses a synchronous append with a pointed error naming the T3.1 contract", async () => {
      const appendCalls: UnsequencedEventEnvelope[] = [];
      // Deliberately synchronous: this is exactly the shape the seam used to
      // REQUIRE, and exactly what must NOT be silently absorbed now.
      const syncEventLog: SessionEventLog = {
        append: (envelope): Promise<EventLogAppendReceipt> => {
          appendCalls.push(envelope);
          // A synchronous implementation smuggled past the compile-time layer —
          // the cast models plain-JS / cast-through wiring.
          return undefined as unknown as Promise<EventLogAppendReceipt>;
        },
      };
      const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
        sessionEvents: syncEventLog,
      });

      await expect(
        emitter.emitOnline({ sessionId: SESSION_ID, nodeId: NODE_ID, newState: "online" }),
      ).rejects.toThrow(
        /async-transactional[\s\S]*EventLogService\.append[\s\S]*withSessionAppendLock[\s\S]*transactionalPrelude/,
      );

      // Tripwire, not prevention: the implementation has already run by the time
      // the non-promise comes back — the guard's job is to be LOUD on the first
      // emit, not to undo that work.
      expect(appendCalls).toHaveLength(1);
    });

    it("refuses a non-thenable OBJECT return (not merely undefined)", async () => {
      // A synchronous implementation that returns a plain receipt-shaped object
      // is the likeliest real-world spelling of this bug — a fake written
      // against the old seam, or a hand-rolled double. The guard is a THENABLE
      // test, not an `undefined` test, so it must catch this too.
      const objectReturningEventLog: SessionEventLog = {
        append: (envelope): Promise<EventLogAppendReceipt> =>
          ({
            id: envelope.id,
            sequence: 0,
            rowHash: new Uint8Array(32),
          }) as unknown as Promise<EventLogAppendReceipt>,
      };

      await expect(
        new RuntimeNodeEventEmitter({ sessionEvents: objectReturningEventLog }).emitOnline({
          sessionId: SESSION_ID,
          nodeId: NODE_ID,
          newState: "online",
        }),
      ).rejects.toThrow(/did not return a promise/);
    });

    it("ADMITS a custom thenable (duck-typed, not instanceof Promise)", async () => {
      // The positive control, and the mirror of the pre-re-point suite's
      // custom-thenable REFUSAL: `await` latches onto ANY `then` function, so
      // the guard must too. A `instanceof Promise` check would reject a
      // perfectly valid async implementation built on a userland promise or a
      // wrapper — a false positive on the fail-closed side, which is why the
      // duck test is the right one in BOTH directions.
      const receipt: EventLogAppendReceipt = { id: "x", sequence: 3, rowHash: new Uint8Array(32) };
      const customThenableEventLog: SessionEventLog = {
        append: (): Promise<EventLogAppendReceipt> =>
          ({
            then: (resolve?: (value: EventLogAppendReceipt) => void) => resolve?.(receipt),
          }) as unknown as Promise<EventLogAppendReceipt>,
      };

      await expect(
        new RuntimeNodeEventEmitter({ sessionEvents: customThenableEventLog }).emitOnline({
          sessionId: SESSION_ID,
          nodeId: NODE_ID,
          newState: "online",
        }),
      ).resolves.toEqual(receipt);
    });

    it("propagates a REJECTING append unchanged", async () => {
      // The failure channel the whole inversion exists to preserve: a producer
      // must learn that its durable write did not commit. The emitter awaits, so
      // the rejection reaches the caller verbatim rather than becoming a
      // fire-and-forget that reported success.
      const rejectingEventLog: SessionEventLog = {
        append: (): Promise<EventLogAppendReceipt> => Promise.reject(new Error("mutex lost")),
      };

      await expect(
        new RuntimeNodeEventEmitter({ sessionEvents: rejectingEventLog }).emitOnline({
          sessionId: SESSION_ID,
          nodeId: NODE_ID,
          newState: "online",
        }),
      ).rejects.toThrow("mutex lost");
    });
  });
});

// ----------------------------------------------------------------------------
// Determinism — injected clocks + id flow through to the persisted row (D6 dep)
// ----------------------------------------------------------------------------

describe("RuntimeNodeEventEmitter — determinism (injected monotonicNow/now/newEventId)", () => {
  it("flows injected monotonicNow, now, and newEventId through to the persisted row", async () => {
    const FIXED_MONOTONIC: bigint = 4_242_000_000n;
    const FIXED_OCCURRED_AT: string = "2026-06-02T08:30:00.000Z";
    const FIXED_EVENT_ID: string = "evt-deterministic-0";

    const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
      sessionEvents: ctx.eventLog,
      monotonicNow: () => FIXED_MONOTONIC,
      now: () => FIXED_OCCURRED_AT,
      newEventId: () => FIXED_EVENT_ID,
    });

    const returned: EventLogAppendReceipt = await emitter.emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
    });

    // The receipt echoes the injected id source. `occurredAt` / `monotonicNs`
    // are no longer on the return value (the receipt carries identifiers, not
    // the envelope), so they are asserted where they actually matter — on the
    // persisted row below, which is the surface a verifier reads.
    expect(returned.id).toBe(FIXED_EVENT_ID);

    // A single emit with a constant id does not collide.
    const rows: ReadonlyArray<IntegrityRow> = readRawRows(ctx.db, SESSION_ID);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.monotonic_ns).toBe(FIXED_MONOTONIC);
    expect(row.occurred_at).toBe(FIXED_OCCURRED_AT);
  });

  it("defaults newEventId to a unique-per-emit source so successive emits do not collide on the PRIMARY KEY", async () => {
    // No `newEventId` override → the production `crypto.randomUUID()` default.
    // Two emits must produce two DISTINCT ids (a constant default would throw
    // on the second INSERT against the TEXT PRIMARY KEY).
    const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
      sessionEvents: ctx.eventLog,
    });

    const first: EventLogAppendReceipt = await emitter.emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
    });
    const second: EventLogAppendReceipt = await emitter.emitCapabilityDeclared({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      capability: "provider-driver",
      capabilityDetails: {},
    });

    expect(first.id).not.toBe(second.id);
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------
// The two T2.1-inherited normalization obligations the append path discharges
// (`Spec-006 §Canonical Serialization Rules`).
//
// Asserted against `EventLogService.append` DIRECTLY rather than through the
// emitter, and that is load-bearing: `RuntimeNodeEventEmitter` already narrows
// `actor` at its own boundary (`base.actor ?? null`), so an absent `actor` can
// never reach `append` through this emitter and an emitter-mediated arm would
// verify green against an append path with the narrowing DELETED. The
// obligations are `append()`'s per Plan-006 T3.1, so `append()` is what has to
// be driven. (T3.5 owns `src/events/__tests__/`; these arms live here so the
// obligations are not untested until that task lands, and they are the only two
// in this file that bypass the emitter.)
// ----------------------------------------------------------------------------

describe("EventLogService.append — T2.1-inherited normalization (Spec-006 §Canonical Serialization Rules)", () => {
  // Wire-legal but NON-canonical: a `+05:00` offset with no fractional seconds.
  // `EventEnvelope.occurredAt` is documented "ISO 8601" and admits it, while
  // `session_events.occurred_at` is declared RFC 3339 UTC at millisecond
  // precision. That gap is what the append path's `normalizeOccurredAt` call
  // closes, and this is the input that opens it.
  const OFFSET_OCCURRED_AT: string = "2026-06-02T13:30:00+05:00";
  const NORMALIZED_OCCURRED_AT: string = "2026-06-02T08:30:00.000Z";

  // `actor` is deliberately ABSENT — the third state (absent / null / string)
  // that the narrowing collapses. The return type is an ANNOTATION, never an
  // `as` cast on the literal: a cast would silently accept a typo'd or missing
  // member and this arm would then assert normalization over a shape the
  // append path never really sees.
  function makeUnnarrowedEnvelope(): UnsequencedEventEnvelope {
    const envelope: UnsequencedEventEnvelope = {
      id: "evt-normalize-0",
      sessionId: SessionIdSchema.parse(SESSION_ID),
      occurredAt: OFFSET_OCCURRED_AT,
      category: "runtime_node_lifecycle",
      type: "runtime_node.online",
      payload: { sessionId: SESSION_ID, nodeId: NODE_ID, newState: "online" },
      version: EventEnvelopeVersionSchema.parse("1.0"),
    };
    return envelope;
  }

  it("persists the NORMALIZED occurredAt and narrows an absent actor to null, so a verifier rehydrating the row reproduces the signed bytes", async () => {
    const receipt: EventLogAppendReceipt = await ctx.eventLog.append(makeUnnarrowedEnvelope());

    const rows: ReadonlyArray<IntegrityRow> = readRawRows(ctx.db, SESSION_ID);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    // (1) The STORED instant is the normalized one and the producer's raw
    // spelling appears nowhere. This exact-value assertion is the ONLY thing
    // that discriminates the obligation, and deliberately so: `canonicalizeEvent`
    // normalizes internally, so a row persisting the raw `+05:00` spelling still
    // VERIFIES below. The damage is to the column contract and to every lexical
    // date-range scan over `occurred_at` — invisible to signature checking.
    expect(row.occurred_at).toBe(NORMALIZED_OCCURRED_AT);
    expect(row.occurred_at).not.toBe(OFFSET_OCCURRED_AT);
    expect(isCanonicalOccurredAt(row.occurred_at)).toBe(true);

    // (2) An absent `actor` reaches storage as SQL NULL.
    expect(row.actor).toBeNull();

    // (3) The verifier's round trip — where the `actor` obligation bites.
    // Rehydrate the envelope FROM THE PERSISTED ROW through the wire schema, so
    // the row's NULL `actor` comes back as present-`null` exactly as T4.1's
    // read side will see it, then verify against that row's own integrity
    // columns. `canonicalizeEvent` emits DIFFERENT bytes for absent vs
    // present-null, so an append that signed the ABSENT shape would leave this
    // untampered row failing verification — the precise failure the narrowing
    // exists to prevent, and one no column assertion can see.
    const rehydrated: EventEnvelope = EventEnvelopeSchema.parse({
      id: receipt.id,
      sessionId: SESSION_ID,
      sequence: receipt.sequence,
      occurredAt: row.occurred_at,
      category: row.category,
      type: row.type,
      actor: row.actor,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      version: row.version,
    });

    expect(
      verifyRow(
        canonicalizeEvent(rehydrated),
        {
          prevHash: row.prev_hash,
          rowHash: row.row_hash,
          daemonSignature: row.daemon_signature,
        },
        FIXED_DAEMON_PUBLIC_KEY,
      ),
    ).toStrictEqual({ valid: true });
  });
});

// ----------------------------------------------------------------------------
// Per-event payload shapes (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`) + sessionId/actor reconciliation
// ----------------------------------------------------------------------------

describe("RuntimeNodeEventEmitter — per-event payload shapes (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", () => {
  function persistedRow(db: DatabaseType, sequence: bigint): IntegrityRow {
    const rows: ReadonlyArray<IntegrityRow> = readRawRows(db, SESSION_ID);
    const match = rows.find((r) => r.sequence === sequence);
    expect(match).toBeDefined();
    if (match === undefined) throw new Error("no row at sequence");
    return match;
  }

  function persistedPayload(db: DatabaseType, sequence: bigint): Record<string, unknown> {
    return JSON.parse(persistedRow(db, sequence).payload) as Record<string, unknown>;
  }

  it("registered → base + {capabilities, nodeVersion, platform} (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", async () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const event: EventLogAppendReceipt = await emitter.emitRegistered({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      actor: PARTICIPANT_ID,
      previousState: "registering",
      newState: "online",
      capabilities: { "provider-driver": { contractVersion: "1.0" } },
      nodeVersion: "1.4.2",
      platform: "darwin-arm64",
    });
    const payload = persistedPayload(ctx.db, BigInt(event.sequence));
    expect(persistedRow(ctx.db, BigInt(event.sequence)).type).toBe("runtime_node.registered");
    expect(payload).toEqual({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      previousState: "registering",
      newState: "online",
      actor: PARTICIPANT_ID,
      capabilities: { "provider-driver": { contractVersion: "1.0" } },
      nodeVersion: "1.4.2",
      platform: "darwin-arm64",
    });
    // Envelope actor mirrors payload actor — single reconciliation point. Read
    // off the PERSISTED row (the receipt carries identifiers only), which is a
    // strictly stronger read: it proves the reconciliation survived the write.
    expect(persistedRow(ctx.db, BigInt(event.sequence)).actor).toBe(PARTICIPANT_ID);
  });

  it("online → base (no extension), defaulting actor to null when omitted (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", async () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const event: EventLogAppendReceipt = await emitter.emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
    });
    const payload = persistedPayload(ctx.db, BigInt(event.sequence));
    expect(persistedRow(ctx.db, BigInt(event.sequence)).type).toBe("runtime_node.online");
    expect(payload).toEqual({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
      actor: null,
    });
    // Omitted actor → null on BOTH the envelope and the payload.
    expect(persistedRow(ctx.db, BigInt(event.sequence)).actor).toBeNull();
  });

  it("offline → base + {lastHeartbeatAt, reason: explicit_shutdown} (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", async () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const event: EventLogAppendReceipt = await emitter.emitOffline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      previousState: "online",
      newState: "offline",
      lastHeartbeatAt: "2026-06-02T11:59:00.000Z",
      reason: "explicit_shutdown",
    });
    const payload = persistedPayload(ctx.db, BigInt(event.sequence));
    expect(persistedRow(ctx.db, BigInt(event.sequence)).type).toBe("runtime_node.offline");
    expect(payload).toEqual({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      previousState: "online",
      newState: "offline",
      actor: null,
      lastHeartbeatAt: "2026-06-02T11:59:00.000Z",
      reason: "explicit_shutdown",
    });
  });

  it("capability_declared → reduced base + {capability, capabilityDetails} (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", async () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const event: EventLogAppendReceipt = await emitter.emitCapabilityDeclared({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      actor: PARTICIPANT_ID,
      capability: "provider-driver",
      capabilityDetails: { contractVersion: "1.0", flags: { streaming: true } },
    });
    const payload = persistedPayload(ctx.db, BigInt(event.sequence));
    expect(persistedRow(ctx.db, BigInt(event.sequence)).type).toBe(
      "runtime_node.capability_declared",
    );
    // Reduced base: NO previousState/newState NodeState fields.
    expect(payload).toEqual({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      actor: PARTICIPANT_ID,
      capability: "provider-driver",
      capabilityDetails: { contractVersion: "1.0", flags: { streaming: true } },
    });
    expect(payload).not.toHaveProperty("newState");
  });

  it("capability_updated → reduced base + {capability, previousState, newState} as snapshots (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", async () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const event: EventLogAppendReceipt = await emitter.emitCapabilityUpdated({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      capability: "provider-driver",
      // previousState/newState are CapabilityDetails SNAPSHOTS, not NodeState.
      previousState: { contractVersion: "1.0" },
      newState: { contractVersion: "1.1" },
    });
    const payload = persistedPayload(ctx.db, BigInt(event.sequence));
    expect(persistedRow(ctx.db, BigInt(event.sequence)).type).toBe(
      "runtime_node.capability_updated",
    );
    expect(payload).toEqual({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      actor: null,
      capability: "provider-driver",
      previousState: { contractVersion: "1.0" },
      newState: { contractVersion: "1.1" },
    });
  });
});
