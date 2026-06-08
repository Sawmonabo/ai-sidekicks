// Plan-003 §Phase 3 §T3.8: router-level tRPC tests for the runtime-node sibling
// router (`runtimenode.attach` / `.heartbeat` / `.capabilityupdate` / `.detach`)
// against a pglite-backed `Querier`. These pin the NEW transport wiring that no
// service test covers:
//
//   * Mounting — every procedure resolves under the `runtimenode.*` namespace
//     (the sibling-router composition) with input -> backing service -> output
//     routing intact.
//   * The void->null mapping (heartbeat) and the already-`null` passthrough
//     (detach) at the wire boundary.
//   * The catch-arms that map the two services' typed exceptions to tRPC
//     `CONFLICT` (HTTP 409): the attach conflict + revoked refusals and the
//     capability-update refusal. The services already test the typed throwables
//     directly (attach-service.test.ts); these tests assert ONLY the
//     transport-layer code translation, which is T3.8's sole new behavior.
//
// REAL services over PGlite (not a structural stub): `RuntimeNodeRouterDeps`
// holds the concrete `AttachService` / `HeartbeatService` classes (nominal,
// private `#querier`), which a structural stub cannot satisfy without a cast —
// exactly why `session-router.test.ts` drives the real `SessionDirectoryService`
// over PGlite. The harness mirrors `attach-service.test.ts` (migrations +
// `adaptPGlite` + the two services) and `session-router.test.ts`'s
// `t.createCallerFactory(router)` in-process caller. The PGlite->Querier adapter
// is a LOCAL copy (sibling tests each carry their own — the dispatch contract
// forbids exporting a shared test fixture from `packages/control-plane/`).
//
// Refs: docs/plans/003-runtime-node-attach.md §T3.8, ADR-014.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  EventEnvelopeVersion,
  NodeId,
  ParticipantId,
  RuntimeNodeAttachRequest,
  SessionId,
} from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import { t } from "../../sessions/trpc.js";
import { AttachService } from "../attach-service.js";
import { VersionFloorExceededException } from "../errors.js";
import { HeartbeatService } from "../heartbeat-service.js";
import { createRuntimeNodeRouter } from "../runtime-node-router.factory.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUID v7-shaped ids (the brand validators accept any RFC 9562
// UUID; real generation is daemon-side). `NODE_ID` is a daemon-minted opaque
// TEXT scalar (NOT a UUID); `CLIENT_VERSION` is the branded MAJOR.MINOR semver.
// ----------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e0001" as SessionId;
const OTHER_SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e0002" as SessionId;
const PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-0000000f0001" as ParticipantId;
const NODE_ID: NodeId = "node-alpha-01" as NodeId;
const CLIENT_VERSION: EventEnvelopeVersion = "1.4" as EventEnvelopeVersion;

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
// PGlite -> Querier adapter (local copy — mirrors attach-service.test.ts `wrap`).
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
// Seed helpers (bypass the services to set up starting states the router then
// exercises — mirrors attach-service.test.ts).
// ----------------------------------------------------------------------------

async function seedParticipant(querier: Querier, participantId: ParticipantId): Promise<void> {
  await querier.query("INSERT INTO participants (id) VALUES ($1)", [participantId]);
}

async function seedSession(
  querier: Querier,
  sessionId: SessionId,
  minClientVersion?: string,
): Promise<void> {
  // No min_client_version => NULL floor ("no floor") — the default for the
  // transport-mounting tests, whose focus is mounting not the floor verdict. A
  // supplied floor seeds the version-floor write-refusal catch-arm test.
  if (minClientVersion === undefined) {
    await querier.query("INSERT INTO sessions (id, state) VALUES ($1, 'active')", [sessionId]);
    return;
  }
  await querier.query(
    "INSERT INTO sessions (id, state, min_client_version) VALUES ($1, 'active', $2)",
    [sessionId, minClientVersion],
  );
}

