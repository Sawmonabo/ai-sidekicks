// Plan-003 Phase 4 T4.2: I1 integration test for `runtimeNodeClient`, plus the
// SHARED PGlite-backed harness that T4.3 (degraded-via-heartbeat) and T4.4
// (version-floor write-refusal) extend.
//
// Spec coverage — the named acceptance criteria from Spec-003:
//   * I1 — live attach to an already-active session leaves session identity
//          unchanged (Spec-003 line 120 AC1: "A participant can attach a local
//          runtime node to an already active session"; Spec-003 line 50: attach
//          "must not require session recreation").
//
// Architecture (locked — see Plan-003 Phase 4 dispatch): this harness drives the
// REAL `AttachService` / `HeartbeatService` over an in-memory PGlite database —
// the SAME pattern `control-plane/src/runtime-nodes/__tests__/attach-service.test.ts`
// and `control-plane/src/server/__tests__/host-runtime-node.test.ts` use — NOT
// fixture-subclass services. The control-plane path is the SUBSTANTIVE I1: it
// drives the attach THROUGH `createControlPlaneRuntimeNodeClient` -> the tRPC
// fetch handler -> the real attach service against real PGlite persistence, then
// reads the `sessions` table directly to assert the no-recreation invariant
// (attach writes `runtime_node_attachments`, never `sessions`). The reason the
// services are real (not fixtures, as `sessionClient.integration.test.ts` used
// for session CRUD): runtime-node's floor/state IS the subject under test for
// the downstream tasks — T4.4 must drive the version-floor refusal through the
// real `AttachService.updateCapabilities` floor-gate with real persistence
// connecting `attach` (writes the below-floor row) -> `capabilityUpdate` (reads
// it FOR UPDATE, throws `VersionFloorExceededException`); a fixture that fakes
// the floor decision is a scripted tautology and is explicitly rejected.
//
// The daemon path is TRANSPORT BREADTH only: the daemon side has NO runtime-node
// IPC handler yet, so `createDaemonRuntimeNodeClient.attach` is covered with an
// in-memory `ClientTransport` + a scripted reply table (mirroring
// `sessionClient.integration.test.ts`'s `buildDaemonHarness`). This proves the
// daemon factory wraps `JsonRpcClient.call` with the right method + schemas.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import {
  AttachService,
  type ControlPlaneDeps,
  type ControlPlaneEnv,
  HeartbeatService,
  type Querier,
  SessionDirectoryService,
  applyMigrations,
  buildControlPlaneFetchHandler,
} from "@ai-sidekicks/control-plane";
import {
  type EventEnvelopeVersion,
  JSONRPC_VERSION,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponseEnvelope,
  type NodeId,
  type ParticipantId,
  type SessionId,
} from "@ai-sidekicks/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createControlPlaneRuntimeNodeClient,
  createDaemonRuntimeNodeClient,
} from "../src/runtimeNodeClient.js";
import { JsonRpcClient } from "../src/transport/jsonRpcClient.js";
import type { ClientTransport } from "../src/transport/types.js";

// ---------------------------------------------------------------------------
// Fixtures — UUID v7-shaped ids (the brand validators accept any RFC 9562 UUID;
// real generation is daemon-side). `NODE_ID` is a daemon-minted opaque TEXT
// scalar (NOT a UUID); `CLIENT_VERSION` is the branded MAJOR.MINOR semver. The
// brand-cast fixture-id style matches both precedent test files.
// ---------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000d001" as SessionId;
const PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-00000000d101" as ParticipantId;
const NODE_ID: NodeId = "node-alpha-01" as NodeId;
const CLIENT_VERSION: EventEnvelopeVersion = "1.4" as EventEnvelopeVersion;

const CAPABILITIES: Record<string, unknown> = {
  "provider-driver": { kind: "claude", streaming: true },
  maxConcurrentRuns: 3,
};

// The control-plane base URL the SDK appends `${endpoint}/${method}` to. The
// in-process fetch handler ignores the host; the URL just has to parse.
const CONTROL_PLANE_BASE_URL = "https://control-plane.test";

