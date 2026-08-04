// NodeCapabilityService — Plan-003 Phase 2 (T2.2).
//
// Exercises capability declaration + change-detected emission over a real test
// SQLite DB (mirrors `node-event-emitter.test.ts` / `session-service.test.ts`
// lifecycle: `openDatabase` factory → per-test tmp file → `afterEach` close +
// unlink). Composition is the production root: `SessionService(db)` →
// `RuntimeNodeEventEmitter({ sessionEvents })` → `NodeCapabilityService(db,
// emitter)`, all over the SAME `db` handle (the transaction's atomicity depends
// on the emitter's append running on that connection).
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * D2 path 1 (declare → capability_declared, `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`): a first
//     declaration emits exactly one `runtime_node.capability_declared` event
//     (reduced base + {capability, capabilityDetails}) + a `node_capabilities`
//     row.
//   * D2 path 2 (re-declare changed → capability_updated, `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`): a
//     re-declare with CHANGED details emits exactly one
//     `runtime_node.capability_updated` carrying the prior + new snapshots, and
//     the row's `capability_value` is updated.
//   * D2 path 3 (re-declare identical → idempotent): a re-declare with IDENTICAL
//     details emits NO further event AND does NOT write (the row's `updated_at`
//     stays at the last actual change — proven with an ADVANCING clock).
//   * Non-trivial idempotency (catches key-order fragility AND the
//     normalization-asymmetry bug): a nested record re-declared with reordered
//     keys + an extra `undefined`-valued key is "unchanged" — no event, no
//     write. This FAILS a naive raw-stringify / raw-incoming compare and PASSES
//     the both-sides-normalized `isDeepStrictEqual`.
//   * Atomicity, two arms — the `nextSequence` injection seam they used to ride
//     is gone with the T3.1 re-point, so each drives a REAL failure of the real
//     append path instead. (a) ROLLBACK: the emitter is pinned to an event id
//     that already exists, so the event INSERT violates `session_events`' PRIMARY
//     KEY AFTER the upsert prelude ran inside the transaction — the
//     `node_capabilities` upsert rolls back (no row). (b) The stronger property
//     the re-point bought: a signing-key source that REJECTS makes the append
//     refuse before opening its transaction, so the prelude never runs at all
//     and there is no partial state to roll back.
//   * I-003-2 (the declaration is the precondition that gates `online`): a
//     `runtime_node.capability_declared` event lands for the node id — the event
//     a Phase-3/T2.4 `online` gate waits for.
//   * T2.4 / D3 (online only after capability_declared, I-003-2; `Spec-003 §Default Behavior`):
//     bringOnline returns false + emits nothing before any declaration EXISTS —
//     the node stays in its non-online (registering) state (`Spec-003 §Default Behavior`, "online
//     only after capability declaration succeeds"). After declare it returns true
//     and appends `runtime_node.online` (newState online, previousState
//     registering) AFTER the capability_declared event. This is declaration
//     ABSENCE (the :57 gate), NOT capability-validation FAILURE: `Spec-003 §Fallback Behavior`
//     ("validation FAILS → degraded/offline, not healthy") is a DIFFERENT path,
//     server-derived — Phase 2 has no `degraded`/`offline`-on-invalid emission
//     (the emitter/schemas V1.1-gate `degraded`/`revoked` durable events on the
//     node-identity anchor, ADR-017), so D3 codifies NONE of :76.
//   * T2.4 gate-reads-ROW-not-EVENT (§357 regression guard): after an identical
//     no-op re-declare that emitted NO second event, bringOnline still onlines —
//     proving the gate read the durable node-keyed ROW, not the event stream
//     (the WHY of the gate-on-row design; Model A would never online here).
//
// Spec coverage: `Spec-003 §Default Behavior` (online only after capability declaration — the
// T2.4 gate D3 verifies: no online until a declaration EXISTS;
// least-privilege schedulability — declaration is the path that makes a
// capability schedulable, proven by path 1's `node_capabilities` row),
// `Spec-003 §State And Data Implications` (capability/trust changes emitted
// as session events), and the T2.4 gate contract (serial re-attach
// satisfies the node-scoped gate without re-declaring — the gate-reads-ROW block).
// (`Spec-003 §Fallback Behavior` — validation FAILURE → degraded/offline — is NOT covered here: it is
// a server-derived path, no Phase-2 `degraded` emit shape; D3 tests declaration
// ABSENCE via the :57 gate, not validation failure. `Spec-003 §Pitfalls To Avoid` — no implicit
// exposure on ATTACH — is the register path's obligation, exercised in
// node-registry.test.ts where `register` carries capabilities yet writes zero
// `node_capabilities` rows.) Verifies invariant: I-003-2 (the declaration is the
// precondition that gates `online`).

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
import { NodeCapabilityService } from "../node-capability-service.js";
import { RuntimeNodeEventEmitter } from "../node-event-emitter.js";

