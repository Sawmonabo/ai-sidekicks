// P6 — HeartbeatService heartbeat ingestion + degraded/offline staleness sweep
// (Plan-003 Phase 3, T3.6).
//
// AC P6 (Plan-003 Phase 3 T3.6 §Test): heartbeat ingestion updates
// `runtime_node_presence`; a node whose latest heartbeat ages past `30s` then
// `60s` is demoted by the staleness sweep to `runtime_node.degraded` then
// `runtime_node.offline`. The single integration walk ("the P6 walk") below
// drives the whole arc on ONE node: ingest → fresh sweep no-op → age past 30s →
// degraded → age past 60s → offline.
//
// Spec coverage (each row gets a behavior test, NOT just the AC):
//   * Spec-003 line 59 (heartbeat cadence `15s`; ingestion writes presence): the
//     ingest tests assert `recordHeartbeat` UPSERTs the `runtime_node_presence`
//     row (insert + update-in-place) and that ingestion EMITS NOTHING (ADR-017 —
//     no control-plane event log).
//   * Spec-003 line 60 (degraded `30s` / offline `60s` thresholds + the `30s`
//     hysteresis band): the threshold tests assert the exact demotion boundaries
//     and that a recovered (re-heartbeated) node is NOT re-demoted — the
//     hysteresis property (a node whose heartbeats resume within the `30s` band
//     returns to `online` without ever passing through `offline`).
//   * Spec-003 line 61 (control-plane-owned, server-derived staleness sweep —
//     NEVER self-reported): the server-derived tests assert the sweep — not the
//     daemon — drives the demotion, `last_heartbeat_at` is stamped with the SERVER
//     clock (the request carries no timestamp; a `healthState: 'online'` heartbeat
//     on an already-stale row does NOT let the node self-report itself fresh —
//     only the server `now()` stamp does), and the demote uses the DB clock.
//
// Invariant coverage:
//   * I-003-5 (≤1 active attachment per node): the presence→attachment session
//     join reads the active set through the EXACT `idx_node_attachments_active`
//     predicate (`state IN ('registering','online','degraded')`). A node with one
//     active attachment yields that session id on the transition; a node with NO
//     active attachment still demotes + emits with `sessionId` absent; a node
//     whose only attachment is INACTIVE (`offline`/`revoked`) also yields no
//     session id. The join cannot select two sessions because the index forbids
//     two active rows — the test seeds one active + one inactive attachment and
//     asserts the single active session id is the one carried.
//
// Emission seam:
//   * emit-once-per-transition: a stable-state node re-swept does not re-emit; a
//     node demoted to `degraded` then re-swept (still in the degraded band) does
//     not re-emit `degraded`; only a genuine state CHANGE surfaces a transition.
//   * both-thresholds-crossed: a node aged straight past 60s (skipping the
//     degraded band entirely) emits a SINGLE `online → offline` transition, never
//     a spurious `degraded` first.
//   * crash guard: an `onTransition` observer that throws (sync) or rejects
//     (async) is swallowed, the demotion still commits, and the OTHER nodes'
//     transitions still fire (per-node guard, not whole-loop).
//
// Harness: the PGlite-in-memory pattern from attach-service.test.ts — a fresh
// ephemeral PGlite per test, `applyMigrations` (walks v1+v2+v3, so
// `runtime_node_presence` + `runtime_node_attachments` exist), seeding via direct
// INSERTs. Staleness is simulated by seeding `last_heartbeat_at` in the PAST
// (`now() - make_interval(secs => N)`) — NOT a fake clock: the sweep compares
// against the live DB `now()`, so a row stamped 120s ago is genuinely past both
// bands when the sweep runs milliseconds later. The sweep is driven DIRECTLY
// (`service.sweepStaleNodes()`), bypassing the `start()` timer, so the tests are
// deterministic and do not depend on wall-clock interval scheduling.
//
// Refs: Plan-003 Phase 3 T3.6 §Step / §Test (sweep interval `5s`, AC P6); Spec-003
// §Default Behavior line 59 / line 60 / line 61; Plan-003 §Invariants I-003-5;
// docs/architecture/schemas/shared-postgres-schema.md §"Runtime Node Attachments
// (Plan-003)".

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NodeId,
  RuntimeNodeDegradedPayload,
  RuntimeNodeHealthState,
  RuntimeNodeOfflinePayload,
  SessionId,
} from "@ai-sidekicks/contracts";
import {
  RuntimeNodeDegradedPayloadSchema,
  RuntimeNodeOfflinePayloadSchema,
} from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import {
  HeartbeatService,
  RUNTIME_NODE_DEGRADED_AFTER_MS,
  RUNTIME_NODE_OFFLINE_AFTER_MS,
  type RuntimeNodeStalenessTransition,
} from "../heartbeat-service.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUID v7-shaped session/participant ids (the brand validators
// accept any RFC 9562 UUID). `nodeId` is a daemon-assigned opaque TEXT scalar.
// ----------------------------------------------------------------------------

