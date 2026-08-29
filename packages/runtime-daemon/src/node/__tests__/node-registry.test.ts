// NodeRegistry — Plan-003 Phase 2 (T2.1).
//
// Exercises durable node identity + the dual-write-with-transaction registration
// path over a real test SQLite DB (mirrors `node-event-emitter.test.ts` /
// `session-service.test.ts` lifecycle: `openDatabase` factory → per-test tmp
// file → `afterEach` close + unlink). The production composition is wired here
// verbatim: `SessionService(db)` → `RuntimeNodeEventEmitter({ sessionEvents })`
// → `NodeRegistry(db, emitter)`, all over the SAME `db` handle, because the
// transaction's atomicity depends on the emitter's append running on that
// connection.
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * D1 (Plan-003 T2.1 / `Spec-003 §State And Data Implications` + `Spec-003 §Implementation Notes`, AC1): register a node, CLOSE + REOPEN
//     the DB handle, build a fresh registry over the reopened DB, `lookup` →
//     the same node identity is recoverable from the durable row. Proves
//     identity is SQLite-durable, not in-memory state.
//   * I-003-3 (registration records a node without mutating membership): a
//     successful register touches `node_trust_state` + `session_events` ONLY,
//     and the timeline event is the audit-distinct `runtime_node.registered`
//     type. (Membership lives in control-plane Postgres `session_memberships`,
//     NOT in the daemon's Local SQLite schema — so the daemon registry is
//     STRUCTURALLY incapable of mutating it: the table is absent here, asserted
//     below. The end-to-end no-membership-mutation proof is a Phase-3
//     control-plane concern; P7/P8.)
//   * Atomicity, two arms — the `nextSequence` injection seam they used to ride
//     is gone with the T3.1 re-point, so each drives a REAL failure of the real
//     append path instead. (a) ROLLBACK: the emitter is pinned to an event id
//     that already exists, so the event INSERT violates `session_events`' PRIMARY
//     KEY AFTER the upsert prelude ran inside the transaction — the
//     `node_trust_state` upsert rolls back (no row). (b) The stronger property
//     the re-point bought: a signing-key source that REJECTS makes the append
//     refuse before opening its transaction, so the prelude never runs at all
//     and there is no partial state to roll back.
//   * Happy-path emit shape: exactly one `runtime_node.registered` row lands in
//     `session_events` with the `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` payload shape.
//   * `Spec-003 §Pitfalls To Avoid` (no implicit capability exposure on attach): registering a node
//     that CARRIES capabilities on the wire writes ZERO `node_capabilities` rows —
//     only an explicit `declare` (T2.2) makes a capability schedulable, never
//     `register` (least privilege; the wire capabilities are replay-only).
//   * Re-register: a second register preserves `established_at` + `trust_level`
//     and refreshes only `updated_at` (registration never elevates trust).
//   * The lifecycle observer seam (the wiring point Plan-005 T3.12 / P2-9 names
//     for starting and stopping a node's capability/auth refresh cadence):
//     fires with the node AND session context after a SETTLED register and on
//     detach; does NOT fire when the registration rolled back inside its
//     transaction; and a THROWING observer neither fails a register/detach nor
//     goes unreported.
//   * T2.5 / D4 (detach + reconnect under stable node identity, I-003-3): detach
//     emits exactly one `runtime_node.offline` (reason `explicit_shutdown`,
//     newState `offline`, previousState `online`, non-empty ISO `lastHeartbeatAt`)
//     and LEAVES the `node_trust_state` row INTACT — so `lookup` still resolves the
//     node after detach, and a reconnect register resolves the SAME identity with
//     `established_at` preserved from the first registration.
//
// Spec coverage: `Spec-003 §Fallback Behavior` (disconnected node keeps membership; reconnect
// under same identity — the T2.5 detach path), `Spec-003 §State And Data Implications`
// (durable runtime-node records), `Spec-003 §Implementation Notes`
// (node identity stable across reconnect), `Spec-003 §Pitfalls To Avoid`
// (no implicit capability exposure on attach), and
// `Spec-003 §Acceptance Criteria` AC1. Verifies invariant: I-003-3
// (registration records a node without mutating membership; detach does not revoke
// membership).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionId } from "@ai-sidekicks/contracts";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { openDatabase } from "../../session/migration-runner.js";
import { SessionService, UnsignedPlaceholderAppendToken } from "../../session/session-service.js";
import type {
  NodeRegistryOptions,
  NodeTrustStateRow,
  RuntimeNodeLifecycleContext,
  RuntimeNodeLifecycleObserver,
} from "../node-registry.js";
import { NodeRegistry } from "../node-registry.js";
import { RuntimeNodeEventEmitter } from "../node-event-emitter.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// UUIDv7-format session id (validated through the payload schema's
// `SessionIdSchema`), matching the emitter test's fixture.
const SESSION_ID: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
// `NodeId` is a daemon-minted opaque scalar (min 1, max 256), NOT a UUID.
const NODE_ID: string = "node-01J0ND0000NN5J5J5J5J5J5J";
// `actor` is the EventEnvelope free-form actor string (here a ULID).
const PARTICIPANT_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";