/**
 * Fixed-key {@link DaemonSigningKeySource} — this suite is about the producer's
 * dual-write, not key custody (`signing-key-source.test.ts` owns that).
 */
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

/** One park: the test waits on `reached`, the read waits on `parked`. */
interface ParkGate {
  /** Resolves once a `read` has actually reached this park. */
  readonly reached: Promise<void>;
  /** Resolves once the test has released this park. */
  readonly parked: Promise<void>;
  arrive(): void;
  release(): void;
}

function makeParkGate(): ParkGate {
  let arrive!: () => void;
  let release!: () => void;
  const reached: Promise<void> = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const parked: Promise<void> = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, parked, arrive, release };
}

/**
 * A key source that parks its first `parkCount` reads until each is released,
 * then behaves like the fixed one.
 *
 * The seam the cross-session race arms need, and the production shape rather
 * than an artificial hook: the key unseal is the async step between a declare's
 * read-decide and its write, so parking here reproduces exactly the interleaving
 * the in-prelude re-check exists to catch.
 *
 * ONE PARK PER ATTEMPT, and that is what makes the park COUNT the attempt
 * count: `declare` re-runs read-decide-emit from the top on the divergence
 * sentinel, and each attempt reads the signing key exactly once. A source that
 * parked once lets every retry run to completion — enough for the arms that
 * exercise a single lost race, and structurally unable to reach the retry
 * budget's exhaustion branch.
 */
class ParkingDaemonSigningKeySource implements DaemonSigningKeySource {
  readonly #privateKey: Ed25519PrivateKey = new Uint8Array(32).fill(7) as Ed25519PrivateKey;
  readonly #gates: ReadonlyArray<ParkGate>;
  #readCount = 0;

  constructor(parkCount: number = 1) {
    this.#gates = Array.from({ length: parkCount }, () => makeParkGate());
  }

  /**
   * How many reads have been served. One read per `declare` attempt, so this is
   * the ATTEMPT count — the only observable that separates "committed on the
   * first attempt" from "diverged and retried into the same outcome".
   */
  get readCount(): number {
    return this.#readCount;
  }

  /** Resolves once read #`index` (0-based) has reached its park. */
  parkReachedAt(index: number): Promise<void> {
    return this.#gateAt(index).reached;
  }

  /** Lets read #`index` (0-based) leave its park. */
  releaseAt(index: number): void {
    this.#gateAt(index).release();
  }

  async read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
    const index: number = this.#readCount;
    this.#readCount += 1;
    if (index < this.#gates.length) {
      const gate: ParkGate = this.#gateAt(index);
      gate.arrive();
      await gate.parked;
    }
    return this.#privateKey;
  }

  create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
    return Promise.reject(
      new Error("ParkingDaemonSigningKeySource.create is not used by this suite"),
    );
  }

  #gateAt(index: number): ParkGate {
    const gate: ParkGate | undefined = this.#gates[index];
    if (gate === undefined) {
      throw new Error(
        `ParkingDaemonSigningKeySource: no park #${String(index)}; ${String(this.#gates.length)} were requested. A park index past the end means the arm and the retry budget disagree about how many attempts there are.`,
      );
    }
    return gate;
  }
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const SESSION_ID: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const NODE_ID: string = "node-01J0ND0000NN5J5J5J5J5J5J";
const CAPABILITY: string = "provider-driver";

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

interface CapabilityRow {
  readonly node_id: string;
  readonly capability_key: string;
  readonly capability_value: string;
  readonly updated_at: string;
}