const SESSION_A_ID: SessionId = "01970000-0000-7000-8000-0000000e0001" as SessionId;
const PARTICIPANT_ID = "01970000-0000-7000-8000-0000000f0001";
const NODE_ID: NodeId = "node-heartbeat-fixture-001" as NodeId;
const NODE_ID_2: NodeId = "node-heartbeat-fixture-002" as NodeId;

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (identical to attach-service.test.ts `wrap`)
// ----------------------------------------------------------------------------

function adaptPGlite(pg: PGlite): Querier {
  return wrap(pg);
}

function wrap(handle: PGlite | Transaction): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      const result = await handle.query<T>(sql, mutableParams);
      return { rows: result.rows };
    },
    exec: async (sql: string): Promise<void> => {
      await handle.exec(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      if (!isPGlite(handle)) {
        throw new Error(
          "Querier.transaction(): nested transactions are not supported on this substrate.",
        );
      }
      return handle.transaction(async (tx) => fn(wrap(tx)));
    },
  };
}

function isPGlite(handle: PGlite | Transaction): handle is PGlite {
  return typeof (handle as { transaction?: unknown }).transaction === "function";
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  pg: PGlite;
  querier: Querier;
}

let ctx: TestContext;

beforeEach(async () => {
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);
  ctx = { pg, querier };
});

afterEach(async () => {
  await ctx.pg.close();
  vi.restoreAllMocks();
});

// ----------------------------------------------------------------------------
// Seed helpers
// ----------------------------------------------------------------------------

async function seedParticipant(querier: Querier, participantId: string): Promise<void> {
  await querier.query("INSERT INTO participants (id) VALUES ($1)", [participantId]);
}

async function seedSession(querier: Querier, sessionId: string): Promise<void> {
  await querier.query("INSERT INTO sessions (id, state) VALUES ($1, 'active')", [sessionId]);
}

// Seed a `runtime_node_presence` row with `last_heartbeat_at` stamped `agedSeconds`
// in the PAST (relative to the DB clock) and an explicit `health_state`. This is
// how staleness is simulated: a row stamped 120s ago is genuinely older than both
// the 30s and 60s bands when the sweep runs against the live `now()`. `agedSeconds
// = 0` stamps a CURRENT heartbeat (a fresh, non-stale row).
async function seedPresence(
  querier: Querier,
  args: { nodeId: NodeId; agedSeconds: number; healthState: "online" | "degraded" | "offline" },
): Promise<void> {
  await querier.query(
    `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at, health_state)
     VALUES ($1, now() - make_interval(secs => $2), $3)`,
    [args.nodeId, args.agedSeconds, args.healthState],
  );
}

// Seed a `runtime_node_attachments` row in a given state so the presence→attachment
// join has content. `state` defaults to an ACTIVE value ('online') so the active
// predicate matches; pass 'offline'/'revoked' to seed an INACTIVE attachment that
// the join must NOT select.
async function seedAttachment(
  querier: Querier,
  args: { sessionId: string; participantId: string; nodeId: NodeId; state?: string },
): Promise<void> {
  await querier.query(
    `INSERT INTO runtime_node_attachments
       (session_id, participant_id, node_id, capabilities, client_version, state)
     VALUES ($1, $2, $3, '{}'::jsonb, '1.0', $4)`,
    [args.sessionId, args.participantId, args.nodeId, args.state ?? "online"],
  );
}

