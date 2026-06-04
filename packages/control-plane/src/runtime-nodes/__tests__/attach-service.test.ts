// P1/P9/P10 — AttachService attach gates (Plan-003 Phase 3, T3.2).
//
// P1 (Spec-003 §Required Behavior line 53, AC P1): `RuntimeNodeAttach` against a
//     session whose `min_client_version` is NULL admits ALL daemon versions
//     unconditionally — the attachment row is written in state `registering`
//     (non-online until capability declaration, I-003-2) with the derived
//     `readOnly` flag `false` (a NULL floor admits at full permission). The
//     "permits all daemons" property is exercised across several `clientVersion`
//     values, including one far above any plausible floor.
//
// P9 (Plan-003 §Invariants I-003-5, AC P9): the single-active-session contract.
//     (a) a node already actively attached to session A, attempting a SECOND
//         active attach to session B, is refused with the typed
//         `runtime_node.session_conflict` CONFLICT — the
//         `idx_node_attachments_active` partial-unique index raises SQLSTATE
//         `23505`, which the service catches and rethrows typed. (Asserted at the
//         typed-exception / `code` level — the HTTP 409 projection is T3.8's
//         transport test, not this service test.)
//     (b) a reconnect after detach REACTIVATES the `offline` row (the upsert's
//         `ON CONFLICT (node_id, session_id) DO UPDATE` reactivation) rather than
//         inserting a duplicate — the same attachment `id` survives, the row
//         count stays at one, and the state returns to `registering`.
//
// P10 (Plan-003 T3.2/P10, runtime-node-model.md line 52): a re-attach of a
//     `revoked` row is refused with the typed `runtime_node.revoked_terminal`
//     CONFLICT — revocation is TERMINAL, never reactivated. The revoked row is
//     left unchanged.
//
// I-003-3 (Plan-003 §Invariants I-003-3, Spec-003 line 47): attach writes ONLY
//     `runtime_node_attachments` — a successful attach leaves `session_memberships`
//     byte-for-byte unchanged (no INSERT/UPDATE/DELETE, no lock). Asserted via a
//     before/after snapshot of the full `session_memberships` content (mirrors
//     the MembershipService no-mutation precedent).
//
// Harness: the PGlite-in-memory pattern from
// `memberships/__tests__/membership-service.test.ts` /
// `migrations/__tests__/0003-runtime-nodes.test.ts` — a fresh ephemeral PGlite
// instance per test, `applyMigrations` for schema bootstrap (now including v3,
// so `runtime_node_attachments` exists), seeding via direct INSERTs, then
// exercising the service. Each refusal test asserts BOTH the thrown error code
// AND the persisted-state property by re-SELECTing the affected row(s).
//
// For P9(b)'s reconnect leg the `offline` row is set directly via the `Querier`
// in the arrange step (the detach method that would produce it is T3.7's, not
// this task's — the dispatch authorizes seeding the state directly here).
//
// Refs: Plan-003 Phase 3 T3.2 §Step / §Test; Spec-003 line 47 (attach-membership
// separation), line 53 (NULL floor permits all daemons), line 69 (reconnect
// under same identity), line 118 (one active session at a time in v1); Plan-003
// §Invariants I-003-3 / I-003-5; docs/domain/runtime-node-model.md line 52.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  EventEnvelopeVersion,
  NodeId,
  ParticipantId,
  RuntimeNodeAttachRequest,
  SessionId,
} from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import { AttachService, isAtOrAboveFloor } from "../attach-service.js";
import {
  RuntimeNodeRevokedException,
  RuntimeNodeSessionConflictException,
  RUNTIME_NODE_REVOKED_TERMINAL_CODE,
  RUNTIME_NODE_SESSION_CONFLICT_CODE,
} from "../errors.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUID v7-shaped ids (the brand validators accept any RFC 9562
// UUID; real generation is daemon-side). `nodeId` is a daemon-assigned opaque
// TEXT scalar (NOT a UUID). `clientVersion` is the branded MAJOR.MINOR semver.
// ----------------------------------------------------------------------------