function readCapabilityRow(
  db: DatabaseType,
  nodeId: string,
  capabilityKey: string,
): CapabilityRow | undefined {
  return db
    .prepare(
      `SELECT node_id, capability_key, capability_value, updated_at
         FROM node_capabilities
        WHERE node_id = ? AND capability_key = ?`,
    )
    .get(nodeId, capabilityKey) as CapabilityRow | undefined;
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle (mirrors node-event-emitter.test.ts)
// ----------------------------------------------------------------------------

interface TestContext {
  db: DatabaseType;
  tmpDir: string;
}

let ctx: TestContext;

beforeEach(() => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-node-capability-test-"));
  const dbPath: string = join(tmpDir, "test.db");
  const db: DatabaseType = openDatabase(dbPath);
  ctx = { db, tmpDir };
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

// An ADVANCING clock: each call returns a distinct timestamp. This is what
// makes the "no write on identical re-declare" assertion non-vacuous — with a
// CONSTANT clock, `updated_at` would be identical whether or not the upsert ran,
// so the assertion could never catch a "skips emit but still upserts" bug.
function makeAdvancingClock(): () => string {
  let minute: number = 0;
  return () => {
    const stamp: string = `2026-06-02T12:${minute.toString().padStart(2, "0")}:00.000Z`;
    minute += 1;
    return stamp;
  };
}

// Wire the Phase-2 object graph over the current `ctx.db`. `now` defaults
// to an advancing clock; the emitter id source is a collision-free counter.
// The seam is ASYNC-TRANSACTIONAL post the Plan-006 T3.1 re-point
// (node-event-emitter.ts's header owns the contract): `EventLogService.append`
// over the SAME connection backs it, which is what lets the service's upsert
// travel as a `transactionalPrelude` and join the append's transaction.
function makeCapabilityService(
  now: () => string = makeAdvancingClock(),
  signingKeySource: DaemonSigningKeySource = new FixedDaemonSigningKeySource(),
  eventIdPrefix: string = "evt",
): NodeCapabilityService {
  let idCounter: number = 0;
  const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
    // The production append path over `ctx.db` — SAME connection as the service,
    // which is the wiring contract: the service's upsert travels as a
    // `transactionalPrelude` and must join the append's transaction.
    sessionEvents: new EventLogService({
      db: ctx.db,
      signingKeySource,
    }),
    // Prefixed so two services racing on ONE database cannot collide on
    // `session_events.id`, which is a TEXT PRIMARY KEY across all sessions.
    newEventId: () => `${eventIdPrefix}-${(idCounter++).toString()}`,
  });
  return new NodeCapabilityService(ctx.db, emitter, now);
}

// ----------------------------------------------------------------------------
// D2 path 1 — first declaration emits capability_declared (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`)
// ----------------------------------------------------------------------------

describe("NodeCapabilityService — D2 path 1 (first declaration → capability_declared)", () => {
  it("emits exactly one runtime_node.capability_declared event + writes a node_capabilities row", async () => {
    const service: NodeCapabilityService = makeCapabilityService();
    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: { contractVersion: "1.0", flags: { streaming: true } },
    });

    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.type).toBe("runtime_node.capability_declared");
    expect(event.category).toBe("runtime_node_lifecycle");

    // `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` shape: reduced base + {capability, capabilityDetails}. NO
    // previousState/newState NodeState fields (capability events are not
    // NodeState transitions).
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    expect(payload).toEqual({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      actor: null,
      capability: CAPABILITY,
      capabilityDetails: { contractVersion: "1.0", flags: { streaming: true } },
    });

    // The durable row carries the normalized JSON snapshot.
    const row: CapabilityRow | undefined = readCapabilityRow(ctx.db, NODE_ID, CAPABILITY);
    expect(row).toBeDefined();
    expect(JSON.parse(row?.capability_value ?? "null")).toEqual({
      contractVersion: "1.0",
      flags: { streaming: true },
    });
  });
});

// ----------------------------------------------------------------------------
// D2 path 2 — changed re-declare emits capability_updated (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`)
// ----------------------------------------------------------------------------

describe("NodeCapabilityService — D2 path 2 (changed re-declare → capability_updated)", () => {
  it("emits exactly one runtime_node.capability_updated with prior + new snapshots and updates the row", async () => {
    const service: NodeCapabilityService = makeCapabilityService();
    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: { contractVersion: "1.0" },
    });
    // updated_at after the first declare is the advancing clock's first value.
    const afterDeclare: CapabilityRow | undefined = readCapabilityRow(ctx.db, NODE_ID, CAPABILITY);
    expect(afterDeclare?.updated_at).toBe("2026-06-02T12:00:00.000Z");

    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: { contractVersion: "1.1" },
    });

    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    // Two events total: the declared, then the updated.
    expect(events.map((e) => e.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
    ]);

    const updatedEvent = events[1];
    expect(updatedEvent).toBeDefined();
    if (updatedEvent === undefined) return;
    const payload = JSON.parse(updatedEvent.payload) as Record<string, unknown>;
    // `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` shape: reduced base + {capability, previousState, newState} as
    // CapabilityDetails SNAPSHOTS carrying the prior + new details.
    expect(payload).toEqual({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      actor: null,
      capability: CAPABILITY,
      previousState: { contractVersion: "1.0" },
      newState: { contractVersion: "1.1" },
    });

    // The row's value is updated and `updated_at` advanced to the change's time.
    const afterUpdate: CapabilityRow | undefined = readCapabilityRow(ctx.db, NODE_ID, CAPABILITY);
    expect(JSON.parse(afterUpdate?.capability_value ?? "null")).toEqual({ contractVersion: "1.1" });
    expect(afterUpdate?.updated_at).toBe("2026-06-02T12:01:00.000Z");
  });
});

// ----------------------------------------------------------------------------
// D2 path 3 — identical re-declare is idempotent (no event, no write)
// ----------------------------------------------------------------------------