// Read a node's stored presence row (the post-sweep / post-ingest state).
async function readPresence(
  querier: Querier,
  nodeId: NodeId,
): Promise<{ health_state: string; last_heartbeat_at: string } | undefined> {
  const result = await querier.query<{ health_state: string; last_heartbeat_at: Date | string }>(
    "SELECT health_state, last_heartbeat_at FROM runtime_node_presence WHERE node_id = $1",
    [nodeId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }
  const lastHeartbeatAt: string =
    row.last_heartbeat_at instanceof Date
      ? row.last_heartbeat_at.toISOString()
      : row.last_heartbeat_at;
  return { health_state: row.health_state, last_heartbeat_at: lastHeartbeatAt };
}

// ----------------------------------------------------------------------------
// P6 — the integration walk: ingest → degraded → offline (the AC headline)
// ----------------------------------------------------------------------------

describe("HeartbeatService — P6 the degraded→offline staleness walk (AC P6)", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_A_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_A_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
    });
  });

  it("ingests a heartbeat, then demotes online→degraded→offline as the heartbeat ages past 30s then 60s", async () => {
    const transitions: RuntimeNodeStalenessTransition[] = [];
    const service = new HeartbeatService(ctx.querier, {
      onTransition: (transition) => {
        transitions.push(transition);
      },
    });

    // (a) INGESTION updates runtime_node_presence (Spec-003 line 59). A fresh
    // heartbeat lands the node `online` with a current server timestamp.
    await service.recordHeartbeat({ nodeId: NODE_ID, healthState: "online" });
    const afterIngest = await readPresence(ctx.querier, NODE_ID);
    expect(afterIngest?.health_state).toBe("online");

    // (b) A sweep against a FRESH heartbeat is a no-op — the node is well within
    // the 30s band, so nothing is demoted and nothing is emitted.
    const freshSweep = await service.sweepStaleNodes();
    expect(freshSweep).toHaveLength(0);
    expect(transitions).toHaveLength(0);
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("online");

    // (c) Age the heartbeat past the 30s degraded band (but not yet 60s) and
    // sweep — the node is demoted online → degraded (Spec-003 line 60).
    await ageHeartbeat(ctx.querier, NODE_ID, 45);
    const degradedSweep = await service.sweepStaleNodes();
    expect(degradedSweep).toHaveLength(1);
    expect(degradedSweep[0]).toMatchObject({ nodeId: NODE_ID, from: "online", to: "degraded" });
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("degraded");

    // (d) Age the heartbeat past the 60s offline band and sweep again — the node
    // is demoted degraded → offline (Spec-003 line 60). The offline transition
    // carries the `heartbeat_lost` reason + the demoting last-heartbeat timestamp.
    await ageHeartbeat(ctx.querier, NODE_ID, 90);
    const offlineSweep = await service.sweepStaleNodes();
    expect(offlineSweep).toHaveLength(1);
    expect(offlineSweep[0]).toMatchObject({
      nodeId: NODE_ID,
      from: "degraded",
      to: "offline",
      reason: "heartbeat_lost",
    });
    expect(offlineSweep[0]?.sessionId).toBe(SESSION_A_ID);
    expect(typeof offlineSweep[0]?.lastHeartbeatAt).toBe("string");
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("offline");

    // The observer saw exactly the two genuine transitions, in order.
    expect(transitions.map((transition) => `${transition.from}->${transition.to}`)).toEqual([
      "online->degraded",
      "degraded->offline",
    ]);
  });
});

// Re-stamp a node's `last_heartbeat_at` to `agedSeconds` in the past (simulates
// the heartbeat aging without a fake clock — the next sweep compares against the
// live DB `now()`).
async function ageHeartbeat(querier: Querier, nodeId: NodeId, agedSeconds: number): Promise<void> {
  await querier.query(
    "UPDATE runtime_node_presence SET last_heartbeat_at = now() - make_interval(secs => $2) WHERE node_id = $1",
    [nodeId, agedSeconds],
  );
}

// ----------------------------------------------------------------------------
// Spec-003 line 59 — heartbeat ingestion writes presence + emits nothing
// ----------------------------------------------------------------------------

