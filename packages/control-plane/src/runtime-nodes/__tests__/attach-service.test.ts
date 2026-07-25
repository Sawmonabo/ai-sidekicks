// P1 / P2 / P3 / P5 / P7 / P8 / P9 / P10 — AttachService behavior gates (Plan-003
// Phase 3, T3.2 + T3.3 + T3.5 + T3.7) — plus the readRoster projection suite
// (Plan-003 Phase 5, T5.0c; the trailing describe blocks).
//
// `Spec-003 §Required Behavior` (attach is a separate step from membership
// acceptance; multiple runtime nodes per session; attach must not require
// session recreation; detach/offline must not revoke membership by default;
// version-floor admission) / `Spec-003 §Default Behavior` (an explicit `detach`
// retires the node) + Plan-003 §Invariants I-003-1 / I-003-3 / I-003-5.
//
// readRoster (T5.0c): `Spec-003 §Acceptance Criteria` (AC2 — degraded/offline
// distinguishable from healthy online; AC3 — multiple nodes coexist without
// changing session identity; AC4 — the derived readOnly verdict surfaced on
// read) / `Spec-003 §Required Behavior` (multiple runtime nodes per session) /
// `Spec-003 §Fallback Behavior` (a capability-degraded node stays visible, not
// treated as healthy) / `Spec-003 §Default Behavior` (both health axes verbatim,
// never collapsed) + `Spec-003 §Interfaces And Contracts` 2026-06-09 amendment
// (visibility / nullability / derived readOnly / never-mask / ADR-017 non-collision).
//
// P1 (`Spec-003 §Required Behavior`): a session whose `min_client_version` floor is NULL
//     ("no floor") admits EVERY daemon version with `readOnly = false`. The
//     attachment row is created in the `registering` liveness state.
//
// P2 / P3 (`Spec-003 §Required Behavior` / I-003-1, T3.3): a non-NULL floor compares the
//     daemon's `clientVersion` numerically (MAJOR.MINOR).
//     P2 (client_version >= floor) — admit read-write (`readOnly = false`).
//     P3 (client_version  < floor) — admit READ-ONLY (`readOnly = true`); the
//         node remains joined and reads succeed, never ejected (admit-not-eject).
//     Multi-digit cases ("10.0" > "2.0"; "1.9" < "1.10") guard against a lexical
//     string compare; a malformed floor is rejected at the read-time parse (it is
//     NOT silently admitted).
//
// P5 (`Spec-003 §Required Behavior` + AC3 / I-003-3, T3.5 — characterization only):
//     two DISTINCT nodes attach to the SAME session and both land as active
//     `registering` rows (the `(node_id, session_id)` arbiter + the per-node
//     active index admit multi-node-per-session), while the `sessions` row stays
//     byte-for-byte identical and uncreated (attach never writes `sessions` —
//     `Spec-003 §Required Behavior`, no recreation). No production change: the shipped T3.2
//     path already satisfies this.
//
// P9 (I-003-5, single active attachment):
//     P9a (cross-session conflict) — a node already actively attached to ANOTHER
//         session is refused with the typed `RuntimeNodeAttachConflictException`
//         (the partial-unique `idx_node_attachments_active` `23505`, translated).
//     P9b (reconnect) — a node whose row for THIS session is `offline` is
//         reactivated by re-attach (offline -> registering), NOT refused.
//
// P10 (revocation is terminal): a re-attach against a row in the terminal
//     `revoked` state for THIS session is refused with the typed
//     `RuntimeNodeAttachRevokedException` — never reactivated.
//
// P7 / P8 (I-003-3, attach-membership separation — Plan-003 test matrix):
//     P7 (`Spec-003 §Required Behavior` — `RuntimeNodeAttach MUST NOT mutate
//         session_memberships`) is verified by the shipped attach I-003-3 test
//         (the "leaves a co-resident session_memberships row byte-for-byte
//         unchanged after a successful attach" block below) — no separate P7 test
//         is added here, the existing attach test IS P7.
//     P8 (`Spec-003 §Required Behavior` — `RuntimeNodeDetach leaves session_memberships
//         unchanged`; an offline/detached node retains its membership) is the new
//         detach happy-path test below. Asserted along the SAME two disjoint
//         mutation modes as the attach I-003-3 test (byte-identity snapshot +
//         total count).
//
// detach correctness (T3.7, `Spec-003 §Default Behavior` "an explicit `detach` retires the
//     node"; I-003-5 single-active resolution): detach writes the terminal state
//     `offline` ONLY (it is NOT a `revoked` producer — `Spec-003 §Default Behavior`). The new
//     detach block covers the slot+liveness `-> offline` transition (P8 happy
//     path), the LOAD-BEARING revoked-not-flipped guard (the active-state filter
//     protects P10 revocation-terminality), idempotent re-detach, the never-
//     attached no-op, and the presence-absent UPDATE-only no-op.
//
// I-003-3 (attach must not mutate session_memberships): a successful attach
//     leaves the `session_memberships` table untouched. Asserted along TWO
//     disjoint mutation modes — (1) a before/after byte-identity snapshot of a
//     co-resident row's mutable columns catches an in-place UPDATE (which a
//     count check misses), and (2) an unchanged total row count catches a stray
//     INSERT/DELETE of a different row (which the single-row snapshot misses).
//
// Suite order: P10 and P9a run FIRST. If the revoked-suppression /
// cross-session-conflict reasoning in attach-service.ts is wrong, the failure
// (a `25P02` aborted-transaction error or a wrong-exception) surfaces
// immediately, before the happy-path tests.
//
// Harness: the PGlite-in-memory pattern from
// `memberships/__tests__/membership-service.test.ts` / the migrations suites —
// a fresh ephemeral PGlite instance per test, `applyMigrations` (v1 + v2 + v3)
// for schema bootstrap, seeding via direct INSERTs, then exercising the service.
// The PGlite->Querier adapter is a LOCAL copy (the dispatch contract forbids
// exporting a new test fixture from `packages/control-plane/`; sibling tests
// each carry their own copy — see
// migrations/__tests__/runtime-node-upstream-anchors.test.ts note (e)).

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import type {
  EventEnvelopeVersion,
  NodeId,
  ParticipantId,
  RuntimeNodeAttachRequest,
  RuntimeNodeCapabilityUpdateRequest,
  SessionId,
} from "@ai-sidekicks/contracts";
import {
  RUNTIME_NODE_ATTACH_CONFLICT_CODE,
  RUNTIME_NODE_ATTACH_REVOKED_CODE,
  RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE,
  VERSION_FLOOR_EXCEEDED_CODE,
} from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import { AttachService } from "../attach-service.js";
import {
  RuntimeNodeAttachConflictException,
  RuntimeNodeAttachRevokedException,
  RuntimeNodeCapabilityUpdateConflictException,
  VersionFloorExceededException,
} from "../errors.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUID v7-shaped ids (the brand validators accept any RFC 9562
// UUID; real generation is daemon-side). `NODE_ID` is a daemon-minted opaque
// TEXT scalar (NOT a UUID), `CLIENT_VERSION` is the branded MAJOR.MINOR semver.
// ----------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e0001" as SessionId;
const OTHER_SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e0002" as SessionId;
const PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-0000000f0001" as ParticipantId;
// A SECOND participant for the cross-owner reconnect block: a DIFFERENT
// participant attempting to reattach a node to a session whose existing
// `(node_id, session_id)` row is owned by `PARTICIPANT_ID`. The owner is
// immutable across reconnect (`Spec-003 §Implementation Notes`), so this reattach is refused
// and the row's owner stays `PARTICIPANT_ID` (`Spec-003 §Pitfalls To Avoid` — never destroy
// node provenance).
const OTHER_PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-0000000f0002" as ParticipantId;
const NODE_ID: NodeId = "node-alpha-01" as NodeId;
// A SECOND daemon-minted node id for the P5 multi-node-coexistence block: a
// distinct opaque TEXT scalar so node A and node B are two separate active
// attachments in the SAME session (the `(node_id, session_id)` conflict arbiter
// treats them as two distinct pairs; the per-node active index does not collide
// across distinct node_ids).
const NODE_ID_BETA: NodeId = "node-beta-02" as NodeId;
const CLIENT_VERSION: EventEnvelopeVersion = "1.4" as EventEnvelopeVersion;

// A distinctive capability map so the P1 JSONB round-trip asserts the value
// survived serialization into the JSONB column (a silent stringify bug would
// pass a state-only assertion — see advisor note).
const CAPABILITIES: Record<string, unknown> = {
  "provider-driver": { kind: "claude", streaming: true },
  maxConcurrentRuns: 3,
};

// A DISTINCT capability map for the capability-update round-trip: a different
// shape than the seeded `{a:1}`-style snapshot so the refresh assertion proves
// the new map REPLACED the old one (the request carries a full replacement set
// — the FULL-REPLACEMENT sentence in the `RuntimeNodeCapabilityUpdateRequest`
// header comment), and the JSONB round-trip proves the cast-free object bind
// survived serialization (a silent stringify bug would pass a state-only check).
const UPDATED_CAPABILITIES: Record<string, unknown> = {
  "provider-driver": { kind: "codex", streaming: false },
  maxConcurrentRuns: 8,
  toolPolicy: "auto",
};

function buildAttachRequest(
  overrides: Partial<RuntimeNodeAttachRequest> = {},
): RuntimeNodeAttachRequest {
  return {
    sessionId: SESSION_ID,
    participantId: PARTICIPANT_ID,
    nodeId: NODE_ID,
    clientVersion: CLIENT_VERSION,
    capabilities: CAPABILITIES,
    healthState: "online",
    ...overrides,
  };
}

