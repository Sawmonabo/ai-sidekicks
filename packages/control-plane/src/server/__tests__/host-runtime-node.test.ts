// Plan-003 §T3.8: runtime-node procedures resolve through the MERGED host.
//
// The standalone caller tests (runtime-node-router.test.ts) drive
// `createRuntimeNodeRouter` directly via `t.createCallerFactory`, which bypasses
// the production composition at host.ts: `t.mergeRouters(createSessionRouter,
// createRuntimeNodeRouter)` behind `buildControlPlaneFetchHandler` +
// `fetchRequestHandler`. The session side of that merge is runtime-proven by
// sse-retry-prefix.test.ts (it dispatches `session.subscribe` through the
// handler); this test closes the symmetric gap for `runtimenode.*`.
//
// A single end-to-end dispatch is sufficient and intentional: a 200 at
// `/trpc/runtimenode.heartbeat` is reachable ONLY if the flat sibling merge
// mounted the procedure at that path. A regression that re-nested the
// runtime-node router (or dropped it from the merge) would surface here as a
// 404 — every standalone caller test would still pass. We assert merged-host
// REACHABILITY only; the procedure's internal behavior is covered by the
// caller tests and heartbeat-service.test.ts.
//
// Refs: docs/plans/003-runtime-node-attach.md §T3.8, ADR-014,
//       packages/control-plane/src/server/host.ts (the t.mergeRouters composition).

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import type { ParticipantId, SessionId } from "@ai-sidekicks/contracts";

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