describe("HeartbeatService.recordHeartbeat (Spec-003 line 59 — ingestion)", () => {
  it("INSERTs a presence row on a node's first heartbeat", async () => {
    const service = new HeartbeatService(ctx.querier);

    expect(await readPresence(ctx.querier, NODE_ID)).toBeUndefined();
    await service.recordHeartbeat({ nodeId: NODE_ID, healthState: "online" });

    const row = await readPresence(ctx.querier, NODE_ID);
    expect(row?.health_state).toBe("online");
    // The server stamped a current timestamp (within a few seconds of now).
    const ageMs = Date.now() - new Date(row?.last_heartbeat_at ?? 0).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(5_000);
  });

  it("UPSERTs (updates in place) on a subsequent heartbeat — one row per node, not a duplicate", async () => {
    const service = new HeartbeatService(ctx.querier);

    await service.recordHeartbeat({ nodeId: NODE_ID, healthState: "online" });
    await service.recordHeartbeat({ nodeId: NODE_ID, healthState: "degraded" });

    // Exactly one row (the PRIMARY KEY on node_id + ON CONFLICT DO UPDATE), and it
    // carries the latest self-reported health.
    const count = await ctx.querier.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM runtime_node_presence WHERE node_id = $1",
      [NODE_ID],
    );
    expect(count.rows[0]?.count).toBe("1");
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("degraded");
  });

  it("accepts a self-reported 'degraded' heartbeat and stores it (the wire health enum)", async () => {
    const service = new HeartbeatService(ctx.querier);
    const healthState: RuntimeNodeHealthState = "degraded";
    await service.recordHeartbeat({ nodeId: NODE_ID, healthState });
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("degraded");
  });

  it("EMITS NOTHING on ingestion (ADR-017 — the control plane has no event log)", async () => {
    const onTransition = vi.fn();
    const service = new HeartbeatService(ctx.querier, { onTransition });

    await service.recordHeartbeat({ nodeId: NODE_ID, healthState: "online" });
    await service.recordHeartbeat({ nodeId: NODE_ID, healthState: "degraded" });

    // Ingestion mutates the snapshot only — the durable event append is the
    // daemon's (Plan-006 Tier 4); the observer seam is the SWEEP's, never ingest's.
    expect(onTransition).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Spec-003 line 60 — degraded 30s / offline 60s thresholds + hysteresis
// ----------------------------------------------------------------------------

describe("HeartbeatService.sweepStaleNodes (Spec-003 line 60 — thresholds + hysteresis)", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_A_ID);
  });

  it("does NOT demote a node just UNDER the 30s degraded band", async () => {
    const service = new HeartbeatService(ctx.querier);
    // 20s old — within the degraded band (< 30s). No demotion.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 20, healthState: "online" });

    const transitions = await service.sweepStaleNodes();
    expect(transitions).toHaveLength(0);
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("online");
  });

  it("demotes online→degraded once the heartbeat is past 30s but under 60s", async () => {
    const service = new HeartbeatService(ctx.querier);
    // 40s old — past the 30s degraded band, under the 60s offline band.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 40, healthState: "online" });

    const transitions = await service.sweepStaleNodes();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: "online", to: "degraded" });
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("degraded");
  });

  it("demotes straight to offline (single online→offline transition) when aged past 60s, never degraded first", async () => {
    const service = new HeartbeatService(ctx.querier);
    // 90s old — past BOTH bands. The offline pass runs first and claims the row;
    // the degraded pass excludes the just-offlined row. A SINGLE online→offline
    // transition, not online→degraded→offline.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 90, healthState: "online" });

    const transitions = await service.sweepStaleNodes();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      from: "online",
      to: "offline",
      reason: "heartbeat_lost",
    });
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("offline");
  });

  it("HYSTERESIS: a node demoted to degraded that re-heartbeats (recovers) is NOT re-demoted by the next sweep", async () => {
    const service = new HeartbeatService(ctx.querier);
    // Start stale → degrade it.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 40, healthState: "online" });
    expect(await service.sweepStaleNodes()).toHaveLength(1);
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("degraded");

    // The node recovers — a fresh heartbeat promotes it back to online and resets
    // the server timestamp. The sweep is demote-only; ingest is the only promoter.
    await service.recordHeartbeat({ nodeId: NODE_ID, healthState: "online" });
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("online");

    // The next sweep sees a current heartbeat → no re-demotion. The node's
    // heartbeats resumed within the `30s` band, so it returned to `online` without
    // ever passing through `offline` — the Spec-003 line 60 hysteresis property.
    expect(await service.sweepStaleNodes()).toHaveLength(0);
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("online");
  });

  it("respects injected non-default thresholds (the bands are the Spec figures, but configurable)", async () => {
    // Tight bands: degrade at 2s, offline at 4s. Confirms the SQL second-count is
    // driven by the constructor options, not hard-coded.
    const service = new HeartbeatService(ctx.querier, {
      degradedAfterMs: 2_000,
      offlineAfterMs: 4_000,
    });
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 3, healthState: "online" });

    const transitions = await service.sweepStaleNodes();
    expect(transitions[0]).toMatchObject({ from: "online", to: "degraded" });
  });

  it("the canonical thresholds are the Spec-003 line 60 figures (30s / 60s)", () => {
    expect(RUNTIME_NODE_DEGRADED_AFTER_MS).toBe(30_000);
    expect(RUNTIME_NODE_OFFLINE_AFTER_MS).toBe(60_000);
  });

  it("rejects an inverted hysteresis configuration (offline band before degraded band) at construction", () => {
    expect(
      () => new HeartbeatService(ctx.querier, { degradedAfterMs: 60_000, offlineAfterMs: 30_000 }),
    ).toThrow(/offlineAfterMs.*must be >=.*degradedAfterMs/);
  });

  it("SUB-SECOND bands do NOT mass-demote the fleet (fractional make_interval, no floor-to-zero)", async () => {
    // Regression guard: a sub-second ops-knob override must NOT floor to a `0s`
    // band. With `Math.floor(500 / 1000) === 0`, `make_interval(secs => 0)` makes
    // the predicate `last_heartbeat_at < now()`, which matches EVERY row and
    // demotes the whole fleet — including nodes that just heartbeated. Passing the
    // FRACTIONAL `0.5` / `0.8` instead keeps the band sub-second-accurate.
    const service = new HeartbeatService(ctx.querier, {
      degradedAfterMs: 500,
      offlineAfterMs: 800,
    });
    // A FRESH node (0s old) — heartbeated this instant. Must survive the sweep.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 0, healthState: "online" });
    // A genuinely STALE node (2s old) — past both sub-second bands. Positive
    // control: the sweep is doing real work, so the fresh-node survival below is
    // load-bearing, not a vacuous no-op.
    await seedPresence(ctx.querier, { nodeId: NODE_ID_2, agedSeconds: 2, healthState: "online" });

    const transitions = await service.sweepStaleNodes();

    // The stale node IS demoted (to offline — 2s is past the 0.8s offline band).
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: "online", to: "offline" });
    expect((await readPresence(ctx.querier, NODE_ID_2))?.health_state).toBe("offline");
    // The fresh node is UNTOUCHED — proving no floor-to-zero mass-demote.
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("online");
  });
});