const SESSION_A_ID = "01970000-0000-7000-8000-0000000e0001";
const SESSION_B_ID = "01970000-0000-7000-8000-0000000e0002";
const PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-0000000f0001" as ParticipantId;
const NODE_ID: NodeId = "node-attach-fixture-001" as NodeId;

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (mirrors membership-service.test.ts `wrap`)
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
  service: AttachService;
}

let ctx: TestContext;

beforeEach(async () => {
  // Fresh in-memory PGlite per test. `applyMigrations` walks v1 + v2 + v3, so
  // `runtime_node_attachments` (+ the two unique indexes) and the upstream
  // `sessions` / `participants` / `session_memberships` anchors all exist.
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);
  ctx = { pg, querier, service: new AttachService(querier) };
});

afterEach(async () => {
  await ctx.pg.close();
});

// ----------------------------------------------------------------------------
// Seed helpers
// ----------------------------------------------------------------------------

async function seedParticipant(querier: Querier, participantId: ParticipantId): Promise<void> {
  await querier.query("INSERT INTO participants (id) VALUES ($1)", [participantId]);
}

// `min_client_version` defaults to NULL when `floor` is omitted — the P1
// permissive case. Pass a non-NULL `floor` (e.g. "2.0") to exercise the T3.3
// floor-comparison branch (P2 at/above → read/write; P3 below → read-only).
async function seedSession(
  querier: Querier,
  sessionId: string,
  floor: string | null = null,
): Promise<void> {
  await querier.query(
    "INSERT INTO sessions (id, state, min_client_version) VALUES ($1, 'active', $2)",
    [sessionId, floor],
  );
}

// Seed an active `session_memberships` row so the I-003-3 no-mutation assertion
// has content to compare before/after attach. Attach must never touch this row.
async function seedMembership(
  querier: Querier,
  args: { sessionId: string; participantId: ParticipantId; role: string; state: string },
): Promise<void> {
  await querier.query(
    `INSERT INTO session_memberships (session_id, participant_id, role, state, joined_at)
     VALUES ($1, $2, $3, $4, now())`,
    [args.sessionId, args.participantId, args.role, args.state],
  );
}

// Build a `RuntimeNodeAttachRequest` with overridable fields. Defaults to
// SESSION_A + the shared node/participant; `clientVersion` defaults to a low
// MAJOR.MINOR so the NULL-floor "permits all" property is the only thing under
// test (the value is irrelevant when the floor is NULL).
function buildAttachRequest(
  overrides: Partial<RuntimeNodeAttachRequest> = {},
): RuntimeNodeAttachRequest {
  return {
    sessionId: SESSION_A_ID as SessionId,
    participantId: PARTICIPANT_ID,
    nodeId: NODE_ID,
    clientVersion: "1.0" as EventEnvelopeVersion,
    capabilities: { "provider-driver": { kind: "claude" } },
    healthState: "online",
    ...overrides,
  };
}

// Read every attachment row for a node, ordered, so duplicate-vs-reactivate is
// observable. Returns the minimal shape the assertions need.
async function readAttachments(
  querier: Querier,
  nodeId: string,
): Promise<
  ReadonlyArray<{ id: string; session_id: string; state: string; client_version: string }>
> {
  const result = await querier.query<{
    id: string;
    session_id: string;
    state: string;
    client_version: string;
  }>(
    `SELECT id, session_id, state, client_version
       FROM runtime_node_attachments
      WHERE node_id = $1
      ORDER BY attached_at ASC, id ASC`,
    [nodeId],
  );
  return result.rows;
}

// Snapshot the FULL `session_memberships` content (all columns that attach could
// conceivably touch) for the I-003-3 before/after equality assertion.
async function snapshotMemberships(
  querier: Querier,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const result = await querier.query<Record<string, unknown>>(
    `SELECT id, session_id, participant_id, role, state, joined_at, updated_at
       FROM session_memberships
      ORDER BY id ASC`,
  );
  // Normalize TIMESTAMPTZ to a stable string so a Date-vs-string substrate
  // difference cannot make two equal snapshots compare unequal.
  return result.rows.map((row) => ({
    ...row,
    joined_at: normalizeTimestamp(row["joined_at"]),
    updated_at: normalizeTimestamp(row["updated_at"]),
  }));
}

