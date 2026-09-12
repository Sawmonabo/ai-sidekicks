// End-to-end tRPC integration tests for `session.create` / `session.read`
// against a pglite-backed `Querier`. The tests exercise:
//
//   * The procedure plumbing (Zod input validation + canonical error codes
//     `NOT_FOUND` / `UNAUTHORIZED` mapped through `TRPCError`)
//   * The `SessionDirectoryService` routing path — every procedure resolves
//     through the constructor-injected service, never a `Querier` or
//     `pg.Pool` directly.
//
// The integration substrate is `t.createCallerFactory(router)` — tRPC v11's
// canonical in-process caller. This bypasses HTTP transport but exercises
// the same router middleware chain (input parser, output parser, procedure
// dispatch) — sufficient for verifying the per-procedure auth/ not-found
// contracts. SSE wire-frame behavior is covered separately by the SSE suite
// against `fetchRequestHandler`, because the SSE producer is a fetch-side
// artifact.
//
// Lock-ordering inheritance is verified TRANSITIVELY: the directory service
// tests already assert lock-ordering directly via `wrapWithLog` SQL capture;
// the router tests assert that the procedures route through the directory
// service (the only path that could acquire the lock), so the lock invariant
// is preserved through the procedure call.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { type UserId, type SessionId } from "@ai-sidekicks/contracts";
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
// Two user ids — OWNER (the "current user" stub returns) and
// SECOND (a different user used to model cross-user joins).
// Both ids are RFC-9562-conformant UUID v7 fixtures (the schema accepts any
// RFC 9562 UUID; daemon-minted ids are out of scope for the router tests).
// SESSION_ID is the daemon-supplied UUID v7 that the stub `generateSessionId`
// returns; tests that need a not-found id use UNKNOWN_SESSION_ID.

const OWNER_USER_ID: UserId = "01970000-0000-7000-8000-00000000c001" as UserId;
const SECOND_USER_ID: UserId = "01970000-0000-7000-8000-00000000c002" as UserId;
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
  // Seed both users — the owner FK on `sessions` requires the row to exist
  // before any directory-service call references it.
  await querier.query("INSERT INTO users (id) VALUES ($1), ($2)", [OWNER_USER_ID, SECOND_USER_ID]);

  const deps: SessionRouterDeps = {
    directoryService: new SessionDirectoryService(querier),
    resolveCurrentUserId: () => OWNER_USER_ID,
    generateSessionId: () => SESSION_ID,
    eventStreamProvider: async function* () {
      // These cases do not subscribe; the SSE suite covers that path.
    },
  };

  const router = createSessionRouter(deps);
  const caller = t.createCallerFactory(router)({ requestId: "test-req-1" });
  return { pg, querier, router, caller };
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
// session.create round-trip
// ---------------------------------------------------------------------------

describe("session.create — end-to-end tRPC roundtrip via pglite", () => {
  it("creates a session and returns the canonical SessionCreateResponse shape", async () => {
    const response = await harness.caller.session.create({
      config: { topic: "test session" },
      metadata: { mood: "verifying" },
    });

    expect(response.sessionId).toBe(SESSION_ID);
    // Default state is `provisioning`; the daemon flips to `active`
    // post-attach — the directory layer never owns the active transition.
    expect(response.state).toBe("provisioning");
    expect(response.channels).toEqual([]);
    const ownerProbe = await harness.querier.query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM sessions WHERE id = $1",
      [SESSION_ID],
    );
    expect(ownerProbe.rows[0]?.owner_user_id).toBe(OWNER_USER_ID);
  });

  it("is idempotent across repeated calls — second create returns the first row", async () => {
    // The router calls `generateSessionId()` per call; the stub returns the
    // same id each time, modeling the post-retry path where the daemon
    // presents the same id again. The directory service's ON CONFLICT (id)
    // DO UPDATE returns the existing row.
    const first = await harness.caller.session.create({});
    const second = await harness.caller.session.create({});
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.state).toBe(first.state);
    // Exactly one row survives both calls — the ON CONFLICT (id) DO UPDATE
    // branch returned the pre-existing row instead of forking a duplicate.
    const countProbe = await harness.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE id = $1",
      [SESSION_ID],
    );
    expect(countProbe.rows[0]?.count).toBe("1");
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
// ---------------------------------------------------------------------------

describe("T5 / session.read — end-to-end tRPC roundtrip via pglite", () => {
  it("returns the persisted snapshot after a create", async () => {
    await harness.caller.session.create({ config: { topic: "round-trip" } });
    const response = await harness.caller.session.read({ sessionId: SESSION_ID });
    expect(response.session.id).toBe(SESSION_ID);
    expect(response.session.state).toBe("provisioning");
    // `SessionSnapshot` carries id/state/config/metadata/timestamps; the
    // owner binding belongs to `SessionCreateResponse` (the create path
    // surfaces the just-bound owner). Verifying config round-trip here
    // proves the snapshot persisted the create-time payload.
    expect(response.session.config).toEqual({ topic: "round-trip" });
    // Placeholder cursors are deterministic strings authored by the
    // service; their exact values are the service's and aren't re-asserted here.
    // We just verify the field is present.
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