// ----------------------------------------------------------------------------
// Spec-003 line 61 — control-plane-owned, server-derived sweep (never self-reported)
// ----------------------------------------------------------------------------

describe("HeartbeatService.sweepStaleNodes (Spec-003 line 61 — server-derived, control-plane-owned)", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_A_ID);
  });

  it("the SWEEP (not the daemon) drives the demotion — health is server-derived", async () => {
    const service = new HeartbeatService(ctx.querier);
    // A node that last self-reported `online` but has gone silent past the offline
    // band. Nothing the node sent says `offline` — the control plane DERIVES it.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 120, healthState: "online" });

    // Before the sweep the stored state is still the node's last self-report.
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("online");
    // The control-plane sweep is what transitions it to offline.
    await service.sweepStaleNodes();
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("offline");
  });

  it("stamps last_heartbeat_at with the SERVER clock — the request carries no timestamp to self-report", async () => {
    const service = new HeartbeatService(ctx.querier);
    // Seed a row whose stored timestamp is far in the FUTURE (a hypothetical
    // self-reported clock the node could try to push). A fresh heartbeat must
    // OVERWRITE it with the server `now()`, not preserve a client-chosen value —
    // there is no request field that could carry one.
    await ctx.querier.query(
      `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at, health_state)
       VALUES ($1, now() + make_interval(secs => 3600), 'online')`,
      [NODE_ID],
    );

    await service.recordHeartbeat({ nodeId: NODE_ID, healthState: "online" });

    const row = await readPresence(ctx.querier, NODE_ID);
    // The stored timestamp is now the SERVER's (within seconds of now), NOT the
    // +1h value — proving the timestamp is server-derived, never self-reported.
    const ageMs = Date.now() - new Date(row?.last_heartbeat_at ?? 0).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(5_000);
  });

  it("a self-reported 'online' heartbeat does NOT rescue a node from a sweep if its server timestamp is stale", async () => {
    const service = new HeartbeatService(ctx.querier);
    // The node's stored health is `online` (its last self-report) but its SERVER
    // timestamp is 120s stale. The node cannot self-report itself fresh — only a
    // new server-stamped heartbeat resets the clock. The sweep offlines it on the
    // server-derived staleness, regardless of the stored self-reported health.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 120, healthState: "online" });

    const transitions = await service.sweepStaleNodes();
    expect(transitions[0]).toMatchObject({ from: "online", to: "offline" });
  });
});

// ----------------------------------------------------------------------------
// I-003-5 — presence→attachment session join reads the active set (≤1 active)
// ----------------------------------------------------------------------------