// Gate-passing env — the dual-gate shape `buildControlPlaneFetchHandler`
// requires before router dispatch (mirrors host-runtime-node.test.ts PASSING_ENV
// + sessionClient.integration.test.ts PASSING_ENV).
const PASSING_ENV: ControlPlaneEnv = {
  CONTROL_PLANE_BOOTSTRAP_ENABLED: "1",
  ENVIRONMENT: "development",
};

const PROTOCOL_VERSION = "2026-05-01";

// ---------------------------------------------------------------------------
// PGlite -> Querier adapter (LOCAL copy — the control-plane dispatch contract
// forbids exporting a test fixture from `packages/control-plane/`, so sibling
// tests each carry their own copy; this mirrors attach-service.test.ts's `wrap`
// / host-runtime-node.test.ts's `wrap`).
// ---------------------------------------------------------------------------
//
// PGlite#query expects `params` as `any[]` (mutable); the `Querier` interface
// uses `ReadonlyArray<unknown>`. The spread copy decouples the mutability claim
// without copying values. `transaction(fn)` wraps `pg.transaction(fn)` and
// re-wraps the inner `tx` as a `Querier` so in-transaction code uses the same
// surface; nested `tx.transaction(...)` throws (Postgres has no native nested
// transactions without SAVEPOINTs). This is the substrate the floor-gate's
// `SELECT ... FOR UPDATE` runs over in T4.4.

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
// Seed helpers — direct INSERTs (NOT through the SDK; the SDK has no session-
// create surface). Mirrors attach-service.test.ts's `seedParticipant` /
// `seedSession`.
// ---------------------------------------------------------------------------

async function seedParticipant(querier: Querier, participantId: ParticipantId): Promise<void> {
  await querier.query("INSERT INTO participants (id) VALUES ($1)", [participantId]);
}

// Seed an ACTIVE session with a CONFIGURABLE `min_client_version` floor. The
// floor is NULL (no version gate) for I1/I2; T4.4 passes a real floor (e.g.
// "2.0") so a below-floor daemon's later `capabilityUpdate` write is refused
// through the REAL `AttachService.updateCapabilities` floor-gate. `minClientVersion`
// omitted => the column stays SQL NULL.
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

// Seed an ACTIVE membership row (the "has joined a live session" precondition
// in Spec-003 AC1 line 120). Direct INSERT bypassing joinSession; mirrors
// host-runtime-node.test.ts's `seedMembership`. The attach path never reads it
// (attach is a SEPARATE step from membership — Spec-003 line 47), but seeding it
// keeps the scenario faithful to AC1's wording.
async function seedMembership(
  querier: Querier,
  args: { sessionId: SessionId; participantId: ParticipantId; role: string; state: string },
): Promise<void> {
  await querier.query(
    `INSERT INTO session_memberships (session_id, participant_id, role, state, joined_at)
     VALUES ($1, $2, $3, $4, now())`,
    [args.sessionId, args.participantId, args.role, args.state],
  );
}

// Snapshot the WHOLE sessions row for the no-recreation byte-identity assertion.
// Raw `SELECT *` (no ::text casts): a before/after snapshot of the SAME row on
// the SAME PGlite instance with no mutation in between hydrates identically on
// both reads, so `toEqual` is stable — while `SELECT *` gives teeth against a
// mutation to ANY column (a hand-picked cast list would miss a column the attach
// path might wrongly touch). Mirrors the P5 multi-node session-identity guard in
// attach-service.test.ts.
async function readSessionRow(
  querier: Querier,
  sessionId: SessionId,
): Promise<Record<string, unknown> | undefined> {
  const probe = await querier.query<Record<string, unknown>>(
    "SELECT * FROM sessions WHERE id = $1",
    [sessionId],
  );
  return probe.rows[0];
}

async function countSessions(querier: Querier): Promise<number> {
  const probe = await querier.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM sessions");
  return probe.rows[0]?.n ?? -1;
}

async function countAttachments(querier: Querier): Promise<number> {
  const probe = await querier.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM runtime_node_attachments",
  );
  return probe.rows[0]?.n ?? -1;
}

