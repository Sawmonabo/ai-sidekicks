// P6 — HeartbeatService behavior gates (Plan-003 Phase 3, T3.6).
//
// Spec-003 §Default Behavior lines 59-61. Cite map (each spec_coverage row has
// an explicit home; cites are the authoritative coverage contract, ACs a
// subset):
//
//   Spec-003 line 59 (heartbeat cadence 15s / ingestion):
//       - "ingest creates / updates a presence row" (the heartbeat-reception
//         side of the 15s cadence — this service IS where a beat lands).
//       - "STALENESS_SWEEP_INTERVAL_MS is exported and finer than the 15s
//         cadence" — pins the line-61 "set finer than the 15s cadence" claim
//         that derives FROM the line-59 cadence, giving line 59 a concrete
//         numeric anchor rather than resting on framing alone.
//
//   Spec-003 line 60 (degraded@30s, offline@60s, hysteresis):
//       - "sweep demotes a 45s-stale row to degraded"
//       - "sweep demotes a 90s-stale row to offline"
//       - "sweep leaves a 10s-fresh row untouched" (the < 30s band)
//       - "hysteresis recovery": a degraded node that resumes heartbeating is
//         restored to online WITHOUT passing through offline.
//
//   Spec-003 line 61 (server-derived, sweep-driven, coordination-record
//   transition, NO durable event):
//       - "sweep is idempotent / transition-only": an already-offline row still
//         aged > 60s returns an EMPTY array (no re-write, no re-report) — the
//         production-grade idempotency a forever-looping sweep requires.
//       - "sweep writes ONLY runtime_node_presence": a co-resident
//         runtime_node_attachments row is byte-for-byte unchanged after a sweep
//         that demotes a presence row (the coordination-record axis is disjoint
//         from the attachment-slot axis).
//       - the no-durable-event property is structural: `ingest`/`sweepStaleness`
//         touch ONE table and return; there is no event-log surface to assert
//         against (ADR-017 — no control-plane event log exists).
//
// Harness: the in-process PGlite pattern from attach-service.test.ts /
// the migrations suites — a fresh ephemeral PGlite per test, `applyMigrations`
// (v1 + v2 + v3) for schema bootstrap, seeding via direct INSERTs, then
// exercising the service. The PGlite->Querier adapter is a LOCAL copy (sibling
// tests each carry their own; the dispatch contract forbids exporting a new
// test fixture from `packages/control-plane/`). Controlled ages are seeded with
// SQL server time (`now() - interval 'N seconds'`) — no fake JS timers, so
// ingest's `now()` and the sweep's `now()` share the database clock. NOTE:
// `runtime_node_presence` has NO foreign keys (`node_id` is a bare TEXT PRIMARY
// KEY), so presence rows are inserted directly with no sessions/participants
// seeding — only the no-cross-table-write test seeds an attachment (which DOES
// have FKs) to prove the boundary behaviorally.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NodeId, ParticipantId, SessionId } from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import {
  HeartbeatService,
  STALENESS_SWEEP_INTERVAL_MS,
  type SweptTransition,
} from "../heartbeat-service.js";

// ----------------------------------------------------------------------------
// Test fixtures. `NODE_ID` is a daemon-minted opaque TEXT scalar (NOT a UUID);
// the session/participant ids (used only by the no-cross-table-write test's
// attachment seeding, which has FKs) are UUID v7-shaped.
// ----------------------------------------------------------------------------

const NODE_ID: NodeId = "node-alpha-01" as NodeId;
// A second distinct node — the multi-node sweep test seeds both so the sweep's
// `.map` over multiple RETURNING rows and the per-row CASE are exercised.
const NODE_ID_BETA: NodeId = "node-beta-02" as NodeId;
const SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e0001" as SessionId;
const PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-0000000f0001" as ParticipantId;

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy — mirrors attach-service.test.ts `wrap`
// / membership-service.test.ts; the dispatch contract forbids exporting a
// shared test fixture from packages/control-plane).
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
// Seed / probe helpers
// ----------------------------------------------------------------------------