describe("NodeCapabilityService — D2 path 3 (identical re-declare → idempotent no-op)", () => {
  it("emits no further event AND does not write (updated_at unchanged) on an identical re-declare", async () => {
    const service: NodeCapabilityService = makeCapabilityService();
    const details: Record<string, unknown> = { contractVersion: "1.0", flags: { streaming: true } };

    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: details,
    });
    // First declare lands at the advancing clock's first value.
    expect(readCapabilityRow(ctx.db, NODE_ID, CAPABILITY)?.updated_at).toBe(
      "2026-06-02T12:00:00.000Z",
    );

    // Re-declare with structurally-identical (here, a fresh object with the same
    // content) details.
    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: { contractVersion: "1.0", flags: { streaming: true } },
    });

    // Idempotent: still exactly one event...
    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("runtime_node.capability_declared");

    // ...and `updated_at` is UNCHANGED (the advancing clock would have produced
    // 12:01 had the upsert run — its absence proves no write happened). This is
    // the non-vacuous form of the no-write assertion.
    expect(readCapabilityRow(ctx.db, NODE_ID, CAPABILITY)?.updated_at).toBe(
      "2026-06-02T12:00:00.000Z",
    );
  });

  it("treats reordered keys + an extra undefined-valued key as IDENTICAL — no event, no write", async () => {
    // This is the bug-catching case: it FAILS against a naive raw-`JSON.stringify`
    // byte-compare (key order differs) AND against a raw-incoming-vs-round-tripped
    // compare (the `undefined`-valued key makes the raw side mis-compare), and
    // PASSES only with the both-sides-normalized `isDeepStrictEqual`.
    const service: NodeCapabilityService = makeCapabilityService();

    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: { name: "claude", limits: { tokens: 1000, concurrency: 2 } },
    });
    expect(readCapabilityRow(ctx.db, NODE_ID, CAPABILITY)?.updated_at).toBe(
      "2026-06-02T12:00:00.000Z",
    );

    // Structurally identical: keys reordered at BOTH levels, plus an extra
    // `undefined`-valued key that `JSON.stringify` strips.
    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: {
        limits: { concurrency: 2, tokens: 1000 },
        name: "claude",
        extra: undefined,
      },
    });

    // No `capability_updated` spam — the re-declare is recognized as identical.
    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("runtime_node.capability_declared");
    expect(events.some((e) => e.type === "runtime_node.capability_updated")).toBe(false);

    // And no write — `updated_at` unchanged.
    expect(readCapabilityRow(ctx.db, NODE_ID, CAPABILITY)?.updated_at).toBe(
      "2026-06-02T12:00:00.000Z",
    );
  });
});

// ----------------------------------------------------------------------------
// I-003-2 — the declaration is the precondition that gates `online`
// ----------------------------------------------------------------------------