// Build a capability-update request (mirrors `buildAttachRequest`). `capabilities`
// is REQUIRED on every request (the full replacement set), so it defaults to
// `UPDATED_CAPABILITIES`; `healthChanges` is omitted by default (a
// capabilities-only refresh) and supplied per-test for the health-transition
// cases.
function buildCapabilityUpdateRequest(
  overrides: Partial<RuntimeNodeCapabilityUpdateRequest> = {},
): RuntimeNodeCapabilityUpdateRequest {
  return {
    nodeId: NODE_ID,
    capabilities: UPDATED_CAPABILITIES,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy — mirrors membership-service.test.ts
// `wrap` / migrations/__tests__/runtime-node-upstream-anchors.test.ts note (e)).
// ----------------------------------------------------------------------------
//
// PGlite#query expects `params` as `any[]` (mutable); the `Querier` interface
// uses `ReadonlyArray<unknown>`. The spread copy decouples the mutability claim
// without copying values. `transaction(fn)` wraps `pg.transaction(fn)` and
// re-wraps the inner `tx` as a `Querier` so in-transaction code uses the same
// surface; nested `tx.transaction(...)` throws (Postgres has no native nested
// transactions without SAVEPOINTs).

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
// Seed helpers
// ----------------------------------------------------------------------------

async function seedParticipant(querier: Querier, participantId: ParticipantId): Promise<void> {
  await querier.query("INSERT INTO participants (id) VALUES ($1)", [participantId]);
}

// Seed a session. `minClientVersion` omitted => the column stays SQL NULL
// ("no floor") — the P1 unconditional-admission shape.
async function seedSession(
  querier: Querier,
  sessionId: SessionId,
  minClientVersion?: string,
): Promise<void> {
  if (minClientVersion === undefined) {
    await querier.query("INSERT INTO sessions (id, state) VALUES ($1, 'active')", [sessionId]);
    return;
  }
  await querier.query(
    "INSERT INTO sessions (id, state, min_client_version) VALUES ($1, 'active', $2)",
    [sessionId, minClientVersion],
  );
}

// Seed a runtime_node_attachments row directly (bypassing the service) so the
// P9b reconnect (`offline`) and P10 (`revoked`) tests can set up the terminal /
// reactivatable starting states the attach path then exercises. `capabilities`
// is bound as an object to the JSONB column (PGlite serializes it). Returns the
// generated attachment id.
async function seedAttachment(
  querier: Querier,
  args: {
    sessionId: SessionId;
    participantId: ParticipantId;
    nodeId: NodeId;
    state: string;
    clientVersion?: string;
  },
): Promise<string> {
  const inserted = await querier.query<{ id: string }>(
    `INSERT INTO runtime_node_attachments
       (session_id, participant_id, node_id, capabilities, client_version, state)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [args.sessionId, args.participantId, args.nodeId, {}, args.clientVersion ?? "1.0", args.state],
  );
  const row: { id: string } | undefined = inserted.rows[0];
  if (row === undefined) {
    throw new Error("seedAttachment: INSERT returned no row");
  }
  return row.id;
}

// Seed a membership row for the I-003-3 no-mutation guard. `joined_at` is cast
// to a concrete value so the byte-identity snapshot is stable.
async function seedMembership(
  querier: Querier,
  args: { sessionId: SessionId; participantId: ParticipantId; role: string; state: string },
): Promise<string> {
  const inserted = await querier.query<{ id: string }>(
    `INSERT INTO session_memberships (session_id, participant_id, role, state, joined_at)
     VALUES ($1, $2, $3, $4, now())
     RETURNING id`,
    [args.sessionId, args.participantId, args.role, args.state],
  );
  const row: { id: string } | undefined = inserted.rows[0];
  if (row === undefined) {
    throw new Error("seedMembership: INSERT returned no row");
  }
  return row.id;
}

// Re-read an attachment row's mutable columns (text-cast TIMESTAMPTZ to
// normalize pg/PGlite hydration). `capabilities::text` surfaces the stored JSONB
// so the P1 round-trip can parse it back.
async function readAttachmentRow(
  querier: Querier,
  nodeId: NodeId,
  sessionId: SessionId,
): Promise<{ state: string; capabilities: string; client_version: string } | undefined> {
  const probe = await querier.query<{
    state: string;
    capabilities: string;
    client_version: string;
  }>(
    `SELECT state, capabilities::text AS capabilities, client_version
       FROM runtime_node_attachments WHERE node_id = $1 AND session_id = $2`,
    [nodeId, sessionId],
  );
  return probe.rows[0];
}

// Read an attachment row's `participant_id` (the owner) for the reconnect
// provenance assertions: the same-owner reconnect must leave it unchanged, and a
// cross-owner reconnect must NOT overwrite it (`Spec-003 §Pitfalls To Avoid`). Returns
// `undefined` when no row exists for the `(node_id, session_id)` pair.
async function readAttachmentOwner(
  querier: Querier,
  nodeId: NodeId,
  sessionId: SessionId,
): Promise<string | undefined> {
  const probe = await querier.query<{ participant_id: string }>(
    "SELECT participant_id FROM runtime_node_attachments WHERE node_id = $1 AND session_id = $2",
    [nodeId, sessionId],
  );
  return probe.rows[0]?.participant_id;
}

// Read the FULL capability-update-relevant projection of an attachment row,
// including the `attached_at` creation timestamp (text-cast to normalize
// pg/PGlite TIMESTAMPTZ hydration). Used by the capability-update tests to prove
// (a) `attached_at` is byte-for-byte unchanged across an update (the method must
// NOT overwrite the creation clock — `updatedAt` is a transient `now()`), and
// (b) the `capabilities` snapshot round-trips. `readAttachmentRow` above omits
// `attached_at`, so this is the capability-update complement.
async function readAttachmentRowWithTimestamp(
  querier: Querier,
  nodeId: NodeId,
  sessionId: SessionId,
): Promise<{ state: string; capabilities: string; attached_at: string } | undefined> {
  const probe = await querier.query<{
    state: string;
    capabilities: string;
    attached_at: string;
  }>(
    `SELECT state, capabilities::text AS capabilities, attached_at::text AS attached_at
       FROM runtime_node_attachments WHERE node_id = $1 AND session_id = $2`,
    [nodeId, sessionId],
  );
  return probe.rows[0];
}

// Snapshot a membership row's mutable columns for the I-003-3 byte-identity
// assertion. `::text` casts normalize TIMESTAMPTZ across pg/PGlite.
async function readMembershipRow(
  querier: Querier,
  membershipId: string,
): Promise<
  { role: string; state: string; joined_at: string | null; updated_at: string } | undefined
> {
  const probe = await querier.query<{
    role: string;
    state: string;
    joined_at: string | null;
    updated_at: string;
  }>(
    `SELECT role, state, joined_at::text AS joined_at, updated_at::text AS updated_at
       FROM session_memberships WHERE id = $1`,
    [membershipId],
  );
  return probe.rows[0];
}

// Seed a runtime_node_presence row directly (bypassing the heartbeat service)
// so the detach tests can set up a node that has already heartbeated. Presence is
// heartbeat-owned (T3.6 creates the row on the first beat); the detach tests that
// OMIT this seed model a node that never heartbeated (no presence row) so the
// detach presence UPDATE is a clean 0-row no-op. `lastHeartbeatAt` is coalesced
// to SQL NULL in the PARAM array (not left as raw `undefined`) so PGlite's
// `COALESCE($3, now())` resolves it server-side — mirrors seedAttachment's
// `args.clientVersion ?? "1.0"` house pattern (PGlite binds an explicit `null`,
// never a JS `undefined`, to a bind slot).
async function seedPresence(
  querier: Querier,
  args: { nodeId: NodeId; healthState: string; lastHeartbeatAt?: string },
): Promise<void> {
  await querier.query(
    `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at, health_state)
     VALUES ($1, COALESCE($3, now()), $2)`,
    [args.nodeId, args.healthState, args.lastHeartbeatAt ?? null],
  );
}

// Re-read a presence row's mutable columns for the detach liveness-axis
// assertion. `last_heartbeat_at::text` normalizes TIMESTAMPTZ across pg/PGlite.
// Returns `undefined` when no presence row exists (the never-heartbeated node) —
// the detach presence-absent test asserts detach did NOT create one (UPDATE-only).
async function readPresenceRow(
  querier: Querier,
  nodeId: NodeId,
): Promise<{ health_state: string; last_heartbeat_at: string } | undefined> {
  const probe = await querier.query<{ health_state: string; last_heartbeat_at: string }>(
    `SELECT health_state, last_heartbeat_at::text AS last_heartbeat_at
       FROM runtime_node_presence WHERE node_id = $1`,
    [nodeId],
  );
  return probe.rows[0];
}

async function countAttachments(querier: Querier): Promise<number> {
  const probe = await querier.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM runtime_node_attachments",
  );
  return probe.rows[0]?.n ?? -1;
}

// Total runtime_node_presence row count — the same second mutation mode for the
// presence table (readPresenceRow inspects only the ONE node's row, so it cannot
// see a stray INSERT/DELETE of a DIFFERENT presence row; this count closes that
// gap, exactly as countMemberships does for session_memberships).
async function countPresence(querier: Querier): Promise<number> {
  const probe = await querier.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM runtime_node_presence",
  );
  return probe.rows[0]?.n ?? -1;
}

// Total session_memberships row count for the I-003-3 no-mutation guard. The
// byte-identity snapshot (readMembershipRow) only inspects the ONE seeded row,
// so it cannot see a stray INSERT/DELETE of a DIFFERENT membership row; this
// count closes that second, disjoint mutation mode ("must not mutate" the table,
// not just the seeded row).
async function countMemberships(querier: Querier): Promise<number> {
  const probe = await querier.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM session_memberships",
  );
  return probe.rows[0]?.n ?? -1;
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  pg: PGlite;
  querier: Querier;
  service: AttachService;
}

let ctx: TestContext;

beforeEach(async () => {
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);
  ctx = { pg, querier, service: new AttachService(querier) };
});

afterEach(async () => {
  await ctx.pg.close();
});

// ----------------------------------------------------------------------------
// P10 — revocation is terminal (runs first: fastest failure signal)
// ----------------------------------------------------------------------------

describe("AttachService — P10 (revocation is terminal)", () => {
  it("refuses a re-attach against a revoked row with the typed revoked exception and does not reactivate it", async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    // The node's attachment for THIS session is in the terminal revoked state.
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "revoked",
    });

    // Capture the single rejection once, then assert both the class and the
    // typed `code` literal (the transport layer lifts `code` onto the wire
    // envelope). One invocation avoids re-running the refusal path.
    const error = await ctx.service.attach(buildAttachRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeNodeAttachRevokedException);
    expect(error).toMatchObject({ code: RUNTIME_NODE_ATTACH_REVOKED_CODE });

    // No-mutation property: the row stays revoked (the DO UPDATE was suppressed),
    // and the transaction rolled back, so no extra row exists.
    const after = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.state).toBe("revoked");
    expect(await countAttachments(ctx.querier)).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// P9a — cross-session conflict (single active attachment, I-003-5)
// ----------------------------------------------------------------------------

describe("AttachService — P9a (cross-session active conflict, I-003-5)", () => {
  it("refuses attach when the node is already actively attached to another session with the typed conflict exception", async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedSession(ctx.querier, OTHER_SESSION_ID);
    // The node already holds an ACTIVE-state attachment in ANOTHER session — the
    // partial-unique idx_node_attachments_active forbids a second active row.
    await seedAttachment(ctx.querier, {
      sessionId: OTHER_SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });

    const error = await ctx.service.attach(buildAttachRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeNodeAttachConflictException);
    expect(error).toMatchObject({ code: RUNTIME_NODE_ATTACH_CONFLICT_CODE });

    // No-info-leak: the message references the node id, never the OTHER session.
    expect((error as Error).message).toContain(String(NODE_ID));
    expect((error as Error).message).not.toContain(String(OTHER_SESSION_ID));

    // The transaction rolled back: no new row for THIS session, the other
    // session's active row is untouched.
    const thisSession = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(thisSession).toBeUndefined();
    const otherSession = await readAttachmentRow(ctx.querier, NODE_ID, OTHER_SESSION_ID);
    expect(otherSession?.state).toBe("online");
    expect(await countAttachments(ctx.querier)).toBe(1);
  });

  it("translates the active-index 23505 raised by the DO UPDATE (reactivating an offline row while the node is active elsewhere)", async () => {
    // The other branch of the P9 conflict: the 23505 on idx_node_attachments_active
    // can fire from the DO UPDATE, not only a fresh INSERT. Starting rows for the
    // node: an `offline` row for THIS session (NOT in the partial active index, so
    // the seed is admissible) and an `online` row in ANOTHER session. Re-attaching
    // THIS session takes the ON CONFLICT path -> DO UPDATE flips offline ->
    // registering, which would make a SECOND active row for the node -> the
    // partial-unique index raises 23505 DURING the update. The constraint-name +
    // SQLSTATE guard (not the statement phase) translates it to the same typed
    // conflict refusal as the INSERT-sourced collision (P9a).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedSession(ctx.querier, OTHER_SESSION_ID);
    const offlineAttachmentId = await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "offline",
    });
    await seedAttachment(ctx.querier, {
      sessionId: OTHER_SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });

    const error = await ctx.service.attach(buildAttachRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeNodeAttachConflictException);
    expect(error).toMatchObject({ code: RUNTIME_NODE_ATTACH_CONFLICT_CODE });

    // The transaction rolled back: this session's row stays offline (the failed
    // reactivation reverted), the other session's active row is untouched, and no
    // row was added or removed (two rows for the node throughout).
    const thisSession = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(thisSession?.state).toBe("offline");
    const otherSession = await readAttachmentRow(ctx.querier, NODE_ID, OTHER_SESSION_ID);
    expect(otherSession?.state).toBe("online");
    expect(await countAttachments(ctx.querier)).toBe(2);
    expect(offlineAttachmentId).toMatch(/[0-9a-f-]{36}/i);
  });
});

// ----------------------------------------------------------------------------
// Negative branch — a non-(active-index) error rethrows raw (untranslated)
// ----------------------------------------------------------------------------

describe("AttachService — raw-rethrow of a non-conflict database error", () => {
  it("does NOT translate a session_id FK violation (23503) into a typed attach refusal", async () => {
    // The catch-arm's `throw error;` negative branch: an error that is NOT a
    // 23505 on idx_node_attachments_active passes through untranslated. Attaching
    // against a NON-EXISTENT session reaches it — the NULL-floor read tolerates a
    // missing session (returns no row -> floor = null, no throw), then the INSERT
    // violates the `session_id` FK with SQLSTATE 23503. The participant IS seeded,
    // so `session_id` is the ONLY unsatisfied FK; the violation is unambiguous.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    // Deliberately do NOT seed the session.

    const error = await ctx.service.attach(buildAttachRequest()).catch((e: unknown) => e);

    // The raw FK error surfaces — NEITHER typed attach refusal swallowed it. This
    // locks the constraint-name guard (ACTIVE_ATTACHMENT_INDEX): only the active
    // index's 23505 becomes a typed conflict; everything else rethrows as-is.
    expect(error).not.toBeInstanceOf(RuntimeNodeAttachConflictException);
    expect(error).not.toBeInstanceOf(RuntimeNodeAttachRevokedException);
    // Positively pin the SQLSTATE (portable; survives a constraint rename) so the
    // test proves the error reached the INSERT and rethrew raw, rather than some
    // unrelated Error escaping earlier (which would also pass the negatives).
    expect(error).toMatchObject({ code: "23503" });
    // The aborted transaction rolled back: no attachment row was created.
    expect(await countAttachments(ctx.querier)).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// P9b — reconnect reactivates an offline row
// ----------------------------------------------------------------------------

describe("AttachService — P9b (reconnect reactivates an offline row)", () => {
  it("reactivates an offline attachment for the same session (offline -> registering) instead of refusing", async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    // The node's prior attachment for THIS session went offline (a dropped
    // heartbeat). The partial active index does NOT constrain an offline row, so
    // re-attach is eligible and the DO UPDATE reactivates it.
    const attachmentId = await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "offline",
    });

    const response = await ctx.service.attach(buildAttachRequest());

    expect(response.state).toBe("registering");
    expect(response.readOnly).toBe(false);
    // Same row reactivated in place (no duplicate row), so the attachment id is
    // stable and the count stays 1.
    expect(response.attachmentId).toBe(attachmentId);
    expect(await countAttachments(ctx.querier)).toBe(1);
    const after = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.state).toBe("registering");
  });

  it("demotes a same-session ALREADY-active row back to registering on re-attach (pins current behavior; plan-silent)", async () => {
    // Pins CURRENT, defensible behavior (NOT a spec mandate): a re-attach for a
    // session where the node is already `online` (and NO other active row exists,
    // so the partial active index permits the in-place update) restarts the
    // registration handshake — the DO UPDATE flips online -> registering in place.
    // Asserting it here makes any future deliberate change visible at review,
    // rather than silently shipping as a contract break.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    const attachmentId = await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });

    const response = await ctx.service.attach(buildAttachRequest());

    // Same row, demoted in place: no second index entry (no other active row for
    // the node), so no 23505; resolves at registering, id stable, count stays 1.
    expect(response.state).toBe("registering");
    expect(response.attachmentId).toBe(attachmentId);
    expect(await countAttachments(ctx.querier)).toBe(1);
    const after = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.state).toBe("registering");
  });
});

// ----------------------------------------------------------------------------
// P9 owner-immutability — reconnect must not destroy node provenance
// ----------------------------------------------------------------------------
//
// `Spec-003 §Implementation Notes` (node identity must be STABLE across reconnect if the same
// local daemon is reattaching) + `Spec-003 §Pitfalls To Avoid` (destroying historical
// node provenance when a node reconnects is PROHIBITED) + Plan-003 §Invariants
// I-003-5 (the `(node_id, session_id)` index is the upsert ON CONFLICT target for
// the reconnect path).
//
// The reconnect upsert's DO UPDATE is guarded
// `WHERE state <> 'revoked' AND participant_id = EXCLUDED.participant_id`, and
// `participant_id` is NOT in the SET — so the owner participant is IMMUTABLE
// across reconnect. The two tests below pin both sides of that guard, exercising
// the full reconnect path through the service (attach -> detach -> attach):
//   (1) SAME-participant reconnect-after-detach SUCCEEDS (the legitimate P9
//       reconnect: offline -> registering) and the owner is unchanged (the SET
//       removal must not break the happy path or drop the owner); and
//   (4) CROSS-owner reconnect is REFUSED with the typed conflict, and the row's
//       owner is STILL the original participant (provenance preserved, not
//       overwritten) — the data-integrity guarantee `Spec-003 §Pitfalls To Avoid` mandates.
// (Cases 2 and 3 of the matrix — the cross-session active conflict and the
// revoked refusal — are the P9a and P10 blocks above; they remain regression
// guards for the SET/WHERE change and are not duplicated here.)

describe("AttachService — P9 owner-immutability (reconnect preserves node provenance, `Spec-003 §Implementation Notes` + `Spec-003 §Pitfalls To Avoid`)", () => {
  it("reconnects a SAME-participant node after detach (offline -> registering) and leaves the owner participant unchanged", async () => {
    // The legitimate P9 reconnect, end-to-end through the service: the SAME
    // participant attaches node N, detaches it (slot -> offline), then reattaches.
    // The reattach must SUCCEED (the same-owner DO UPDATE reactivates the offline
    // row) — and the owner participant must be byte-for-byte unchanged (the SET no
    // longer reassigns participant_id; the happy path must not break or drop it).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    // Attach, then detach (retires the slot to offline), then reattach — all as
    // the SAME participant.
    const first = await ctx.service.attach(buildAttachRequest());
    expect(first.state).toBe("registering");
    expect(await readAttachmentOwner(ctx.querier, NODE_ID, SESSION_ID)).toBe(
      String(PARTICIPANT_ID),
    );

    await ctx.service.detach({ nodeId: NODE_ID });
    const afterDetach = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(afterDetach?.state).toBe("offline");

    const reconnect = await ctx.service.attach(buildAttachRequest());

    // The reconnect reactivated the SAME row in place (offline -> registering): id
    // stable, count stays 1, no duplicate row.
    expect(reconnect.state).toBe("registering");
    expect(reconnect.attachmentId).toBe(first.attachmentId);
    expect(await countAttachments(ctx.querier)).toBe(1);
    const after = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.state).toBe("registering");
    // The owner participant survived the reconnect unchanged (the SET-removal
    // did not drop the owner; provenance preserved on the legitimate path too).
    expect(await readAttachmentOwner(ctx.querier, NODE_ID, SESSION_ID)).toBe(
      String(PARTICIPANT_ID),
    );
  });

  it("refuses a CROSS-owner reconnect to the same session with the typed conflict and preserves the original owner (`Spec-003 §Pitfalls To Avoid`)", async () => {
    // The data-integrity bug this fix closes: participant A attaches node N to
    // session S and detaches it (slot -> offline); participant B (the SAME session
    // S) then attempts to attach node N. The ON CONFLICT (node_id, session_id)
    // path fires, but the DO UPDATE's `participant_id = EXCLUDED.participant_id`
    // conjunct is false (existing owner A != B), so the update is suppressed (zero
    // RETURNING rows) and the zero-row verify discriminates the cross-owner cause
    // -> the typed conflict refusal. Crucially, the original owner A is NOT
    // overwritten (`Spec-003 §Pitfalls To Avoid` — never destroy historical node provenance).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedParticipant(ctx.querier, OTHER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    // A attaches node N to session S, then detaches (slot -> offline) so the row
    // is eligible for the ON CONFLICT DO UPDATE path B will hit (an offline row is
    // outside the partial active index, so B's attempt is not the cross-SESSION
    // 23505 case — it is purely the cross-OWNER same-session case).
    await ctx.service.attach(buildAttachRequest());
    await ctx.service.detach({ nodeId: NODE_ID });
    const afterDetach = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(afterDetach?.state).toBe("offline");

    // B (a DIFFERENT participant, SAME session) attempts to reattach node N.
    const error = await ctx.service
      .attach(buildAttachRequest({ participantId: OTHER_PARTICIPANT_ID }))
      .catch((thrown: unknown) => thrown);

    // The typed conflict refusal (the same code as the cross-session P9a case,
    // distinct message).
    expect(error).toBeInstanceOf(RuntimeNodeAttachConflictException);
    expect(error).toMatchObject({ code: RUNTIME_NODE_ATTACH_CONFLICT_CODE });
    // No-info-leak: the message names the node id + the caller's OWN session id,
    // never the owning participant's id.
    expect((error as Error).message).toContain(String(NODE_ID));
    expect((error as Error).message).toContain(String(SESSION_ID));
    expect((error as Error).message).not.toContain(String(PARTICIPANT_ID));

    // PROVENANCE PRESERVED (the load-bearing `Spec-003 §Pitfalls To Avoid` property): the
    // transaction rolled back and the row's owner is STILL A — B did NOT overwrite
    // it. The row also stays offline (the suppressed DO UPDATE did not reactivate
    // it), and there is exactly one row (no duplicate inserted).
    expect(await readAttachmentOwner(ctx.querier, NODE_ID, SESSION_ID)).toBe(
      String(PARTICIPANT_ID),
    );
    const after = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.state).toBe("offline");
    expect(await countAttachments(ctx.querier)).toBe(1);
  });

  it("refuses a CROSS-owner reconnect to an ACTIVE same-session row via the cross-owner branch (NOT the cross-session 23505 path)", async () => {
    // The ACTIVE sub-case of cross-owner (the offline test above is the inactive
    // sub-case) — a distinct two-index interaction worth pinning. Participant A
    // attaches node N to session S and the row STAYS active (`registering`; A does
    // NOT detach). Participant B (SAME session S) then attaches node N. The ON
    // CONFLICT matches the `(node_id, session_id)` composite arbiter
    // (`idx_node_attachments_node`); the DO UPDATE's `participant_id =
    // EXCLUDED.participant_id` conjunct is false (A != B) so the update touches NO
    // row — which means the partial active index `idx_node_attachments_active` is
    // NOT triggered (no second active row is written), so this does NOT take the
    // cross-SESSION 23505 path. The zero-row verify then routes to the cross-OWNER
    // branch. This proves an active cross-owner reconnect surfaces the cross-owner
    // refusal, never the "attached to another session" cross-session refusal.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedParticipant(ctx.querier, OTHER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    // A attaches node N to session S; the row stays ACTIVE (registering) — no
    // detach, so the existing row is in the partial active index.
    const first = await ctx.service.attach(buildAttachRequest());
    expect(first.state).toBe("registering");

    // B (a DIFFERENT participant, SAME session) attempts to attach node N.
    const error = await ctx.service
      .attach(buildAttachRequest({ participantId: OTHER_PARTICIPANT_ID }))
      .catch((thrown: unknown) => thrown);

    // The typed conflict refusal — and specifically the CROSS-OWNER message, NOT
    // the cross-session "attached to another session" message. Asserting the
    // cross-session phrasing is ABSENT is what proves the active cross-owner case
    // did NOT leak into the 23505/cross-session path (which would have produced a
    // different message under the same exception type).
    expect(error).toBeInstanceOf(RuntimeNodeAttachConflictException);
    expect(error).toMatchObject({ code: RUNTIME_NODE_ATTACH_CONFLICT_CODE });
    expect((error as Error).message).toContain(String(NODE_ID));
    expect((error as Error).message).toContain(String(SESSION_ID));
    expect((error as Error).message).toContain("under a different participant");
    expect((error as Error).message).not.toContain("attached to another session");
    // No-info-leak: the owning participant id is never disclosed.
    expect((error as Error).message).not.toContain(String(PARTICIPANT_ID));

    // PROVENANCE PRESERVED: the row's owner is STILL A (B did NOT overwrite it),
    // the row's state is STILL `registering` (the suppressed DO UPDATE left it
    // untouched — not demoted, not reactivated), and there is exactly one row.
    expect(await readAttachmentOwner(ctx.querier, NODE_ID, SESSION_ID)).toBe(
      String(PARTICIPANT_ID),
    );
    const after = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.state).toBe("registering");
    expect(await countAttachments(ctx.querier)).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// P1 — NULL-floor unconditional admission (`Spec-003 §Required Behavior`)
// ----------------------------------------------------------------------------

describe("AttachService — P1 (NULL-floor unconditional admission, `Spec-003 §Required Behavior`)", () => {
  it("admits a fresh attach with readOnly=false and state=registering when the session floor is NULL", async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    // No min_client_version => NULL floor => no version gate.
    await seedSession(ctx.querier, SESSION_ID);

    const response = await ctx.service.attach(buildAttachRequest());

    // PERMISSION axis: NULL floor admits read-write unconditionally.
    expect(response.readOnly).toBe(false);
    // LIVENESS axis: a fresh admit lands at registering.
    expect(response.state).toBe("registering");
    expect(response.attachmentId).toMatch(/[0-9a-f-]{36}/i);
    expect(typeof response.attachedAt).toBe("string");
    // The attachment row was created.
    expect(await countAttachments(ctx.querier)).toBe(1);

    // JSONB round-trip: the capability object survived serialization into the
    // JSONB column (guards a silent stringify bug a state-only check would miss).
    const stored = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(stored).toBeDefined();
    expect(stored?.client_version).toBe(String(CLIENT_VERSION));
    const storedCapabilities: unknown = JSON.parse(stored?.capabilities ?? "null");
    expect(storedCapabilities).toEqual(CAPABILITIES);
  });
});

// ----------------------------------------------------------------------------
// P2 / P3 — version-floor comparison (`Spec-003 §Required Behavior` / I-003-1)
// ----------------------------------------------------------------------------
//
// P2 (client_version >= floor): admit read-write (readOnly === false).
// P3 (client_version  < floor): admit READ-ONLY (readOnly === true) — the node
//     remains joined and reads succeed; it is NEVER ejected (I-003-1 / ADR-018
//     §Decision #4). The VERSION_FLOOR_EXCEEDED write refusal is T3.4's; at this
//     service boundary "reads succeed" == the node is admitted in a joined state
//     (state === "registering", the attachment row persists, attach() did not
//     throw).
//
// The multi-digit cases ("10.0" above "2.0"; "1.9" below "1.10") are the
// lexical-bug guards: a string compare would invert these verdicts, so they pin
// the comparator's numeric MAJOR.MINOR ordering (event.ts §compareEventEnvelopeVersion).
//
// The malformed-floor cases prove the floor goes through
// `EventEnvelopeVersionSchema.parse` (which throws), NOT an `as`-cast that would
// reach the comparator as NaN and silently admit read-write. `sessions.min_client_version`
// is a plain nullable TEXT column (0001-initial.ts line 104 — no DB CHECK), so a
// regex-invalid floor seeds fine and the ONLY guard is the read-time parse.

describe("AttachService — P2/P3 (version-floor comparison, `Spec-003 §Required Behavior` / I-003-1)", () => {
  it("admits a daemon BELOW a non-NULL floor in read-only state (P3 — admit-not-eject, I-003-1)", async () => {
    // Below-floor (client 1.0 < floor 2.0): admit READ-ONLY, never eject. The
    // write refusal (VERSION_FLOOR_EXCEEDED) on this read-only daemon's next
    // write is T3.4's; here the daemon is admitted joined with readOnly = true.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "2.0");

    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "1.0" as EventEnvelopeVersion }),
    );

    expect(response.readOnly).toBe(true);
    expect(response.state).toBe("registering");
  });

  it("admits a daemon AT the floor as read-write (P2 — the >= boundary edge)", async () => {
    // The boundary edge: client_version === floor is AT-or-above, so read-write.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "2.0");

    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "2.0" as EventEnvelopeVersion }),
    );

    expect(response.readOnly).toBe(false);
    expect(response.state).toBe("registering");
  });

  it("admits a daemon ABOVE the floor as read-write (P2 — minor above)", async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "2.0");

    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "2.5" as EventEnvelopeVersion }),
    );

    expect(response.readOnly).toBe(false);
  });

  it("admits a daemon a MAJOR above the floor as read-write (P2 — 2.0 above floor 1.9)", async () => {
    // Major dominates: client 2.0 outranks floor 1.9 despite minor 0 < 9.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "1.9");

    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "2.0" as EventEnvelopeVersion }),
    );

    expect(response.readOnly).toBe(false);
  });

  it("admits a multi-digit-MAJOR daemon above the floor as read-write (P2 — lexical-bug guard, 10.0 > 2.0)", async () => {
    // Numeric major 10 > 2 -> read-write. A lexical string compare would give
    // `"10" < "2"` and WRONGLY flip this to read-only; this pins numeric ordering.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "2.0");

    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "10.0" as EventEnvelopeVersion }),
    );

    expect(response.readOnly).toBe(false);
  });

  it("admits a multi-digit-MINOR daemon below the floor in read-only state (P3 — lexical-bug guard, 1.9 < 1.10)", async () => {
    // Numeric minor 9 < 10 -> below floor -> read-only. A lexical compare would
    // give `"1.9" > "1.10"` and WRONGLY admit read-write; this pins numeric order.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "1.10");

    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "1.9" as EventEnvelopeVersion }),
    );

    expect(response.readOnly).toBe(true);
  });

  it("keeps a below-floor daemon JOINED with reads succeeding (P3 / I-003-1 admit-not-eject)", async () => {
    // The load-bearing I-003-1 property beyond `readOnly === true`: a below-floor
    // attach is admitted (joined), not ejected. At this service boundary that is
    // (a) attach() does NOT throw, (b) the node lands in a joined liveness state
    // (registering), and (c) the attachment row is persisted (a subsequent read
    // finds it). Together these are "the daemon remains joined and may read".
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "2.0");

    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "1.0" as EventEnvelopeVersion }),
    );

    // Admitted read-only, in a joined liveness state — NOT ejected.
    expect(response.readOnly).toBe(true);
    expect(response.state).toBe("registering");
    // The attachment row persists (the node is joined; reads find it).
    expect(await countAttachments(ctx.querier)).toBe(1);
    const persisted = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(persisted).toBeDefined();
    expect(persisted?.state).toBe("registering");
  });

  it.each([
    ["single-segment", "1"],
    ["three-segment", "1.0.0"],
  ])(
    "rejects attach when the session floor is regex-invalid (%s: %j) — floor goes through .parse, not an as-cast",
    async (_label, malformedFloor) => {
      // A malformed floor must NOT silently admit read-write. The non-NULL branch
      // parses the raw DB floor through EventEnvelopeVersionSchema.parse, which
      // throws on a regex-invalid value (single-segment "1", three-segment
      // "1.0.0"). An `as`-cast bypass would instead reach the numeric comparator
      // as NaN and silently admit. seedSession writes the malformed floor fine
      // (TEXT column, no DB CHECK), so the parse is the only guard.
      await seedParticipant(ctx.querier, PARTICIPANT_ID);
      await seedSession(ctx.querier, SESSION_ID, malformedFloor);

      await expect(ctx.service.attach(buildAttachRequest())).rejects.toThrow(ZodError);
      // The aborted transaction rolled back: no attachment row was created.
      expect(await countAttachments(ctx.querier)).toBe(0);
    },
  );
});