// Insert a presence row directly with a controlled age (SQL server time). Used
// to put a node at a known staleness BEFORE a sweep. `ageSeconds = 0` seeds a
// row whose `last_heartbeat_at` is the current server time (a "just heard from"
// node). No FK seeding is needed — `runtime_node_presence` has none.
async function seedPresence(
  querier: Querier,
  args: { nodeId: NodeId; ageSeconds: number; healthState: string },
): Promise<void> {
  await querier.query(
    `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at, health_state)
     VALUES ($1, now() - ($2::int * interval '1 second'), $3)`,
    [args.nodeId, args.ageSeconds, args.healthState],
  );
}

// Read a presence row's mutable columns. `last_heartbeat_at::text` normalizes
// TIMESTAMPTZ hydration across pg/PGlite; the epoch-seconds gap from server
// `now()` lets a test assert "recent" without a brittle absolute timestamp.
async function readPresence(
  querier: Querier,
  nodeId: NodeId,
): Promise<{ health_state: string; staleness_seconds: number } | undefined> {
  const probe = await querier.query<{ health_state: string; staleness_seconds: number }>(
    `SELECT health_state,
            EXTRACT(EPOCH FROM (now() - last_heartbeat_at))::float8 AS staleness_seconds
       FROM runtime_node_presence WHERE node_id = $1`,
    [nodeId],
  );
  return probe.rows[0];
}

function transitionFor(
  swept: ReadonlyArray<SweptTransition>,
  nodeId: NodeId,
): SweptTransition | undefined {
  return swept.find((transition) => transition.nodeId === String(nodeId));
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  pg: PGlite;
  querier: Querier;
  service: HeartbeatService;
}

let ctx: TestContext;

beforeEach(async () => {
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);
  ctx = { pg, querier, service: new HeartbeatService(querier) };
});

afterEach(async () => {
  await ctx.pg.close();
});

// ----------------------------------------------------------------------------
// Spec-003 line 59 — heartbeat ingestion + the sweep-interval cadence anchor
// ----------------------------------------------------------------------------

describe("HeartbeatService — ingest (Spec-003 line 59)", () => {
  it("creates a presence row with a recent last_heartbeat_at and the reported health on first heartbeat (P6)", async () => {
    await ctx.service.ingest({ nodeId: NODE_ID, healthState: "online" });

    const row = await readPresence(ctx.querier, NODE_ID);
    expect(row).toBeDefined();
    expect(row?.health_state).toBe("online");
    // `now()`-stamped, so the row is fresh — far below the 30s degraded floor.
    expect(row?.staleness_seconds ?? Number.POSITIVE_INFINITY).toBeLessThan(5);
  });

  it("updates the SAME row (no duplicate) on a subsequent heartbeat, overwriting health + timestamp (P6)", async () => {
    // First beat lands the row stale (so the second beat's timestamp bump is
    // observable as a freshness change, not just a no-op).
    await seedPresence(ctx.querier, { nodeId: NODE_ID, ageSeconds: 20, healthState: "online" });

    await ctx.service.ingest({ nodeId: NODE_ID, healthState: "degraded" });

    // The daemon now self-reports `degraded`; the upsert overwrites health and
    // re-stamps the timestamp on the EXISTING row (PRIMARY KEY conflict path).
    const row = await readPresence(ctx.querier, NODE_ID);
    expect(row?.health_state).toBe("degraded");
    expect(row?.staleness_seconds ?? Number.POSITIVE_INFINITY).toBeLessThan(5);
    expect(await countPresence(ctx.querier)).toBe(1);
  });

  it("rejects a daemon attempting to self-report offline (the 2-value wire enum is online|degraded only)", async () => {
    // Spec-003 line 61: `offline` is server-DERIVED (the sweep), never daemon-
    // self-reported. The boundary parse enforces the 2-value enum, so an
    // `offline` heartbeat is rejected before any row is written.
    await expect(
      ctx.service.ingest({ nodeId: NODE_ID, healthState: "offline" as "online" | "degraded" }),
    ).rejects.toThrow();
    // No row was written — the parse failed before the upsert.
    expect(await countPresence(ctx.querier)).toBe(0);
  });

  it("exports STALENESS_SWEEP_INTERVAL_MS finer than the 15s heartbeat cadence (Spec-003 line 59 -> line 61 bound)", () => {
    // The line-61 timing guarantee ("recorded within one sweep interval of a
    // threshold crossing", "set finer than the 15s cadence") derives from the
    // line-59 cadence. Pin it numerically: the constant is exported (T3.8's
    // scheduler imports it) and is strictly finer than 15s.
    expect(STALENESS_SWEEP_INTERVAL_MS).toBe(5_000);
    expect(STALENESS_SWEEP_INTERVAL_MS).toBeLessThan(15_000);
  });
});