// ---------------------------------------------------------------------------
// Control-plane SDK builder — REAL AttachService / HeartbeatService over the
// per-test PGlite querier, wrapped by `buildControlPlaneFetchHandler` as a
// `fetcher` and consumed by `createControlPlaneRuntimeNodeClient`.
// ---------------------------------------------------------------------------
//
// This is the inverse of `sessionClient.integration.test.ts`'s
// `buildSubscribeOnlyDeps`: there, runtime-node services were backed by a
// throwing Querier (never-reached); here the runtime-node services use the REAL
// PGlite `querier` (the subject under test), and only the SESSION-CRUD deps
// (`directoryService`) + the SSE `eventStreamProvider` stay never-reached —
// `runtimenode.attach` / `heartbeat` / `capabilityupdate` / `detach` never
// resolve a session-create / subscribe procedure.
//
// `resolveCurrentParticipantId` is REAL (returns the seeded participant): the
// attach procedure self-checks `input.participantId !== resolveCurrentParticipantId(ctx)`
// and throws `UNAUTHORIZED` on mismatch (runtime-node-router.factory.ts:170-176),
// so a throwing stub would short-circuit attach BEFORE it reaches `AttachService`.
// This mirrors host-runtime-node.test.ts's `makePassThroughDeps` wiring
// (currentParticipantId === the seeded PARTICIPANT_ID).
//
// The SAME `querier` instance backs both services AND the direct `SELECT * FROM
// sessions` assertions, so state persists across attach/heartbeat/capabilityUpdate
// within a test — the invariant T4.3/T4.4 depend on.

const NEVER_REACHED = (symbol: string): Error =>
  new Error(`runtime-node path must not consume session-CRUD dependency ${symbol}`);

const throwingQuerier: Querier = {
  query: () => {
    throw NEVER_REACHED("Querier.query");
  },
  exec: () => {
    throw NEVER_REACHED("Querier.exec");
  },
  transaction: () => {
    throw NEVER_REACHED("Querier.transaction");
  },
};

// Build `ControlPlaneDeps` whose runtime-node services run over the REAL PGlite
// `querier` and whose `resolveCurrentParticipantId` returns the seeded
// participant. The directory service + session-id/identity callbacks + event
// stream provider are never reached by the runtime-node procedures, so they take
// the throwing posture (matching `buildSubscribeOnlyDeps`). `currentParticipantId`
// defaults to the fixture `PARTICIPANT_ID`; T4.4 can pass an explicit value.
function buildRuntimeNodeDeps(
  querier: Querier,
  currentParticipantId: ParticipantId = PARTICIPANT_ID,
): ControlPlaneDeps {
  return {
    // Session CRUD is never reached on the runtime-node path — back it with the
    // throwing Querier (the nominally-typed class cannot be satisfied by a
    // structural literal, so subclass-via-throwing-Querier is the established
    // never-reached posture from buildSubscribeOnlyDeps).
    directoryService: new SessionDirectoryService(throwingQuerier),
    // REAL runtime-node services over the per-test PGlite querier — the subject
    // under test. `AttachService.attach` (I1/T4.4), `AttachService.updateCapabilities`
    // (T4.4 floor-gate), and `HeartbeatService.ingest` (T4.3 degraded transition)
    // all read/write through this same connection.
    attachService: new AttachService(querier),
    heartbeatService: new HeartbeatService(querier),
    // REAL — the attach self-check compares this against `request.participantId`
    // and throws UNAUTHORIZED on mismatch, so it MUST equal the seeded participant.
    resolveCurrentParticipantId: (): ParticipantId => currentParticipantId,
    // Never reached on the runtime-node path (session-create / join only).
    generateSessionId: (): SessionId => {
      throw NEVER_REACHED("generateSessionId");
    },
    resolveIdentityHandle: (): ParticipantId => {
      throw NEVER_REACHED("resolveIdentityHandle");
    },
    // Never reached — runtime-node has no subscribe (SSE) procedure.
    eventStreamProvider: () => {
      throw NEVER_REACHED("eventStreamProvider");
    },
  };
}

// Wrap a `ControlPlaneDeps` as a `createControlPlaneRuntimeNodeClient` fetcher.
// `buildControlPlaneFetchHandler(deps)` returns `(req, env) => Promise<Response>`;
// the SDK's `fetcher` is `(req) => Promise<Response>`, so we bind PASSING_ENV.
function buildControlPlaneRuntimeNodeClient(
  deps: ControlPlaneDeps,
): ReturnType<typeof createControlPlaneRuntimeNodeClient> {
  const handler = buildControlPlaneFetchHandler(deps);
  const fetcher = (request: Request): Promise<Response> => handler(request, PASSING_ENV);
  return createControlPlaneRuntimeNodeClient({ fetcher, baseUrl: CONTROL_PLANE_BASE_URL });
}

