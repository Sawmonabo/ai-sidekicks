// Plan-003 §T3.8 + §T3.4: runtime-node procedures resolve through the MERGED
// host, AND the shared errorFormatter projects their typed refusals onto the
// wire `error.data.aisError` envelope.
//
// The standalone caller tests (runtime-node-router.test.ts) drive
// `createRuntimeNodeRouter` directly via `t.createCallerFactory`, which bypasses
// the production composition at host.ts: `t.mergeRouters(createSessionRouter,
// createRuntimeNodeRouter)` behind `buildControlPlaneFetchHandler` +
// `fetchRequestHandler`. The session side of that merge is runtime-proven by
// sse-retry-prefix.test.ts (it dispatches `session.subscribe` through the
// handler); this test closes the symmetric gap for `runtimenode.*`.
//
// The mounting dispatch is a single end-to-end call and intentional: a 200 at
// `/trpc/runtimenode.heartbeat` is reachable ONLY if the flat sibling merge
// mounted the procedure at that path. A regression that re-nested the
// runtime-node router (or dropped it from the merge) would surface here as a
// 404 — every standalone caller test would still pass.
//
// The errorFormatter-projection dispatches are the ONLY tests in the suite that
// observe the wire `error.data.aisError` envelope: `errorFormatter` runs in
// tRPC's HTTP/adapter path (`getErrorShape`), NOT in the in-process
// `createCallerFactory` the caller tests use, so the envelope is unobservable
// there. They close the T3.8 deferral — proving the formatter, collapsed onto a
// single `AisWireException` base `instanceof` (T3.4), projects EVERY subclass
// uniformly (each previously only set `cause` with no per-class formatter branch).
//
// Coverage is deliberately whole-family: the `AisWireException` base
// (../../ais-wire-exception.ts) has exactly FIVE concrete subclasses, and the
// HTTP path exercises all five here —
//   * the four runtime-node refusals (all code+message-only — `aisError` carries
//     NO `details` key): `VersionFloorExceededException`,
//     `RuntimeNodeAttachConflictException`, `RuntimeNodeAttachRevokedException`,
//     and `RuntimeNodeCapabilityUpdateConflictException`; and
//   * the session-domain `ResourceLimitExceededException` — the ONLY subclass
//     carrying structured `details`, so its `aisError` MUST include the
//     `{resource, limit, current}` payload (the formatter's
//     `cause.details !== undefined` TRUE branch, exercised on the wire here and
//     nowhere else).
// This guards the invisible-regression class the in-process caller tests cannot:
// a revert of any subclass to `extends Error`, or a dropped `cause` in a catch-
// arm, would silently delete that refusal's `aisError` envelope while every
// caller test still passed.
//
// Refs: docs/plans/003-runtime-node-attach.md §T3.8 + §T3.4, ADR-014, ADR-018
//       §Decision #4, Spec-003 line 130, Spec-001 §Limit Enforcement,
//       error-contracts.md §Runtime Node + §Version,
//       packages/control-plane/src/server/host.ts (the t.mergeRouters
//       composition), ../../ais-wire-exception.ts (the base — the formatter
//       match-type + the five-subclass family).

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import type { NodeId, ParticipantId, SessionId } from "@ai-sidekicks/contracts";
import {
  RESOURCE_LIMIT_EXCEEDED_CODE,
  RUNTIME_NODE_ATTACH_CONFLICT_CODE,
  RUNTIME_NODE_ATTACH_REVOKED_CODE,
  RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE,
  VERSION_FLOOR_EXCEEDED_CODE,
} from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import { buildControlPlaneFetchHandler, type ControlPlaneEnv } from "../host.js";
import { makePassThroughDeps } from "./_helpers.js";

// Gate-passing env — mirrors the dual-gate shape the existing handler
// integration tests use (sse-retry-prefix.test.ts PASSING_ENV).
const PASSING_ENV: ControlPlaneEnv = {
  CONTROL_PLANE_BOOTSTRAP_ENABLED: "1",
  ENVIRONMENT: "development",
};

// Session-side ids required by PassThroughDepsConfig. The heartbeat path never
// reads them (no session/participant FK on `runtime_node_presence`), but the
// config type requires them; UUID v7-shaped values satisfy the brand validators.
const CURRENT_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-0000000f0001" as ParticipantId;
const NEXT_SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e0001" as SessionId;