// Raw read shape for the persisted `runtime_node.registered` event. The
// integrity columns are not relevant here (D5 owns them); we read the payload +
// type to assert the `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` shape.
interface EventRow {
  readonly sequence: bigint;
  readonly type: string;
  readonly category: string;
  readonly payload: string;
}

function readEventRows(db: DatabaseType, sessionId: string): ReadonlyArray<EventRow> {
  return db
    .prepare(
      `SELECT sequence, type, category, payload
         FROM session_events
        WHERE session_id = ?
        ORDER BY sequence ASC`,
    )
    .safeIntegers(true)
    .all(sessionId) as ReadonlyArray<EventRow>;
}

function readTrustRows(db: DatabaseType, nodeId: string): ReadonlyArray<NodeTrustStateRow> {
  return db
    .prepare(
      `SELECT node_id, trust_level, established_at, updated_at
         FROM node_trust_state
        WHERE node_id = ?`,
    )
    .all(nodeId) as ReadonlyArray<NodeTrustStateRow>;
}

// Count `node_capabilities` rows for a node — used to prove that registration
// does NOT populate the capability table (`Spec-003 §Pitfalls To Avoid`, no implicit capability
// exposure on attach: declaration is the ONLY path that makes a capability
// schedulable, never registration, even when `register` carries capabilities).
function capabilityRowCount(db: DatabaseType, nodeId: string): number {
  const row: { count: number } = db
    .prepare("SELECT COUNT(*) AS count FROM node_capabilities WHERE node_id = ?")
    .get(nodeId) as { count: number };
  return row.count;
}

// Count the Local SQLite tables touched by registration. `session_memberships`
// is intentionally NOT one of them — it is a control-plane Postgres table, not
// part of this daemon schema (see migrations/0001-initial.ts).
function tableExists(db: DatabaseType, tableName: string): boolean {
  const row: { count: number } = db
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { count: number };
  return row.count > 0;
}

function tableRowCount(db: DatabaseType, tableName: string): number {
  const row: { count: number } = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as {
    count: number;
  };
  return row.count;
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle (mirrors node-event-emitter.test.ts)
// ----------------------------------------------------------------------------

interface TestContext {
  db: DatabaseType;
  dbPath: string;
  tmpDir: string;
}

let ctx: TestContext;

beforeEach(() => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-node-registry-test-"));
  const dbPath: string = join(tmpDir, "test.db");
  // Canonical factory — same pragmas + migrations as production. No session row
  // is seeded (the `session_events` table has no FK on `session_id`).
  const db: DatabaseType = openDatabase(dbPath);
  ctx = { db, dbPath, tmpDir };
});