function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

// ----------------------------------------------------------------------------
// P1 — NULL floor admits all daemon versions (Spec-003 line 53)
// ----------------------------------------------------------------------------

describe("AttachService.attach (P1 — NULL min_client_version admits all daemons)", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_A_ID, null);
  });

  it("admits an attach against a NULL-floor session in state 'registering', readOnly=false", async () => {
    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "1.0" as EventEnvelopeVersion }),
    );

    // Non-online until capability declaration (I-003-2): a fresh attach lands in
    // `registering`, not `online`.
    expect(response.state).toBe("registering");
    // A NULL floor admits at FULL permission — never read-only.
    expect(response.readOnly).toBe(false);
    expect(response.attachmentId).toMatch(/[0-9a-f-]{36}/i);
    expect(typeof response.attachedAt).toBe("string");

    // The row is persisted with the reported version + capabilities.
    const rows = await readAttachments(ctx.querier, NODE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: SESSION_A_ID,
      state: "registering",
      client_version: "1.0",
    });
  });

  it.each([
    ["0.1", "a far-below-any-plausible-floor version"],
    ["1.0", "a baseline version"],
    ["99.99", "a far-above-any-plausible-floor version"],
  ])("admits clientVersion '%s' (%s) when the session floor is NULL", async (clientVersion) => {
    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: clientVersion as EventEnvelopeVersion }),
    );

    // The defining property of a NULL floor: EVERY version is admitted, none is
    // read-only, regardless of how low/high the reported version is. This is the
    // Spec-003 line 53 "A NULL floor permits all daemons" contract — the
    // versions span well below and well above any non-NULL floor T3.3's
    // comparison would evaluate against.
    expect(response.state).toBe("registering");
    expect(response.readOnly).toBe(false);

    const rows = await readAttachments(ctx.querier, NODE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.client_version).toBe(clientVersion);
  });
});

// ----------------------------------------------------------------------------
// I-003-3 — attach does not mutate session_memberships
// ----------------------------------------------------------------------------

describe("AttachService.attach (I-003-3 — no session_memberships mutation)", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_A_ID, null);
    // A pre-existing active membership for the SAME participant — attach shares a
    // participant identity with membership but must compose orthogonally
    // (I-003-3): the row must survive attach byte-for-byte.
    await seedMembership(ctx.querier, {
      sessionId: SESSION_A_ID,
      participantId: PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });
  });

  it("leaves session_memberships byte-for-byte unchanged after a successful attach", async () => {
    const before = await snapshotMemberships(ctx.querier);
    expect(before).toHaveLength(1);

    await ctx.service.attach(buildAttachRequest());

    const after = await snapshotMemberships(ctx.querier);
    // No INSERT/UPDATE/DELETE against session_memberships — the full content is
    // identical (same row, same role/state, same updated_at — an UPDATE would
    // have bumped updated_at). This is the canonical control-plane-side I-003-3
    // verification (P7), distinct from the daemon-side structural check.
    expect(after).toEqual(before);
  });
});

// ----------------------------------------------------------------------------
// P9 — single active session: cross-session refusal + reconnect reactivation
// (I-003-5)
// ----------------------------------------------------------------------------

