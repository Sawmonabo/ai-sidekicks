// P1 / P2 / P3 / P9 / P10 — AttachService behavior gates (Plan-003 Phase 3,
// T3.2 + T3.3).
//
// Spec-003 line 53 (version-floor admission) + Plan-003 §Invariants I-003-1 /
// I-003-3 / I-003-5.
//
// P1 (Spec-003 line 53): a session whose `min_client_version` floor is NULL
//     ("no floor") admits EVERY daemon version with `readOnly = false`. The
//     attachment row is created in the `registering` liveness state.
//
// P2 / P3 (Spec-003 line 53 / I-003-1, T3.3): a non-NULL floor compares the
//     daemon's `clientVersion` numerically (MAJOR.MINOR).
//     P2 (client_version >= floor) — admit read-write (`readOnly = false`).
//     P3 (client_version  < floor) — admit READ-ONLY (`readOnly = true`); the
//         node remains joined and reads succeed, never ejected (admit-not-eject).
//     Multi-digit cases ("10.0" > "2.0"; "1.9" < "1.10") guard against a lexical
//     string compare; a malformed floor is rejected at the read-time parse (it is
//     NOT silently admitted).
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
  SessionId,
} from "@ai-sidekicks/contracts";
import {
  RUNTIME_NODE_ATTACH_CONFLICT_CODE,
  RUNTIME_NODE_ATTACH_REVOKED_CODE,
} from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import { AttachService } from "../attach-service.js";
import {
  RuntimeNodeAttachConflictException,
  RuntimeNodeAttachRevokedException,
} from "../errors.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUID v7-shaped ids (the brand validators accept any RFC 9562
// UUID; real generation is daemon-side). `NODE_ID` is a daemon-minted opaque
// TEXT scalar (NOT a UUID), `CLIENT_VERSION` is the branded MAJOR.MINOR semver.
// ----------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e0001" as SessionId;
const OTHER_SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e0002" as SessionId;
const PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-0000000f0001" as ParticipantId;
const NODE_ID: NodeId = "node-alpha-01" as NodeId;
const CLIENT_VERSION: EventEnvelopeVersion = "1.4" as EventEnvelopeVersion;

// A distinctive capability map so the P1 JSONB round-trip asserts the value
// survived serialization into the JSONB column (a silent stringify bug would
// pass a state-only assertion — see advisor note).
const CAPABILITIES: Record<string, unknown> = {
  "provider-driver": { kind: "claude", streaming: true },
  maxConcurrentRuns: 3,
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

async function countAttachments(querier: Querier): Promise<number> {
  const probe = await querier.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM runtime_node_attachments",
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
// P1 — NULL-floor unconditional admission (Spec-003 line 53)
// ----------------------------------------------------------------------------

describe("AttachService — P1 (NULL-floor unconditional admission, Spec-003 line 53)", () => {
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
// P2 / P3 — version-floor comparison (Spec-003 line 53 / I-003-1)
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

describe("AttachService — P2/P3 (version-floor comparison, Spec-003 line 53 / I-003-1)", () => {
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