afterEach(() => {
  // The per-session append lock is a module singleton — reset between cases so
  // a leftover queue entry cannot stall the next case as an unrelated timeout.
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

// Wire the Phase-2 object graph over the current `ctx.db`: same handle
// shared by SessionService, the emitter, and the registry. `now` is injectable
// for deterministic timestamp assertions; the emitter id source is a collision-
// free counter so multiple emits never violate the `TEXT PRIMARY KEY`. The
// seam is ASYNC-TRANSACTIONAL post the Plan-006 T3.1 re-point
// (node-event-emitter.ts's header owns the contract): `EventLogService.append`
// over the SAME connection backs it, which is what lets the registry's
// trust-state write travel as a `transactionalPrelude`.
function makeRegistry(now: () => string = () => "2026-06-02T12:00:00.000Z"): NodeRegistry {
  let idCounter: number = 0;
  const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
    sessionEvents: makeEventLog(),
    newEventId: () => `evt-${(idCounter++).toString()}`,
  });
  return new NodeRegistry(ctx.db, emitter, now);
}

/**
 * The production append path over `ctx.db` — Plan-006 T3.1's `EventLogService`,
 * which the T3.1 re-point made this emitter's seam. SAME connection as the
 * registry, which is the wiring contract: the registry's upsert travels as a
 * `transactionalPrelude` and must join the append's transaction, and
 * better-sqlite3 transactions are connection-level.
 */
function makeEventLog(): EventLogService {
  return new EventLogService({ db: ctx.db, signingKeySource: new FixedDaemonSigningKeySource() });
}

/** Fixed-key signing source — this suite is about the dual-write, not custody. */
class FixedDaemonSigningKeySource implements DaemonSigningKeySource {
  readonly #privateKey: Ed25519PrivateKey = new Uint8Array(32).fill(7) as Ed25519PrivateKey;

  read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
    return Promise.resolve(this.#privateKey);
  }

  create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
    return Promise.reject(
      new Error("FixedDaemonSigningKeySource.create is not used by this suite"),
    );
  }
}

// ----------------------------------------------------------------------------
// D1 — durable identity recovered across DB reopen (`Spec-003 §State And Data Implications` + `Spec-003 §Implementation Notes`, AC1)
// ----------------------------------------------------------------------------