describe("AttachService.attach (P9 — single active session, I-003-5)", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_A_ID, null);
    await seedSession(ctx.querier, SESSION_B_ID, null);
  });

  it("refuses a second active attach to a DIFFERENT session with the typed session_conflict CONFLICT", async () => {
    // First attach to session A — succeeds, leaving an active ('registering')
    // row.
    await ctx.service.attach(buildAttachRequest({ sessionId: SESSION_A_ID as SessionId }));

    // Second active attach for the SAME node to session B — the composite
    // (node_id, session_id) tuple differs, so the ON CONFLICT target does NOT
    // fire; the only constraint that can reject this is the
    // idx_node_attachments_active partial-unique index (I-003-5). The service
    // catches the 23505 and rethrows typed.
    await expect(
      ctx.service.attach(buildAttachRequest({ sessionId: SESSION_B_ID as SessionId })),
    ).rejects.toBeInstanceOf(RuntimeNodeSessionConflictException);

    // Assert at the typed-exception / code level (the HTTP 409 projection is
    // T3.8's transport test).
    await expect(
      ctx.service.attach(buildAttachRequest({ sessionId: SESSION_B_ID as SessionId })),
    ).rejects.toMatchObject({ code: RUNTIME_NODE_SESSION_CONFLICT_CODE });

    // The refused attach left NO session-B row — the active session-A row is the
    // only attachment (the rejected INSERT rolled back).
    const rows = await readAttachments(ctx.querier, NODE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_id).toBe(SESSION_A_ID);
  });

  it("reactivates an offline row on reconnect (upsert ON CONFLICT) rather than duplicating it", async () => {
    // First attach to session A.
    const first = await ctx.service.attach(
      buildAttachRequest({ sessionId: SESSION_A_ID as SessionId }),
    );

    // Simulate a detach -> offline transition by setting the row state directly
    // (the detach method is T3.7's, not this task's; the arrange seeds the
    // `offline` state the reconnect path consumes). An `offline` row escapes the
    // partial-unique active predicate, so it does not block the reconnect.
    await ctx.querier.query(
      "UPDATE runtime_node_attachments SET state = 'offline' WHERE node_id = $1 AND session_id = $2",
      [NODE_ID, SESSION_A_ID],
    );

    // Reconnect under the SAME node identity to the SAME session — Spec-003 line
    // 69 / line 94. The upsert's ON CONFLICT (node_id, session_id) DO UPDATE
    // REACTIVATES the offline row to 'registering' (a plain INSERT would violate
    // the composite unique key).
    const reconnect = await ctx.service.attach(
      buildAttachRequest({
        sessionId: SESSION_A_ID as SessionId,
        clientVersion: "2.0" as EventEnvelopeVersion,
      }),
    );

    // SAME attachment id — the row was reactivated, not re-inserted (revocation-
    // free reconnect preserves historical node provenance, Spec-003 line 101).
    expect(reconnect.attachmentId).toBe(first.attachmentId);
    expect(reconnect.state).toBe("registering");

    // Exactly ONE row for the node — no duplicate from the reconnect, and the
    // reactivated row carries the reconnect's reported version.
    const rows = await readAttachments(ctx.querier, NODE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.attachmentId,
      session_id: SESSION_A_ID,
      state: "registering",
      client_version: "2.0",
    });
  });
});

// ----------------------------------------------------------------------------
// P10 — re-attach of a revoked row is refused (revocation is terminal)
// ----------------------------------------------------------------------------

describe("AttachService.attach (P10 — revoked re-attach refused, terminal)", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_A_ID, null);
  });

  it("refuses a re-attach of a revoked row with the typed revoked CONFLICT, leaving the row unchanged", async () => {
    // First attach, then revoke the row directly (the revoke-state write is the
    // T3.7 detach/revoke path, not this task — seed the terminal `revoked` state
    // the refusal consumes). A `revoked` row escapes the active predicate, so the
    // refusal here is the APPLICATION-level terminal-revocation guard, NOT the
    // 23505 index path (which is the distinct cross-session case).
    await ctx.service.attach(buildAttachRequest({ sessionId: SESSION_A_ID as SessionId }));
    await ctx.querier.query(
      "UPDATE runtime_node_attachments SET state = 'revoked' WHERE node_id = $1 AND session_id = $2",
      [NODE_ID, SESSION_A_ID],
    );

    // Re-attach attempt — refused. Revocation is terminal: a revoked node is "no
    // longer trusted or allowed to participate" (runtime-node-model.md line 52),
    // so the row is NOT reactivated (contrast the `offline` reconnect path).
    await expect(
      ctx.service.attach(buildAttachRequest({ sessionId: SESSION_A_ID as SessionId })),
    ).rejects.toBeInstanceOf(RuntimeNodeRevokedException);
    await expect(
      ctx.service.attach(buildAttachRequest({ sessionId: SESSION_A_ID as SessionId })),
    ).rejects.toMatchObject({ code: RUNTIME_NODE_REVOKED_TERMINAL_CODE });

    // The revoked row is unchanged — still exactly one row, still `revoked` (the
    // refused attach rolled back; no reactivation, no duplicate insert).
    const rows = await readAttachments(ctx.querier, NODE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("revoked");
  });
});