// ----------------------------------------------------------------------------
// P5 — multi-node coexistence (`Spec-003 §Required Behavior` + AC3; I-003-3 identity)
// ----------------------------------------------------------------------------
//
// P5 (`Spec-003 §Required Behavior` "support multiple runtime nodes per session" + `Spec-003 §Required Behavior`
//     "attach must not require session recreation"; the acceptance criterion at
//     `Spec-003 §Acceptance Criteria` "Multiple runtime nodes can coexist in one session
//     without changing session identity"; Plan-003 §Invariants I-003-3): two
//     DISTINCT nodes attaching to the SAME session both land as active rows, and
//     the attach path mutates nothing on `sessions` (no UPDATE, no recreate).
//
// Why no production change is needed (this block is purely characterization —
// the shipped T3.2 attach path already satisfies P5; see attach-service.ts):
//   * The upsert's conflict arbiter is the TOTAL `(node_id, session_id)` unique
//     (`idx_node_attachments_node`, 0003-runtime-nodes.ts line 116). Node A and
//     node B against the same session are two DISTINCT (node_id, session_id)
//     pairs, so neither attach conflicts with the other — both take the INSERT
//     arm cleanly.
//   * The single-active constraint `idx_node_attachments_active`
//     (0003-runtime-nodes.ts lines 122-123) is partial-UNIQUE on `(node_id)`
//     ALONE — per node, NOT per session. Node A active and node B active in the
//     same session are distinct node_ids, so the index admits both; it only
//     forbids ONE node holding two active rows (the P9 cross-session case).
//   * The attach flow writes ONLY `runtime_node_attachments`; it never SELECTs
//     FOR UPDATE, INSERTs, or UPDATEs the `sessions` row (the floor read at
//     step 1 is a plain SELECT). So session identity — `id` and every other
//     `sessions` column — is invariant across any number of attaches, and no new
//     `sessions` row is created. This is the multi-node complement to T3.2's
//     single-attach I-003-3 guard, extended to the `sessions` table itself.