describe("NodeCapabilityService — I-003-2 (declaration is the precondition that gates online)", () => {
  it("lands a runtime_node.capability_declared event for the node — the event a later online gate waits for", async () => {
    const service: NodeCapabilityService = makeCapabilityService();
    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: { contractVersion: "1.0" },
    });

    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    // The capability_declared event exists in the durable log: the T2.4 ordering
    // gate (I-003-2) is allowed to emit `online` only AFTER observing this event
    // for the same node id. Here we prove the gating event is produced + durable.
    const declared = events.find((e) => e.type === "runtime_node.capability_declared");
    expect(declared).toBeDefined();
    const payload = JSON.parse(declared?.payload ?? "null") as Record<string, unknown>;
    expect(payload["nodeId"]).toBe(NODE_ID);
    // No `online` event is emitted by THIS service — declaration does not itself
    // bring the node online (that is the T2.4 producer's job).
    expect(events.some((e) => e.type === "runtime_node.online")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Atomicity — a throwing emit rolls back the node_capabilities upsert
// ----------------------------------------------------------------------------

describe("NodeCapabilityService — atomicity (a failed event write rolls back the capability upsert)", () => {
  it("rolls back the node_capabilities upsert when the event INSERT throws inside the transaction", async () => {
    // The upsert is now a `transactionalPrelude` running INSIDE the append's
    // transaction, immediately BEFORE the event-row INSERT. To exercise ROLLBACK
    // specifically, the failure must land AFTER the prelude has already applied
    // — so the emitter is pinned to an event id that ALREADY EXISTS, making the
    // INSERT violate `session_events`' TEXT PRIMARY KEY. A pre-transaction
    // refusal would not test rollback at all (the next case covers that
    // stronger property separately).
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
      sessionEvents: new EventLogService({
        db: ctx.db,
        signingKeySource: new FixedDaemonSigningKeySource(),
      }),
      newEventId: () => "evt-collide",
    });
    const service: NodeCapabilityService = new NodeCapabilityService(ctx.db, emitter);

    await expect(
      service.declare({
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        capability: CAPABILITY,
        capabilityDetails: { contractVersion: "1.0" },
      }),
    ).rejects.toThrow(/UNIQUE|PRIMARY KEY|constraint/i);

    // The upsert rolled back with the failed INSERT: no capability row, and the
    // only event on the session is the seed.
    expect(readCapabilityRow(ctx.db, NODE_ID, CAPABILITY)).toBeUndefined();
    expect(readEventRows(ctx.db, SESSION_ID)).toHaveLength(1);
  });

  it("never RUNS the upsert when the append refuses before opening its transaction", async () => {
    // The property the re-point made STRONGER than rollback: a refusal raised
    // before the transaction opens means the prelude never executes at all, so
    // there is no partial state to roll back. A regression that moved the
    // prelude ahead of the append's pre-transaction checks would still pass the
    // rollback arm above while breaking this one.
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
    const service: NodeCapabilityService = new NodeCapabilityService(ctx.db, emitter);

    await expect(
      service.declare({
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        capability: CAPABILITY,
        capabilityDetails: { contractVersion: "1.0" },
      }),
    ).rejects.toThrow("key unseal refused");

    expect(readCapabilityRow(ctx.db, NODE_ID, CAPABILITY)).toBeUndefined();
    expect(readEventRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Composite PK — distinct capability_keys on one node are independent rows
// ----------------------------------------------------------------------------

describe("NodeCapabilityService — distinct capability keys are independent (composite PK)", () => {
  it("declares two distinct capabilities on one node as independent rows, each emitting capability_declared (not _updated)", async () => {
    const service: NodeCapabilityService = makeCapabilityService();
    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: "provider-driver",
      capabilityDetails: { contractVersion: "1.0" },
    });
    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: "git-worktree",
      capabilityDetails: { maxWorktrees: 4 },
    });

    // Two INDEPENDENT rows under the composite PK (node_id, capability_key) — the
    // second declaration must neither collide with nor overwrite the first.
    const driverRow: CapabilityRow | undefined = readCapabilityRow(
      ctx.db,
      NODE_ID,
      "provider-driver",
    );
    const worktreeRow: CapabilityRow | undefined = readCapabilityRow(
      ctx.db,
      NODE_ID,
      "git-worktree",
    );
    expect(JSON.parse(driverRow?.capability_value ?? "null")).toEqual({ contractVersion: "1.0" });
    expect(JSON.parse(worktreeRow?.capability_value ?? "null")).toEqual({ maxWorktrees: 4 });

    // The second capability is a FIRST declaration of ITS key, so it emits
    // capability_DECLARED, never _updated. (A change-detection SELECT missing the
    // `AND capability_key` clause would read provider-driver's row as git-worktree's
    // "existing" row, mis-compare, and wrongly emit capability_updated — this is the
    // assertion that pins the composite-key SELECT.)
    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    expect(events.map((e) => e.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.capability_declared",
    ]);

    // The first capability's row is untouched by the second declaration (advancing
    // clock: still the first declare's 12:00, not the second's 12:01).
    expect(driverRow?.updated_at).toBe("2026-06-02T12:00:00.000Z");
    expect(worktreeRow?.updated_at).toBe("2026-06-02T12:01:00.000Z");
  });
});

// ----------------------------------------------------------------------------
// Model B — change-detection is node-scoped, not session-scoped
// ----------------------------------------------------------------------------

describe("NodeCapabilityService — change-detection is node-scoped, not session-scoped (Model B)", () => {
  it("treats an identical re-declare in a DIFFERENT session as a no-op — no capability_declared in the second session", async () => {
    // A distinct UUIDv7 session id (same shape as SESSION_ID, final group bumped).
    const SESSION_TWO: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f01";
    const service: NodeCapabilityService = makeCapabilityService();
    const details: Record<string, unknown> = { contractVersion: "1.0", flags: { streaming: true } };

    // First declaration in session one → capability_declared lands in S1.
    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: details,
    });
    // Re-declare the SAME node + capability + details under a DIFFERENT session — a
    // supported serial re-attach (`Spec-003 §Resolved Questions and V1 Scope Decisions`). `node_capabilities` is node-keyed
    // (no session_id column), so the existing row is found and this is a no-op: NO
    // capability_declared lands in session two. (The daemon `online` gate reads the
    // node-keyed row, not a per-session event, so S2-online does not depend on a
    // fresh declaration event here — see node-capability-service.ts SELECT comment.)
    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_TWO,
      capability: CAPABILITY,
      capabilityDetails: { contractVersion: "1.0", flags: { streaming: true } },
    });

    // Session one carries the single declaration; session two carries NO capability
    // event at all — the dedup spans sessions because it is keyed on the node.
    expect(readEventRows(ctx.db, SESSION_ID).map((e) => e.type)).toEqual([
      "runtime_node.capability_declared",
    ]);
    expect(readEventRows(ctx.db, SESSION_TWO)).toHaveLength(0);

    // No write happened on the second declare (advancing clock: updated_at would be
    // 12:01 had the upsert run; staying at 12:00 proves the no-op).
    expect(readCapabilityRow(ctx.db, NODE_ID, CAPABILITY)?.updated_at).toBe(
      "2026-06-02T12:00:00.000Z",
    );
  });
});

