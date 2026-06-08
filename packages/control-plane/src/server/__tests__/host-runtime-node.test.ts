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
// The errorFormatter-projection dispatches (T3.4) are the ONLY tests in the
// suite that observe the wire `error.data.aisError` envelope: `errorFormatter`
// runs in tRPC's HTTP/adapter path (`getErrorShape`), NOT in the in-process
// `createCallerFactory` the caller tests use, so the envelope is unobservable
// there. They close the T3.8 deferral — proving the formatter, collapsed onto a
// single `AisWireException` base `instanceof` (T3.4), projects the runtime-node
// refusals (which previously only set `cause` with no formatter branch). Both
// runtime-node refusals here are code+message-only, so `aisError` carries NO
// `details` key (the canonical `ErrorResponse.details` is optional).
//
// Refs: docs/plans/003-runtime-node-attach.md §T3.8 + §T3.4, ADR-014, ADR-018
//       §Decision #4, Spec-003 line 123, error-contracts.md §Runtime Node +
//       §Version, packages/control-plane/src/server/host.ts (the t.mergeRouters
//       composition), ../../ais-wire-exception.ts (the formatter match-type).

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import type { NodeId, ParticipantId, SessionId } from "@ai-sidekicks/contracts";
import {
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

// Ids for the errorFormatter-projection dispatches (the capabilityupdate
// refusals seed real attachment rows). `SESSION_ID` reuses `NEXT_SESSION_ID`;
// `NODE_ID` is a daemon-minted opaque TEXT scalar (not a UUID).
const SESSION_ID: SessionId = NEXT_SESSION_ID;
const PARTICIPANT_ID: ParticipantId = CURRENT_PARTICIPANT_ID;
const NODE_ID: NodeId = "node-alpha-01" as NodeId;

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

// Seed helpers for the projection dispatches — bypass the services to set up the
// rows the capabilityupdate refusals exercise (mirrors runtime-node-router.test.ts).
async function seedParticipant(querier: Querier, participantId: ParticipantId): Promise<void> {
  await querier.query("INSERT INTO participants (id) VALUES ($1)", [participantId]);
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
// errorFormatter projection — runtime-node refusals reach error.data.aisError
// (T3.4; closes the T3.8 deferral).
// ----------------------------------------------------------------------------
//
// These are the only suite tests that observe the wire `error.data.aisError`
// envelope — `errorFormatter` runs in the HTTP/adapter path, not the in-process
// caller. They prove the formatter (collapsed onto a single `AisWireException`
// base `instanceof` in T3.4) projects BOTH the version-floor write-refusal AND a
// previously-deferred sibling (the capability-update conflict) uniformly. Both
// are code+message-only, so each `aisError` carries NO `details` key.

describe("errorFormatter projection — runtime-node aisError envelope (T3.4)", () => {
  it("projects version.floor_exceeded as {code, message} (no details) for a below-floor write", async () => {
    // A floored session (floor 2.0) holds the node's active attachment at a
    // below-floor client_version (1.0): the read-only verdict the write-gate
    // re-derives. The capability WRITE is refused with the typed
    // VersionFloorExceededException, which the catch-arm maps to CONFLICT and the
    // shared formatter projects onto error.data.aisError (Spec-003 line 123 /
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
});