describe("AttachService — P5 (multi-node coexistence, `Spec-003 §Required Behavior` + AC; I-003-3 session identity)", () => {
  it("admits two distinct nodes as co-active attachments in one session and leaves the sessions row byte-for-byte unchanged", async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    // A NULL-floor session (no version gate) — both daemons are admitted
    // read-write; the focus here is coexistence + session identity, not the
    // floor verdict (P1/P2/P3 cover that).
    await seedSession(ctx.querier, SESSION_ID);

    // Snapshot the WHOLE sessions row BEFORE any attach. Raw `SELECT *` (no
    // ::text casts): this is a before/after snapshot of the SAME row on the SAME
    // PGlite instance with no mutation in between, so hydration is identical on
    // both reads and `toEqual` is stable — while `SELECT *` gives the test teeth
    // against a mutation to ANY column (a hand-picked cast list would miss a
    // column the attach path might wrongly touch). Exactly one session row exists
    // going in.
    const sessionBeforeProbe = await ctx.querier.query<Record<string, unknown>>(
      "SELECT * FROM sessions WHERE id = $1",
      [SESSION_ID],
    );
    const sessionBefore: Record<string, unknown> | undefined = sessionBeforeProbe.rows[0];
    expect(sessionBefore).toBeDefined();
    const sessionCountProbe = await ctx.querier.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM sessions",
    );
    expect(sessionCountProbe.rows[0]?.n).toBe(1);

    // Node A then node B attach to the SAME session under the SAME participant.
    // Neither call throws — the distinct (node_id, session_id) pairs do not
    // conflict, and the per-node active index admits both distinct node_ids.
    const responseAlpha = await ctx.service.attach(buildAttachRequest());
    const responseBeta = await ctx.service.attach(buildAttachRequest({ nodeId: NODE_ID_BETA }));

    // Both admitted in the fresh `registering` liveness state (two nodes, one
    // session, both active).
    expect(responseAlpha.state).toBe("registering");
    expect(responseBeta.state).toBe("registering");
    // Two distinct attachment rows now exist.
    expect(await countAttachments(ctx.querier)).toBe(2);
    const alphaRow = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    const betaRow = await readAttachmentRow(ctx.querier, NODE_ID_BETA, SESSION_ID);
    expect(alphaRow).toBeDefined();
    expect(betaRow).toBeDefined();
    expect(alphaRow?.state).toBe("registering");
    expect(betaRow?.state).toBe("registering");

    // Pin the exact attachment set: with countAttachments()===2 above, selecting
    // ALL rows (no session_id filter) and asserting both the node_id and session_id
    // lists proves the two distinct nodes both landed in THIS session and nowhere
    // else — a beta row written to a different session would surface a differing
    // session_id here (the filtered form could not observe that). "node-alpha-01"
    // sorts before "node-beta-02", so ORDER BY node_id yields [alpha, beta].
    const attachmentsProbe = await ctx.querier.query<{ node_id: string; session_id: string }>(
      "SELECT node_id, session_id FROM runtime_node_attachments ORDER BY node_id",
    );
    expect(attachmentsProbe.rows.map((row) => row.node_id)).toEqual([
      String(NODE_ID),
      String(NODE_ID_BETA),
    ]);
    expect(attachmentsProbe.rows.map((row) => row.session_id)).toEqual([
      String(SESSION_ID),
      String(SESSION_ID),
    ]);

    // Session identity preserved (the "without changing session identity"
    // clause): the sessions row is byte-for-byte identical after both attaches
    // (no UPDATE to id / state / min_client_version / any column), and still
    // exactly ONE session row exists (attach did NOT recreate the session —
    // `Spec-003 §Required Behavior`).
    const sessionAfterProbe = await ctx.querier.query<Record<string, unknown>>(
      "SELECT * FROM sessions WHERE id = $1",
      [SESSION_ID],
    );
    expect(sessionAfterProbe.rows[0]).toEqual(sessionBefore);
    const sessionCountAfterProbe = await ctx.querier.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM sessions",
    );
    expect(sessionCountAfterProbe.rows[0]?.n).toBe(1);
  });

  it("leaves a co-resident session_memberships row byte-for-byte unchanged when two nodes attach to the session (I-003-3, multi-node)", async () => {
    // The multi-node complement to T3.2's single-attach I-003-3 test: even when
    // SEVERAL nodes attach to a session, the attach domain stays disjoint from
    // the membership domain (cross-plan-dependencies.md §1) — no node's attach
    // reads-for-update, inserts, updates, or deletes any session_memberships row.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    const membershipId = await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const before = await readMembershipRow(ctx.querier, membershipId);
    expect(before).toBeDefined();
    // Exactly the one seeded membership row exists going in.
    expect(await countMemberships(ctx.querier)).toBe(1);

    // Two distinct nodes attach to the same session.
    await ctx.service.attach(buildAttachRequest());
    await ctx.service.attach(buildAttachRequest({ nodeId: NODE_ID_BETA }));

    // Two disjoint mutation modes, two assertions (mirroring T3.2's I-003-3
    // test): (1) byte-for-byte identity of the seeded row catches an in-place
    // UPDATE; (2) unchanged total count catches a stray INSERT/DELETE of a
    // DIFFERENT membership row. Neither moves under multi-node attach.
    const after = await readMembershipRow(ctx.querier, membershipId);
    expect(after).toEqual(before);
    expect(await countMemberships(ctx.querier)).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// I-003-3 — attach must not mutate session_memberships
// ----------------------------------------------------------------------------

describe("AttachService — I-003-3 (attach must not mutate session_memberships)", () => {
  it("leaves a co-resident session_memberships row byte-for-byte unchanged after a successful attach", async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    // A membership row co-resident in the same session. The attach flow must
    // touch ONLY runtime_node_attachments — never read-for-update, insert, or
    // update this row (the runtime-node attach domain is disjoint from the
    // membership domain; cross-plan-dependencies.md §1).
    const membershipId = await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const before = await readMembershipRow(ctx.querier, membershipId);
    expect(before).toBeDefined();
    // Exactly the one seeded membership row exists going in.
    expect(await countMemberships(ctx.querier)).toBe(1);

    const response = await ctx.service.attach(buildAttachRequest());
    expect(response.state).toBe("registering");

    // Two disjoint mutation modes, two assertions:
    //   (1) Byte-for-byte identity of the seeded row catches an in-place UPDATE
    //       (which a count check would miss — the count doesn't move).
    //   (2) Unchanged total row count catches a stray INSERT/DELETE of a
    //       DIFFERENT membership row (which the byte-identity check would miss —
    //       it only inspects the seeded row's id). Together they cover the full
    //       "attach must not mutate session_memberships" invariant statement.
    const after = await readMembershipRow(ctx.querier, membershipId);
    expect(after).toEqual(before);
    expect(await countMemberships(ctx.querier)).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// P7/P8 + detach (offline transition) — T3.7
// ----------------------------------------------------------------------------
//
// `Spec-003 §Required Behavior` (detach/offline must NOT revoke membership by default — P8 /
// I-003-3) + `Spec-003 §Default Behavior` (an explicit `detach` retires the node; `revoked`
// is authority-issued, never self-asserted — so detach writes `offline` ONLY) +
// Plan-003 §Invariants I-003-3 (attach-membership separation) / I-003-5 (detach
// resolves the node's SINGLE active attachment by `nodeId` alone).
//
// detach moves the node's one active attachment to `offline` across two
// orthogonal axes — the SLOT axis (`runtime_node_attachments.state`) and the
// LIVENESS axis (`runtime_node_presence.health_state`) — and returns `null` (the
// no-content wire response). The five cases below pin: (a) the P8 happy path +
// membership no-mutation; (b) the LOAD-BEARING revoked-not-flipped guard; (c)
// idempotent re-detach; (d) the never-attached no-op; (e) the presence-absent
// UPDATE-only no-op. P7 (attach must not mutate session_memberships, Spec-003
// `Spec-003 §Required Behavior`) is the SHIPPED attach I-003-3 test above — not re-tested here.

describe("AttachService — P7/P8 + detach (offline transition, T3.7)", () => {
  it("retires an active node to offline on both axes and leaves session_memberships byte-for-byte unchanged (P8, `Spec-003 §Required Behavior` / I-003-3)", async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    // An ACTIVE attachment (slot axis) + a presence row (liveness axis), both
    // `online` — the live-node starting state an explicit detach retires.
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });
    await seedPresence(ctx.querier, { nodeId: NODE_ID, healthState: "online" });
    // A membership row co-resident in the session. `Spec-003 §Required Behavior`: an explicit
    // detach (or offline) must NOT revoke this membership — the detach flow must
    // touch ONLY runtime_node_attachments + runtime_node_presence.
    const membershipId = await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const membershipBefore = await readMembershipRow(ctx.querier, membershipId);
    expect(membershipBefore).toBeDefined();
    expect(await countMemberships(ctx.querier)).toBe(1);

    // Capture presence BEFORE detach so we can prove the health-only UPDATE
    // (`SET health_state = $2`) never touches the heartbeat clock — the
    // last_heartbeat_at timestamp must survive the flip to offline untouched.
    const presenceBefore = await readPresenceRow(ctx.querier, NODE_ID);
    expect(presenceBefore).toBeDefined();

    const result = await ctx.service.detach({ nodeId: NODE_ID });

    // The no-content wire response is literally `null`.
    expect(result).toBeNull();

    // Slot axis retired: the active attachment moved online -> offline.
    const attachmentAfter = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(attachmentAfter?.state).toBe("offline");
    // Liveness axis retired: presence health moved online -> offline (the same
    // liveness-death the T3.6 sweep derives at 60s, effected here immediately).
    const presenceAfter = await readPresenceRow(ctx.querier, NODE_ID);
    expect(presenceAfter?.health_state).toBe("offline");
    // The heartbeat clock is untouched: detach's presence write flips ONLY
    // health_state, never last_heartbeat_at (parallel to the membership
    // byte-identity check below — makes readPresenceRow's timestamp column
    // load-bearing).
    expect(presenceAfter?.last_heartbeat_at).toBe(presenceBefore?.last_heartbeat_at);

    // P8 / I-003-3: the co-resident membership row is byte-for-byte unchanged AND
    // the total membership count is unchanged — the two disjoint mutation modes
    // (in-place UPDATE vs stray INSERT/DELETE), mirroring the attach I-003-3 test.
    // An offline/detached node retains its membership (`Spec-003 §Required Behavior`).
    const membershipAfter = await readMembershipRow(ctx.querier, membershipId);
    expect(membershipAfter).toEqual(membershipBefore);
    expect(await countMemberships(ctx.querier)).toBe(1);
  });

  it("does NOT flip a revoked attachment to offline — the active-state guard protects revocation-terminality (LOAD-BEARING, P10-adjacent)", async () => {
    // The single case that goes red if the `AND state IN
    // ('registering','online','degraded')` active-state guard is dropped from
    // detach's slot UPDATE. A `revoked` row is INACTIVE (outside the partial
    // active index), so detach must NOT match it — `revoked` is terminal
    // (`Spec-003 §Default Behavior`; attach's P10 reads it to refuse re-attach). A naive
    // `WHERE node_id = $1` (no state guard) would corrupt revoked -> offline,
    // silently breaking revocation-terminality. No presence row is seeded (a
    // revoked node need not have heartbeated).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "revoked",
    });

    const result = await ctx.service.detach({ nodeId: NODE_ID });

    // Idempotent no-op (no ACTIVE attachment to retire) and — load-bearing — the
    // attachment stays EXACTLY `revoked`, never demoted to `offline`.
    expect(result).toBeNull();
    const after = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.state).toBe("revoked");
  });

  it("is idempotent — a second detach of an already-offline node is a clean no-op", async () => {
    // An already-`offline` attachment is INACTIVE, so a (re-)detach matches no
    // active row and returns null without re-writing. The state stays `offline`.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "offline",
    });

    const result = await ctx.service.detach({ nodeId: NODE_ID });

    expect(result).toBeNull();
    const after = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.state).toBe("offline");
  });

  it("returns null and creates no row when detaching a node that was never attached", async () => {
    // No attachment row exists for the node at all. Detach is a clean no-op: it
    // returns null and does NOT INSERT a row (the slot UPDATE matches nothing).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    const result = await ctx.service.detach({ nodeId: NODE_ID });

    expect(result).toBeNull();
    expect(await countAttachments(ctx.querier)).toBe(0);
  });

  it("retires the attachment but does NOT create a presence row when the node never heartbeated (presence UPDATE is UPDATE-only)", async () => {
    // An ACTIVE attachment but NO presence row — a node admitted by attach that
    // has not yet heartbeated (presence rows are heartbeat-owned, T3.6). Detach
    // retires the slot axis (online -> offline) but the liveness-axis UPDATE
    // matches no row and is a clean no-op — detach must NOT INSERT a presence row
    // (last_heartbeat_at is NOT NULL with no default; an INSERT here would be both
    // wrong and unsatisfiable).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });

    const result = await ctx.service.detach({ nodeId: NODE_ID });

    expect(result).toBeNull();
    // Slot axis retired.
    const attachmentAfter = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(attachmentAfter?.state).toBe("offline");
    // Liveness axis: still NO presence row (detach did not create one).
    expect(await readPresenceRow(ctx.querier, NODE_ID)).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// updateCapabilities — control-plane discovery-snapshot refresh (T3.9)
// ----------------------------------------------------------------------------
//
// Spec-003 §Default-Behavior `capabilityupdate` amendment + §Fallback Behavior
// (capability-validation failure leaves the node `degraded`) + `Spec-003 §Required Behavior` / `Spec-003 §Default Behavior` (the
// control plane is NOT the daemon-side capability-declaration authority) +
// Plan-003 §Invariants I-003-2 (cannot drive registering -> online) / I-003-3
// (no session_memberships mutation) / I-003-5 (single active attachment) +
// ADR-017 (no control-plane event log).
//
// updateCapabilities refreshes the `capabilities` JSONB snapshot (the discovery
// roster) on the node's single active attachment and, when `healthChanges` is
// present, applies the daemon-reported capability-health transition — writing
// `runtime_node_attachments` ONLY (no presence, no membership, no durable
// event). The blocks below pin: the capabilities round-trip; the I-003-2
// registering->online refusal (the ONE residual state-context guard) WITH
// rollback; the EXPLICITLY-ALLOWED registering->degraded and degraded->online
// transitions (pinning the guard's narrowness against an over-broad regression);
// the no-active-row typed refusal (the I-003-5 active-band resolution); the
// `updatedAt` = server now() / `attached_at`-unchanged property; the I-003-3
// membership no-mutation; and the structural no-durable-event / write-surface
// confinement (ADR-017).

describe("AttachService — updateCapabilities (discovery-snapshot refresh, T3.9)", () => {
  it("refreshes the capabilities JSONB snapshot on the active row (round-trips, cast-free bind)", async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    // An ACTIVE (online) attachment whose capabilities the daemon now replaces.
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });

    const response = await ctx.service.updateCapabilities(
      buildCapabilityUpdateRequest({ capabilities: UPDATED_CAPABILITIES }),
    );

    // The response projects the node id + the (unchanged, no healthChanges)
    // liveness state.
    expect(String(response.nodeId)).toBe(String(NODE_ID));
    expect(response.state).toBe("online");

    // JSONB round-trip: the new capability object REPLACED the seeded `{}` and
    // survived serialization into the JSONB column (a silent stringify bug a
    // state-only check would miss — and proof the cast-free object bind works on
    // an UPDATE SET, not just attach's INSERT VALUES).
    const stored = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(stored).toBeDefined();
    const storedCapabilities: unknown = JSON.parse(stored?.capabilities ?? "null");
    expect(storedCapabilities).toEqual(UPDATED_CAPABILITIES);
  });

  it("sets updatedAt to the server now() (valid ISO-8601) and leaves attached_at byte-for-byte unchanged", async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });

    // Capture the creation timestamp BEFORE the update — the method must NOT
    // overwrite `attached_at` (the canonical schema has only `attached_at`;
    // `updatedAt` is a transient `now()`, never a stored column).
    const before = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(before).toBeDefined();

    const serverBefore = Date.now();
    const response = await ctx.service.updateCapabilities(buildCapabilityUpdateRequest());
    const serverAfter = Date.now();

    // `updatedAt` is a real, parseable ISO-8601 timestamp (NOT attach's weak
    // typeof === "string" check — this proves now() -> toIsoString -> the
    // response schema's `z.iso.datetime({ offset: true })` actually round-trips)
    // and sits at approximately server now() (within the call window, with a
    // small clock-skew slack).
    const updatedAtMillis = new Date(response.updatedAt).getTime();
    expect(Number.isFinite(updatedAtMillis)).toBe(true);
    expect(updatedAtMillis).toBeGreaterThanOrEqual(serverBefore - 1000);
    expect(updatedAtMillis).toBeLessThanOrEqual(serverAfter + 1000);

    // `attached_at` is byte-for-byte unchanged (the creation clock survives the
    // refresh — `updatedAt` did NOT leak into a stored column).
    const after = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.attached_at).toBe(before?.attached_at);
  });

  it("ALLOWS a capabilities-only refresh on a registering row and returns the broad NodeState (request->response asymmetry)", async () => {
    // EXPLICITLY ALLOWED — the 4th enumerated I-003-2 case: a capabilities-only
    // refresh (NO healthChanges) on a `registering` row is permitted (no liveness
    // transition at all). This pins the guard's `&& healthChanges?.state ===
    // "online"` conjunct on its `undefined` branch: a mutation broadening the
    // guard to "registering && state !== degraded" would wrongly throw here.
    //
    // Load-bearing: it is the request->response asymmetry demonstration
    // (`Spec-003 §Default Behavior`). `response.state` is the broad 5-value `NodeState` and
    // here takes `registering` — a value the 2-value request `healthChanges.state`
    // enum (online|degraded) CANNOT express. No other test exercises a response
    // state outside the request enum, so this is the asymmetry's only pin.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "registering",
    });

    const response = await ctx.service.updateCapabilities(buildCapabilityUpdateRequest());

    // The asymmetry: the response carries the broad `registering` liveness state
    // the request enum cannot express, and the row stays `registering` (no
    // healthChanges => no transition).
    expect(response.state).toBe("registering");
    const after = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.state).toBe("registering");
    // The capabilities snapshot was still refreshed (a capabilities-only update
    // is a real refresh, not a no-op): the new map replaced the seeded `{}`.
    const storedCapabilities: unknown = JSON.parse(after?.capabilities ?? "null");
    expect(storedCapabilities).toEqual(UPDATED_CAPABILITIES);
  });

  it("refuses driving a registering attachment online (I-003-2 guard) and rolls back byte-for-byte", async () => {
    // The ONE residual I-003-2 state-context guard: a `registering` attachment
    // cannot be brought `online` via capability update — bringing a node online
    // requires a daemon-side capability declaration, which the control plane is
    // not the authority for (`Spec-003 §Required Behavior` + `Spec-003 §Default Behavior`). The wire VALUE `online` is
    // legal (the 2-value health enum); only its application to a registering row
    // is refused.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "registering",
    });

    // Snapshot the row BEFORE so the throw-rolls-back property is provable
    // byte-for-byte (the guard must throw BEFORE the UPDATE — no partial write).
    const before = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(before).toBeDefined();

    const error = await ctx.service
      .updateCapabilities(buildCapabilityUpdateRequest({ healthChanges: { state: "online" } }))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RuntimeNodeCapabilityUpdateConflictException);
    expect(error).toMatchObject({ code: RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE });
    // No-info-leak: the message names the node id + the PUBLIC rule, never the
    // node's current internal `state` (parallels attach P9a's no-session-leak).
    expect((error as Error).message).toContain(String(NODE_ID));
    expect((error as Error).message).not.toContain("registering");

    // Rollback: the row is byte-for-byte unchanged — capabilities NOT refreshed
    // (still the seeded `{}`), state still `registering`, attached_at untouched.
    const after = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(after).toEqual(before);
  });

  it("ALLOWS registering -> degraded (`Spec-003 §Fallback Behavior` — pins the guard's narrowness)", async () => {
    // EXPLICITLY ALLOWED — the guard is the SINGLE registering->online case, NOT
    // a blanket registering->* refusal. A capability-validation failure leaves
    // the node `degraded` (Spec-003 §Fallback Behavior), so registering ->
    // degraded MUST succeed. This pins the guard's narrowness: an over-broad
    // `registering -> any health change` regression would redden this.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "registering",
    });

    const response = await ctx.service.updateCapabilities(
      buildCapabilityUpdateRequest({ healthChanges: { state: "degraded" } }),
    );

    expect(response.state).toBe("degraded");
    const after = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.state).toBe("degraded");
  });

  it("ALLOWS degraded -> online (the control-plane guard blocks ONLY the direct registering->online edge)", async () => {
    // EXPLICITLY ALLOWED — the `online <-> degraded` capability-health axis is
    // the permitted transition (Spec-003 §Fallback Behavior). The I-003-2 guard
    // blocks ONLY the direct `registering -> online` edge (`Spec-003 §Default Behavior`), so
    // `degraded -> online` is permitted because `degraded` is already PAST that
    // gate. Note: a node can reach `degraded` via `registering -> degraded` (the
    // capability-validation-failed Fallback path) WITHOUT ever having been
    // `online`, so the allow does NOT rest on "the node was declared online once"
    // — whether a node was ever daemon-declared online is not something the
    // control plane tracks or gates on; it gates the single edge, nothing more.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "degraded",
    });

    const response = await ctx.service.updateCapabilities(
      buildCapabilityUpdateRequest({ healthChanges: { state: "online" } }),
    );

    expect(response.state).toBe("online");
    const after = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.state).toBe("online");
  });

  it("refuses a capability update against a node with no active attachment (typed 409, I-003-5 active-band)", async () => {
    // No active row resolves -> the typed refusal (NOT an unknown 500, NOT a
    // null no-op). This is the I-003-5 load-bearing assertion: it proves the
    // `state IN (active band)` filter EXCLUDES the offline row (a single
    // happy-path test would pass even if the method resolved by bare node_id).
    // The node's only row is `offline` (a detached node) — outside the
    // active band — so a late capability-update finds nothing to refresh. (The
    // never-attached variant follows.)
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "offline",
    });

    const error = await ctx.service
      .updateCapabilities(buildCapabilityUpdateRequest())
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RuntimeNodeCapabilityUpdateConflictException);
    expect(error).toMatchObject({ code: RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE });
    expect((error as Error).message).toContain(String(NODE_ID));

    // The offline row was NOT touched (the transaction rolled back; the filter
    // never matched it).
    const after = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(after?.state).toBe("offline");
  });

  it("refuses a capability update for a node that was never attached (typed 409, no row created)", async () => {
    // The never-attached variant of the no-active-row refusal: the node has NO
    // attachment row at all. The method must throw the typed refusal and NOT
    // INSERT a row (it only ever UPDATEs an existing active row).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    const error = await ctx.service
      .updateCapabilities(buildCapabilityUpdateRequest())
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RuntimeNodeCapabilityUpdateConflictException);
    expect(error).toMatchObject({ code: RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE });
    expect(await countAttachments(ctx.querier)).toBe(0);
  });

  it("does NOT touch a revoked attachment — the active-band excludes revoked (trust-terminality, mirrors detach)", async () => {
    // The identical trust-terminality exposure detach guards with its
    // "does NOT flip a revoked attachment" test, applied to capability update. A
    // `revoked` row is INACTIVE (outside `state IN ('registering','online',
    // 'degraded')`), so the resolver must NOT match it — `revoked` is terminal
    // (`Spec-003 §Default Behavior`; attach's P10 reads it to refuse re-attach). The offline
    // test above covers the band mechanism generically; this pins `revoked`
    // SPECIFICALLY, so a future edit widening the band to include `revoked` (which
    // would let a capability update silently resurrect a revoked node) is caught.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "revoked",
    });

    const before = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(before).toBeDefined();

    const error = await ctx.service
      .updateCapabilities(buildCapabilityUpdateRequest())
      .catch((thrown: unknown) => thrown);

    // Typed refusal (no active row to refresh) and — load-bearing — the row stays
    // EXACTLY `revoked`, byte-for-byte (capabilities NOT refreshed, never demoted
    // to another state): revocation-terminality holds across a capability update.
    expect(error).toBeInstanceOf(RuntimeNodeCapabilityUpdateConflictException);
    expect(error).toMatchObject({ code: RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE });
    const after = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(after).toEqual(before);
    expect(after?.state).toBe("revoked");
  });

  it("resolves the SINGLE active attachment by nodeId across sessions and leaves an inactive same-node row untouched (I-003-5)", async () => {
    // Gold-standard I-003-5 hardening (parallels detach's "does NOT flip
    // revoked" guard): the SAME node has an `offline` row in session A and an
    // `online` row in session B. The active-band filter resolves EXACTLY the one
    // active row (B) by `nodeId` alone — the request carries no `sessionId` —
    // and refreshes it, while the inactive A row is left byte-for-byte unchanged.
    // This proves the single-active-attachment resolution is unambiguous and the
    // band excludes the inactive row.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedSession(ctx.querier, OTHER_SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "offline",
    });
    await seedAttachment(ctx.querier, {
      sessionId: OTHER_SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });

    const inactiveBefore = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(inactiveBefore).toBeDefined();

    const response = await ctx.service.updateCapabilities(buildCapabilityUpdateRequest());

    // The ACTIVE row (session B) was refreshed: capabilities replaced, state
    // unchanged (no healthChanges).
    expect(response.state).toBe("online");
    const activeAfter = await readAttachmentRowWithTimestamp(
      ctx.querier,
      NODE_ID,
      OTHER_SESSION_ID,
    );
    const activeCapabilities: unknown = JSON.parse(activeAfter?.capabilities ?? "null");
    expect(activeCapabilities).toEqual(UPDATED_CAPABILITIES);

    // The INACTIVE row (session A) is byte-for-byte unchanged — the active-band
    // filter never touched it.
    const inactiveAfter = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(inactiveAfter).toEqual(inactiveBefore);
  });

  it("leaves a co-resident session_memberships row byte-for-byte unchanged (I-003-3)", async () => {
    // I-003-3: the runtime-node domain is disjoint from the membership domain
    // (cross-plan-dependencies.md §1). A capability update must touch ONLY
    // runtime_node_attachments — never read-for-update, insert, update, or delete
    // a session_memberships row. Asserted along the SAME two disjoint mutation
    // modes as the attach / detach I-003-3 tests (byte-identity snapshot + total
    // count).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });
    const membershipId = await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const before = await readMembershipRow(ctx.querier, membershipId);
    expect(before).toBeDefined();
    expect(await countMemberships(ctx.querier)).toBe(1);

    await ctx.service.updateCapabilities(
      buildCapabilityUpdateRequest({ healthChanges: { state: "degraded" } }),
    );

    // (1) Byte-for-byte identity of the seeded row catches an in-place UPDATE;
    // (2) unchanged total count catches a stray INSERT/DELETE of a DIFFERENT row.
    const after = await readMembershipRow(ctx.querier, membershipId);
    expect(after).toEqual(before);
    expect(await countMemberships(ctx.querier)).toBe(1);
  });

  it("emits no durable event and confines its write surface to runtime_node_attachments (ADR-017)", async () => {
    // ADR-017: the control plane has no event log — the daemon's node-capability
    // service stays the `runtime_node.capability_updated` writer; this method
    // only refreshes the coordination snapshot. The no-event property is
    // STRUCTURAL: AttachService takes ONLY a Querier (no event-emitter
    // dependency), so it CANNOT emit a durable event. We assert that structurally
    // by confining the write surface: an active capability update with a health
    // change writes runtime_node_attachments (the slot row) and touches NEITHER
    // runtime_node_presence (the liveness axis stays heartbeat-owned, T3.6 — the
    // axes are orthogonal) NOR session_memberships. (There is no events table to
    // assert against — inventing one would be inventing a control-plane event
    // log ADR-017 forbids.)
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });
    // No presence row is seeded — proving the capability update does NOT create
    // one (presence is heartbeat-owned; the liveness axis is orthogonal).

    await ctx.service.updateCapabilities(
      buildCapabilityUpdateRequest({ healthChanges: { state: "degraded" } }),
    );

    // Write-surface confinement: the slot row IS the only thing written. The
    // attachment moved to degraded (the slot write happened)...
    const attachmentAfter = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
    expect(attachmentAfter?.state).toBe("degraded");
    // ...while NO presence row was created (the liveness axis is untouched —
    // a heartbeat-owned table the capability update never writes)...
    expect(await readPresenceRow(ctx.querier, NODE_ID)).toBeUndefined();
    // ...and NO session_memberships row was created (I-003-3 — the membership
    // domain is disjoint).
    expect(await countMemberships(ctx.querier)).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// updateCapabilities — version-floor write-refusal (P4 / I-003-1, T3.4)