// ----------------------------------------------------------------------------
// Spec-003 line 60 — sweep-driven degraded/offline + hysteresis recovery
// ----------------------------------------------------------------------------

describe("HeartbeatService — sweepStaleness demotions (Spec-003 line 60)", () => {
  it("demotes an online row stale past 30s to degraded and returns it (P6)", async () => {
    await seedPresence(ctx.querier, { nodeId: NODE_ID, ageSeconds: 45, healthState: "online" });

    const swept = await ctx.service.sweepStaleness();

    const row = await readPresence(ctx.querier, NODE_ID);
    expect(row?.health_state).toBe("degraded");
    expect(transitionFor(swept, NODE_ID)).toEqual({
      nodeId: String(NODE_ID),
      healthState: "degraded",
    });
  });

  it("demotes a row stale past 60s to offline and returns it (P6)", async () => {
    await seedPresence(ctx.querier, { nodeId: NODE_ID, ageSeconds: 90, healthState: "online" });

    const swept = await ctx.service.sweepStaleness();

    const row = await readPresence(ctx.querier, NODE_ID);
    expect(row?.health_state).toBe("offline");
    expect(transitionFor(swept, NODE_ID)).toEqual({
      nodeId: String(NODE_ID),
      healthState: "offline",
    });
  });

  it("further demotes an ALREADY-degraded row aged past 60s to offline (the AC's degraded -> offline progression leg)", async () => {
    // The literal "degraded then offline" leg of the P6 AC: a node previously
    // demoted to `degraded` that has since aged past the 60s offline floor is
    // further demoted to `offline` by the next sweep. This exercises the
    // staleness-only target computation (the WHERE keys on staleness, not the
    // current state), so a future WHERE narrowing (e.g. an accidental
    // `AND health_state = 'online'`) that stranded degraded nodes would fail
    // here.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, ageSeconds: 90, healthState: "degraded" });

    const swept = await ctx.service.sweepStaleness();

    const row = await readPresence(ctx.querier, NODE_ID);
    expect(row?.health_state).toBe("offline");
    expect(transitionFor(swept, NODE_ID)).toEqual({
      nodeId: String(NODE_ID),
      healthState: "offline",
    });
  });

  it("leaves a fresh row (< 30s) untouched and does NOT return it", async () => {
    await seedPresence(ctx.querier, { nodeId: NODE_ID, ageSeconds: 10, healthState: "online" });

    const swept = await ctx.service.sweepStaleness();

    const row = await readPresence(ctx.querier, NODE_ID);
    expect(row?.health_state).toBe("online");
    expect(transitionFor(swept, NODE_ID)).toBeUndefined();
  });

  it("restores a sweep-demoted degraded node to online on resumed heartbeat WITHOUT passing through offline (hysteresis)", async () => {
    // The node was demoted to `degraded` (heartbeat aged into the 30-60s band).
    await seedPresence(ctx.querier, { nodeId: NODE_ID, ageSeconds: 45, healthState: "degraded" });

    // Its heartbeats resume WITHIN the hysteresis band — ingest restores it.
    await ctx.service.ingest({ nodeId: NODE_ID, healthState: "online" });

    const afterIngest = await readPresence(ctx.querier, NODE_ID);
    expect(afterIngest?.health_state).toBe("online");
    expect(afterIngest?.staleness_seconds ?? Number.POSITIVE_INFINITY).toBeLessThan(5);

    // A subsequent sweep leaves it `online` and reports nothing for it — it
    // recovered without ever crossing into `offline`.
    const swept = await ctx.service.sweepStaleness();
    const afterSweep = await readPresence(ctx.querier, NODE_ID);
    expect(afterSweep?.health_state).toBe("online");
    expect(transitionFor(swept, NODE_ID)).toBeUndefined();
  });

  it("resurrects a sweep-declared offline node to online on ANY resumed heartbeat (no re-attach gating)", async () => {
    // The one liveness-recovery transition the hysteresis test does NOT cover: a
    // node the sweep already drove to `offline` (fully dead, aged past 60s)
    // resurrects on a resumed heartbeat via the SAME unconditional
    // `DO UPDATE SET ... health_state = $2` path. This pins that the liveness
    // axis (`runtime_node_presence`) and the attachment-slot axis are disjoint:
    // a heartbeat restores liveness with NO re-attach gating (re-attach against
    // an `offline` ATTACHMENT row is a separate concern owned by T3.2/T3.7).
    await seedPresence(ctx.querier, { nodeId: NODE_ID, ageSeconds: 90, healthState: "offline" });

    await ctx.service.ingest({ nodeId: NODE_ID, healthState: "online" });

    const afterIngest = await readPresence(ctx.querier, NODE_ID);
    expect(afterIngest?.health_state).toBe("online");
    expect(afterIngest?.staleness_seconds ?? Number.POSITIVE_INFINITY).toBeLessThan(5);

    // And a follow-up sweep leaves the resurrected node alone.
    const swept = await ctx.service.sweepStaleness();
    expect(transitionFor(swept, NODE_ID)).toBeUndefined();
  });

  it("sweeps MULTIPLE nodes in one pass, returning each with its own per-row target (multiplicity)", async () => {
    // Every other test seeds exactly one row, so the sweep's `.map` over
    // multiple RETURNING rows and the per-row CASE are never exercised — a
    // regression to "one global target for the whole table" or "return only the
    // first row" would pass them all. Seed two nodes at DIFFERENT ages so they
    // demote to DIFFERENT targets in a SINGLE sweep; the returned array (which
    // feeds T3.8 observability) must carry both, each at its correct target.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, ageSeconds: 45, healthState: "online" });
    await seedPresence(ctx.querier, {
      nodeId: NODE_ID_BETA,
      ageSeconds: 90,
      healthState: "online",
    });

    const swept = await ctx.service.sweepStaleness();

    // Per-row targets, both surfaced (order-independent — assert by node id).
    expect(transitionFor(swept, NODE_ID)).toEqual({
      nodeId: String(NODE_ID),
      healthState: "degraded",
    });
    expect(transitionFor(swept, NODE_ID_BETA)).toEqual({
      nodeId: String(NODE_ID_BETA),
      healthState: "offline",
    });
    expect(swept).toHaveLength(2);

    // Both rows actually landed at their respective states.
    const alpha = await readPresence(ctx.querier, NODE_ID);
    const beta = await readPresence(ctx.querier, NODE_ID_BETA);
    expect(alpha?.health_state).toBe("degraded");
    expect(beta?.health_state).toBe("offline");
  });
});