// ---------------------------------------------------------------------------
// Daemon transport harness — in-memory ClientTransport + scripted reply table.
// Mirrors `sessionClient.integration.test.ts`'s `buildDaemonHarness`. The daemon
// side has NO runtime-node IPC handler yet, so the reply table is scripted; this
// proves the daemon factory wraps `JsonRpcClient.call` with the right method
// (`runtimenode.attach`) + request/response schemas.
// ---------------------------------------------------------------------------

interface ScriptedDaemonResponse {
  readonly method: string;
  readonly buildResult: (request: JsonRpcRequest) => unknown;
}

class InMemoryDaemonTransport implements ClientTransport {
  public readonly sentEnvelopes: Array<JsonRpcRequest | JsonRpcNotification> = [];
  readonly #scripted: ScriptedDaemonResponse[];
  #onMessage: ((msg: JsonRpcResponseEnvelope | JsonRpcNotification) => void) | null = null;
  #onClose: ((reason?: Error) => void) | null = null;

  public constructor(scripted: ScriptedDaemonResponse[]) {
    this.#scripted = scripted;
  }

  public send(envelope: JsonRpcRequest | JsonRpcNotification): void {
    this.sentEnvelopes.push(envelope);
    if (!("id" in envelope)) {
      // Notifications carry no id — no response expected.
      return;
    }
    const reply = this.#scripted.find((entry) => entry.method === envelope.method);
    if (reply === undefined) {
      this.dispatchInbound({
        jsonrpc: JSONRPC_VERSION,
        id: envelope.id,
        error: { code: -32601, message: `Unscripted method: ${envelope.method}` },
      });
      return;
    }
    this.dispatchInbound({
      jsonrpc: JSONRPC_VERSION,
      id: envelope.id,
      result: reply.buildResult(envelope),
    });
  }

  public onMessage(handler: (msg: JsonRpcResponseEnvelope | JsonRpcNotification) => void): void {
    this.#onMessage = handler;
  }

  public onClose(handler: (reason?: Error) => void): void {
    this.#onClose = handler;
  }

  public close(): Promise<void> {
    if (this.#onClose !== null) {
      this.#onClose(undefined);
    }
    return Promise.resolve();
  }

  public dispatchInbound(msg: JsonRpcResponseEnvelope | JsonRpcNotification): void {
    if (this.#onMessage === null) {
      throw new Error("dispatchInbound called before onMessage was registered");
    }
    this.#onMessage(msg);
  }
}

interface DaemonHarness {
  readonly transport: InMemoryDaemonTransport;
  readonly client: JsonRpcClient;
}

function buildDaemonHarness(scripted: ScriptedDaemonResponse[]): DaemonHarness {
  const transport = new InMemoryDaemonTransport(scripted);
  const client = new JsonRpcClient(transport, { protocolVersion: PROTOCOL_VERSION });
  return { transport, client };
}

// ---------------------------------------------------------------------------
// Per-test database lifecycle (mirrors attach-service.test.ts)
// ---------------------------------------------------------------------------

interface TestContext {
  pg: PGlite;
  querier: Querier;
}

let ctx: TestContext;

beforeEach(async () => {
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);
  ctx = { pg, querier };
});

afterEach(async () => {
  await ctx.pg.close();
});

// ---------------------------------------------------------------------------
// I1 — live attach to an already-active session leaves session identity unchanged
// (Spec-003 line 120 AC1 + line 50 no-recreation) — control-plane transport
// ---------------------------------------------------------------------------