// ----------------------------------------------------------------------------
//
// `Spec-003 §Acceptance Criteria` (the sole spec authority): a daemon attaching below the
// session's `min_client_version` is admitted READ-ONLY, surfaces typed
// `VERSION_FLOOR_EXCEEDED` on any subsequent WRITE attempt, and is NEVER ejected
// for the floor mismatch (ADR-018 §Decision #4) + Plan-003 §Invariants I-003-1.
//
// The full I-003-1 lifecycle: T3.3 admits the below-floor node read-only (the
// P2/P3 block above proves the `readOnly = true` verdict at attach); T3.4 — here
// — refuses its capability WRITE with the typed `VersionFloorExceededException`
// while leaving it JOINED. The load-bearing never-eject property is the
// byte-unchanged attachment row across the refused write (the throw rolls the
// transaction back), proving the node is denied-not-removed.
//
// The gate re-derives the read-only verdict at WRITE time from the CURRENT
// session floor + the daemon's stored `client_version` (the same `#deriveReadOnly`
// comparison attach uses). The boundary cases pin its narrowness: an AT-floor
// node writes successfully (the gate does not over-fire on the `>=` edge), and a
// NULL-floor session admits every write (no gate at all).

describe("AttachService — updateCapabilities version-floor write-refusal (P4 / I-003-1, T3.4)", () => {
  it("refuses a below-floor (read-only) node's capability write with typed VERSION_FLOOR_EXCEEDED and leaves it JOINED (`Spec-003 §Acceptance Criteria` / I-003-1)", async () => {
    // Full lifecycle through the real admission path: a floored session
    // (floor 2.0) admits a below-floor daemon (client 1.0) READ-ONLY at attach
    // (T3.3), then the daemon's capability WRITE is refused (T3.4).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "2.0");

    // (T3.3) Attach admits read-only — the precondition this write-refusal
    // builds on. Asserting `readOnly === true` here ties the two halves of
    // I-003-1 together in one test (admit read-only -> refuse the write).
    const attachResponse = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "1.0" as EventEnvelopeVersion }),
    );
    expect(attachResponse.readOnly).toBe(true);
    expect(attachResponse.state).toBe("registering");

    // Snapshot the attachment row BEFORE the write so the never-eject /
    // byte-unchanged property is provable across the refused write.
    const before = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(before).toBeDefined();

    // (T3.4) The capability WRITE is refused with the typed exception. Capture
    // the rejection once, then assert both the class and the typed `code`
    // literal (the transport layer lifts `code` onto the wire envelope).
    const error = await ctx.service
      .updateCapabilities(buildCapabilityUpdateRequest())
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VersionFloorExceededException);
    expect(error).toMatchObject({ code: VERSION_FLOOR_EXCEEDED_CODE });

    // No-info-leak: the message carries the caller-legitimate upgrade context
    // (the node id + the daemon's own declared client version + the session
    // floor — all values the attaching daemon already knows), never another
    // session's identity.
    expect((error as Error).message).toContain(String(NODE_ID));
    expect((error as Error).message).toContain("1.0");
    expect((error as Error).message).toContain("2.0");

    // NEVER EJECTED (the load-bearing I-003-1 property): the throw rolled the
    // transaction back, so the attachment row is byte-for-byte unchanged
    // (capabilities NOT refreshed — still the attach-time CAPABILITIES, state
    // still registering, attached_at untouched) and the node stays joined.
    const after = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(after).toEqual(before);
    expect(after?.state).toBe("registering");
    const afterCapabilities: unknown = JSON.parse(after?.capabilities ?? "null");
    expect(afterCapabilities).toEqual(CAPABILITIES);
    // Still exactly one attachment row — the node was denied, not removed.
    expect(await countAttachments(ctx.querier)).toBe(1);
  });

  it("throws VERSION_FLOOR_EXCEEDED (not the I-003-2 conflict) when a below-floor registering node requests state:online — pins floor-gate precedes the I-003-2 guard", async () => {
    // Gate-ordering tripwire. A below-floor (client 1.0 / floor 2.0) `registering`
    // node whose capability-update carries `healthChanges: { state: "online" }`
    // trips BOTH refusals: the floor-gate (step 3 of updateCapabilities) AND the
    // I-003-2 registering->online guard (step 4). ONLY the gate ordering decides
    // which type — and therefore which wire `code` — is thrown. The floor-gate
    // runs first, so the below-floor verdict MUST win: a stale daemon learns it
    // is below the floor (VERSION_FLOOR_EXCEEDED) rather than the narrower "you
    // cannot self-promote to online" conflict. A future reorder that moved the
    // I-003-2 guard ahead of the floor-gate would silently swap the surfaced
    // code; this test is what catches that.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "2.0");

    // Attach lands the below-floor node read-only in `registering` (the same
    // admission path the first test uses); confirm the precondition so the
    // ordering assertion below is unambiguous about which state the node is in.
    const attachResponse = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "1.0" as EventEnvelopeVersion }),
    );
    expect(attachResponse.readOnly).toBe(true);
    expect(attachResponse.state).toBe("registering");

    const error = await ctx.service
      .updateCapabilities(buildCapabilityUpdateRequest({ healthChanges: { state: "online" } }))
      .catch((thrown: unknown) => thrown);

    // The floor-gate wins the race: VERSION_FLOOR_EXCEEDED, NOT the I-003-2
    // capability-update conflict. Asserting the conflict type is explicitly
    // absent makes the ordering — not merely "some refusal" — the thing pinned.
    expect(error).toBeInstanceOf(VersionFloorExceededException);
    expect(error).not.toBeInstanceOf(RuntimeNodeCapabilityUpdateConflictException);
    expect(error).toMatchObject({ code: VERSION_FLOOR_EXCEEDED_CODE });
  });

  it("ALLOWS an AT-floor node's capability write (the gate does not over-fire on the >= edge)", async () => {
    // Boundary: client_version === floor is AT-or-above, so read-write — the
    // write must succeed. Pins the gate's narrowness against an off-by-one that
    // would wrongly refuse the at-floor node (parallels the P2 attach edge).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "2.0");
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
      clientVersion: "2.0",
    });

    const response = await ctx.service.updateCapabilities(buildCapabilityUpdateRequest());

    // The write landed: the response projects the node + (unchanged) liveness
    // state, and the capabilities snapshot was refreshed.
    expect(String(response.nodeId)).toBe(String(NODE_ID));
    expect(response.state).toBe("online");
    const after = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    const storedCapabilities: unknown = JSON.parse(after?.capabilities ?? "null");
    expect(storedCapabilities).toEqual(UPDATED_CAPABILITIES);
  });

  it("ALLOWS an above-floor node's capability write (read-write admission, no gate)", async () => {
    // A daemon comfortably above the floor (client 2.5 > floor 2.0) writes
    // freely — the read-write complement to the AT-floor edge above.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "2.0");
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
      clientVersion: "2.5",
    });

    const response = await ctx.service.updateCapabilities(buildCapabilityUpdateRequest());

    expect(response.state).toBe("online");
    const after = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    const storedCapabilities: unknown = JSON.parse(after?.capabilities ?? "null");
    expect(storedCapabilities).toEqual(UPDATED_CAPABILITIES);
  });

  it("ALLOWS a capability write when the session floor is NULL (no version gate at all)", async () => {
    // A NULL-floor session ("no floor") has no version gate — every daemon
    // version, however old, writes freely. Pins that the gate's NULL-floor
    // branch (`#deriveReadOnly` returns false) does not refuse the write. The
    // seeded daemon's `client_version` is the helper default "1.0".
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
      clientVersion: "1.0",
    });

    const response = await ctx.service.updateCapabilities(buildCapabilityUpdateRequest());

    expect(response.state).toBe("online");
    const after = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    const storedCapabilities: unknown = JSON.parse(after?.capabilities ?? "null");
    expect(storedCapabilities).toEqual(UPDATED_CAPABILITIES);
  });
});

