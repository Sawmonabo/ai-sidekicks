// Plan-008 §Phase 1 §T-008b-1-T4..T6: end-to-end tRPC integration tests for
// `session.create` / `session.read` / `session.join` against a pglite-backed
// `Querier`. The tests exercise:
//
//   * The procedure plumbing (Zod input validation + canonical error codes
//     `NOT_FOUND` / `UNAUTHORIZED` mapped through `TRPCError`)
//   * The `SessionDirectoryService` routing path (per I-008-3 #1) — every
//     procedure resolves through the constructor-injected service, never a
//     `Querier` or `pg.Pool` directly.
//   * The Tier 1 stub semantics for `session.join`: identityHandle is a
//     ParticipantId-encoded self-handle. Cross-participant joins reject with
//     the canonical `auth.not_authorized` message-prefix until Tier 5
//     invite/presence wires Plan-002 + Plan-018.
//
// The integration substrate is `t.createCallerFactory(router)` — tRPC v11's
// canonical in-process caller. This bypasses HTTP transport but exercises
// the same router middleware chain (input parser, output parser, procedure
// dispatch) — sufficient for verifying I-008-3 + the per-procedure auth/
// not-found contracts. SSE wire-frame behavior is covered separately by
// T-008b-1-T7..T9 against `fetchRequestHandler` because the SSE producer is
// a fetch-side artifact.
//
// Lock-ordering (I-001-1) inheritance is verified TRANSITIVELY: the directory
// service tests already assert lock-ordering directly via `wrapWithLog`
// SQL capture; the router tests assert that the procedures route through
// the directory service (the only path that could acquire the lock), so
// the lock invariant is preserved through the procedure call.
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-T4..T6,
//       docs/plans/008-control-plane-relay-and-session-join.md §I-008-3 #1,
//       docs/architecture/contracts/api-payload-contracts.md §Tier 1 (Plan-008).

import { PGlite, type Transaction } from "@electric-sql/pglite";
import {
  type ParticipantId,
  type SessionId,
  type SessionJoinRequest,
} from "@ai-sidekicks/contracts";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, type Querier } from "../migration-runner.js";
import { SessionDirectoryService } from "../session-directory-service.js";
import { createSessionRouter } from "../session-router.factory.js";
import type { SessionRouterDeps } from "../session-router.js";
import { t } from "../trpc.js";

// ---------------------------------------------------------------------------
// PGlite -> Querier adapter (matches session-directory-service.test.ts)
// ---------------------------------------------------------------------------
//
// Inlined rather than extracted into a shared helper module to keep the test's
// substrate dependencies obvious from one file. If a third caller later wants
// the same adapter, lifting it then is straightforward.

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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
//
// Two participant ids — OWNER (the "current user" Tier 1 stub returns) and
// SECOND (a different participant used to model cross-participant joins).
// Both ids are RFC-9562-conformant UUID v7 fixtures (the schema accepts any
// RFC 9562 UUID; daemon-minted ids are out of scope for the router tests).
// SESSION_ID is the daemon-supplied UUID v7 that the stub `generateSessionId`
// returns; tests that need a not-found id use UNKNOWN_SESSION_ID.

const OWNER_PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-00000000c001" as ParticipantId;
const SECOND_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-00000000c002" as ParticipantId;
const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000d001" as SessionId;
const UNKNOWN_SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000d999" as SessionId;

// Build the harness via a local helper so its return type is inferred
// directly from `createSessionRouter` + `t.createCallerFactory` — that path
// preserves the procedure-record narrowing on the caller. Annotating the
// caller's type explicitly via `TRPCBuiltRouter`'s alias erases the procedure
// keys to an index signature under `noPropertyAccessFromIndexSignature`.
async function buildHarness() {
  const pg = new PGlite();
  const querier = adaptPGlite(pg);
  await applyMigrations(querier);
  // Seed both participants — the FK constraint on sessions/memberships
  // requires the row to exist before any directory-service call references it.
  await querier.query("INSERT INTO participants (id) VALUES ($1), ($2)", [
    OWNER_PARTICIPANT_ID,
    SECOND_PARTICIPANT_ID,
  ]);

  const deps: SessionRouterDeps = {
    directoryService: new SessionDirectoryService(querier),
    resolveCurrentParticipantId: () => OWNER_PARTICIPANT_ID,
    generateSessionId: () => SESSION_ID,
    // Tier 1 stub: the wire `identityHandle` IS the ParticipantId. Tier 5
    // wires Plan-018 identity service for canonical handle -> participantId
    // resolution. Returning the cast directly is the documented Tier 1 stub.
    resolveIdentityHandle: (handle) => handle as ParticipantId,
    eventStreamProvider: async function* () {
      // T4-T6 do not subscribe; T7-T9 cover SSE.
    },
  };

  const router = createSessionRouter(deps);
  const caller = t.createCallerFactory(router)({ requestId: "test-req-1" });
  return { pg, router, caller };
}