// ----------------------------------------------------------------------------
// Spec-003 line 61 — idempotent / transition-only + writes only presence
// ----------------------------------------------------------------------------

describe("HeartbeatService — sweep idempotency + write boundary (Spec-003 line 61)", () => {
  it("does NOT re-write or re-report an already-offline row still aged past 60s (idempotent / transition-only)", async () => {
    // The row is ALREADY at its computed target (`offline`) and still stale. A
    // re-sweep must be a no-op: no re-write, no re-report. This pins the
    // production-grade idempotency a forever-looping 5s sweep requires.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, ageSeconds: 90, healthState: "offline" });

    const swept = await ctx.service.sweepStaleness();

    expect(swept).toEqual([]);
    expect(transitionFor(swept, NODE_ID)).toBeUndefined();
    // Still offline, still the only row.
    const row = await readPresence(ctx.querier, NODE_ID);
    expect(row?.health_state).toBe("offline");
    expect(await countPresence(ctx.querier)).toBe(1);
  });

  it("does NOT promote an explicitly-detached offline row back to degraded while it sits in the 30-60s band", async () => {
    // detach (attach-service.ts) parks a node at `offline` but leaves its
    // last_heartbeat_at at the final beat. Seeded squarely in the 30-60s band
    // (~40s), the sweep's CASE computes `degraded` for that staleness — so
    // WITHOUT the offline guard the transition predicate (`offline <> degraded`)
    // would rewrite this retired node back to `degraded` and re-report it. The
    // sweep only ever demotes; an `offline` row is terminal for it. Seeding at
    // 90s would NOT exercise this — the CASE-target guard already excludes a
    // 90s-stale offline row, so this case must sit in the degraded band to bite.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, ageSeconds: 40, healthState: "offline" });

    const swept = await ctx.service.sweepStaleness();

    // Stays offline (NOT rewritten to degraded) and is not re-reported.
    const row = await readPresence(ctx.querier, NODE_ID);
    expect(row?.health_state).toBe("offline");
    expect(transitionFor(swept, NODE_ID)).toBeUndefined();
  });

  it("does NOT re-report a degraded row already at its degraded target (idempotent across the 30-60s band)", async () => {
    // The complementary idempotency case: a row already `degraded` and aged in
    // the 30-60s band stays put and is not re-reported.
    await seedPresence(ctx.querier, { nodeId: NODE_ID, ageSeconds: 45, healthState: "degraded" });

    const swept = await ctx.service.sweepStaleness();

    expect(swept).toEqual([]);
    const row = await readPresence(ctx.querier, NODE_ID);
    expect(row?.health_state).toBe("degraded");
  });

  it("writes ONLY runtime_node_presence — a co-resident attachment row is byte-for-byte unchanged after a sweep", async () => {
    // Seed a full attachment row (it has FKs, so seed its session + participant)
    // alongside a stale presence row. The sweep must demote presence WITHOUT
    // touching the attachment-slot axis (the two axes are disjoint — Spec-003
    // line 61). Proven behaviorally (the boundary holds at runtime), not by
    // inspecting the SQL string.
    await ctx.querier.query("INSERT INTO participants (id) VALUES ($1)", [PARTICIPANT_ID]);
    await ctx.querier.query("INSERT INTO sessions (id, state) VALUES ($1, 'active')", [SESSION_ID]);
    const attachmentBefore = await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });
    await seedPresence(ctx.querier, { nodeId: NODE_ID, ageSeconds: 90, healthState: "online" });

    const swept = await ctx.service.sweepStaleness();

    // Presence transitioned (the sweep DID act this tick — so an unchanged
    // attachment is meaningful, not a vacuous "nothing ran").
    expect(transitionFor(swept, NODE_ID)?.healthState).toBe("offline");
    // The attachment row is byte-for-byte identical (no state flip, no
    // re-timestamp): the sweep never named runtime_node_attachments.
    const attachmentAfter = await readAttachment(ctx.querier, NODE_ID, SESSION_ID);
    expect(attachmentAfter).toEqual(attachmentBefore);
    expect(attachmentAfter?.state).toBe("online");
  });
});

