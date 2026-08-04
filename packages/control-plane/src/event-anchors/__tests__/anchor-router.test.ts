// Plan-006 T3.3 — `eventanchor.upload` resolves through the MERGED host.
//
// Every test here dispatches an HTTP request at
// `buildControlPlaneFetchHandler` rather than driving the router factory
// through `t.createCallerFactory`, and that is the point rather than an
// incidental choice. Three things are only observable on the HTTP path:
//
//   1. THE MOUNT (Plan-006 CP-006-2). A 200 at `/trpc/eventanchor.upload` is
//      reachable only if `t.mergeRouters` composed this router flat alongside
//      the session and runtime-node siblings. A regression that re-nested it or
//      dropped it from the merge surfaces here as a 404 while every in-process
//      caller test would still pass — the same gap
//      `server/__tests__/host-runtime-node.test.ts` closes for `runtimenode.*`.
//   2. THE `.input()` REFUSAL as a wire STATUS. The metadata-only invariant
//      (I-006-3-02) is enforced by a `.strict()` schema at the procedure
//      boundary, and a caller needs to see a 4xx — not a 200 with the extra
//      member quietly dropped.
//   3. THE I-008-1 GATE still intercepting. Adding a third router to the merge
//      must not open a path around the dual gate.
//
// The store's own behaviour (idempotency mechanics, byte fidelity, the FK arm)
// is covered against PGlite in the sibling `anchor-store.test.ts`; this file
// asserts the transport contract on top of it and does not re-derive it.
//
// Refs: Plan-006 T3.3, `Plan-006 §Cross-Plan Obligations` CP-006-2, ADR-014,
// ADR-017, `packages/control-plane/src/server/host.ts` (the `t.mergeRouters`
// composition).

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnchorPayload, NodeId, ParticipantId, SessionId } from "@ai-sidekicks/contracts";

import { buildControlPlaneFetchHandler, type ControlPlaneEnv } from "../../server/host.js";
import { makePassThroughDeps } from "../../server/__tests__/_helpers.js";
import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const SESSION_ID = "01970000-0000-7000-8000-00000000a001" as SessionId;
const ABSENT_SESSION_ID = "01970000-0000-7000-8000-00000000dead" as SessionId;
const CURRENT_PARTICIPANT_ID = "01970000-0000-7000-8000-00000000b001" as ParticipantId;
const NEXT_SESSION_ID = "01970000-0000-7000-8000-00000000a002" as SessionId;
const NODE_ID = "node-alpha" as NodeId;
const ANCHORED_AT = "2026-08-04T00:00:00.000Z";

const PASSING_ENV: ControlPlaneEnv = {
  CONTROL_PLANE_BOOTSTRAP_ENABLED: "1",
  ENVIRONMENT: "development",
};

const REFUSING_ENV: ControlPlaneEnv = {
  CONTROL_PLANE_BOOTSTRAP_ENABLED: "0",
  ENVIRONMENT: "development",
};

function anchorFixture(overrides: Partial<AnchorPayload> = {}): AnchorPayload {
  return {
    sessionId: SESSION_ID,
    nodeId: NODE_ID,
    startSequence: 1,
    endSequence: 1000,
    merkleRoot: Buffer.alloc(32, 0x11).toString("base64"),
    rootSignature: Buffer.alloc(64, 0x22).toString("base64"),
    anchoredAt: ANCHORED_AT,
    ...overrides,
  };
}

