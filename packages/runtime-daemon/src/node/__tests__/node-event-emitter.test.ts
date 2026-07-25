// RuntimeNodeEventEmitter — Plan-003 Phase 2 (T2.3).
//
// Exercises the emission seam that routes `runtime_node.*` events through
// the canonical Plan-001 `SessionService.append` path over a real test
// SQLite DB (mirrors `session-service.test.ts` lifecycle: `openDatabase`
// factory → per-test tmp file → `afterEach` close + unlink).
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * D5 (Plan-003 T2.3 required assertion / I-003-4): a persisted
//     `runtime_node.*` row carries a non-null `monotonic_ns` in the Plan-001
//     column shape with ZERO-FILLED integrity columns (asserted via a raw
//     `session_events` query, since `readEvents`/`StoredEvent` do not surface
//     the integrity blobs). Proves `monotonic_ns` is debug data the append
//     path materializes, distinct from the `sequence` replay key.
//   * Emission boundary (CP-003-1): an out-of-bounds payload field makes the
//     emit throw via the T2.0 schema's `.parse()` — the validation seam
//     actually rejects, it is not an ad-hoc object.
//   * Sequence allocation: two successive emits land at consecutive
//     sequences via the log-derive default (covers BOTH branches: empty-log
//     → 0, then last+1); injecting a custom `nextSequence` overrides it.
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
// session events); `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` (per-event payload shapes).
// Verifies invariant: I-003-4 (`monotonic_ns` is within-daemon debug data,
// not the replay key — the replay key is `sequence`).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../session/migration-runner.js";
import { SessionService } from "../../session/session-service.js";
import type { AppendableEvent, StoredEvent } from "../../session/types.js";
import { RuntimeNodeEventEmitter } from "../node-event-emitter.js";
import type { RuntimeNodeEventEmitterDeps } from "../node-event-emitter.js";

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

// The integrity-column placeholder bytes the Plan-001 append path zero-fills
// (32/32/64 per 0001-initial.ts CHECK constraints). The emitter never touches
// these; D5 asserts the append path materialized them.
const ZERO_HASH_LEN: number = 32;
const ZERO_SIGNATURE_LEN: number = 64;

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
  ctx = { db, service: new SessionService(db), tmpDir };
});