// ----------------------------------------------------------------------------
// Shared probes (declared after the suites that don't need them for readability)
// ----------------------------------------------------------------------------

async function countPresence(querier: Querier): Promise<number> {
  const probe = await querier.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM runtime_node_presence",
  );
  return probe.rows[0]?.n ?? -1;
}

// Seed a runtime_node_attachments row (FK-backed) and return its mutable
// columns for the byte-identity comparison the no-cross-table-write test makes.
async function seedAttachment(
  querier: Querier,
  args: { sessionId: SessionId; participantId: ParticipantId; nodeId: NodeId; state: string },
): Promise<{ id: string; state: string; attached_at: string } | undefined> {
  await querier.query(
    `INSERT INTO runtime_node_attachments
       (session_id, participant_id, node_id, capabilities, client_version, state)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [args.sessionId, args.participantId, args.nodeId, {}, "1.0", args.state],
  );
  return readAttachment(querier, args.nodeId, args.sessionId);
}

// Re-read an attachment row's mutable columns (text-cast TIMESTAMPTZ to
// normalize pg/PGlite hydration) for the before/after byte-identity assertion.
async function readAttachment(
  querier: Querier,
  nodeId: NodeId,
  sessionId: SessionId,
): Promise<{ id: string; state: string; attached_at: string } | undefined> {
  const probe = await querier.query<{ id: string; state: string; attached_at: string }>(
    `SELECT id, state, attached_at::text AS attached_at
       FROM runtime_node_attachments WHERE node_id = $1 AND session_id = $2`,
    [nodeId, sessionId],
  );
  return probe.rows[0];
}