// Ids for the errorFormatter-projection dispatches (the attach / capabilityupdate
// / join refusals seed real attachment + membership rows). `SESSION_ID` reuses
// `NEXT_SESSION_ID`; `NODE_ID` is a daemon-minted opaque TEXT scalar (not a UUID).
const SESSION_ID: SessionId = NEXT_SESSION_ID;
const PARTICIPANT_ID: ParticipantId = CURRENT_PARTICIPANT_ID;
const NODE_ID: NodeId = "node-alpha-01" as NodeId;

// A second session id for the attach cross-session-conflict projection: the node
// holds an ACTIVE attachment HERE, so a `runtimenode.attach` to `SESSION_ID`
// trips the single-active-attachment refusal (I-003-5).
const OTHER_SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e0002" as SessionId;

// Ten participant ids (none equal to `CURRENT_PARTICIPANT_ID`) that fill a
// session to the default participants-per-session cap of 10. The 11th joiner —
// `CURRENT_PARTICIPANT_ID`, a NEW participant the self-resolver admits — trips
// `ResourceLimitExceededException` (the details-carrying projection, test 3).
const TEN_CAP_FILLING_PARTICIPANT_IDS: ReadonlyArray<ParticipantId> = [
  "01970000-0000-7000-8000-0000000f0011" as ParticipantId,
  "01970000-0000-7000-8000-0000000f0012" as ParticipantId,
  "01970000-0000-7000-8000-0000000f0013" as ParticipantId,
  "01970000-0000-7000-8000-0000000f0014" as ParticipantId,
  "01970000-0000-7000-8000-0000000f0015" as ParticipantId,
  "01970000-0000-7000-8000-0000000f0016" as ParticipantId,
  "01970000-0000-7000-8000-0000000f0017" as ParticipantId,
  "01970000-0000-7000-8000-0000000f0018" as ParticipantId,
  "01970000-0000-7000-8000-0000000f0019" as ParticipantId,
  "01970000-0000-7000-8000-0000000f001a" as ParticipantId,
];

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy — mirrors runtime-node-router.test.ts
// `wrap`; sibling tests each carry their own per the no-shared-fixture rule).
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

// The tRPC v11 HTTP mutation wire shape this package emits (no transformer, no
// batching): POST `/trpc/<proc>` with `Content-Type: application/json` and the
// raw input JSON as the body. Verbatim form from the SDK's proven dispatch at
// packages/client-sdk/src/sessionClient.ts:364-369.
function buildHeartbeatRequest(): Request {
  return new Request("https://control-plane.test/trpc/runtimenode.heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId: "node-alpha-01", healthState: "online" }),
  });
}

// A `runtimenode.capabilityupdate` POST (same wire form as the heartbeat
// request above). `capabilities` is the required full-replacement set.
function buildCapabilityUpdateRequest(): Request {
  return new Request("https://control-plane.test/trpc/runtimenode.capabilityupdate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodeId: String(NODE_ID),
      capabilities: { "provider-driver": "claude" },
    }),
  });
}

// A `runtimenode.attach` POST (same wire form as above). The attach refusals
// (cross-session conflict, terminal revoked re-attach) are driven through this
// to observe their `aisError` projection on the wire. `CLIENT_VERSION` is at the
// default NULL floor (the conflict/revoked refusals precede any floor check).
function buildAttachRequest(): Request {
  return new Request("https://control-plane.test/trpc/runtimenode.attach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: String(SESSION_ID),
      participantId: String(PARTICIPANT_ID),
      nodeId: String(NODE_ID),
      clientVersion: "1.4",
      capabilities: { "provider-driver": "claude" },
      healthState: "online",
    }),
  });
}

// A `session.join` POST (same no-transformer/no-batching wire form). The
// `identityHandle` is the wire-encoded ParticipantId the default
// `makePassThroughDeps` self-resolver maps back to a `ParticipantId`; the join
// handler admits it only when it equals `resolveCurrentParticipantId` (so the
// joiner here is `CURRENT_PARTICIPANT_ID`). This drives the session-domain
// `ResourceLimitExceededException` onto the wire to observe its details-carrying
// `aisError` projection.
function buildJoinRequest(sessionId: SessionId, identityHandle: ParticipantId): Request {
  return new Request("https://control-plane.test/trpc/session.join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: String(sessionId),
      identityHandle: String(identityHandle),
    }),
  });
}

// Seed helpers for the projection dispatches — bypass the services to set up the
// rows the capabilityupdate refusals exercise (mirrors runtime-node-router.test.ts).
async function seedParticipant(querier: Querier, participantId: ParticipantId): Promise<void> {
  await querier.query("INSERT INTO participants (id) VALUES ($1)", [participantId]);
}

