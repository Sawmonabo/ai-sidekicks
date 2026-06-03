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
//   * D2 path 1 (declare → capability_declared, Spec-006:379): a first
//     declaration emits exactly one `runtime_node.capability_declared` event
//     (reduced base + {capability, capabilityDetails}) + a `node_capabilities`
//     row.
//   * D2 path 2 (re-declare changed → capability_updated, Spec-006:380): a
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
//   * Atomicity: the REAL emitter with an injected throwing `nextSequence` makes
//     a NEW declaration's emit throw AFTER the upsert ran in the transaction, so
//     the `node_capabilities` upsert rolls back (no row).
//   * I-003-2 (the declaration is the precondition that gates `online`): a
//     `runtime_node.capability_declared` event lands for the node id — the event
//     a Phase-3/T2.4 `online` gate waits for.
//   * T2.4 / D3 (online only after capability_declared, I-003-2; Spec-003:57):
//     bringOnline returns false + emits nothing before any declaration EXISTS —
//     the node stays in its non-online (registering) state (Spec-003:57, "online
//     only after capability declaration succeeds"). After declare it returns true
//     and appends `runtime_node.online` (newState online, previousState
//     registering) AFTER the capability_declared event. This is declaration
//     ABSENCE (the :57 gate), NOT capability-validation FAILURE: Spec-003:63
//     ("validation FAILS → degraded/offline, not healthy") is a DIFFERENT path,
//     entirely Phase 3 — Phase 2 has no `degraded`/`offline`-on-invalid emission
//     (the emitter/schemas defer `degraded`/`revoked` to Plan-003 Phase 3 with
//     their heartbeat/admin producers), so D3 codifies NONE of :63.
//   * T2.4 gate-reads-ROW-not-EVENT (§357 regression guard): after an identical
//     no-op re-declare that emitted NO second event, bringOnline still onlines —
//     proving the gate read the durable node-keyed ROW, not the event stream
//     (the WHY of the gate-on-row design; Model A would never online here).
//
// Spec coverage: Spec-003 line 57 (online only after capability declaration — the
// T2.4 gate D3 verifies: no online until a declaration EXISTS), line 58
// (least-privilege schedulability — declaration is the path that makes a
// capability schedulable, proven by path 1's `node_capabilities` row), line 79
// (capability/trust changes emitted as session events), line 114 (serial re-attach
// satisfies the node-scoped gate without re-declaring — the gate-reads-ROW block).
// (Spec-003:63 — validation FAILURE → degraded/offline — is NOT covered here: it is
// a Phase-3 path with no Phase-2 `degraded` emit shape; D3 tests declaration
// ABSENCE via the :57 gate, not validation failure. Spec-003:96 — no implicit
// exposure on ATTACH — is the register path's obligation, exercised in
// node-registry.test.ts where `register` carries capabilities yet writes zero
// `node_capabilities` rows.) Verifies invariant: I-003-2 (the declaration is the
// precondition that gates `online`).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../session/migration-runner.js";
import { SessionService } from "../../session/session-service.js";
import { NodeCapabilityService } from "../node-capability-service.js";
import { RuntimeNodeEventEmitter } from "../node-event-emitter.js";

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

// Wire the production composition root over the current `ctx.db`. `now` defaults
// to an advancing clock; the emitter id source is a collision-free counter.
function makeCapabilityService(now: () => string = makeAdvancingClock()): NodeCapabilityService {
  const sessionService: SessionService = new SessionService(ctx.db);
  let idCounter: number = 0;
  const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
    sessionEvents: sessionService,
    newEventId: () => `evt-${(idCounter++).toString()}`,
  });
  return new NodeCapabilityService(ctx.db, emitter, now);
}

// ----------------------------------------------------------------------------
// D2 path 1 — first declaration emits capability_declared (Spec-006:379)
// ----------------------------------------------------------------------------