// ----------------------------------------------------------------------------
// P2 — non-NULL floor, client AT/ABOVE floor admits at full read/write
// (Spec-003 line 53; ADR-018 §Decision #1/#4; readOnly orthogonal to state)
// ----------------------------------------------------------------------------

describe("AttachService.attach (P2 — client at/above a non-NULL floor → read/write)", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    // Floor 2.0. A client at or above it is admitted at full permission.
    await seedSession(ctx.querier, SESSION_A_ID, "2.0");
  });

  it("admits a client ABOVE the floor with readOnly=false, state 'registering', row persisted", async () => {
    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "2.5" as EventEnvelopeVersion }),
    );

    // Above the floor → full read/write. `state` is the unchanged liveness axis
    // (still `registering` per I-003-2), `readOnly` the orthogonal permission
    // axis (api-payload-contracts.md:496-497).
    expect(response.readOnly).toBe(false);
    expect(response.state).toBe("registering");

    const rows = await readAttachments(ctx.querier, NODE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "registering", client_version: "2.5" });
  });

  it("admits a client EXACTLY AT the floor with readOnly=false (at-floor is read/write — boundary)", async () => {
    // The boundary case the `>=` (not `>`) in `isAtOrAboveFloor` is responsible
    // for: client == floor is at/above, so read/write, NOT read-only.
    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "2.0" as EventEnvelopeVersion }),
    );

    expect(response.readOnly).toBe(false);
    expect(response.state).toBe("registering");
  });

  it("admits a client a higher MAJOR but LOWER minor than the floor with readOnly=false (semver-aware, not lexicographic)", async () => {
    // Floor 2.0; client 10.0 is above it. A lexicographic string compare would
    // read "10.0" < "2.0" and wrongly flag read-only — this proves the service
    // path is semver-aware end to end, not just the unit-tested comparator.
    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "10.0" as EventEnvelopeVersion }),
    );

    expect(response.readOnly).toBe(false);
    expect(response.state).toBe("registering");
  });
});

// ----------------------------------------------------------------------------
// P3 — non-NULL floor, client BELOW floor admits READ-ONLY (I-003-1:
// admit-in-read-only / never-eject — the node stays joined, reads succeed)
// ----------------------------------------------------------------------------

describe("AttachService.attach (P3 — client below a non-NULL floor → read-only, still joined)", () => {
  beforeEach(async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    // Floor 2.0. A client below it is admitted READ-ONLY, not rejected.
    await seedSession(ctx.querier, SESSION_A_ID, "2.0");
  });

  it("ADMITS (does not reject) a below-floor client with readOnly=true — I-003-1 never-eject", async () => {
    // The attach SUCCEEDS — it does not throw and does not reject. I-003-1 is
    // admit-in-read-only: a below-floor daemon stays joined; only its permission
    // axis is downgraded.
    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "1.5" as EventEnvelopeVersion }),
    );

    expect(response.readOnly).toBe(true);
    // State is UNCHANGED by the read-only verdict — still admitted in
    // `registering` (readOnly is orthogonal to state, never a NodeState value).
    expect(response.state).toBe("registering");
    expect(response.attachmentId).toMatch(/[0-9a-f-]{36}/i);
  });

  it("leaves the below-floor node JOINED — the row is persisted and a read path succeeds", async () => {
    await ctx.service.attach(buildAttachRequest({ clientVersion: "1.5" as EventEnvelopeVersion }));

    // "Node stays joined and reads succeed" (Plan-003 T3.3 §Step / P3): the
    // attachment row is present with the reported (below-floor) version and is
    // readable — admission persisted exactly one active row, no rejection.
    const rows = await readAttachments(ctx.querier, NODE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: SESSION_A_ID,
      state: "registering",
      client_version: "1.5",
    });
  });

  it("flags read-only for a client with the SAME major but a lower minor than the floor (1.5 < 2.0... and 1.99 < 2.0)", async () => {
    // Floor 2.0, client 1.99: same-major-lower-or-different — below the floor, so
    // read-only. Guards the minor-vs-major precedence at the service boundary.
    const response = await ctx.service.attach(
      buildAttachRequest({ clientVersion: "1.99" as EventEnvelopeVersion }),
    );

    expect(response.readOnly).toBe(true);
    expect(response.state).toBe("registering");
  });
});