// ----------------------------------------------------------------------------
// T2.4 / D3 — online only after capability_declared (I-003-2 ordering gate)
// ----------------------------------------------------------------------------

describe("NodeCapabilityService — T2.4/D3 (online only after capability_declared, I-003-2)", () => {
  it("gates online on a prior declaration: no online before declare; online follows capability_declared for the same node", async () => {
    const service: NodeCapabilityService = makeCapabilityService();

    // Before any declaration the I-003-2 precondition is unmet: bringOnline reads
    // the (absent) node-keyed row, emits NOTHING, and returns false. The node
    // stays in its non-online (registering) state (`Spec-003 §Default Behavior`). Registration is
    // deliberately NOT performed — the gate reads `node_capabilities`, not
    // `node_trust_state`, so this test stays focused on the declaration→online
    // gate without coupling to NodeRegistry.
    expect(await service.bringOnline({ nodeId: NODE_ID, sessionId: SESSION_ID })).toBe(false);
    expect(readEventRows(ctx.db, SESSION_ID)).toHaveLength(0);

    // Declare a capability → exactly one capability_declared lands.
    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: { contractVersion: "1.0" },
    });

    // Now the gate is satisfied: bringOnline returns true and appends online AFTER
    // the declared event.
    expect(await service.bringOnline({ nodeId: NODE_ID, sessionId: SESSION_ID })).toBe(true);

    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    // The exact ordered sequence: capability_declared THEN online (I-003-2 — online
    // follows the declaration for the same node id).
    expect(events.map((e) => e.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.online",
    ]);

    // The online payload is the registering→online transition (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` base).
    const onlineEvent = events[1];
    expect(onlineEvent).toBeDefined();
    if (onlineEvent === undefined) return;
    const payload = JSON.parse(onlineEvent.payload) as Record<string, unknown>;
    expect(payload["newState"]).toBe("online");
    expect(payload["previousState"]).toBe("registering");
    expect(payload["nodeId"]).toBe(NODE_ID);
    expect(payload["sessionId"]).toBe(SESSION_ID);
  });
});

// ----------------------------------------------------------------------------
// T2.4 — the gate reads the durable ROW, not the capability_declared EVENT (§357)
// ----------------------------------------------------------------------------

describe("NodeCapabilityService — T2.4 gate reads the durable ROW, not the event (§357)", () => {
  it("onlines after an identical no-op re-declare emitted no second event — proving the gate read the row, not the event", async () => {
    // This is the regression guard for the WHY of the gate-on-row design: if the
    // gate keyed on a `capability_declared` EVENT, a node that already declared
    // (row present) but re-declares as an identical no-op (which emits NO event,
    // T2.2 / Model B) would never online — Model A resurfacing at the emission
    // layer. Gating on the durable ROW makes "has this node declared?" correct
    // across re-declares. Single-session; no re-attach plumbing.
    const service: NodeCapabilityService = makeCapabilityService();
    const details: Record<string, unknown> = { contractVersion: "1.0", flags: { streaming: true } };

    // First declaration → one capability_declared, one durable row.
    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: details,
    });

    // Identical re-declare → the committed no-op: NO second event (T2.2 / Model B).
    await service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: { contractVersion: "1.0", flags: { streaming: true } },
    });
    expect(readEventRows(ctx.db, SESSION_ID)).toHaveLength(1);
    expect(readEventRows(ctx.db, SESSION_ID)[0]?.type).toBe("runtime_node.capability_declared");

    // bringOnline STILL returns true and emits online — even though the most recent
    // declare emitted NO event. The ONLY way online can fire here is if the gate
    // read the durable ROW (which the no-op re-declare left present), NOT the event
    // stream. This is the assertion that pins the gate-on-row design.
    expect(await service.bringOnline({ nodeId: NODE_ID, sessionId: SESSION_ID })).toBe(true);

    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    expect(events.map((e) => e.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.online",
    ]);
  });
});

// ----------------------------------------------------------------------------
// Cross-session concurrency — the window the SESSION-keyed lock cannot close
// ----------------------------------------------------------------------------

// `node_capabilities` is PK (node_id, capability_key) with NO session_id column,
// so two declares of ONE capability under DIFFERENT sessions hold DIFFERENT
// append locks and both reach their read-decide. That is the window the
// in-prelude re-check plus bounded retry closes, and it is invisible to any
// same-session arm.
const SECOND_SESSION_ID: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f01";