// ----------------------------------------------------------------------------
// readRoster — the session roster projection (T5.0c)
// ----------------------------------------------------------------------------
//
// `Spec-003 §Interfaces And Contracts` 2026-06-09 amendment: the
// roster read returns EVERY `runtime_node_attachments` row for the session —
// all five `state` values verbatim, no server-side hiding (`Spec-003
// §Interfaces And Contracts`; AC2 needs degraded/offline visible) —
// LEFT-JOINs the heartbeat-owned
// presence axis (NULL until the first beat), derives `readOnly` per row at
// read time from the stored `client_version` vs the session's CURRENT
// `min_client_version` floor (AC4 / I-003-1 — the read-side surfacing
// of admit-not-eject), and carries BOTH health axes verbatim with no collapsed
// scalar (`Spec-003 §Default Behavior` — reconciliation is the client's render-time concern). The
// read NEVER derives staleness (the T3.6 sweep stays the single
// liveness-derivation writer) and writes NOTHING (I-003-3: no
// session_memberships access; ADR-017: no durable event — structural, the
// control plane has no event log).
//
// The blocks below pin: all-five-states visibility (offline/revoked included);
// attach -> roster end-to-end multi-node coexistence (AC3 / `Spec-003 §Required Behavior`);
// axis independence in BOTH directions plus the verbatim heartbeat clock; the
// no-staleness-derivation property; the per-row derived readOnly verdict
// (below/at floor in ONE roster + the NULL-floor branch); pre-first-heartbeat
// nullability; session isolation (including the same node's rows split across
// sessions); the empty roster; the read-only write-surface (snapshot + count
// across all three tables); and the fail-closed parse of a corrupted stored
// `client_version`.