// ----------------------------------------------------------------------------
// isAtOrAboveFloor — the semver-aware MAJOR.MINOR comparator, unit-tested
// directly. This is the hardened proof it is NOT lexicographic (ADR-018
// §Decision #1; api-payload-contracts.md:490): as raw strings "10.0" < "2.0"
// and "1.10" < "1.5", both WRONG — the comparator must report the opposite.
// ----------------------------------------------------------------------------

describe("isAtOrAboveFloor — semver-aware MAJOR.MINOR comparison (not lexicographic)", () => {
  it.each<readonly [clientVersion: string, floor: string, expected: boolean, why: string]>([
    // [clientVersion, floor, expected, why]
    ["2.0", "2.0", true, "equal → at floor (>= is inclusive)"],
    ["2.1", "2.0", true, "same major, higher minor → above"],
    ["2.0", "2.1", false, "same major, lower minor → below"],
    ["3.0", "2.9", true, "higher major dominates a lower minor"],
    ["10.0", "2.0", true, "MAJOR 10 > 2 — lexicographic '10.0' < '2.0' is the trap"],
    ["2.0", "10.0", false, "MAJOR 2 < 10 — symmetric trap, must be below"],
    ["1.10", "1.5", true, "MINOR 10 > 5 — lexicographic '1.10' < '1.5' is the trap"],
    ["1.5", "1.10", false, "MINOR 5 < 10 — symmetric trap, must be below"],
    ["2.0", "1.99", true, "higher major beats a much larger floor minor"],
    ["1.99", "2.0", false, "lower major loses despite a much larger own minor"],
    ["0.1", "0.0", true, "zero major boundary, higher minor → above"],
    ["0.0", "0.1", false, "zero major boundary, lower minor → below"],
  ])("isAtOrAboveFloor(%j, %j) === %s — %s", (clientVersion, floor, expected) => {
    expect(isAtOrAboveFloor(clientVersion, floor)).toBe(expected);
  });

  it("throws (fail-loud) on a malformed floor rather than silently returning a verdict", () => {
    // The floor is read from `sessions.min_client_version` via a row-shape cast,
    // not a runtime parse, and the column has NO CHECK constraint — so a
    // malformed floor is a possible data-integrity violation. A tolerant parse
    // would make NaN comparisons return false (fail-safe read-only), silently
    // MASKING the corruption as a fleet-wide read-only downgrade; the comparator
    // throws instead so the corruption surfaces (see isAtOrAboveFloor JSDoc).
    expect(() => isAtOrAboveFloor("1.0", "not-a-version")).toThrow(/MAJOR\.MINOR/);
    expect(() => isAtOrAboveFloor("1.0", "1")).toThrow(/MAJOR\.MINOR/);
    expect(() => isAtOrAboveFloor("1.0", "1.0.0")).toThrow(/MAJOR\.MINOR/);
    expect(() => isAtOrAboveFloor("1.0", "01.0")).toThrow(/MAJOR\.MINOR/);
  });

  it("throws (fail-loud) on a malformed clientVersion operand too", () => {
    expect(() => isAtOrAboveFloor("garbage", "2.0")).toThrow(/MAJOR\.MINOR/);
  });
});