// `CAPABILITY_DECLARE_MAX_ATTEMPTS` from `node-capability-service.ts`, re-spelled
// here rather than exported: the constant is module-private BY DESIGN (nothing
// outside the retry loop may branch on the budget), and exporting a symbol for a
// test's convenience widens the module's surface for no production reason. The
// exhaustion arm below fails loudly if the two ever disagree — a budget larger
// than this value leaves the parked declare waiting on a park that was never
// requested, and a smaller one rejects before the loop finishes.
const DECLARE_ATTEMPT_BUDGET: number = 3;

/** Every `runtime_node.capability_*` row across BOTH sessions, in commit order. */
function readCapabilityEventsAcrossSessions(db: DatabaseType): ReadonlyArray<EventRow> {
  return db
    .prepare(
      `SELECT sequence, type, category, payload
         FROM session_events
        WHERE session_id IN (?, ?) AND type LIKE 'runtime_node.capability_%'
        ORDER BY rowid ASC`,
    )
    .safeIntegers(true)
    .all(SESSION_ID, SECOND_SESSION_ID) as ReadonlyArray<EventRow>;
}

interface CapabilityEventPayload {
  readonly capabilityDetails?: Record<string, unknown>;
  readonly previousState?: Record<string, unknown>;
  readonly newState?: Record<string, unknown>;
}