// The tRPC v11 HTTP mutation wire shape this package emits (no transformer, no
// batching): POST `/trpc/<proc>` with `Content-Type: application/json` and the
// raw input JSON as the body — the same form `host-runtime-node.test.ts` uses.
function buildUploadRequest(body: unknown): Request {
  return new Request("https://control-plane.test/trpc/eventanchor.upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy)
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
// Per-test lifecycle
// ----------------------------------------------------------------------------

let pg: PGlite;
let handler: (request: Request, env: ControlPlaneEnv) => Promise<Response>;

beforeEach(async () => {
  pg = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);
  await querier.query("INSERT INTO sessions (id) VALUES ($1)", [SESSION_ID]);
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

// Reads the tRPC success envelope `{ result: { data: <output> } }` (no
// transformer). Read `.result.data` specifically — tRPC may carry sibling
// metadata on `result`.
async function readResultData(response: Response): Promise<unknown> {
  const body = (await response.json()) as { result?: { data?: unknown } };
  return body.result?.data;
}

async function readErrorCode(response: Response): Promise<unknown> {
  const body = (await response.json()) as { error?: { data?: { code?: unknown } } };
  return body.error?.data?.code;
}

// ----------------------------------------------------------------------------
// The mount (CP-006-2)
// ----------------------------------------------------------------------------

describe("merged host — eventanchor.upload resolves through t.mergeRouters (CP-006-2)", () => {
  it("dispatches an anchor upload and returns 200 + { stored: true }", async () => {
    const response = await handler(buildUploadRequest(anchorFixture()), PASSING_ENV);

    // Status first: a 404 (procedure not mounted by the merge) or a 503 (gate
    // refusal) would make the body read misleading, and the status assertion
    // names the failure mode cleanly.
    expect(response.status).toBe(200);
    expect(await readResultData(response)).toEqual({ stored: true });
  });

  it("returns 200 + { stored: false } on an identical re-upload (idempotent success)", async () => {
    await handler(buildUploadRequest(anchorFixture()), PASSING_ENV);
    const second = await handler(buildUploadRequest(anchorFixture()), PASSING_ENV);

    // NOT a 409. A retried upload of the same range is the daemon's normal
    // behaviour when an attempt's outcome is unknown to it, and answering with
    // an error status would strand the anchor in the local queue forever.
    expect(second.status).toBe(200);
    expect(await readResultData(second)).toEqual({ stored: false });
  });

  it("admits a wider covering anchor sharing a start_sequence", async () => {
    await handler(buildUploadRequest(anchorFixture({ endSequence: 1000 })), PASSING_ENV);
    const covering = await handler(
      buildUploadRequest(anchorFixture({ endSequence: 5000 })),
      PASSING_ENV,
    );
    expect(covering.status).toBe(200);
    expect(await readResultData(covering)).toEqual({ stored: true });
  });
});

// ----------------------------------------------------------------------------
// I-006-3-02 at the transport boundary
// ----------------------------------------------------------------------------

describe("eventanchor.upload — metadata-only refusal on the wire (I-006-3-02)", () => {
  for (const smuggledMember of ["payload", "events", "pii_payload"] as const) {
    it(`REFUSES a request body carrying \`${smuggledMember}\` with a 4xx`, async () => {
      const response = await handler(
        buildUploadRequest({
          ...anchorFixture(),
          [smuggledMember]: { secret: "event bytes that must never reach the control plane" },
        }),
        PASSING_ENV,
      );

      // A 200 here would mean the extra member was accepted and silently
      // stripped — the caller would believe it uploaded content that never
      // arrived, and the invariant would be enforced by nothing.
      expect(response.status).toBe(400);
      expect(await readErrorCode(response)).toBe("BAD_REQUEST");
    });
  }

  it("refuses a commitment field of the wrong decoded width", async () => {
    const response = await handler(
      buildUploadRequest(anchorFixture({ merkleRoot: Buffer.alloc(31).toString("base64") })),
      PASSING_ENV,
    );
    expect(response.status).toBe(400);
  });

  it("refuses an inverted range before it reaches the database CHECK", async () => {
    const response = await handler(
      buildUploadRequest(anchorFixture({ startSequence: 1000, endSequence: 999 })),
      PASSING_ENV,
    );
    expect(response.status).toBe(400);
  });
});

// ----------------------------------------------------------------------------
// The unknown-session arm
// ----------------------------------------------------------------------------

describe("eventanchor.upload — unknown session", () => {
  it("maps an absent session to 404 NOT_FOUND rather than a retriable 500", async () => {
    // A raw FK violation would surface as INTERNAL_SERVER_ERROR, which tells the
    // daemon to retry a request that can never succeed. NOT_FOUND is the
    // terminal answer it needs.
    const response = await handler(
      buildUploadRequest(anchorFixture({ sessionId: ABSENT_SESSION_ID })),
      PASSING_ENV,
    );
    expect(response.status).toBe(404);
    expect(await readErrorCode(response)).toBe("NOT_FOUND");
  });
});

// ----------------------------------------------------------------------------
// The I-008-1 gate still intercepts
// ----------------------------------------------------------------------------

describe("eventanchor.upload — the I-008-1 dual gate is not bypassed by the new mount", () => {
  it("refuses with 503 before router dispatch when the kill-switch is off", async () => {
    // Adding a third router to the merge must not open a path around the gate.
    // `makePassThroughDeps` supplies a live querier here, so a 503 proves the
    // gate intercepted rather than the store failing.
    const response = await handler(buildUploadRequest(anchorFixture()), REFUSING_ENV);
    expect(response.status).toBe(503);
  });
});