describe("NodeCapabilityService — D2 path 1 (first declaration → capability_declared)", () => {
  it("emits exactly one runtime_node.capability_declared event + writes a node_capabilities row", () => {
    const service: NodeCapabilityService = makeCapabilityService();
    service.declare({
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

    // Spec-006:379 shape: reduced base + {capability, capabilityDetails}. NO
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
// D2 path 2 — changed re-declare emits capability_updated (Spec-006:380)
// ----------------------------------------------------------------------------

describe("NodeCapabilityService — D2 path 2 (changed re-declare → capability_updated)", () => {
  it("emits exactly one runtime_node.capability_updated with prior + new snapshots and updates the row", () => {
    const service: NodeCapabilityService = makeCapabilityService();
    service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: { contractVersion: "1.0" },
    });
    // updated_at after the first declare is the advancing clock's first value.
    const afterDeclare: CapabilityRow | undefined = readCapabilityRow(ctx.db, NODE_ID, CAPABILITY);
    expect(afterDeclare?.updated_at).toBe("2026-06-02T12:00:00.000Z");

    service.declare({
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
    // Spec-006:380 shape: reduced base + {capability, previousState, newState} as
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
  it("emits no further event AND does not write (updated_at unchanged) on an identical re-declare", () => {
    const service: NodeCapabilityService = makeCapabilityService();
    const details: Record<string, unknown> = { contractVersion: "1.0", flags: { streaming: true } };

    service.declare({
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
    service.declare({
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

  it("treats reordered keys + an extra undefined-valued key as IDENTICAL — no event, no write", () => {
    // This is the bug-catching case: it FAILS against a naive raw-`JSON.stringify`
    // byte-compare (key order differs) AND against a raw-incoming-vs-round-tripped
    // compare (the `undefined`-valued key makes the raw side mis-compare), and
    // PASSES only with the both-sides-normalized `isDeepStrictEqual`.
    const service: NodeCapabilityService = makeCapabilityService();

    service.declare({
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
    service.declare({
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
  it("lands a runtime_node.capability_declared event for the node — the event a later online gate waits for", () => {
    const service: NodeCapabilityService = makeCapabilityService();
    service.declare({
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

describe("NodeCapabilityService — atomicity (throwing emit rolls back the capability upsert)", () => {
  it("rolls back the node_capabilities upsert when the emit throws inside the transaction", () => {
    // REAL emitter with an injected throwing `nextSequence` — the throw lands
    // INSIDE the emit, AFTER the upsert ran in the transaction, so the rollback
    // of the already-applied upsert is what is under test.
    const sessionService: SessionService = new SessionService(ctx.db);
    const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
      sessionEvents: sessionService,
      nextSequence: () => {
        throw new Error("forced");
      },
    });
    const service: NodeCapabilityService = new NodeCapabilityService(ctx.db, emitter);

    expect(() =>
      service.declare({
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        capability: CAPABILITY,
        capabilityDetails: { contractVersion: "1.0" },
      }),
    ).toThrow("forced");

    // The upsert rolled back with the failed emit: no capability row, no event.
    expect(readCapabilityRow(ctx.db, NODE_ID, CAPABILITY)).toBeUndefined();
    expect(readEventRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Composite PK — distinct capability_keys on one node are independent rows
// ----------------------------------------------------------------------------

describe("NodeCapabilityService — distinct capability keys are independent (composite PK)", () => {
  it("declares two distinct capabilities on one node as independent rows, each emitting capability_declared (not _updated)", () => {
    const service: NodeCapabilityService = makeCapabilityService();
    service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: "provider-driver",
      capabilityDetails: { contractVersion: "1.0" },
    });
    service.declare({
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
  it("treats an identical re-declare in a DIFFERENT session as a no-op — no capability_declared in the second session", () => {
    // A distinct UUIDv7 session id (same shape as SESSION_ID, final group bumped).
    const SESSION_TWO: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f01";
    const service: NodeCapabilityService = makeCapabilityService();
    const details: Record<string, unknown> = { contractVersion: "1.0", flags: { streaming: true } };

    // First declaration in session one → capability_declared lands in S1.
    service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: details,
    });
    // Re-declare the SAME node + capability + details under a DIFFERENT session — a
    // supported serial re-attach (Spec-003:114). `node_capabilities` is node-keyed
    // (no session_id column), so the existing row is found and this is a no-op: NO
    // capability_declared lands in session two. (The daemon `online` gate reads the
    // node-keyed row, not a per-session event, so S2-online does not depend on a
    // fresh declaration event here — see node-capability-service.ts SELECT comment.)
    service.declare({
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
  it("gates online on a prior declaration: no online before declare; online follows capability_declared for the same node", () => {
    const service: NodeCapabilityService = makeCapabilityService();

    // Before any declaration the I-003-2 precondition is unmet: bringOnline reads
    // the (absent) node-keyed row, emits NOTHING, and returns false. The node
    // stays in its non-online (registering) state (Spec-003:57). Registration is
    // deliberately NOT performed — the gate reads `node_capabilities`, not
    // `node_trust_state`, so this test stays focused on the declaration→online
    // gate without coupling to NodeRegistry.
    expect(service.bringOnline({ nodeId: NODE_ID, sessionId: SESSION_ID })).toBe(false);
    expect(readEventRows(ctx.db, SESSION_ID)).toHaveLength(0);

    // Declare a capability → exactly one capability_declared lands.
    service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: { contractVersion: "1.0" },
    });

    // Now the gate is satisfied: bringOnline returns true and appends online AFTER
    // the declared event.
    expect(service.bringOnline({ nodeId: NODE_ID, sessionId: SESSION_ID })).toBe(true);

    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    // The exact ordered sequence: capability_declared THEN online (I-003-2 — online
    // follows the declaration for the same node id).
    expect(events.map((e) => e.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.online",
    ]);

    // The online payload is the registering→online transition (Spec-006:375 base).
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
  it("onlines after an identical no-op re-declare emitted no second event — proving the gate read the row, not the event", () => {
    // This is the regression guard for the WHY of the gate-on-row design: if the
    // gate keyed on a `capability_declared` EVENT, a node that already declared
    // (row present) but re-declares as an identical no-op (which emits NO event,
    // T2.2 / Model B) would never online — Model A resurfacing at the emission
    // layer. Gating on the durable ROW makes "has this node declared?" correct
    // across re-declares. Single-session; no re-attach plumbing.
    const service: NodeCapabilityService = makeCapabilityService();
    const details: Record<string, unknown> = { contractVersion: "1.0", flags: { streaming: true } };

    // First declaration → one capability_declared, one durable row.
    service.declare({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      capabilityDetails: details,
    });

    // Identical re-declare → the committed no-op: NO second event (T2.2 / Model B).
    service.declare({
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
    expect(service.bringOnline({ nodeId: NODE_ID, sessionId: SESSION_ID })).toBe(true);

    const events: ReadonlyArray<EventRow> = readEventRows(ctx.db, SESSION_ID);
    expect(events.map((e) => e.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.online",
    ]);
  });
});