describe("NodeCapabilityService — concurrent declares under DIFFERENT sessions", () => {
  it("emits exactly ONE capability_declared when both racers declare the SAME details", async () => {
    const parkedKeySource = new ParkingDaemonSigningKeySource();
    const parkedService = makeCapabilityService(makeAdvancingClock(), parkedKeySource, "parked");
    const racingService = makeCapabilityService(makeAdvancingClock(), undefined, "racer");
    const details = { contractVersion: "1.0", flags: { streaming: true } };

    // Reads "no row", decides FIRST-DECLARE, then stalls in the key unseal
    // holding only session 1's lock.
    const parkedDeclare = parkedService.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: details,
    });
    await parkedKeySource.parkReachedAt(0);

    // The racer runs to completion on session 2's uncontended lock.
    await racingService.declare({
      nodeId: NODE_ID,
      sessionId: SECOND_SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: details,
    });

    parkedKeySource.releaseAt(0);
    await parkedDeclare;

    // Asserted on the UNION of both sessions — a per-session count would find
    // one event in each and call that correct. The loser's re-check aborted its
    // stale first-declare; its retry found the stored value structurally equal
    // and took the idempotent no-op branch.
    const events = readCapabilityEventsAcrossSessions(ctx.db);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("runtime_node.capability_declared");

    const row = readCapabilityRow(ctx.db, NODE_ID, CAPABILITY);
    expect(row?.capability_value).toBe(JSON.stringify(details));
  });

  it("reclassifies the loser to capability_updated whose previousState is the RACER'S committed value", async () => {
    const parkedKeySource = new ParkingDaemonSigningKeySource();
    const parkedService = makeCapabilityService(makeAdvancingClock(), parkedKeySource, "parked");
    const racingService = makeCapabilityService(makeAdvancingClock(), undefined, "racer");
    const loserDetails = { contractVersion: "1.0", flags: { streaming: true } };
    const racerDetails = { contractVersion: "2.0", flags: { streaming: false } };

    const parkedDeclare = parkedService.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: loserDetails,
    });
    await parkedKeySource.parkReachedAt(0);

    await racingService.declare({
      nodeId: NODE_ID,
      sessionId: SECOND_SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: racerDetails,
    });

    parkedKeySource.releaseAt(0);
    await parkedDeclare;

    const events = readCapabilityEventsAcrossSessions(ctx.db);
    expect(events.map((event) => event.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
    ]);

    // THE LOAD-BEARING HALF. `previousState` must be what the racer COMMITTED,
    // never the absent row the loser read before the race — a retry that reused
    // its stale read would describe a transition that never happened.
    const updated = JSON.parse(String(events[1]?.payload)) as CapabilityEventPayload;
    expect(updated.previousState).toEqual(racerDetails);
    expect(updated.newState).toEqual(loserDetails);
    // The durable row holds the LAST writer's value, matching `newState`.
    expect(readCapabilityRow(ctx.db, NODE_ID, CAPABILITY)?.capability_value).toBe(
      JSON.stringify(loserDetails),
    );
  });

  it("does not call a key-REORDERED racer write a divergence", async () => {
    // The re-check must compare on the same NORMALIZED terms the decision used.
    // Comparing raw `capability_value` TEXT instead makes a racer that rewrote
    // the row with its keys in another order look like a change, which costs a
    // retry — and three of them exhaust the budget and surface the sentinel out
    // of a declare that nothing actually invalidated.
    //
    // The rewrite goes through SQL rather than a second `declare`, because
    // `declare`'s own idempotent branch would refuse to write an equal value at
    // all: the point here is a row that MOVED in storage without moving in
    // meaning, which is what any other writer of this column can produce.
    const seeded = { contractVersion: "1.0", flags: { streaming: true } };
    await makeCapabilityService(makeAdvancingClock(), undefined, "seed").declare({
      nodeId: NODE_ID,
      sessionId: SECOND_SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: seeded,
    });

    const parkedKeySource = new ParkingDaemonSigningKeySource();
    const parkedService = makeCapabilityService(makeAdvancingClock(), parkedKeySource, "parked");
    const newDetails = { contractVersion: "2.0", flags: { streaming: false } };
    const parkedDeclare = parkedService.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: newDetails,
    });
    await parkedKeySource.parkReachedAt(0);

    ctx.db
      .prepare(
        `UPDATE node_capabilities SET capability_value = ?
          WHERE node_id = ? AND capability_key = ?`,
      )
      .run(
        JSON.stringify({ flags: { streaming: true }, contractVersion: "1.0" }),
        NODE_ID,
        CAPABILITY,
      );
    parkedKeySource.releaseAt(0);
    await parkedDeclare;

    // ONE attempt — the discriminating assertion. Every other observable here
    // is identical whether the declare committed straight away or diverged and
    // retried into the same outcome, because the retry would re-read a value
    // that means what the first read meant.
    expect(parkedKeySource.readCount).toBe(1);
    expect(readCapabilityRow(ctx.db, NODE_ID, CAPABILITY)?.capability_value).toBe(
      JSON.stringify(newDetails),
    );
    const events = readCapabilityEventsAcrossSessions(ctx.db);
    expect(events.map((event) => event.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
    ]);
    // `previousState` is the SEEDED snapshot, structurally — the reordering the
    // racer introduced is not a difference the timeline should report either.
    const updated = JSON.parse(String(events[1]?.payload)) as CapabilityEventPayload;
    expect(updated.previousState).toEqual(seeded);
  });

  it("exhausts the retry budget loudly, writing nothing, when EVERY attempt loses", async () => {
    // THE EXHAUSTION BRANCH. The arms above lose ONE race and succeed on the
    // retry, so they never reach `attempt >= CAPABILITY_DECLARE_MAX_ATTEMPTS`
    // and cannot tell a bounded retry from an unbounded one. This arm loses
    // every attempt: the key source parks once per attempt, and the racer
    // commits a fresh value while each attempt is parked.
    //
    // THE RACER'S VALUES MUST BE STRUCTURALLY DISTINCT FROM ROUND TO ROUND. The
    // re-check compares normalized snapshots, so a racer that rewrote the same
    // value (or the same keys in another order) would NOT be a divergence and
    // the parked attempt would commit — the arm would pass while testing
    // nothing about exhaustion.
    const parkedKeySource = new ParkingDaemonSigningKeySource(DECLARE_ATTEMPT_BUDGET);
    const parkedService = makeCapabilityService(makeAdvancingClock(), parkedKeySource, "parked");
    const racingService = makeCapabilityService(makeAdvancingClock(), undefined, "racer");
    const loserDetails = { contractVersion: "1.0", flags: { streaming: true } };

    const parkedDeclare = parkedService.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: loserDetails,
    });

    for (let round = 0; round < DECLARE_ATTEMPT_BUDGET; round += 1) {
      await parkedKeySource.parkReachedAt(round);
      await racingService.declare({
        nodeId: NODE_ID,
        sessionId: SECOND_SESSION_ID,
        capability: CAPABILITY,
        capabilityDetails: { contractVersion: `2.${String(round)}`, flags: { streaming: false } },
      });
      parkedKeySource.releaseAt(round);
    }

    // LOUD, not silent: the last attempt rethrows the sentinel rather than
    // writing on a decision three racers old.
    await expect(parkedDeclare).rejects.toThrow(
      /changed between the read-decide step and the write transaction/,
    );
    await expect(parkedDeclare).rejects.toMatchObject({ name: "CapabilityRowDivergedError" });

    // ALL-OR-NOTHING across both halves of the dual-write. The durable row is
    // the racer's LAST value, untouched by the loser, and the loser's session
    // holds no event row at all — no sequence consumed, no orphaned
    // capability_updated describing a transition that never committed.
    expect(readCapabilityRow(ctx.db, NODE_ID, CAPABILITY)?.capability_value).toBe(
      JSON.stringify({
        contractVersion: `2.${String(DECLARE_ATTEMPT_BUDGET - 1)}`,
        flags: { streaming: false },
      }),
    );
    expect(readEventRows(ctx.db, SESSION_ID)).toHaveLength(0);
    expect(readCapabilityEventsAcrossSessions(ctx.db).map((event) => event.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
      "runtime_node.capability_updated",
    ]);
  });
});