type Harness = Awaited<ReturnType<typeof buildHarness>>;

let harness: Harness;

beforeEach(async () => {
  harness = await buildHarness();
});

afterEach(async () => {
  await harness.pg.close();
});

// ---------------------------------------------------------------------------
// T-008b-1-T4: session.create round-trip
// ---------------------------------------------------------------------------

describe("T4 / session.create — end-to-end tRPC roundtrip via pglite", () => {
  it("creates a session and returns the canonical SessionCreateResponse shape", async () => {
    const response = await harness.caller.session.create({
      config: { topic: "test session" },
      metadata: { mood: "verifying" },
    });

    expect(response.sessionId).toBe(SESSION_ID);
    // Tier 1 default state is `provisioning`; the daemon flips to `active`
    // post-attach per Plan-001 PR #4 service contract — the directory layer
    // never owns the active transition.
    expect(response.state).toBe("provisioning");
    // Memberships array contains exactly the owner — the only participant
    // bound at create time per BL-069 invariant #2.
    expect(response.memberships).toHaveLength(1);
    expect(response.memberships[0]?.participantId).toBe(OWNER_PARTICIPANT_ID);
    expect(response.memberships[0]?.role).toBe("owner");
    expect(response.channels).toEqual([]);
  });

  it("is idempotent across repeated calls — second create returns the first row", async () => {
    // The router calls `generateSessionId()` per call; the stub returns the
    // same id each time (Tier 5 mints UUID v7 per call), modeling the
    // post-retry path where the daemon presents the same id again. The
    // directory service's ON CONFLICT (id) DO UPDATE returns the existing row.
    const first = await harness.caller.session.create({});
    const second = await harness.caller.session.create({});
    expect(second.sessionId).toBe(first.sessionId);
    // `MembershipSummary.id` is the canonical membership identifier (the
    // service column is `memberships.id`); the wire field follows that name
    // verbatim. Verifying it round-trips equal across two creates proves the
    // ON CONFLICT (session_id, participant_id) DO UPDATE branch returned the
    // pre-existing row instead of silently inserting a duplicate.
    expect(second.memberships[0]?.id).toBe(first.memberships[0]?.id);
  });

  it("rejects malformed input (Zod validation surfaces as TRPCError BAD_REQUEST)", async () => {
    // `config` and `metadata` must be objects-of-unknown-or-omitted. A string
    // value violates the schema; tRPC v11 surfaces parse failures as
    // BAD_REQUEST so the wire client receives a typed error envelope. The
    // cast on the inner field — narrower than casting the whole input —
    // drives the runtime parse path while keeping the outer typing honest.
    const malformed = {
      config: "not-an-object" as unknown as Record<string, unknown>,
    };
    await expect(harness.caller.session.create(malformed)).rejects.toMatchObject({
      // tRPCError exposes a `code` getter; we match on the canonical
      // TRPC_ERROR_CODE_KEY rather than on the wire-side numeric to keep
      // the test version-resilient.
      code: "BAD_REQUEST",
    });
  });
});

// ---------------------------------------------------------------------------
// T-008b-1-T5: session.read round-trip
// ---------------------------------------------------------------------------