describe("I1 / Spec-003 AC1 (line 120) + line 50 — live attach leaves session identity unchanged", () => {
  it("control-plane transport: a joined participant attaches a node; the sessions row is byte-identical and no second session is materialized", async () => {
    // Seed the already-active session (NULL floor), the participant, and an
    // active membership (the "has joined a live session" precondition). Direct
    // INSERTs — the SDK has no session-create surface.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    // Capture the session identity BEFORE attach: the whole row (byte-identity
    // target) and the count (no-recreation target). Exactly one session exists.
    const sessionBefore = await readSessionRow(ctx.querier, SESSION_ID);
    expect(sessionBefore).toBeDefined();
    expect(await countSessions(ctx.querier)).toBe(1);
    expect(await countAttachments(ctx.querier)).toBe(0);

    // Drive the attach THROUGH the SDK -> tRPC fetch handler -> REAL AttachService
    // against real PGlite. This is the substantive I1 path.
    const sdk = buildControlPlaneRuntimeNodeClient(buildRuntimeNodeDeps(ctx.querier));
    const response = await sdk.attach({
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      clientVersion: CLIENT_VERSION,
      capabilities: CAPABILITIES,
      healthState: "online",
    });

    // (a) The attach response is well-formed: a fresh admit lands `registering`
    // with a UUID-shaped attachment id and an ISO `attachedAt`. A NULL-floor
    // session admits read-write (`readOnly = false`).
    expect(response.state).toBe("registering");
    expect(response.readOnly).toBe(false);
    expect(response.attachmentId).toMatch(/[0-9a-f-]{36}/i);
    expect(typeof response.attachedAt).toBe("string");

    // The attach DID land — one attachment row now exists (proves the attach ran
    // through to persistence, not a no-op the no-recreation check would also pass).
    expect(await countAttachments(ctx.querier)).toBe(1);

    // (b) SESSION IDENTITY UNCHANGED (the I1 core assertion, Spec-003 line 50):
    // the `sessions` row is byte-for-byte identical after the attach — attach
    // writes `runtime_node_attachments`, never `sessions`, so the session id (and
    // every other column) is invariant across the attach.
    const sessionAfter = await readSessionRow(ctx.querier, SESSION_ID);
    expect(sessionAfter).toEqual(sessionBefore);
    // The session id observed before and after the attach is identical.
    expect(sessionAfter?.["id"]).toBe(String(SESSION_ID));

    // (c) NO RECREATION: still exactly ONE session row — the attach did not
    // materialize a second session (Spec-003 line 50, "attach must not require
    // session recreation").
    expect(await countSessions(ctx.querier)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// I1 transport breadth — daemon transport attach (scripted reply table)
// ---------------------------------------------------------------------------

describe("I1 transport breadth — createDaemonRuntimeNodeClient.attach wraps JsonRpcClient.call", () => {
  it("daemon transport: attach routes runtimenode.attach with the right schemas and unwraps the response", async () => {
    // The daemon side has NO runtime-node IPC handler yet, so the reply is
    // scripted. This proves the daemon factory threads `runtimenode.attach` +
    // the attach request/response schemas through `JsonRpcClient.call`. The
    // scripted result echoes the request's sessionId back through nothing — the
    // attach response shape has no sessionId, so the no-recreation invariant is
    // not assertable on this path (it has no persistence); this is breadth only.
    const harness = buildDaemonHarness([
      {
        method: "runtimenode.attach",
        // The daemon has no runtime-node IPC handler yet, so the reply is scripted.
        buildResult: (): unknown => ({
          attachmentId: "01970000-0000-7000-8000-00000000d901",
          state: "registering",
          readOnly: false,
          attachedAt: "2026-06-09T12:00:00.000Z",
        }),
      },
    ]);
    const sdk = createDaemonRuntimeNodeClient(harness.client);

    const response = await sdk.attach({
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: NODE_ID,
      clientVersion: CLIENT_VERSION,
      capabilities: CAPABILITIES,
      healthState: "online",
    });

    // The daemon factory unwrapped + Zod-validated the response.
    expect(response.state).toBe("registering");
    expect(response.readOnly).toBe(false);
    expect(response.attachmentId).toBe("01970000-0000-7000-8000-00000000d901");

    // Exactly one envelope was serialized to the wire, carrying the right method
    // and forwarding the sessionId (the daemon factory must not drop request
    // fields). Co-locating these wire assertions in the test body surfaces a
    // failure directly rather than through the awaited `attach` rejection.
    expect(harness.transport.sentEnvelopes).toHaveLength(1);
    const sent = harness.transport.sentEnvelopes[0];
    expect(sent?.method).toBe("runtimenode.attach");
    const sentParams = sent?.params as { sessionId?: string } | undefined;
    expect(sentParams?.sessionId).toBe(String(SESSION_ID));
  });
});