async function seedAttachment(
  querier: Querier,
  args: {
    sessionId: SessionId;
    participantId: ParticipantId;
    nodeId: NodeId;
    state: string;
    clientVersion?: string;
  },
): Promise<void> {
  await querier.query(
    `INSERT INTO runtime_node_attachments
       (session_id, participant_id, node_id, capabilities, client_version, state)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [args.sessionId, args.participantId, args.nodeId, {}, args.clientVersion ?? "1.0", args.state],
  );
}

// ----------------------------------------------------------------------------
// Per-test harness — build the caller via a local helper so its return type is
// inferred from `createRuntimeNodeRouter` + `t.createCallerFactory` (annotating
// the caller with `RuntimeNodeRouter` would erase the procedure keys to an index
// signature under `noPropertyAccessFromIndexSignature` — see
// session-router.test.ts).
// ----------------------------------------------------------------------------

async function buildHarness() {
  const pg = new PGlite();
  const querier = adaptPGlite(pg);
  await applyMigrations(querier);

  const router = createRuntimeNodeRouter({
    attachService: new AttachService(querier),
    heartbeatService: new HeartbeatService(querier),
  });
  const caller = t.createCallerFactory(router)({ requestId: "test-rn-1" });
  return { pg, querier, caller };
}

type Harness = Awaited<ReturnType<typeof buildHarness>>;

let harness: Harness;

beforeEach(async () => {
  harness = await buildHarness();
});

afterEach(async () => {
  await harness.pg.close();
});

// ----------------------------------------------------------------------------
// Happy-path mounting — proves each procedure mounts under runtimenode.* and
// routes input -> service -> output.
// ----------------------------------------------------------------------------

describe("runtime-node router — happy-path mounting (T3.8)", () => {
  it("runtimenode.attach mounts and resolves with the attach response (input -> service -> output)", async () => {
    await seedParticipant(harness.querier, PARTICIPANT_ID);
    await seedSession(harness.querier, SESSION_ID);

    const response = await harness.caller.runtimenode.attach(buildAttachRequest());

    // The procedure mounts under `runtimenode.*` and the response is the attach
    // projection (a NULL-floor fresh attach: read-write, registering).
    expect(response.state).toBe("registering");
    expect(response.readOnly).toBe(false);
    expect(response.attachmentId).toMatch(/[0-9a-f-]{36}/i);
    expect(typeof response.attachedAt).toBe("string");
  });

  it("runtimenode.heartbeat mounts and resolves to null (void -> null wire mapping)", async () => {
    // No seeding needed: the first heartbeat upserts the presence row. The wire
    // contract is `RuntimeNodeHeartbeatResponseSchema = z.null()`; the router
    // maps the service's `void` to `null`.
    const response = await harness.caller.runtimenode.heartbeat({
      nodeId: NODE_ID,
      healthState: "online",
    });

    expect(response).toBeNull();
  });

  it("runtimenode.detach mounts and resolves to null for a never-attached node (idempotent no-op routing)", async () => {
    // Detach is a clean idempotent no-op when there is no active attachment —
    // it resolves to `null` (`RuntimeNodeDetachResponseSchema = z.null()`),
    // proving the procedure mounts and routes the no-op through the service.
    const response = await harness.caller.runtimenode.detach({ nodeId: NODE_ID });

    expect(response).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Catch-arms — the typed service exceptions map to tRPC CONFLICT (HTTP 409).
// This is T3.8's sole NEW behavior (the services raise the typed throwables; the
// router translates them at the transport boundary).
// ----------------------------------------------------------------------------

describe("runtime-node router — typed exception -> CONFLICT (T3.8 catch-arms)", () => {
  it("runtimenode.attach maps the cross-session conflict (RuntimeNodeAttachConflictException) to CONFLICT", async () => {
    await seedParticipant(harness.querier, PARTICIPANT_ID);
    await seedSession(harness.querier, SESSION_ID);
    await seedSession(harness.querier, OTHER_SESSION_ID);
    // The node already holds an ACTIVE attachment in ANOTHER session — the
    // partial-unique idx_node_attachments_active raises 23505, which the service
    // translates to the typed conflict; the router maps it to tRPC CONFLICT.
    await seedAttachment(harness.querier, {
      sessionId: OTHER_SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
    });

    let caught: TRPCError | undefined;
    try {
      await harness.caller.runtimenode.attach(buildAttachRequest());
    } catch (err) {
      if (err instanceof TRPCError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe("CONFLICT");
    // No-info-leak survives the transport hop: the message names the node id,
    // never the OTHER session.
    expect(caught?.message).toContain(String(NODE_ID));
    expect(caught?.message).not.toContain(String(OTHER_SESSION_ID));
  });

  it("runtimenode.attach maps the revoked-row refusal (RuntimeNodeAttachRevokedException) to CONFLICT", async () => {
    await seedParticipant(harness.querier, PARTICIPANT_ID);
    await seedSession(harness.querier, SESSION_ID);
    // The node's attachment for THIS session is in the terminal `revoked` state;
    // re-attach is refused with the typed revoked exception (the distinct
    // exception branch in the attach catch-arm) -> tRPC CONFLICT.
    await seedAttachment(harness.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "revoked",
    });

    let caught: TRPCError | undefined;
    try {
      await harness.caller.runtimenode.attach(buildAttachRequest());
    } catch (err) {
      if (err instanceof TRPCError) caught = err;
    }
    expect(caught?.code).toBe("CONFLICT");
    expect(caught?.message).toContain(String(NODE_ID));
  });

  it("runtimenode.capabilityupdate maps the no-active-attachment refusal to CONFLICT (also proves the 4th procedure mounts)", async () => {
    await seedParticipant(harness.querier, PARTICIPANT_ID);
    await seedSession(harness.querier, SESSION_ID);
    // No active attachment for the node -> the service throws
    // RuntimeNodeCapabilityUpdateConflictException, which the capabilityupdate
    // catch-arm maps to tRPC CONFLICT. This also exercises the all-lowercase
    // `capabilityupdate` procedure key mounting under runtimenode.*.

    let caught: TRPCError | undefined;
    try {
      await harness.caller.runtimenode.capabilityupdate({
        nodeId: NODE_ID,
        capabilities: CAPABILITIES,
      });
    } catch (err) {
      if (err instanceof TRPCError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe("CONFLICT");
    expect(caught?.message).toContain(String(NODE_ID));
  });

  it("runtimenode.capabilityupdate maps the below-floor write-refusal (VersionFloorExceededException) to CONFLICT", async () => {
    // The version-floor write-refusal catch-arm (T3.4): a below-floor (read-only)
    // node's capability WRITE is refused with VersionFloorExceededException,
    // which the capabilityupdate catch-arm maps to tRPC CONFLICT (HTTP 409 per
    // error-contracts.md §Version) ALONGSIDE the capability-update conflict. A
    // floored session (floor 2.0) holds the node's active attachment at a
    // below-floor client_version (1.0) — the read-only verdict the gate
    // re-derives at write time.
    await seedParticipant(harness.querier, PARTICIPANT_ID);
    await seedSession(harness.querier, SESSION_ID, "2.0");
    await seedAttachment(harness.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
      clientVersion: "1.0",
    });

    let caught: TRPCError | undefined;
    try {
      await harness.caller.runtimenode.capabilityupdate({
        nodeId: NODE_ID,
        capabilities: CAPABILITIES,
      });
    } catch (err) {
      if (err instanceof TRPCError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe("CONFLICT");
    // The typed exception is preserved on `.cause` (what the shared
    // errorFormatter projects onto `shape.data.aisError`) — pins that the
    // floor-refusal arm sets the RIGHT cause, distinct from the conflict family.
    expect(caught?.cause).toBeInstanceOf(VersionFloorExceededException);
    // No-info-leak survives the transport hop: the message carries the node id +
    // the caller-legitimate version context.
    expect(caught?.message).toContain(String(NODE_ID));
  });
});

// ----------------------------------------------------------------------------
// Raw rethrow — a NON-typed service error propagates untranslated. The catch-arm
// discriminates by `instanceof`: only the typed exceptions become CONFLICT;
// everything else is rethrown so tRPC wraps it as INTERNAL_SERVER_ERROR. This
// pins that the catch-arm does NOT blanket-wrap (mirrors attach-service.test.ts's
// "does NOT translate a session_id FK violation (23503)").
// ----------------------------------------------------------------------------

describe("runtime-node router — non-typed error rethrows raw (T3.8 catch-arm discriminates)", () => {
  it("runtimenode.attach rethrows a raw session_id FK violation (23503) as INTERNAL_SERVER_ERROR, NOT CONFLICT", async () => {
    // Seed the participant but DELIBERATELY NOT the session: the NULL-floor read
    // tolerates a missing session (no row -> floor = null, no throw), then the
    // INSERT violates the `session_id` FK with SQLSTATE 23503 — an error the
    // service does NOT translate to a typed exception. The catch-arm's
    // `instanceof` guards both miss, so `throw err` rethrows it raw and tRPC
    // wraps it as INTERNAL_SERVER_ERROR.
    await seedParticipant(harness.querier, PARTICIPANT_ID);

    let caught: TRPCError | undefined;
    try {
      await harness.caller.runtimenode.attach(buildAttachRequest());
    } catch (err) {
      if (err instanceof TRPCError) caught = err;
    }

    expect(caught).toBeDefined();
    // The discriminating assertion: a raw error becomes INTERNAL_SERVER_ERROR,
    // NOT CONFLICT — proving the catch-arm keys on `instanceof`, not a blanket
    // catch-all that would mis-label every failure as a 409 conflict.
    expect(caught?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(caught?.code).not.toBe("CONFLICT");
    // Positively pin the SQLSTATE on the wrapped cause (tRPC sets `.cause` to the
    // original throwable) so this proves the error reached the INSERT and rethrew
    // the FK violation specifically — not some unrelated Error escaping earlier
    // (a setup/seed failure would also surface as INTERNAL_SERVER_ERROR and
    // false-pass the code check alone). Mirrors attach-service.test.ts:566-569.
    expect(caught?.cause).toMatchObject({ code: "23503" });
  });
});