describe("AttachService — readRoster (roster projection, T5.0c)", () => {
  it("returns EVERY attachment row for the session — offline and revoked included — with all five states verbatim (AC2, `Spec-003 §Acceptance Criteria` + `Spec-003 §Interfaces And Contracts`; `Spec-003 §Fallback Behavior`)", async () => {
    // One session, five DISTINCT nodes, one in each NodeState. Distinct
    // node_ids never collide on the per-node active index (three active rows
    // are fine), and the `(node_id, session_id)` arbiter sees five distinct
    // pairs. The roster must surface all five rows with their states verbatim:
    // a `degraded` node stays visible and is NOT presented as healthy (Spec-003
    // `Spec-003 §Fallback Behavior`), and `offline` / `revoked` rows are NOT hidden server-side —
    // AC2's distinguishability needs every state observable.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    const allFiveStates = ["registering", "online", "degraded", "offline", "revoked"] as const;
    for (const state of allFiveStates) {
      await seedAttachment(ctx.querier, {
        sessionId: SESSION_ID,
        participantId: PARTICIPANT_ID,
        nodeId: `node-roster-${state}` as NodeId,
        state,
      });
    }

    const response = await ctx.service.readRoster({ sessionId: SESSION_ID });

    expect(response.nodes).toHaveLength(5);
    const stateByNodeId = new Map(
      response.nodes.map((entry) => [String(entry.nodeId), entry.state]),
    );
    for (const state of allFiveStates) {
      expect(stateByNodeId.get(`node-roster-${state}`)).toBe(state);
    }
  });

  it("projects multiple coexisting nodes attached through the REAL attach path with per-node identity intact (AC3, `Spec-003 §Acceptance Criteria` + `Spec-003 §Required Behavior`)", async () => {
    // End-to-end write -> read coherence: two nodes attach through the real
    // service path (not seeds) with DIFFERENT capability maps, then the roster
    // returns both entries each carrying its OWN identity + fields — per-node
    // capabilities (the JSONB round-trips per row), the branded clientVersion,
    // the owner participantId, and a parseable attachedAt. Both are
    // pre-first-heartbeat, so the liveness axis is NULL on each.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await ctx.service.attach(buildAttachRequest());
    await ctx.service.attach(
      buildAttachRequest({ nodeId: NODE_ID_BETA, capabilities: UPDATED_CAPABILITIES }),
    );

    const response = await ctx.service.readRoster({ sessionId: SESSION_ID });

    expect(response.nodes).toHaveLength(2);
    const alphaEntry = response.nodes.find((entry) => String(entry.nodeId) === String(NODE_ID));
    const betaEntry = response.nodes.find((entry) => String(entry.nodeId) === String(NODE_ID_BETA));
    expect(alphaEntry).toBeDefined();
    expect(betaEntry).toBeDefined();
    // Per-node fields stayed per-node (no cross-row bleed through the JOIN).
    expect(alphaEntry?.capabilities).toEqual(CAPABILITIES);
    expect(betaEntry?.capabilities).toEqual(UPDATED_CAPABILITIES);
    expect(String(alphaEntry?.participantId)).toBe(String(PARTICIPANT_ID));
    expect(String(alphaEntry?.clientVersion)).toBe(String(CLIENT_VERSION));
    expect(Number.isFinite(new Date(alphaEntry?.attachedAt ?? "").getTime())).toBe(true);
    // Fresh attaches: slot `registering`, liveness NULL (no heartbeat yet).
    expect(alphaEntry?.state).toBe("registering");
    expect(alphaEntry?.healthState).toBeNull();
    expect(betaEntry?.healthState).toBeNull();
  });

  it("round-trips DISAGREEING axes verbatim in both directions and carries the heartbeat clock untouched (`Spec-003 §Default Behavior` — never collapse, never mask)", async () => {
    // Axis independence, both directions in ONE roster:
    //   - node A: slot `online` + swept liveness `offline` (the
    //     swept-offline-but-still-attached shape — the sweep writes only
    //     presence, the slot stays active);
    //   - node B: slot `degraded` (capability axis) + fresh liveness `online`
    //     (a capability-degraded node that heartbeats happily).
    // The roster must carry BOTH columns of BOTH rows verbatim — a recovery on
    // one axis never masks a degradation on the other, and no collapsed scalar
    // exists to lose either verdict. The seeded heartbeat instant also
    // round-trips verbatim (the read reports the clock; it never rewrites it).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID_BETA,
      state: "degraded",
    });
    const seededHeartbeatInstant = "2026-06-01T12:00:00.000Z";
    await seedPresence(ctx.querier, {
      nodeId: NODE_ID,
      healthState: "offline",
      lastHeartbeatAt: seededHeartbeatInstant,
    });
    await seedPresence(ctx.querier, { nodeId: NODE_ID_BETA, healthState: "online" });

    const response = await ctx.service.readRoster({ sessionId: SESSION_ID });

    const alphaEntry = response.nodes.find((entry) => String(entry.nodeId) === String(NODE_ID));
    const betaEntry = response.nodes.find((entry) => String(entry.nodeId) === String(NODE_ID_BETA));
    // Direction 1: active slot + dead liveness — both verbatim.
    expect(alphaEntry?.state).toBe("online");
    expect(alphaEntry?.healthState).toBe("offline");
    // Direction 2: degraded slot + healthy liveness — both verbatim.
    expect(betaEntry?.state).toBe("degraded");
    expect(betaEntry?.healthState).toBe("online");
    // The heartbeat clock round-trips as the SAME instant (compared as epoch
    // millis — the seed string and the wire ISO form may differ in rendering).
    expect(new Date(alphaEntry?.lastHeartbeatAt ?? "").getTime()).toBe(
      Date.parse(seededHeartbeatInstant),
    );
  });

  it("NEVER derives staleness — a long-stale heartbeat reports its STORED health verbatim (T3.6 stays the single liveness-derivation writer)", async () => {
    // A presence row whose last_heartbeat_at is 10 minutes old — far past both
    // the 30s degraded and 60s offline thresholds — but whose STORED
    // health_state is still `online` (the sweep has not run). The roster must
    // report `online` verbatim: deriving `degraded`/`offline` from heartbeat
    // age at read time would make readRoster a second, racing liveness author
    // (`Spec-003 §Default Behavior` + `Spec-003 §Interfaces And Contracts` — the T3.6 sweep owns that derivation).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await seedPresence(ctx.querier, {
      nodeId: NODE_ID,
      healthState: "online",
      lastHeartbeatAt: tenMinutesAgo,
    });

    const response = await ctx.service.readRoster({ sessionId: SESSION_ID });

    const entry = response.nodes.find((candidate) => String(candidate.nodeId) === String(NODE_ID));
    // Stored verdict verbatim — NOT an aged-out derivation.
    expect(entry?.healthState).toBe("online");
  });

  it("derives readOnly PER ROW — below-floor true with state untouched, at-floor false in the SAME roster (AC4, `Spec-003 §Acceptance Criteria` / I-003-1)", async () => {
    // A floored session (2.0) holding two nodes: one attached at a below-floor
    // client_version (1.0), one at-floor (2.0). The roster derives the verdict
    // per row from the STORED version vs the CURRENT floor — the same
    // #deriveReadOnly comparator as the attach-time verdict — so the two
    // entries differ on `readOnly` while NOTHING else is touched: the
    // below-floor node's slot state reads verbatim (`online`, still joined,
    // admit-not-eject) and its stored row is byte-for-byte unchanged by the
    // read. readOnly is the PERMISSION axis, orthogonal to `state`.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "2.0");
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
      clientVersion: "1.0",
    });
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID_BETA,
      state: "online",
      clientVersion: "2.0",
    });
    const belowFloorBefore = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(belowFloorBefore).toBeDefined();

    const response = await ctx.service.readRoster({ sessionId: SESSION_ID });

    const belowFloorEntry = response.nodes.find(
      (entry) => String(entry.nodeId) === String(NODE_ID),
    );
    const atFloorEntry = response.nodes.find(
      (entry) => String(entry.nodeId) === String(NODE_ID_BETA),
    );
    // The PERMISSION axis differs per row...
    expect(belowFloorEntry?.readOnly).toBe(true);
    expect(atFloorEntry?.readOnly).toBe(false);
    // ...while the below-floor node's STATE is untouched (visible, joined,
    // never demoted or hidden for the floor mismatch — admit-not-eject).
    expect(belowFloorEntry?.state).toBe("online");
    // And the stored row is byte-for-byte unchanged — the verdict is derived,
    // never written back.
    const belowFloorAfter = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    expect(belowFloorAfter).toEqual(belowFloorBefore);
  });

  it("derives readOnly=false under a NULL floor — no version gate at all (the #deriveReadOnly NULL branch on the read path)", async () => {
    // A NULL-floor session ("no floor") admits every version read-write; the
    // roster's per-row derivation must mirror that: even an old client (the
    // seed default 1.0) reads readOnly=false.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
      clientVersion: "1.0",
    });

    const response = await ctx.service.readRoster({ sessionId: SESSION_ID });

    expect(response.nodes[0]?.readOnly).toBe(false);
  });

  it("carries healthState=null + lastHeartbeatAt=null for a never-heartbeated node (pre-first-heartbeat LEFT-JOIN nullability)", async () => {
    // Presence rows are heartbeat-owned (T3.6 creates them on the first beat),
    // so a node attached but never heartbeated has NO presence row — the LEFT
    // JOIN carries SQL NULLs, which the wire entry surfaces as null/null
    // rather than dropping the node or inventing a liveness verdict.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "registering",
    });

    const response = await ctx.service.readRoster({ sessionId: SESSION_ID });

    expect(response.nodes).toHaveLength(1);
    const entry = response.nodes[0];
    expect(entry?.healthState).toBeNull();
    expect(entry?.lastHeartbeatAt).toBeNull();
    // The slot axis is still fully populated alongside the NULL liveness axis.
    expect(entry?.state).toBe("registering");
  });

  it("isolates sessions — session B's rows (including the SAME node's inactive row) never leak into session A's roster", async () => {
    // Session isolation with the sharpest shape: node ALPHA holds an ACTIVE
    // row in session A and an `offline` row in session B (legal under the
    // partial active index — only ACTIVE states are constrained per node), and
    // node BETA is active in session B only. roster(A) must carry exactly
    // ALPHA's A-row; roster(B) must carry exactly its OWN two rows — BETA's
    // active row AND ALPHA's offline row (visibility: an offline row is B's to
    // show, not A's).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedSession(ctx.querier, OTHER_SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });
    await seedAttachment(ctx.querier, {
      sessionId: OTHER_SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "offline",
    });
    await seedAttachment(ctx.querier, {
      sessionId: OTHER_SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID_BETA,
      state: "online",
    });

    const rosterA = await ctx.service.readRoster({ sessionId: SESSION_ID });
    const rosterB = await ctx.service.readRoster({ sessionId: OTHER_SESSION_ID });

    // Session A: exactly the one A-row — B's rows never bleed in.
    expect(rosterA.nodes).toHaveLength(1);
    expect(String(rosterA.nodes[0]?.nodeId)).toBe(String(NODE_ID));
    expect(rosterA.nodes[0]?.state).toBe("online");
    // Session B: exactly its own two rows — ALPHA's offline row included
    // (per-session visibility), BETA's active row included, A's row absent.
    expect(rosterB.nodes).toHaveLength(2);
    const rosterBStateByNodeId = new Map(
      rosterB.nodes.map((entry) => [String(entry.nodeId), entry.state]),
    );
    expect(rosterBStateByNodeId.get(String(NODE_ID))).toBe("offline");
    expect(rosterBStateByNodeId.get(String(NODE_ID_BETA))).toBe("online");
  });

  it("returns an empty roster for a session with no attachments AND for a non-existent session (the router-tier existence posture)", async () => {
    // An attachment-free session projects `{nodes: []}` — an empty array is a
    // valid wire response, not an error. A NON-EXISTENT session likewise reads
    // empty rather than throwing: session existence/authorization is the
    // router tier's concern (the same posture attach's NULL-floor read takes),
    // and the FK guarantees no attachment row can reference a missing session,
    // so "no session" and "no attachments" are indistinguishable at this READ.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    const emptyRoster = await ctx.service.readRoster({ sessionId: SESSION_ID });
    expect(emptyRoster.nodes).toEqual([]);

    const missingSessionRoster = await ctx.service.readRoster({ sessionId: OTHER_SESSION_ID });
    expect(missingSessionRoster.nodes).toEqual([]);
  });

  it("writes NOTHING — attachments, presence, and session_memberships are byte-for-byte unchanged across a roster read (I-003-3; ADR-017)", async () => {
    // The read-only-projection property, asserted across the FULL write
    // surface with the suite's standard two disjoint mutation modes
    // (byte-identity snapshot + total count): the attachment row, the presence
    // row, and a co-resident membership row all survive a roster read
    // byte-for-byte, and no table gains or loses a row. The no-durable-event
    // property is STRUCTURAL, exactly as the updateCapabilities ADR-017 test
    // pins it: AttachService takes ONLY a Querier (no event-emitter
    // dependency) and the control plane has no event log/table to write — the
    // roster read PROJECTS coordination records, colliding with nothing the
    // ADR-017 V1.1 durable-authorship gate governs.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });
    await seedPresence(ctx.querier, { nodeId: NODE_ID, healthState: "online" });
    const membershipId = await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const attachmentBefore = await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID);
    const presenceBefore = await readPresenceRow(ctx.querier, NODE_ID);
    const membershipBefore = await readMembershipRow(ctx.querier, membershipId);
    expect(attachmentBefore).toBeDefined();
    expect(presenceBefore).toBeDefined();
    expect(membershipBefore).toBeDefined();

    const response = await ctx.service.readRoster({ sessionId: SESSION_ID });
    expect(response.nodes).toHaveLength(1);

    // Byte-identity across every touched-by-JOIN table (mode 1)...
    expect(await readAttachmentRowWithTimestamp(ctx.querier, NODE_ID, SESSION_ID)).toEqual(
      attachmentBefore,
    );
    expect(await readPresenceRow(ctx.querier, NODE_ID)).toEqual(presenceBefore);
    expect(await readMembershipRow(ctx.querier, membershipId)).toEqual(membershipBefore);
    // ...and unchanged totals (mode 2 — no stray INSERT/DELETE anywhere).
    expect(await countAttachments(ctx.querier)).toBe(1);
    expect(await countPresence(ctx.querier)).toBe(1);
    expect(await countMemberships(ctx.querier)).toBe(1);
  });

  it("fails CLOSED on a corrupted stored client_version — the read boundary parses, never casts", async () => {
    // The stored `client_version` is parsed+branded through
    // EventEnvelopeVersionSchema.parse before the readOnly derivation (and
    // re-validated by the response-schema parse). A regex-invalid stored value
    // (the TEXT column has no DB CHECK, so the seed lands fine) must throw
    // loud at the read boundary — an `as`-cast bypass would reach the numeric
    // comparator as NaN and silently mis-derive the permission verdict.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, "2.0");
    await seedAttachment(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
      clientVersion: "1.0.0",
    });

    await expect(ctx.service.readRoster({ sessionId: SESSION_ID })).rejects.toThrow(ZodError);
  });
});