describe("NodeRegistry — D1 (durable identity across DB reopen)", () => {
  it("recovers the registered node identity from SQLite after close + reopen", async () => {
    const registry: NodeRegistry = makeRegistry();
    await registry.register({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capabilities: { "provider-driver": { contractVersion: "1.0" } },
      nodeVersion: "1.4.2",
      platform: "darwin-arm64",
    });

    // Before reopen: the row is present (registered iff a row exists).
    expect(registry.lookup(NODE_ID)?.node_id).toBe(NODE_ID);

    // Close the handle and REOPEN a fresh one over the same file — this is the
    // restart proof. Identity must survive without any in-memory state.
    ctx.db.close();
    ctx.db = openDatabase(ctx.dbPath);

    // A brand-new registry over the reopened DB recovers the SAME identity by
    // READING the durable row (not by replaying events).
    const reopenedRegistry: NodeRegistry = makeRegistry();
    const recovered: NodeTrustStateRow | undefined = reopenedRegistry.lookup(NODE_ID);
    expect(recovered).toBeDefined();
    expect(recovered?.node_id).toBe(NODE_ID);
    expect(recovered?.trust_level).toBe("untrusted");
  });

  it("returns undefined from lookup for a node that was never registered", () => {
    const registry: NodeRegistry = makeRegistry();
    expect(registry.lookup("node-never-registered")).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// I-003-3 — registration records a node without mutating membership
// ----------------------------------------------------------------------------

describe("NodeRegistry — I-003-3 (registration does not mutate session_memberships)", () => {
  it("writes only node_trust_state + a distinct runtime_node.registered event; membership is structurally untouchable here", async () => {
    const registry: NodeRegistry = makeRegistry();

    // Structural proof: the daemon Local SQLite schema has NO session_memberships
    // table (it is a control-plane Postgres surface), so the registry CANNOT
    // mutate membership — there is nothing here to mutate.
    expect(tableExists(ctx.db, "session_memberships")).toBe(false);

    // Capture the row counts of the tables that DO exist before registering, so
    // we can prove registration touched only the two expected tables.
    const beforeSnapshots: number = tableRowCount(ctx.db, "session_snapshots");
    const beforeParticipantKeys: number = tableRowCount(ctx.db, "participant_keys");

    await registry.register({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });

    // The node is recorded: a trust row + a single timeline event whose type is
    // the audit-DISTINCT `runtime_node.registered` (I-003-3's audit-trail clause:
    // attach surfaces as its own event, never as a membership change).
    expect(readTrustRows(ctx.db, NODE_ID)).toHaveLength(1);
    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("runtime_node.registered");

    // No OTHER Local SQLite table was written — registration is scoped to
    // node_trust_state + session_events.
    expect(tableRowCount(ctx.db, "session_snapshots")).toBe(beforeSnapshots);
    expect(tableRowCount(ctx.db, "participant_keys")).toBe(beforeParticipantKeys);
  });
});

// ----------------------------------------------------------------------------
// Happy-path emit shape (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`) + envelope wiring + `Spec-003 §Pitfalls To Avoid`
// (no implicit capability exposure on attach)
// ----------------------------------------------------------------------------

describe("NodeRegistry — emits runtime_node.registered (Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`))", () => {
  it("lands exactly one runtime_node.registered event with the Spec-006 §Runtime Node Lifecycle (`runtime_node_lifecycle`) payload shape and exposes NO capability (`Spec-003 §Pitfalls To Avoid`)", async () => {
    const registry: NodeRegistry = makeRegistry();
    await registry.register({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      actor: PARTICIPANT_ID,
      // Register CARRYING capabilities on the wire — the registered event
      // replays them, but they must NOT be persisted as schedulable
      // `node_capabilities` rows (`Spec-003 §Pitfalls To Avoid`, asserted below).
      capabilities: { "provider-driver": { contractVersion: "1.0" } },
      nodeVersion: "1.4.2",
      platform: "darwin-arm64",
    });

    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.type).toBe("runtime_node.registered");
    expect(event.category).toBe("runtime_node_lifecycle");

    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    // `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` shape: base + {capabilities, nodeVersion, platform}. The
    // initial lifecycle event carries newState `registering` and NO
    // `previousState` (registration is the first transition — the schema's
    // `.optional()` previousState is stripped when omitted).
    expect(payload).toEqual({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      newState: "registering",
      actor: PARTICIPANT_ID,
      capabilities: { "provider-driver": { contractVersion: "1.0" } },
      nodeVersion: "1.4.2",
      platform: "darwin-arm64",
    });
    expect(payload).not.toHaveProperty("previousState");

    // `Spec-003 §Pitfalls To Avoid` — no implicit capability exposure on attach: even though the
    // wire `capabilities` carried a "provider-driver" entry, registration wrote
    // ZERO `node_capabilities` rows. Only an explicit `NodeCapabilityService.declare`
    // (T2.2) makes a capability schedulable, never `register` (least privilege).
    expect(capabilityRowCount(ctx.db, NODE_ID)).toBe(0);
  });

  it("defaults the actor to null when omitted (system actor) and keeps trust at 'untrusted'", async () => {
    const registry: NodeRegistry = makeRegistry();
    await registry.register({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });

    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    const event = events[0];
    expect(event).toBeDefined();
    if (event === undefined) return;
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    expect(payload["actor"]).toBeNull();

    // Registration does NOT elevate trust — the row stays at the schema default.
    expect(registry.lookup(NODE_ID)?.trust_level).toBe("untrusted");
  });
});

// ----------------------------------------------------------------------------
// Re-registration — preserves established_at + trust_level, refreshes updated_at
// ----------------------------------------------------------------------------

describe("NodeRegistry — re-registration preserves established_at + trust_level", () => {
  it("on re-register, updates only updated_at and preserves established_at + trust_level", async () => {
    // An advancing clock so the two registrations carry distinct timestamps —
    // this is what proves established_at is PRESERVED (not reset) while
    // updated_at is REFRESHED on the conflict path.
    const timestamps: string[] = ["2026-06-02T12:00:00.000Z", "2026-06-02T13:30:00.000Z"];
    let clockIndex: number = 0;
    const registry: NodeRegistry = makeRegistry(() => {
      const value: string | undefined = timestamps[clockIndex];
      clockIndex += 1;
      return value ?? "2026-06-02T23:59:59.000Z";
    });

    await registry.register({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });
    const afterFirst: NodeTrustStateRow | undefined = registry.lookup(NODE_ID);
    expect(afterFirst?.established_at).toBe("2026-06-02T12:00:00.000Z");
    expect(afterFirst?.updated_at).toBe("2026-06-02T12:00:00.000Z");

    await registry.register({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capabilities: { "provider-driver": { contractVersion: "2.0" } },
      nodeVersion: "2.0.0",
      platform: "linux-x64",
    });
    const afterSecond: NodeTrustStateRow | undefined = registry.lookup(NODE_ID);
    // established_at PRESERVED (first registration's timestamp)...
    expect(afterSecond?.established_at).toBe("2026-06-02T12:00:00.000Z");
    // ...updated_at REFRESHED to the second registration's timestamp...
    expect(afterSecond?.updated_at).toBe("2026-06-02T13:30:00.000Z");
    // ...trust_level untouched.
    expect(afterSecond?.trust_level).toBe("untrusted");

    // Both registrations emitted a timeline event (re-register is a real event).
    expect(readEventRows(ctx.db, SESSION_ID)).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------
// Atomicity — a throwing emit rolls back the node_trust_state upsert
// ----------------------------------------------------------------------------

describe("NodeRegistry — atomicity (a failed event write leaves no trust-state upsert)", () => {
  it("rolls back the node_trust_state upsert when the event INSERT throws inside the transaction", async () => {
    // The registry's upsert is now a `transactionalPrelude` that runs INSIDE the
    // append's transaction, immediately BEFORE the event-row INSERT. To exercise
    // ROLLBACK specifically, the failure must land AFTER the prelude has already
    // applied — so the emitter is pinned to an event id that ALREADY EXISTS,
    // making the INSERT violate `session_events`' TEXT PRIMARY KEY. A
    // pre-transaction refusal would not test rollback at all (the next case
    // covers that stronger property separately).
    const seedingService: SessionService = new SessionService(ctx.db, {
      allowUnsignedPlaceholderAppend: UnsignedPlaceholderAppendToken.forTestsOnly(),
    });
    seedingService.append({
      id: "evt-collide",
      sessionId: SESSION_ID,
      sequence: 0,
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

    const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
      sessionEvents: makeEventLog(),
      newEventId: () => "evt-collide",
    });
    const registry: NodeRegistry = new NodeRegistry(ctx.db, emitter);

    await expect(
      registry.register({
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        capabilities: {},
        nodeVersion: "1.0.0",
        platform: "linux-x64",
      }),
    ).rejects.toThrow(/UNIQUE|PRIMARY KEY|constraint/i);

    // The upsert rolled back with the failed INSERT: no trust row, and the only
    // event on the session is the seed (the registered event never landed).
    expect(readTrustRows(ctx.db, NODE_ID)).toHaveLength(0);
    expect(registry.lookup(NODE_ID)).toBeUndefined();
    expect(readEventRows(ctx.db, SESSION_ID)).toHaveLength(1);
  });

  it("never RUNS the upsert when the append refuses before opening its transaction", async () => {
    // The property the re-point made STRONGER than rollback. A refusal raised
    // before the transaction opens — here a signing-key failure, in production
    // also the ingest-halt gate — means the prelude never executes at all, so
    // there is no partial state to roll back in the first place. Distinct from
    // the case above, and worth its own control: a regression that moved the
    // prelude ahead of the append's pre-transaction checks would still pass the
    // rollback test while breaking this one.
    class FailingSigningKeySource implements DaemonSigningKeySource {
      read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
        return Promise.reject(new Error("key unseal refused"));
      }
      create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
        return Promise.reject(new Error("unused"));
      }
    }
    const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
      sessionEvents: new EventLogService({
        db: ctx.db,
        signingKeySource: new FailingSigningKeySource(),
      }),
    });
    const registry: NodeRegistry = new NodeRegistry(ctx.db, emitter);

    await expect(
      registry.register({
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        capabilities: {},
        nodeVersion: "1.0.0",
        platform: "linux-x64",
      }),
    ).rejects.toThrow("key unseal refused");

    expect(readTrustRows(ctx.db, NODE_ID)).toHaveLength(0);
    expect(readEventRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// T2.5 / D4 — detach emits offline + leaves registration intact (I-003-3);
// reconnect resolves the SAME identity under the same node id
// ----------------------------------------------------------------------------

describe("NodeRegistry — T2.5/D4 (detach + reconnect under stable node identity, I-003-3)", () => {
  it("emits exactly one explicit_shutdown offline event, leaves the trust row intact, and reconnects to the same identity", async () => {
    // An advancing clock so the first registration, the detach's default
    // lastHeartbeatAt, and the reconnect registration carry DISTINCT timestamps —
    // this is what makes the established_at-PRESERVED assertion non-vacuous (a
    // re-register that reset established_at would surface as the reconnect's later
    // timestamp).
    const timestamps: string[] = [
      "2026-06-02T12:00:00.000Z", // first register → established_at + updated_at
      "2026-06-02T12:05:00.000Z", // detach's default lastHeartbeatAt
      "2026-06-02T12:10:00.000Z", // reconnect register → refreshes updated_at only
    ];
    let clockIndex: number = 0;
    const registry: NodeRegistry = makeRegistry(() => {
      const value: string | undefined = timestamps[clockIndex];
      clockIndex += 1;
      return value ?? "2026-06-02T23:59:59.000Z";
    });

    await registry.register({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });
    const afterRegister: NodeTrustStateRow | undefined = registry.lookup(NODE_ID);
    expect(afterRegister?.established_at).toBe("2026-06-02T12:00:00.000Z");

    // Detach with the explicit-shutdown call-site supplying previousState "online"
    // (the method invents no default; the explicit-shutdown producer supplies it).
    await registry.detach({ nodeId: NODE_ID, sessionId: SESSION_ID, previousState: "online" });

    // Exactly one offline event: register (1) + offline (1) = 2 total events; the
    // second is the offline.
    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    expect(events.map((e) => e.type)).toEqual(["runtime_node.registered", "runtime_node.offline"]);
    const offlineEvent = events[1];
    expect(offlineEvent).toBeDefined();
    if (offlineEvent === undefined) return;
    const payload = JSON.parse(offlineEvent.payload) as Record<string, unknown>;
    // reason HARDCODED explicit_shutdown (detach is the explicit-shutdown producer);
    // newState offline; previousState forwarded as the call site supplied; and a
    // non-empty ISO lastHeartbeatAt defaulted from the injected clock (never null —
    // the node IS heard from at explicit shutdown).
    expect(payload["reason"]).toBe("explicit_shutdown");
    expect(payload["newState"]).toBe("offline");
    expect(payload["previousState"]).toBe("online");
    expect(payload["lastHeartbeatAt"]).toBe("2026-06-02T12:05:00.000Z");

    // I-003-3 — detach does NOT revoke membership: the node_trust_state row is left
    // INTACT, so lookup still resolves the node after detach (the untouched row is
    // what enables reconnect under the same identity).
    const afterDetach: NodeTrustStateRow | undefined = registry.lookup(NODE_ID);
    expect(afterDetach).toBeDefined();
    expect(afterDetach?.node_id).toBe(NODE_ID);
    // detach is emit-only — it touched neither established_at nor updated_at.
    expect(afterDetach?.established_at).toBe("2026-06-02T12:00:00.000Z");
    expect(afterDetach?.updated_at).toBe("2026-06-02T12:00:00.000Z");

    // Reconnect under the SAME node id (a fresh register) → lookup resolves the SAME
    // identity: same node_id, and established_at PRESERVED from the first
    // registration (`Spec-003 §Implementation Notes` — node identity stable across reconnect).
    await registry.register({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });
    const afterReconnect: NodeTrustStateRow | undefined = registry.lookup(NODE_ID);
    expect(afterReconnect?.node_id).toBe(NODE_ID);
    expect(afterReconnect?.established_at).toBe("2026-06-02T12:00:00.000Z");
    // updated_at refreshed by the reconnect register (proves it is the same durable
    // row being re-registered, not a new identity).
    expect(afterReconnect?.updated_at).toBe("2026-06-02T12:10:00.000Z");
  });
});

// ----------------------------------------------------------------------------
// The runtime-node lifecycle observer seam — the sanctioned wiring point the
// provider subsystem's per-node refresh cadence attaches to (Plan-005 T3.12 /
// P2-9). Three properties, each with a distinct failure it forecloses.
// ----------------------------------------------------------------------------

/** A recording observer plus the failures its throwing variant reports. */
interface RecordedLifecycle {
  readonly observer: RuntimeNodeLifecycleObserver;
  readonly registered: RuntimeNodeLifecycleContext[];
  readonly detached: RuntimeNodeLifecycleContext[];
}

function makeRecordingObserver(throwOnEveryCall: boolean = false): RecordedLifecycle {
  const registered: RuntimeNodeLifecycleContext[] = [];
  const detached: RuntimeNodeLifecycleContext[] = [];
  return {
    observer: {
      onNodeRegistered(context: RuntimeNodeLifecycleContext): void {
        registered.push(context);
        if (throwOnEveryCall) {
          throw new Error("observer refused the registration notification");
        }
      },
      onNodeDetached(context: RuntimeNodeLifecycleContext): void {
        detached.push(context);
        if (throwOnEveryCall) {
          throw new Error("observer refused the detach notification");
        }
      },
    },
    registered,
    detached,
  };
}

// Same object graph as `makeRegistry`, with the additive-optional options bag
// supplied. A distinct event-id prefix keeps the counter independent of the
// shared helper's.
function makeObservedRegistry(options: NodeRegistryOptions): NodeRegistry {
  let idCounter: number = 0;
  const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
    sessionEvents: makeEventLog(),
    newEventId: () => `evt-observed-${(idCounter++).toString()}`,
  });
  return new NodeRegistry(ctx.db, emitter, () => "2026-06-02T12:00:00.000Z", options);
}

describe("NodeRegistry — lifecycle observer seam (the provider-plane wiring point)", () => {
  it("notifies with the node AND session context after a settled register, and again on detach", async () => {
    const lifecycle: RecordedLifecycle = makeRecordingObserver();
    const registry: NodeRegistry = makeObservedRegistry({ lifecycleObserver: lifecycle.observer });

    await registry.register({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });

    // Both members matter to the subscriber: the node id keys its per-node
    // state, and the session id is the timeline a capability re-declaration is
    // appended to — without it a subscriber would need its own node→session map.
    expect(lifecycle.registered).toStrictEqual([{ nodeId: NODE_ID, sessionId: SESSION_ID }]);
    expect(lifecycle.detached).toHaveLength(0);
    // The registration itself is unchanged by the presence of a subscriber.
    expect(registry.lookup(NODE_ID)).toBeDefined();

    await registry.detach({ nodeId: NODE_ID, sessionId: SESSION_ID, previousState: "online" });
    expect(lifecycle.detached).toStrictEqual([{ nodeId: NODE_ID, sessionId: SESSION_ID }]);
    // Detach notifies once; it does not re-announce the registration.
    expect(lifecycle.registered).toHaveLength(1);
  });

  it("does NOT notify when the registration rolls back inside its transaction", async () => {
    // The DISCRIMINATING negative control for fire-after-settle. The failure
    // must land AFTER the transactional prelude applied — a duplicate event id
    // violating `session_events`' PRIMARY KEY — because a notification fired
    // from inside the prelude, or anywhere before the emit resolves, would
    // still pass a pre-transaction refusal case while announcing a
    // registration the rollback erased.
    const seedingService: SessionService = new SessionService(ctx.db, {
      allowUnsignedPlaceholderAppend: UnsignedPlaceholderAppendToken.forTestsOnly(),
    });
    seedingService.append({
      id: "evt-observer-collide",
      sessionId: SESSION_ID,
      sequence: 0,
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

    const lifecycle: RecordedLifecycle = makeRecordingObserver();
    const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
      sessionEvents: makeEventLog(),
      newEventId: () => "evt-observer-collide",
    });
    const registry: NodeRegistry = new NodeRegistry(
      ctx.db,
      emitter,
      () => "2026-06-02T12:00:00.000Z",
      { lifecycleObserver: lifecycle.observer },
    );

    await expect(
      registry.register({
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        capabilities: {},
        nodeVersion: "1.0.0",
        platform: "linux-x64",
      }),
    ).rejects.toThrow(/UNIQUE|PRIMARY KEY|constraint/i);

    expect(lifecycle.registered).toHaveLength(0);
    // And the rollback held: no trust row for a node nobody was told about.
    expect(readTrustRows(ctx.db, NODE_ID)).toHaveLength(0);
  });

  it("contains a THROWING observer — register and detach still settle, and the failure is reported", async () => {
    const lifecycle: RecordedLifecycle = makeRecordingObserver(true);
    const reports: Array<{ message: string; cause: unknown }> = [];
    const registry: NodeRegistry = makeObservedRegistry({
      lifecycleObserver: lifecycle.observer,
      onObserverError: (message: string, cause: unknown) => {
        reports.push({ message, cause });
      },
    });

    // Neither call rejects: the durable row and its timeline event are the
    // registry's contract, and a subscriber's fault is not a reason to refuse
    // them.
    await expect(
      registry.register({
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        capabilities: {},
        nodeVersion: "1.0.0",
        platform: "linux-x64",
      }),
    ).resolves.toBeUndefined();
    await expect(
      registry.detach({ nodeId: NODE_ID, sessionId: SESSION_ID, previousState: "online" }),
    ).resolves.toBeUndefined();

    // The registration and the detach both completed for real.
    expect(registry.lookup(NODE_ID)).toBeDefined();
    expect(readEventRows(ctx.db, SESSION_ID).map((row) => row.type)).toEqual([
      "runtime_node.registered",
      "runtime_node.offline",
    ]);

    // Contained is not swallowed: BOTH throws were reported, carrying the
    // thrown cause rather than a flattened message.
    expect(reports).toHaveLength(2);
    expect(reports[0]?.message).toContain("registered");
    expect(reports[0]?.message).toContain(NODE_ID);
    expect((reports[0]?.cause as Error).message).toBe(
      "observer refused the registration notification",
    );
    expect(reports[1]?.message).toContain("detached");
    expect((reports[1]?.cause as Error).message).toBe("observer refused the detach notification");
  });
});