// Seed a session with NO floor (NULL `min_client_version`) — the attach
// conflict/revoked refusals and the participant-cap test do not exercise the
// floor, so the default-no-floor session is the minimal precondition.
async function seedSession(querier: Querier, sessionId: SessionId): Promise<void> {
  await querier.query("INSERT INTO sessions (id, state) VALUES ($1, 'active')", [sessionId]);
}

// Seed an ACTIVE membership row directly (bypassing joinSession) to fill a
// session toward the participants-per-session cap for the resource-limit test.
async function seedMembership(
  querier: Querier,
  sessionId: SessionId,
  participantId: ParticipantId,
): Promise<void> {
  await querier.query(
    `INSERT INTO session_memberships (session_id, participant_id, role, state, joined_at)
     VALUES ($1, $2, 'collaborator', 'active', now())`,
    [sessionId, participantId],
  );
}

// Seed a session with an explicit `min_client_version` floor (the floored
// session the below-floor write-refusal needs).
async function seedFlooredSession(
  querier: Querier,
  sessionId: SessionId,
  minClientVersion: string,
): Promise<void> {
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
    clientVersion: string;
  },
): Promise<void> {
  await querier.query(
    `INSERT INTO runtime_node_attachments
       (session_id, participant_id, node_id, capabilities, client_version, state)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [args.sessionId, args.participantId, args.nodeId, {}, args.clientVersion, args.state],
  );
}

// The tRPC v11 HTTP error envelope (no transformer, no batching): a non-2xx
// dispatch returns `{ error: { message, code, data: { code, httpStatus, path,
// ...errorFormatter additions } } }`. The shared `errorFormatter` appends
// `aisError` under `data` — empirically the projection lands at
// `body.error.data.aisError`. This narrow accessor type pins that path so a
// formatter regression (wrong nesting, dropped projection) surfaces as a typed
// read miss rather than a silent `undefined`.
interface WireErrorEnvelope {
  error?: {
    data?: {
      httpStatus?: number;
      aisError?: { code?: string; message?: string; details?: unknown };
    };
  };
}

let pg: PGlite;
let handler: ReturnType<typeof buildControlPlaneFetchHandler>;

beforeEach(async () => {
  pg = new PGlite();
  const querier = adaptPGlite(pg);
  await applyMigrations(querier);
  handler = buildControlPlaneFetchHandler(
    makePassThroughDeps({
      querier,
      currentParticipantId: CURRENT_PARTICIPANT_ID,
      nextSessionId: NEXT_SESSION_ID,
    }),
  );
});

afterEach(async () => {
  await pg.close();
});

describe("merged host — runtimenode.* resolves through t.mergeRouters (T3.8)", () => {
  it("dispatches runtimenode.heartbeat through buildControlPlaneFetchHandler and returns 200 + null", async () => {
    // First-beat upsert needs no seeding — `runtime_node_presence.node_id` is a
    // bare TEXT PK (no FK), so ingest succeeds standalone (see
    // heartbeat-service.test.ts:182).
    const response = await handler(buildHeartbeatRequest(), PASSING_ENV);

    // Status first: a 404 (procedure not mounted by the merge) or a 503 (gate
    // refusal) would make the body parse throw an opaque error; the status
    // assertion fails cleanly and names the failure mode. A 200 here is only
    // reachable if the flat sibling merge mounted `runtimenode.heartbeat`.
    expect(response.status).toBe(200);

    // The wire success envelope is `{ result: { data: <output> } }` (no
    // transformer — see sessionClient.ts:404-410). The heartbeat output schema
    // is `z.null()`, so `result.data` is `null`. Read `.result.data`
    // specifically (tRPC may carry sibling metadata on `result`).
    const body = (await response.json()) as { result?: { data?: unknown } };
    expect(body.result?.data).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// errorFormatter projection — the AisWireException base covers all FIVE
// subclasses via the HTTP path (T3.4; closes the T3.8 deferral).
// ----------------------------------------------------------------------------
//
// These are the only suite tests that observe the wire `error.data.aisError`
// envelope — `errorFormatter` runs in the HTTP/adapter path, not the in-process
// caller. They prove the formatter (collapsed onto a single `AisWireException`
// base `instanceof` in T3.4) projects EVERY concrete subclass uniformly, across
// both projection branches:
//   * the four runtime-node refusals (the `cause.details === undefined` branch —
//     `aisError` carries NO `details`): the version-floor write-refusal, the
//     attach cross-session conflict, the attach revoked-row refusal, and the
//     capability-update conflict; and
//   * the session-domain `ResourceLimitExceededException` (the
//     `cause.details !== undefined` branch — `aisError` MUST carry the
//     `{resource, limit, current}` payload), the ONLY subclass with structured
//     details, exercised on the wire here and nowhere else.
// Each subclass previously only set `cause` with no per-class formatter branch;
// a revert of any to `extends Error` (or a dropped catch-arm `cause`) would
// silently delete its `aisError` envelope while every in-process caller test
// still passed — exactly the invisible regression these dispatches guard.

describe("errorFormatter projection — AisWireException base covers all subtypes via the HTTP path (T3.4)", () => {
  it("projects version.floor_exceeded as {code, message} (no details) for a below-floor write", async () => {
    // A floored session (floor 2.0) holds the node's active attachment at a
    // below-floor client_version (1.0): the read-only verdict the write-gate
    // re-derives. The capability WRITE is refused with the typed
    // VersionFloorExceededException, which the catch-arm maps to CONFLICT and the
    // shared formatter projects onto error.data.aisError (Spec-003 line 130 /
    // ADR-018 §Decision #4 / I-003-1).
    const querier = adaptPGlite(pg);
    await seedParticipant(querier, PARTICIPANT_ID);
    await seedFlooredSession(querier, SESSION_ID, "2.0");
    await seedAttachment(querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
      clientVersion: "1.0",
    });

    const response = await handler(buildCapabilityUpdateRequest(), PASSING_ENV);

    // HTTP 409 (error-contracts.md §Version row).
    expect(response.status).toBe(409);
    const body = (await response.json()) as WireErrorEnvelope;
    expect(body.error?.data?.httpStatus).toBe(409);

    // The projection: the version-floor code + a message, and CRUCIALLY no
    // `details` key (this surface is code+message-only — the one-sided session
    // floor cannot populate the two-sided VersionBoundExceededDetails schema).
    const aisError = body.error?.data?.aisError;
    expect(aisError).toBeDefined();
    expect(aisError?.code).toBe(VERSION_FLOOR_EXCEEDED_CODE);
    expect(typeof aisError?.message).toBe("string");
    expect(aisError?.message).toContain(String(NODE_ID));
    expect(aisError).not.toHaveProperty("details");
  });

  it("projects runtimenode.capabilityupdate_conflict as {code, message} (no details) — the T3.8-deferred sibling now projects via the base", async () => {
    // A sibling runtime-node refusal proves the T3.8-deferred projection is now
    // LIVE for the whole family (not just version-floor): a capability update
    // against a node with NO active attachment throws
    // RuntimeNodeCapabilityUpdateConflictException, which now projects onto
    // error.data.aisError via the shared AisWireException base `instanceof` (it
    // previously only set `cause` with no formatter branch). No seeding -> no
    // active attachment.
    const response = await handler(buildCapabilityUpdateRequest(), PASSING_ENV);

    expect(response.status).toBe(409);
    const body = (await response.json()) as WireErrorEnvelope;
    expect(body.error?.data?.httpStatus).toBe(409);

    const aisError = body.error?.data?.aisError;
    expect(aisError).toBeDefined();
    expect(aisError?.code).toBe(RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE);
    expect(typeof aisError?.message).toBe("string");
    expect(aisError?.message).toContain(String(NODE_ID));
    expect(aisError).not.toHaveProperty("details");
  });

  it("projects runtime_node.attach_conflict as {code, message} (no details) for a cross-session active attach", async () => {
    // The node already holds an ACTIVE attachment in ANOTHER session: the
    // partial-unique idx_node_attachments_active raises 23505, which the service
    // translates to the typed RuntimeNodeAttachConflictException (I-003-5). The
    // attach catch-arm maps it to CONFLICT and the shared formatter projects it.
    // This is the in-process router test's attach-conflict assertion
    // (runtime-node-router.test.ts:305-331) re-run on the HTTP path — the only
    // surface where `aisError` is observable.
    const querier = adaptPGlite(pg);
    await seedParticipant(querier, PARTICIPANT_ID);
    await seedSession(querier, SESSION_ID);
    await seedSession(querier, OTHER_SESSION_ID);
    await seedAttachment(querier, {
      sessionId: OTHER_SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "online",
      clientVersion: "1.4",
    });

    const response = await handler(buildAttachRequest(), PASSING_ENV);

    // HTTP 409 (error-contracts.md §Runtime Node row).
    expect(response.status).toBe(409);
    const body = (await response.json()) as WireErrorEnvelope;
    expect(body.error?.data?.httpStatus).toBe(409);

    const aisError = body.error?.data?.aisError;
    expect(aisError).toBeDefined();
    expect(aisError?.code).toBe(RUNTIME_NODE_ATTACH_CONFLICT_CODE);
    expect(typeof aisError?.message).toBe("string");
    // No-info-leak survives the HTTP hop: the message names the node id, never
    // the OTHER session holding it (mirrors router.test.ts:329-330).
    expect(aisError?.message).toContain(String(NODE_ID));
    expect(aisError?.message).not.toContain(String(OTHER_SESSION_ID));
    expect(aisError).not.toHaveProperty("details");
  });

  it("projects runtime_node.attach_revoked as {code, message} (no details) for a terminal revoked re-attach", async () => {
    // The node's attachment row FOR THIS session is in the terminal `revoked`
    // state: re-attach is refused with RuntimeNodeAttachRevokedException (P10 —
    // revocation is terminal, never reactivated). The distinct attach catch-arm
    // branch maps it to CONFLICT and the formatter projects it. The HTTP-path
    // twin of runtime-node-router.test.ts:333-354.
    const querier = adaptPGlite(pg);
    await seedParticipant(querier, PARTICIPANT_ID);
    await seedSession(querier, SESSION_ID);
    await seedAttachment(querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      state: "revoked",
      clientVersion: "1.4",
    });

    const response = await handler(buildAttachRequest(), PASSING_ENV);

    expect(response.status).toBe(409);
    const body = (await response.json()) as WireErrorEnvelope;
    expect(body.error?.data?.httpStatus).toBe(409);

    const aisError = body.error?.data?.aisError;
    expect(aisError).toBeDefined();
    expect(aisError?.code).toBe(RUNTIME_NODE_ATTACH_REVOKED_CODE);
    expect(typeof aisError?.message).toBe("string");
    expect(aisError?.message).toContain(String(NODE_ID));
    expect(aisError).not.toHaveProperty("details");
  });

  it("projects resource.limit_exceeded WITH details for an over-cap session.join (the details-carrying branch)", async () => {
    // The session-domain projection — the ONLY subclass carrying structured
    // `details`, so this is the formatter's `cause.details !== undefined` TRUE
    // branch, exercised on the wire here and nowhere else. Seed a session filled
    // to the default participants-per-session cap of 10 (ten distinct members,
    // none equal to CURRENT_PARTICIPANT_ID), then dispatch the 11th `session.join`
    // as CURRENT_PARTICIPANT_ID — a NEW participant the self-resolver admits, so
    // `isRejoin` is false and the cap check fires (session-directory-service.ts
    // :653-669). The router maps ResourceLimitExceededException to
    // TOO_MANY_REQUESTS / HTTP 429 (session-router.factory.ts:152-157), distinct
    // from the runtime-node 409s, preserving the typed exception on `cause` so the
    // shared formatter projects the {resource, limit, current} payload.
    const querier = adaptPGlite(pg);
    await seedSession(querier, SESSION_ID);
    for (const memberId of TEN_CAP_FILLING_PARTICIPANT_IDS) {
      await seedParticipant(querier, memberId);
      await seedMembership(querier, SESSION_ID, memberId);
    }
    // The 11th joiner — a new participant (the cap test needs a non-member so the
    // rejoin-probe does not short-circuit the count check).
    await seedParticipant(querier, CURRENT_PARTICIPANT_ID);

    const response = await handler(
      buildJoinRequest(SESSION_ID, CURRENT_PARTICIPANT_ID),
      PASSING_ENV,
    );

    // HTTP 429 (Spec-001 §Limit Enforcement maps participants-per-session to the
    // canonical TOO_MANY_REQUESTS surface) — NOT the 409 the runtime-node
    // refusals carry.
    expect(response.status).toBe(429);
    const body = (await response.json()) as WireErrorEnvelope;
    expect(body.error?.data?.httpStatus).toBe(429);

    const aisError = body.error?.data?.aisError;
    expect(aisError).toBeDefined();
    expect(aisError?.code).toBe(RESOURCE_LIMIT_EXCEEDED_CODE);
    expect(typeof aisError?.message).toBe("string");
    // CRUCIALLY — unlike every runtime-node case above — `details` IS present and
    // carries the canonical Spec-001 {resource, limit, current} payload.
    expect(aisError?.details).toEqual({
      resource: "participants per session",
      limit: 10,
      current: 10,
    });
  });
});