describe("HeartbeatService.sweepStaleNodes (I-003-5 — presence→active-attachment session join)", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_A_ID);
  });

  it("carries the node's single ACTIVE attachment session id on the transition", async () => {
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_A_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 120, healthState: "online" });

    const service = new HeartbeatService(ctx.querier);
    const transitions = await service.sweepStaleNodes();
    expect(transitions[0]?.sessionId).toBe(SESSION_A_ID);
  });

  it("a node with NO active attachment still demotes + emits, with sessionId ABSENT", async () => {
    // No attachment row at all — the LEFT JOIN yields NULL → sessionId undefined.
    // The node still demotes (presence is per-node, not gated on an attachment).
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 120, healthState: "online" });

    const service = new HeartbeatService(ctx.querier);
    const transitions = await service.sweepStaleNodes();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.to).toBe("offline");
    expect(transitions[0]?.sessionId).toBeUndefined();
  });

  it("does NOT join an INACTIVE (offline) attachment — only the active set yields a session id", async () => {
    // An `offline` attachment escapes the active predicate (state IN
    // ('registering','online','degraded')), so the join must NOT select its
    // session — sessionId stays absent even though an attachment row exists.
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_A_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "offline",
    });
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 120, healthState: "online" });

    const service = new HeartbeatService(ctx.querier);
    const transitions = await service.sweepStaleNodes();
    expect(transitions[0]?.sessionId).toBeUndefined();
  });

  it("selects the single ACTIVE session id even when an INACTIVE attachment to another session also exists (≤1 active)", async () => {
    // I-003-5 guarantees ≤1 ACTIVE attachment, but a node may carry inactive rows
    // for other sessions (e.g. a prior detached session). The join reads through
    // the active predicate, so it deterministically selects the ONE active
    // session and ignores the inactive one — the index forbids two active rows, so
    // the join can never face an ambiguous two-active-session choice.
    const secondSessionId = "01970000-0000-7000-8000-0000000e0002";
    await seedSession(ctx.querier, secondSessionId);
    // An inactive (revoked) attachment to the second session.
    await seedAttachment(ctx.querier, {
      sessionId: secondSessionId,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "revoked",
    });
    // The single active attachment to session A.
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_A_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 120, healthState: "online" });

    const service = new HeartbeatService(ctx.querier);
    const transitions = await service.sweepStaleNodes();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.sessionId).toBe(SESSION_A_ID);
  });
});

// ----------------------------------------------------------------------------
// Emit-once-per-transition — only a genuine state CHANGE surfaces a transition
// ----------------------------------------------------------------------------

describe("HeartbeatService.sweepStaleNodes (emit-once-per-transition idempotency)", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_A_ID);
  });

  it("does not re-emit for a node already at the target state (a stable degraded node re-swept)", async () => {
    const onTransition = vi.fn();
    const service = new HeartbeatService(ctx.querier, { onTransition });

    // Already `degraded`, aged in the degraded band (past 30s, under 60s). The
    // degraded pass excludes `health_state IN ('degraded','offline')`, so a second
    // sweep finds nothing to change → no re-emit.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 45, healthState: "degraded" });

    expect(await service.sweepStaleNodes()).toHaveLength(0);
    expect(onTransition).not.toHaveBeenCalled();
    // The state is unchanged (still degraded), not re-written.
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("degraded");
  });

  it("an already-offline node is not re-emitted (the offline pass excludes it)", async () => {
    const onTransition = vi.fn();
    const service = new HeartbeatService(ctx.querier, { onTransition });
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 200, healthState: "offline" });

    expect(await service.sweepStaleNodes()).toHaveLength(0);
    expect(onTransition).not.toHaveBeenCalled();
  });

  it("emits the degraded transition exactly once across two consecutive sweeps in the degraded band", async () => {
    const onTransition = vi.fn();
    const service = new HeartbeatService(ctx.querier, { onTransition });
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 45, healthState: "online" });

    // First sweep: online → degraded (one emit). Second sweep: still degraded,
    // still in band → no second emit (idempotency lives in the stored state).
    await service.sweepStaleNodes();
    await service.sweepStaleNodes();
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition).toHaveBeenCalledWith(
      expect.objectContaining({ from: "online", to: "degraded" }),
    );
  });
});

// ----------------------------------------------------------------------------
// Crash guard — a throwing/rejecting observer is swallowed; other nodes still fire
// ----------------------------------------------------------------------------