afterEach(() => {
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

function makeEmitter(
  overrides: Partial<RuntimeNodeEventEmitterDeps> = {},
): RuntimeNodeEventEmitter {
  return new RuntimeNodeEventEmitter({
    sessionEvents: ctx.service,
    newEventId: makeCounterIdSource("evt"),
    ...overrides,
  });
}

// ----------------------------------------------------------------------------
// D5 — monotonic_ns persisted, integrity columns zero-filled (I-003-4)
// ----------------------------------------------------------------------------

describe("RuntimeNodeEventEmitter — D5 (monotonic_ns + zero-filled integrity columns)", () => {
  it("persists a runtime_node.* row with non-null monotonic_ns and zero-filled integrity columns", () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter({
      monotonicNow: () => 7_000_000_000n,
    });

    emitter.emitRegistered({
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

    // Integrity columns are zero-filled by the append path (the emitter never
    // computes them). Buffers of the exact CHECK-constraint widths, all bytes
    // zero. participant_signature stays NULL.
    expect(row.prev_hash.length).toBe(ZERO_HASH_LEN);
    expect(row.row_hash.length).toBe(ZERO_HASH_LEN);
    expect(row.daemon_signature.length).toBe(ZERO_SIGNATURE_LEN);
    expect(row.prev_hash.equals(Buffer.alloc(ZERO_HASH_LEN))).toBe(true);
    expect(row.row_hash.equals(Buffer.alloc(ZERO_HASH_LEN))).toBe(true);
    expect(row.daemon_signature.equals(Buffer.alloc(ZERO_SIGNATURE_LEN))).toBe(true);
    expect(row.participant_signature).toBeNull();

    // The row carries the runtime-node type + the Plan-001-owned category.
    expect(row.type).toBe("runtime_node.registered");
    expect(row.category).toBe("runtime_node_lifecycle");
    expect(row.version).toBe("1.0");
  });

  it("allocates a monotonic sequence even when monotonic_ns runs backwards — emission half of I-003-4 (D6 owns the replay-read proof)", () => {
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

    emitter.emitRegistered({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "registering",
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });
    emitter.emitCapabilityDeclared({
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
//   * `nextSequence` is INJECTED, so the fixture does not derive `sequence`
//     through the very `readEvents` under test. Otherwise a regression that
//     reordered the read would feed `#deriveNextSequence` a stale tail and
//     collide on `UNIQUE(session_id, sequence)` during emit — masking the
//     replay-read assertion behind a write-time throw.
//   * `monotonic_ns` is NON-monotonic (mirrors legacy D3's [5e9,1e9,3e9]): it
//     sorts to an order matching NEITHER the ascending nor descending sequence
//     direction, so a read keyed on monotonic_ns in either direction reorders
//     the events and trips the `sequence` assertion.

describe("RuntimeNodeEventEmitter — D6 (replay reads emitter-produced events by sequence, not monotonic_ns)", () => {
  it("readEvents returns runtime_node.* events in sequence order even when monotonic_ns sorts to neither direction", () => {
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
    let nextSequenceValue: number = 0;
    const emitter: RuntimeNodeEventEmitter = makeEmitter({
      monotonicNow: () => {
        const value: bigint | undefined = monotonicByEmit[monotonicIndex];
        monotonicIndex += 1;
        return value ?? 0n;
      },
      // Pin sequence to [0,1,2,3] independent of `readEvents` (the SUT) — see
      // the block comment above for why the default log-derive allocator would
      // mask the regression this guard targets.
      nextSequence: () => nextSequenceValue++,
    });

    // A canonical node lifecycle, emitted in order through the T2.3 seam:
    // registered → capability_declared → online → offline.
    emitter.emitRegistered({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "registering",
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });
    emitter.emitCapabilityDeclared({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      capability: "provider-driver",
      capabilityDetails: { contractVersion: "1.0" },
    });
    emitter.emitOnline({ sessionId: SESSION_ID, nodeId: NODE_ID, newState: "online" });
    emitter.emitOffline({
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
  it("throws and persists nothing when a payload field violates its schema (over-length nodeVersion)", () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    // `nodeVersion` cap is RUNTIME_NODE_VERSION_MAX_LEN = 64; 65 chars trips
    // the schema's length bound. Type-`string`-valid, so this exercises the
    // RUNTIME `.parse()` validation seam (not a TypeScript error).
    const overLengthVersion: string = "9".repeat(65);

    expect(() =>
      emitter.emitRegistered({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        newState: "online",
        capabilities: {},
        nodeVersion: overLengthVersion,
        platform: "darwin-arm64",
      }),
    ).toThrow();

    // The throw happens at the emission boundary BEFORE the append, so no row
    // was persisted — the validation seam is a true gate, not post-hoc.
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects an invalid offline `reason` (not in the Spec-006 enum) at the emission boundary", () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    expect(() =>
      emitter.emitOffline({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        newState: "offline",
        lastHeartbeatAt: "2026-06-02T12:00:00.000Z",
        // Force an out-of-enum value past the typed input via a narrow cast —
        // the schema enum is the runtime gate, and it must reject.
        reason: "bogus_reason" as "explicit_shutdown",
      }),
    ).toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a non-ISO `lastHeartbeatAt` (the offline path's second validated field) at the emission boundary", () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    expect(() =>
      emitter.emitOffline({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        newState: "offline",
        // The schema is `z.iso.datetime({ offset: true })` — a bare date with no
        // time or offset is not a valid RFC 3339 timestamp and must be rejected.
        lastHeartbeatAt: "2026-06-02",
        reason: "explicit_shutdown",
      }),
    ).toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Sequence allocation — log-derive default + custom override
// ----------------------------------------------------------------------------

describe("RuntimeNodeEventEmitter — sequence allocation", () => {
  it("allocates consecutive sequences via the log-derive default (empty-log → 0, then last + 1)", () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();

    const first: AppendableEvent = emitter.emitRegistered({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "registering",
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });
    const second: AppendableEvent = emitter.emitCapabilityDeclared({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      capability: "provider-driver",
      capabilityDetails: { contractVersion: "1.0" },
    });

    // Both branches of the default allocator: empty log → 0, then last + 1.
    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);

    const rows: ReadonlyArray<IntegrityRow> = readRawRows(ctx.db, SESSION_ID);
    expect(rows.map((r) => r.sequence)).toEqual([0n, 1n]);
  });

  it("continues the sequence from pre-existing durable events on the same session", () => {
    // Seed two non-runtime-node events directly, so the log-derive default
    // must start AFTER them — proving it reads the durable log, not a counter.
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
    const emitted: AppendableEvent = emitter.emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
    });

    expect(emitted.sequence).toBe(2);
  });

  it("uses an injected custom nextSequence allocator over the log-derive default", () => {
    const customAllocations: number[] = [100, 101];
    let allocationIndex: number = 0;
    const emitter: RuntimeNodeEventEmitter = makeEmitter({
      nextSequence: () => {
        const next: number | undefined = customAllocations[allocationIndex];
        allocationIndex += 1;
        return next ?? 999;
      },
    });

    const first: AppendableEvent = emitter.emitRegistered({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "registering",
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });
    const second: AppendableEvent = emitter.emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
    });

    expect(first.sequence).toBe(100);
    expect(second.sequence).toBe(101);
    expect(readRawRows(ctx.db, SESSION_ID).map((r) => r.sequence)).toEqual([100n, 101n]);
  });

  it("surfaces the append UNIQUE(session_id, sequence) throw when an allocator yields a duplicate sequence", () => {
    // Backstop proof: if a (buggy) allocator hands out a colliding sequence,
    // the Plan-001 append path's UNIQUE constraint is the safety net.
    const emitter: RuntimeNodeEventEmitter = makeEmitter({
      nextSequence: () => 5, // always the same — second emit must collide
    });

    emitter.emitOnline({ sessionId: SESSION_ID, nodeId: NODE_ID, newState: "online" });
    expect(() =>
      emitter.emitOnline({ sessionId: SESSION_ID, nodeId: NODE_ID, newState: "online" }),
    ).toThrow();

    // The UNIQUE throw is the ONLY effect: the first emit's row survives and the
    // colliding second emit left no partial state (a single-statement INSERT, so
    // the constraint violation persists nothing of the second event).
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// Determinism — injected clocks + id flow through to the persisted row (D6 dep)
// ----------------------------------------------------------------------------

describe("RuntimeNodeEventEmitter — determinism (injected monotonicNow/now/newEventId)", () => {
  it("flows injected monotonicNow, now, and newEventId through to the persisted row", () => {
    const FIXED_MONOTONIC: bigint = 4_242_000_000n;
    const FIXED_OCCURRED_AT: string = "2026-06-02T08:30:00.000Z";
    const FIXED_EVENT_ID: string = "evt-deterministic-0";

    const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
      sessionEvents: ctx.service,
      monotonicNow: () => FIXED_MONOTONIC,
      now: () => FIXED_OCCURRED_AT,
      newEventId: () => FIXED_EVENT_ID,
    });

    const returned: AppendableEvent = emitter.emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
    });

    // The returned event reflects the injected sources...
    expect(returned.id).toBe(FIXED_EVENT_ID);
    expect(returned.monotonicNs).toBe(FIXED_MONOTONIC);
    expect(returned.occurredAt).toBe(FIXED_OCCURRED_AT);

    // ...and so does the persisted row (a single emit with a constant id does
    // not collide).
    const rows: ReadonlyArray<IntegrityRow> = readRawRows(ctx.db, SESSION_ID);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.monotonic_ns).toBe(FIXED_MONOTONIC);
    expect(row.occurred_at).toBe(FIXED_OCCURRED_AT);
  });

  it("defaults newEventId to a unique-per-emit source so successive emits do not collide on the PRIMARY KEY", () => {
    // No `newEventId` override → the production `crypto.randomUUID()` default.
    // Two emits must produce two DISTINCT ids (a constant default would throw
    // on the second INSERT against the TEXT PRIMARY KEY).
    const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
      sessionEvents: ctx.service,
    });

    const first: AppendableEvent = emitter.emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
    });
    const second: AppendableEvent = emitter.emitCapabilityDeclared({
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
// Per-event payload shapes (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`) + sessionId/actor reconciliation
// ----------------------------------------------------------------------------

describe("RuntimeNodeEventEmitter — per-event payload shapes (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", () => {
  function persistedPayload(db: DatabaseType, sequence: bigint): Record<string, unknown> {
    const rows: ReadonlyArray<IntegrityRow> = readRawRows(db, SESSION_ID);
    const match = rows.find((r) => r.sequence === sequence);
    expect(match).toBeDefined();
    if (match === undefined) throw new Error("no row at sequence");
    return JSON.parse(match.payload) as Record<string, unknown>;
  }

  it("registered → base + {capabilities, nodeVersion, platform} (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const event: AppendableEvent = emitter.emitRegistered({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      actor: PARTICIPANT_ID,
      previousState: "registering",
      newState: "online",
      capabilities: { "provider-driver": { contractVersion: "1.0" } },
      nodeVersion: "1.4.2",
      platform: "darwin-arm64",
    });
    expect(event.type).toBe("runtime_node.registered");

    const payload = persistedPayload(ctx.db, BigInt(event.sequence));
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
    // Envelope actor mirrors payload actor — single reconciliation point.
    expect(event.actor).toBe(PARTICIPANT_ID);
  });

  it("online → base (no extension), defaulting actor to null when omitted (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const event: AppendableEvent = emitter.emitOnline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
    });
    expect(event.type).toBe("runtime_node.online");

    const payload = persistedPayload(ctx.db, BigInt(event.sequence));
    expect(payload).toEqual({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "online",
      actor: null,
    });
    // Omitted actor → null on BOTH the envelope and the payload.
    expect(event.actor).toBeNull();
  });

  it("offline → base + {lastHeartbeatAt, reason: explicit_shutdown} (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const event: AppendableEvent = emitter.emitOffline({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      previousState: "online",
      newState: "offline",
      lastHeartbeatAt: "2026-06-02T11:59:00.000Z",
      reason: "explicit_shutdown",
    });
    expect(event.type).toBe("runtime_node.offline");

    const payload = persistedPayload(ctx.db, BigInt(event.sequence));
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

  it("capability_declared → reduced base + {capability, capabilityDetails} (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const event: AppendableEvent = emitter.emitCapabilityDeclared({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      actor: PARTICIPANT_ID,
      capability: "provider-driver",
      capabilityDetails: { contractVersion: "1.0", flags: { streaming: true } },
    });
    expect(event.type).toBe("runtime_node.capability_declared");

    const payload = persistedPayload(ctx.db, BigInt(event.sequence));
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

  it("capability_updated → reduced base + {capability, previousState, newState} as snapshots (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", () => {
    const emitter: RuntimeNodeEventEmitter = makeEmitter();
    const event: AppendableEvent = emitter.emitCapabilityUpdated({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      capability: "provider-driver",
      // previousState/newState are CapabilityDetails SNAPSHOTS, not NodeState.
      previousState: { contractVersion: "1.0" },
      newState: { contractVersion: "1.1" },
    });
    expect(event.type).toBe("runtime_node.capability_updated");

    const payload = persistedPayload(ctx.db, BigInt(event.sequence));
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