describe("T5 / session.read — end-to-end tRPC roundtrip via pglite", () => {
  it("returns the persisted snapshot after a create", async () => {
    await harness.caller.session.create({ config: { topic: "round-trip" } });
    const response = await harness.caller.session.read({ sessionId: SESSION_ID });
    expect(response.session.id).toBe(SESSION_ID);
    expect(response.session.state).toBe("provisioning");
    // `SessionSnapshot` carries id/state/config/metadata/timestamps; the
    // membership list belongs to `SessionCreateResponse` (the create path
    // surfaces the just-bound owner). Verifying config round-trip here
    // proves the snapshot persisted the create-time payload.
    expect(response.session.config).toEqual({ topic: "round-trip" });
    // Tier 1 placeholder cursors are deterministic strings authored by the
    // service; their exact values are owned by Plan-001 PR #4 and aren't
    // re-asserted here. We just verify the field is present.
    expect(typeof response.timelineCursors.latest).toBe("string");
  });

  it("throws TRPCError NOT_FOUND for an unknown sessionId", async () => {
    // Without a prior create, the read path returns `null` from the directory
    // service; the procedure body translates that to TRPCError({code: "NOT_FOUND"}).
    let caught: TRPCError | undefined;
    try {
      await harness.caller.session.read({ sessionId: UNKNOWN_SESSION_ID });
    } catch (err) {
      // tRPC's caller surfaces TRPCError instances directly; instanceof works.
      if (err instanceof TRPCError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe("NOT_FOUND");
    // The error message names the missing session id so callers can log
    // a single line and trace from operator dashboards.
    expect(caught?.message).toContain(UNKNOWN_SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// T-008b-1-T6: session.join Tier 1 stub semantics
// ---------------------------------------------------------------------------

describe("T6 / session.join — Tier 1 stub semantics (self-only)", () => {
  it("succeeds for a self-join (identityHandle resolves to currentParticipantId)", async () => {
    await harness.caller.session.create({});
    const request: SessionJoinRequest = {
      sessionId: SESSION_ID,
      identityHandle: OWNER_PARTICIPANT_ID,
    };
    const response = await harness.caller.session.join(request);
    expect(response.sessionId).toBe(SESSION_ID);
    expect(response.participantId).toBe(OWNER_PARTICIPANT_ID);
    // The owner-membership row was created at session-create time; the join
    // returns its existing membershipId (no silent fork per BL-069 invariant).
    expect(typeof response.membershipId).toBe("string");
  });

  it("rejects a cross-participant join with auth.not_authorized (Tier 1: non-self joins deferred)", async () => {
    await harness.caller.session.create({});
    const crossParticipantRequest: SessionJoinRequest = {
      sessionId: SESSION_ID,
      identityHandle: SECOND_PARTICIPANT_ID,
    };
    let caught: TRPCError | undefined;
    try {
      await harness.caller.session.join(crossParticipantRequest);
    } catch (err) {
      if (err instanceof TRPCError) caught = err;
    }
    expect(caught?.code).toBe("UNAUTHORIZED");
    expect(caught?.message).toContain("auth.not_authorized");
  });

  it("rejects an unresolvable identityHandle with auth.not_authorized", async () => {
    // Override the resolver to return null — the canonical Tier 5 path for
    // a handle Plan-018 cannot resolve. Procedure body must surface this
    // as UNAUTHORIZED, not 500.
    const router = createSessionRouter({
      directoryService: new SessionDirectoryService(adaptPGlite(harness.pg)),
      resolveCurrentParticipantId: () => OWNER_PARTICIPANT_ID,
      generateSessionId: () => SESSION_ID,
      resolveIdentityHandle: () => null,
      eventStreamProvider: async function* () {},
    });
    const caller = t.createCallerFactory(router)({ requestId: "test-req-2" });

    let caught: TRPCError | undefined;
    try {
      await caller.session.join({
        sessionId: SESSION_ID,
        identityHandle: "any-handle",
      });
    } catch (err) {
      if (err instanceof TRPCError) caught = err;
    }
    expect(caught?.code).toBe("UNAUTHORIZED");
    expect(caught?.message).toContain("auth.not_authorized");
  });

  it("returns NOT_FOUND when joining a non-existent session (post-auth check)", async () => {
    // Auth resolves first (self-handle), then the service probes for the
    // session. Probe miss returns null, procedure body surfaces NOT_FOUND.
    let caught: TRPCError | undefined;
    try {
      await harness.caller.session.join({
        sessionId: UNKNOWN_SESSION_ID,
        identityHandle: OWNER_PARTICIPANT_ID,
      });
    } catch (err) {
      if (err instanceof TRPCError) caught = err;
    }
    expect(caught?.code).toBe("NOT_FOUND");
    expect(caught?.message).toContain(UNKNOWN_SESSION_ID);
  });
});