describe("HeartbeatService.sweepStaleNodes (onTransition crash guard)", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_A_ID);
  });

  it("swallows a SYNC throw from the observer — the demotion still commits", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const service = new HeartbeatService(ctx.querier, {
      onTransition: () => {
        throw new Error("observer sync boom");
      },
    });
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 90, healthState: "online" });

    // The sweep itself resolves (the throw is caught per-node), and the demotion
    // is durably committed despite the observer throwing.
    await expect(service.sweepStaleNodes()).resolves.toHaveLength(1);
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("offline");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("observer threw (sync)"),
      expect.any(Error),
    );
  });

  it("swallows an ASYNC rejection from the observer — the demotion still commits", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const service = new HeartbeatService(ctx.querier, {
      onTransition: () => Promise.reject(new Error("observer async boom")),
    });
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 90, healthState: "online" });

    await expect(service.sweepStaleNodes()).resolves.toHaveLength(1);
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("offline");
    // Let the rejected microtask settle so the routed `.catch` runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("observer rejected (async)"),
      expect.any(Error),
    );
  });

  it("one node's throwing observer does NOT abort the OTHER nodes' transitions (per-node guard)", async () => {
    const seen: string[] = [];
    const service = new HeartbeatService(ctx.querier, {
      onTransition: (transition) => {
        seen.push(String(transition.nodeId));
        // The FIRST node's observer throws; the loop must still notify the second.
        if (String(transition.nodeId) === NODE_ID) {
          throw new Error("first node observer boom");
        }
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Two nodes, both aged past the offline band.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 90, healthState: "online" });
    await seedPresence(ctx.querier, { nodeId: NODE_ID_2, agedSeconds: 90, healthState: "online" });

    const transitions = await service.sweepStaleNodes();
    expect(transitions).toHaveLength(2);
    // BOTH nodes' observers were invoked despite the first one throwing — the
    // guard is per-node, not one try/catch around the whole loop.
    expect(seen).toContain(String(NODE_ID));
    expect(seen).toContain(String(NODE_ID_2));
    // Both demotions committed.
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("offline");
    expect((await readPresence(ctx.querier, NODE_ID_2))?.health_state).toBe("offline");
  });
});

// ----------------------------------------------------------------------------
// start() / stop() — the periodic sweep timer lifecycle (Plan-003 T3.6, 5s)
// ----------------------------------------------------------------------------

describe("HeartbeatService start()/stop() — periodic sweep timer", () => {
  it("start() schedules a repeating sweep; stop() clears it; both are idempotent", () => {
    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      const service = new HeartbeatService(ctx.querier, { sweepIntervalMs: 5_000 });

      service.start();
      // A second start() is a no-op — it does not stack a second interval.
      service.start();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5_000);

      service.stop();
      // A second stop() when not running is a no-op.
      service.stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the scheduled tick drives sweepStaleNodes (a stale node is demoted by the timer, not just a direct call)", async () => {
    vi.useFakeTimers();
    let service: HeartbeatService | undefined;
    try {
      await seedParticipant(ctx.querier, PARTICIPANT_ID);
      await seedSession(ctx.querier, SESSION_A_ID);
      await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 90, healthState: "online" });

      service = new HeartbeatService(ctx.querier, { sweepIntervalMs: 5_000 });
      service.start();

      // Advance to the first tick and let the async sweep settle.
      await vi.advanceTimersByTimeAsync(5_000);
    } finally {
      service?.stop();
      vi.useRealTimers();
    }

    // The timer-driven sweep offlined the stale node (no direct sweepStaleNodes
    // call was made — the interval callback drove it).
    expect((await readPresence(ctx.querier, NODE_ID))?.health_state).toBe("offline");
  });
});

// ----------------------------------------------------------------------------
// Seam → payload bridge — a sweep transition record synthesizes into a
// contract-valid runtime_node.degraded / .offline payload
// ----------------------------------------------------------------------------
//
// This is the load-bearing reason T3.6 CO-AUTHORS `RuntimeNodeDegradedPayloadSchema`
// alongside its producer (this sweep): the daemon-side writer (Plan-006 Tier 4)
// will `.parse()` the payload it builds from a transition record, so the record's
// discrete fields MUST be shape-compatible with the payload schema. The service
// tests above exercise the transition RECORD; these tests exercise the boundary
// where that record becomes a payload — closing the gap that the schema is
// otherwise authored-but-unexercised (the §Preload-Bridge gap: a contract whose
// shape is never validated against its intended consumption).
//
// We do NOT construct the payload inside the service (that is the daemon writer's
// job, ADR-017 — the control plane has no event log). We construct it HERE, in the
// test, exactly as the writer will, and assert (a) a real degraded/offline
// transition produces a payload the canonical schema ACCEPTS, and (b) the
// load-bearing validation behaviors the schemas encode actually fire (`detail`
// required-non-empty, `degradedCapabilities` empty-allowed, `.strict()` rejects
// unknown keys). `from`/`to` are `RuntimeNodePresenceHealth` (`online | degraded |
// offline`), all valid `NodeState` members, so they assign to the payload's
// `previousState` / `newState` without a cast.
describe("HeartbeatService — sweep transition → contract payload bridge", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_A_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_A_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });
  });

  it("a degraded transition synthesizes into a RuntimeNodeDegradedPayloadSchema-valid payload (degradedCapabilities empty-allowed for the staleness producer)", async () => {
    const service = new HeartbeatService(ctx.querier);
    // Aged into the degraded band → online→degraded transition.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 45, healthState: "online" });
    const [transition] = await service.sweepStaleNodes();
    expect(transition).toMatchObject({ from: "online", to: "degraded" });

    // The daemon writer builds the degraded payload from the transition record.
    // The staleness producer carries an EMPTY degradedCapabilities (no per-
    // capability signal — the node is reachable-but-stale) and a non-empty
    // `detail` staleness reason. This is exactly the shape the schema must accept
    // (degradedCapabilities NOT required-non-empty) — and the reason the schema
    // was authored this way.
    const degradedPayload: RuntimeNodeDegradedPayload = {
      nodeId: transition!.nodeId,
      sessionId: transition!.sessionId,
      previousState: transition!.from,
      newState: transition!.to,
      degradedCapabilities: [],
      detail: `heartbeat stale: last seen ${transition!.lastHeartbeatAt}`,
    };

    // The canonical schema ACCEPTS the synthesized payload — round-trips byte-for-
    // byte (proves the discrete record maps zero-impedance onto the payload).
    const parsed = RuntimeNodeDegradedPayloadSchema.parse(degradedPayload);
    expect(parsed).toEqual(degradedPayload);
    expect(parsed.sessionId).toBe(SESSION_A_ID);
  });

  it("REJECTS a degraded payload whose detail is empty (the load-bearing wireFreeFormString .min(1))", () => {
    // `detail` is required-non-empty: a degraded event always explains itself, so
    // the staleness producer MUST pass a non-empty reason. An empty detail is the
    // exact failure the `.min(1)` guards — assert it rejects rather than silently
    // admitting a reasonless degraded event.
    const payloadWithEmptyDetail: RuntimeNodeDegradedPayload = {
      nodeId: NODE_ID,
      sessionId: SESSION_A_ID,
      previousState: "online",
      newState: "degraded",
      degradedCapabilities: [],
      detail: "",
    };
    expect(() => RuntimeNodeDegradedPayloadSchema.parse(payloadWithEmptyDetail)).toThrow();
    // A whitespace-only detail is likewise rejected (the `\S` requirement).
    expect(() =>
      RuntimeNodeDegradedPayloadSchema.parse({ ...payloadWithEmptyDetail, detail: "   " }),
    ).toThrow();
  });

  it("REJECTS a degraded payload carrying an unknown key (.strict())", () => {
    // `.strict()` rejects extra keys — a misnamed/extra field on the wire is a
    // contract violation, not silently dropped.
    const payloadWithExtraKey = {
      nodeId: NODE_ID,
      previousState: "online",
      newState: "degraded",
      degradedCapabilities: [],
      detail: "heartbeat stale",
      // Not a member of RuntimeNodeDegradedPayload — `.strict()` must reject it.
      lastHeartbeatAt: "2026-06-04T00:00:00.000Z",
    };
    expect(() => RuntimeNodeDegradedPayloadSchema.parse(payloadWithExtraKey)).toThrow();
  });

  it("an offline transition synthesizes into a RuntimeNodeOfflinePayloadSchema-valid payload (lastHeartbeatAt + heartbeat_lost reason)", async () => {
    const service = new HeartbeatService(ctx.querier);
    // Aged straight past the offline band → online→offline transition carrying the
    // `heartbeat_lost` reason + the demoting last-heartbeat timestamp.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, agedSeconds: 120, healthState: "online" });
    const [transition] = await service.sweepStaleNodes();
    expect(transition).toMatchObject({ from: "online", to: "offline", reason: "heartbeat_lost" });

    // The offline payload carries `lastHeartbeatAt` (the staleness evidence) +
    // `reason`, both present on the transition record — the writer reads them
    // straight across. `lastHeartbeatAt` is ISO 8601 (normalized by the service),
    // which the schema's `z.iso.datetime({ offset: true })` requires.
    const offlinePayload: RuntimeNodeOfflinePayload = {
      nodeId: transition!.nodeId,
      sessionId: transition!.sessionId,
      previousState: transition!.from,
      newState: transition!.to,
      lastHeartbeatAt: transition!.lastHeartbeatAt,
      reason: transition!.reason!,
    };

    const parsed = RuntimeNodeOfflinePayloadSchema.parse(offlinePayload);
    expect(parsed).toEqual(offlinePayload);
    expect(parsed.reason).toBe("heartbeat_lost");
    expect(parsed.lastHeartbeatAt).toBe(transition!.lastHeartbeatAt);
  });
});
