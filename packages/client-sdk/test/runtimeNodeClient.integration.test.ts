// Plan-003 Phase 4 T4.2: I1 integration test for `runtimeNodeClient`, plus the
// SHARED PGlite-backed harness that T4.3 (I2 — capability-health degraded
// distinguishability) and T4.4 (I3 — version-floor write-refusal) extend; all
// three scenarios now live in this file.
//
// Spec coverage — the named acceptance criteria from Spec-003:
//   * I1 — live attach to an already-active session leaves session identity
//          unchanged (Spec-003 line 120 AC1: "A participant can attach a local
//          runtime node to an already active session"; Spec-003 line 50: attach
//          "must not require session recreation").
//   * I2 — a capability-degraded node stays visible and distinguishable from a
//          healthy online node through the client-observable `NodeState`
//          (Spec-003 line 121 AC2; line 76: capability-validation failure
//          leaves the node `degraded`; line 72: the two health axes are
//          independent — the `capabilityupdate` response `state` is the
//          server-derived full `NodeState`). See the I2 section below for why
//          `degraded` is driven on the capability-health axis, per the Plan-003
//          T4.3 amendment (2026-06-09, PR #147).
//   * I3 — mixed-version attach (Spec-003 line 123 AC4): the below-floor daemon
//          is ADMITTED read-only — its reads succeed, its version-sensitive
//          capability WRITE returns typed `VERSION_FLOOR_EXCEEDED`, and neither
//          daemon is ejected for the floor mismatch. The ONE Phase-4 scenario
//          verifying a Plan-003 invariant: I-003-1 (admit-in-read-only /
//          admit-not-eject — Plan-003 §Invariants).
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
  VERSION_FLOOR_EXCEEDED_CODE,
} from "@ai-sidekicks/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RuntimeNodeControlPlaneError,
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

// I2 (T4.3) node ids — TWO distinct nodes in ONE session (the attach upsert's
// conflict key is the total `(node_id, session_id)`, so distinct node ids
// coexist as two attachment rows — the Spec-003 line 49 multi-node shape).
// Named for the scenario role each plays: the capability-degraded subject vs.
// the healthy-online contrast node. Distinct from I1's `node-alpha-01` purely
// for failure-output legibility (each test gets a fresh PGlite, so this is
// readability, not isolation).
const DEGRADED_NODE_ID: NodeId = "node-bravo-degraded-01" as NodeId;
const HEALTHY_NODE_ID: NodeId = "node-charlie-online-01" as NodeId;

// I3 (T4.4) fixtures — the mixed-version daemon pair. The I3 session floor is
// `CLIENT_VERSION` ("1.4") ITSELF, so "at-floor" means EQUAL-to-floor — the
// sharpest admit-read-write boundary case, since the `#deriveReadOnly` gate is
// strictly-below (attach-service.ts: a daemon AT or ABOVE the floor admits
// `readOnly = false`) — and the below-floor daemon reports one MINOR lower
// ("1.3", a valid `EventEnvelopeVersion` MAJOR.MINOR string). Node ids named
// for the version role each daemon plays in the scenario.
const AT_FLOOR_NODE_ID: NodeId = "node-delta-at-floor-01" as NodeId;
const BELOW_FLOOR_NODE_ID: NodeId = "node-echo-below-floor-01" as NodeId;
const BELOW_FLOOR_CLIENT_VERSION: EventEnvelopeVersion = "1.3" as EventEnvelopeVersion;

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
// floor is NULL (no version gate) for I1/I2; I3 (T4.4) passes the real floor
// (`CLIENT_VERSION`, "1.4") so a below-floor daemon's later `capabilityUpdate`
// write is refused through the REAL `AttachService.updateCapabilities`
// floor-gate. `minClientVersion` omitted => the column stays SQL NULL.
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

// Project EVERY attachment row to `node_id -> state` (the SLOT axis,
// `runtime_node_attachments.state`). I2's DB anti-vacuity cross-check reads the
// WHOLE table so a `toEqual` against an exact map proves BOTH the per-node
// states AND that no extra row materialized — sharper than a per-row spot check.
async function readAttachmentStatesByNode(querier: Querier): Promise<Record<string, string>> {
  const probe = await querier.query<{ node_id: string; state: string }>(
    "SELECT node_id, state FROM runtime_node_attachments",
  );
  return Object.fromEntries(probe.rows.map((row) => [row.node_id, row.state]));
}

// Read a node's `runtime_node_presence` row — the LIVENESS axis the heartbeat
// service owns, DISTINCT from the attachment-slot axis above (Spec-003 line 72:
// independent health axes with distinct owners). Persistence-layer observation
// is the CORRECT seam for this axis in Phase 4: no client surface reads it —
// the heartbeat wire response is the no-content `null`, and there is no
// roster-read SDK surface (the reconciled presence × slot roster is downstream
// of Plan-003). `last_heartbeat_at` is typed `unknown` deliberately: the I2
// assertion is non-nullness of the server-clock write, not a driver-specific
// hydration shape (PGlite hydrates TIMESTAMPTZ as a JS Date; `pg` may differ).
async function readPresenceRow(
  querier: Querier,
  nodeId: NodeId,
): Promise<{ health_state: string; last_heartbeat_at: unknown } | undefined> {
  const probe = await querier.query<{ health_state: string; last_heartbeat_at: unknown }>(
    "SELECT health_state, last_heartbeat_at FROM runtime_node_presence WHERE node_id = $1",
    [nodeId],
  );
  return probe.rows[0];
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
    // (T4.3 capability-health transitions; T4.4 floor-gate), and
    // `HeartbeatService.ingest` (T4.3 liveness-axis heartbeat) all read/write
    // through this same connection.
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
// I2 — a degraded node remains distinguishable from a healthy online node
// (Spec-003 line 121 AC2 + line 76 + line 72) — control-plane transport
// ---------------------------------------------------------------------------
//
// WHY the capability-health axis, NOT the originally-planned heartbeat-driven
// roster read (Plan-003 T4.3 as amended 2026-06-09, PR #147): the two health
// axes have DIFFERENT owners and only one is client-observable on the shipped
// Phase-4 surface. The Phase-3 heartbeat/staleness path writes ONLY the
// `runtime_node_presence.health_state` LIVENESS axis, which no Phase-4 SDK
// response surfaces (heartbeat's wire response is the no-content `null`, and
// there is no roster-read SDK surface — the reconciled presence × slot roster
// is downstream of this plan). The `capabilityUpdate` response `state` IS
// client-observable: the server-derived full `NodeState` from
// `runtime_node_attachments.state` (Spec-003 line 72), and
// `registering -> degraded` on that axis is EXPLICITLY permitted by the
// I-003-2 guard, which blocks only `registering -> online` (attach-service.ts
// step 4) — per Spec-003 line 76, a capability-validation failure leaves the
// node `degraded`. So the capability-health axis is the ONE client-observable
// degraded drive in Phase 4, and I2's distinguishability thesis is asserted on
// it.
//
// NO new daemon-transport test here: the daemon side has no runtime-node IPC
// handler, so a scripted reply table would just echo whatever `state` we
// scripted — a tautology with no transition under test. The I1 breadth test
// already proves the daemon factory threads method + schemas through
// `JsonRpcClient.call`; I2's thesis (REAL state transitions reaching real
// persistence) only exists on the real-service control-plane harness.

describe("I2 / Spec-003 AC2 (line 121) + lines 76/72 — degraded node remains distinguishable", () => {
  it("control-plane transport: a capability-degraded node stays visible and distinguishable from a healthy online node in the same session", async () => {
    // Seed the live session (NULL floor — version gating is T4.4's axis, not
    // I2's), the participant, and an active membership. Direct INSERTs — the
    // SDK has no session-create surface.
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const sdk = buildControlPlaneRuntimeNodeClient(buildRuntimeNodeDeps(ctx.querier));

    // (1) Attach TWO nodes to the ONE live session through the SDK. The attach
    // upsert's conflict key is the total `(node_id, session_id)`, so the two
    // distinct node ids land as two attachment rows; both are hard-pinned at
    // `registering` (Spec-003 line 57 — `online` requires a daemon-side
    // capability declaration, which the control plane never performs).
    const degradedSubjectAttach = await sdk.attach({
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: DEGRADED_NODE_ID,
      clientVersion: CLIENT_VERSION,
      capabilities: CAPABILITIES,
      healthState: "online",
    });
    const healthyContrastAttach = await sdk.attach({
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: HEALTHY_NODE_ID,
      clientVersion: CLIENT_VERSION,
      capabilities: CAPABILITIES,
      healthState: "online",
    });
    expect(degradedSubjectAttach.state).toBe("registering");
    expect(healthyContrastAttach.state).toBe("registering");
    // DB anti-vacuity: BOTH attaches landed as rows (two distinct node ids did
    // not collapse into one upserted row).
    expect(await countAttachments(ctx.querier)).toBe(2);

    // (2) Drive node A `registering -> degraded` on the self-reported
    // capability-health axis (Spec-003 line 76 — capability-validation failure
    // leaves the node `degraded`). EXPLICITLY permitted by the I-003-2 guard.
    // The response `state` is the server-derived full `NodeState` (Spec-003
    // line 72), so `degraded` here is the client-observable roster position.
    const degradeResponse = await sdk.capabilityUpdate({
      nodeId: DEGRADED_NODE_ID,
      capabilities: CAPABILITIES,
      healthChanges: {
        state: "degraded",
        reason: "provider driver failed capability validation",
      },
    });
    expect(degradeResponse.state).toBe("degraded");

    // (3) Drive node B to the healthy `online` contrast via the PERMITTED
    // recovery path `registering -> degraded -> online` (`degraded -> online`
    // is recovery — the node self-reports its capability-health back). The
    // direct `registering -> online` self-report is the I-003-2 refusal —
    // unit-covered in control-plane's attach-service tests, deliberately NOT
    // re-attempted here.
    const contrastDegrade = await sdk.capabilityUpdate({
      nodeId: HEALTHY_NODE_ID,
      capabilities: CAPABILITIES,
      healthChanges: {
        state: "degraded",
        reason: "transient validation failure before recovery",
      },
    });
    expect(contrastDegrade.state).toBe("degraded");
    const contrastRecover = await sdk.capabilityUpdate({
      nodeId: HEALTHY_NODE_ID,
      capabilities: CAPABILITIES,
      healthChanges: { state: "online" },
    });
    expect(contrastRecover.state).toBe("online");

    // (4) DISTINGUISHABILITY through the client (the AC2 thesis, Spec-003 line
    // 121): the latest client-observable `NodeState` for A reads `degraded`
    // while B's reads `online` — and A is NOT absent. The absence probe is a
    // capabilities-only `capabilityUpdate` (no `healthChanges`): it must still
    // RESOLVE A's single active attachment — a retired slot (detach/revoke)
    // would surface the typed 409 `runtimenode.capabilityupdate_conflict`
    // refusal instead — and a capabilities-only refresh writes the CURRENT
    // state back unchanged, so the response re-reads `degraded` without
    // mutating the node's position.
    const degradedVisibilityProbe = await sdk.capabilityUpdate({
      nodeId: DEGRADED_NODE_ID,
      capabilities: CAPABILITIES,
    });
    expect(degradedVisibilityProbe.nodeId).toBe(DEGRADED_NODE_ID);
    expect(degradedVisibilityProbe.state).toBe("degraded");
    expect(degradedVisibilityProbe.state).not.toBe(contrastRecover.state);

    // (5) DB anti-vacuity cross-check: EXACTLY the two attachment rows, reading
    // exactly {A: degraded, B: online} on the slot axis — the client-observed
    // distinguishability above is the persisted truth, not a response artifact.
    expect(await readAttachmentStatesByNode(ctx.querier)).toEqual({
      [DEGRADED_NODE_ID]: "degraded",
      [HEALTHY_NODE_ID]: "online",
    });
  });

  it("control-plane transport: heartbeat resolves null and lands the presence row; the liveness axis stays independent of the capability axis", async () => {
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const sdk = buildControlPlaneRuntimeNodeClient(buildRuntimeNodeDeps(ctx.querier));
    const attachResponse = await sdk.attach({
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: DEGRADED_NODE_ID,
      clientVersion: CLIENT_VERSION,
      capabilities: CAPABILITIES,
      healthState: "online",
    });
    expect(attachResponse.state).toBe("registering");

    // (1) Heartbeat END-TO-END: the SDK surfaces the no-content response as a
    // literal `null` resolution (`RuntimeNodeHeartbeatResponseSchema =
    // z.null()` — the wire payload is `result.data = null`, NOT a 204 empty
    // body). The explicit `: null` annotation pins the interface's
    // `Promise<null>` at the call site.
    const heartbeatResult: null = await sdk.heartbeat({
      nodeId: DEGRADED_NODE_ID,
      healthState: "online",
    });
    expect(heartbeatResult).toBeNull();

    // DB anti-vacuity: the heartbeat LANDED server-side — the
    // `runtime_node_presence` row exists with the daemon-reported
    // `health_state` and a non-null server-clock `last_heartbeat_at` (see the
    // `readPresenceRow` JSDoc for why the persistence layer is the correct
    // observation seam for this axis).
    const presenceAfterHeartbeat = await readPresenceRow(ctx.querier, DEGRADED_NODE_ID);
    expect(presenceAfterHeartbeat).toBeDefined();
    expect(presenceAfterHeartbeat?.health_state).toBe("online");
    expect(presenceAfterHeartbeat?.last_heartbeat_at).not.toBeNull();
    expect(presenceAfterHeartbeat?.last_heartbeat_at).toBeDefined();

    // (2) Capability-degrade the SAME node (the Spec-003 line 76 drive, as in
    // the sibling test) — the trigger for the axis-independence observation.
    const degradeResponse = await sdk.capabilityUpdate({
      nodeId: DEGRADED_NODE_ID,
      capabilities: CAPABILITIES,
      healthChanges: {
        state: "degraded",
        reason: "capability validation failed after a healthy heartbeat",
      },
    });
    expect(degradeResponse.state).toBe("degraded");

    // (3) AXIS INDEPENDENCE (Spec-003 line 72): the capability-`degraded`
    // write touched ONLY the slot axis (`runtime_node_attachments.state`) —
    // the liveness axis (`runtime_node_presence.health_state`) still reads the
    // heartbeat-reported `online`. Same node, two axes, two values, each owned
    // by its writer: a degradation on one never clobbers the other.
    const presenceAfterDegrade = await readPresenceRow(ctx.querier, DEGRADED_NODE_ID);
    expect(presenceAfterDegrade?.health_state).toBe("online");
    expect(await readAttachmentStatesByNode(ctx.querier)).toEqual({
      [DEGRADED_NODE_ID]: "degraded",
    });
  });
});

// ---------------------------------------------------------------------------
// I3 — mixed-version attach: at-floor reads/writes; below-floor reads but
// writes return VERSION_FLOOR_EXCEEDED; neither node is ejected
// (Spec-003 line 123 AC4 + I-003-1) — control-plane transport
// ---------------------------------------------------------------------------
//
// THE invariant scenario: T4.4 is the only Phase-4 task verifying a Plan-003
// invariant — I-003-1 (Plan-003 §Invariants, "Attach is admit-not-eject for
// below-floor daemons"). Its load-bearing property: a below-floor daemon MUST
// be admitted in read-only state and remain joined; any subsequent
// version-sensitive domain write MUST return typed `VERSION_FLOOR_EXCEEDED`;
// ejection MUST NOT be the response to a floor mismatch. Ejection would break
// the ADR-018 §Decision #4 graceful-degradation contract — a participant on a
// slightly-old daemon would lose ALL session visibility, not just write
// capability.
//
// What "reads" means on this surface: the Phase-4 runtime-node SDK has NO
// read/roster procedure, so the below-floor read-class evidence is (a) the
// attach response itself returning full data — admission WITH data readback
// (`readOnly` verdict, `state`, `attachmentId`) — and (b) `heartbeat`
// SUCCEEDING below-floor. Presence is version-INVARIANT by design
// (heartbeat-service.ts carries NO floor recheck: the fixed
// `{nodeId, healthState}` shape cannot carry a version-incompatible payload),
// so the read-only daemon keeps participating in liveness while write-blocked.
// The floor gates only version-SENSITIVE domain writes — the capability
// declaration (the Spec-003 line 53 refusal boundary).
//
// NO daemon-transport variant (same reasoning as I2): the `readOnly` verdict
// and the floor refusal are derived by the REAL `AttachService` against the
// session row — a scripted reply table would just echo whatever verdict we
// scripted, a tautology with no floor decision under test.

describe("I3 / Spec-003 AC4 (line 123) + I-003-1 — mixed-version attach: below-floor admitted read-only, write refused, never ejected", () => {
  it("control-plane transport: the at-floor daemon reads and writes; the below-floor daemon reads but its capability write returns typed VERSION_FLOOR_EXCEEDED; both stay joined", async () => {
    // (1) Seed the live session WITH a version floor — `min_client_version` is
    // `CLIENT_VERSION` ("1.4") itself, so the at-floor daemon attaches EQUAL
    // to the floor and the below-floor daemon ("1.3") sits one MINOR below it
    // (see the I3 fixture block).
    await seedParticipant(ctx.querier, PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID, CLIENT_VERSION);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const sdk = buildControlPlaneRuntimeNodeClient(buildRuntimeNodeDeps(ctx.querier));

    // (2) The AT-FLOOR daemon attaches read-write: its `clientVersion` EQUALS
    // the floor, and at-or-above admits `readOnly = false` (the floor gate is
    // strictly-below — attach-service.ts `#deriveReadOnly`).
    const atFloorAttach = await sdk.attach({
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: AT_FLOOR_NODE_ID,
      clientVersion: CLIENT_VERSION,
      capabilities: CAPABILITIES,
      healthState: "online",
    });
    expect(atFloorAttach.state).toBe("registering");
    expect(atFloorAttach.readOnly).toBe(false);

    // (3) The BELOW-FLOOR daemon is ADMITTED, not rejected (I-003-1
    // admit-in-read-only): the attach RESOLVES with a well-formed response —
    // full data readback, the first below-floor "read" — carrying the
    // server-derived `readOnly = true` PERMISSION verdict. The paired-object
    // assert pins the ORTHOGONALITY of the two response axes (Plan-003 T4.4):
    // `readOnly` is NOT a `NodeState` member — the read-only daemon holds a
    // NORMAL `state` (`registering`, identical to its at-floor peer) with the
    // permission flag riding alongside.
    const belowFloorAttach = await sdk.attach({
      sessionId: SESSION_ID,
      participantId: PARTICIPANT_ID,
      nodeId: BELOW_FLOOR_NODE_ID,
      clientVersion: BELOW_FLOOR_CLIENT_VERSION,
      capabilities: CAPABILITIES,
      healthState: "online",
    });
    expect({ state: belowFloorAttach.state, readOnly: belowFloorAttach.readOnly }).toEqual({
      state: "registering",
      readOnly: true,
    });
    expect(belowFloorAttach.attachmentId).toMatch(/[0-9a-f-]{36}/i);
    // DB anti-vacuity: BOTH attaches landed as attachment rows — the
    // below-floor admit is persisted, not a response-only artifact.
    expect(await countAttachments(ctx.querier)).toBe(2);

    // (4) BELOW-FLOOR READS SUCCEED (I-003-1: "the daemon remains joined and
    // may read session state"): heartbeat — the version-invariant read-class
    // operation (see the section header) — resolves the no-content `null` AND
    // the presence row lands server-side with the daemon-reported state.
    const belowFloorHeartbeat: null = await sdk.heartbeat({
      nodeId: BELOW_FLOOR_NODE_ID,
      healthState: "online",
    });
    expect(belowFloorHeartbeat).toBeNull();
    const belowFloorPresence = await readPresenceRow(ctx.querier, BELOW_FLOOR_NODE_ID);
    expect(belowFloorPresence).toBeDefined();
    expect(belowFloorPresence?.health_state).toBe("online");

    // (5) The AT-FLOOR daemon READS AND WRITES: heartbeat resolves, and a
    // capability declaration (capabilities-only refresh — the AC4
    // "version-sensitive domain write" class) SUCCEEDS with the state-carrying
    // response. This payload is kept IDENTICAL to the below-floor attempt in
    // (6), making the contrast a single-variable experiment: the ONLY
    // difference between the accepted and the refused write is the attach-time
    // `clientVersion`.
    const atFloorHeartbeat: null = await sdk.heartbeat({
      nodeId: AT_FLOOR_NODE_ID,
      healthState: "online",
    });
    expect(atFloorHeartbeat).toBeNull();
    const atFloorWrite = await sdk.capabilityUpdate({
      nodeId: AT_FLOOR_NODE_ID,
      capabilities: CAPABILITIES,
    });
    expect(atFloorWrite.nodeId).toBe(AT_FLOOR_NODE_ID);
    expect(atFloorWrite.state).toBe("registering");

    // (6) The BELOW-FLOOR WRITE IS REFUSED — typed, not generic (Spec-003
    // line 123 AC4): the IDENTICAL capability write rejects with the SDK's
    // typed `RuntimeNodeControlPlaneError` carrying the dotted wire code
    // `version.floor_exceeded` (asserted against the canonical
    // `VERSION_FLOOR_EXCEEDED_CODE` constant, never a string literal) and the
    // HTTP 409 CONFLICT provenance (error-contracts.md §Version row). The
    // capture-once `.then()` idiom (membershipClient.integration.test.ts
    // precedent) attempts the refused write exactly ONCE and asserts instance
    // + fields on the same rejection.
    const refusal = await sdk
      .capabilityUpdate({
        nodeId: BELOW_FLOOR_NODE_ID,
        capabilities: CAPABILITIES,
      })
      .then(
        () => {
          throw new Error("expected the below-floor capability write to be refused");
        },
        (error: unknown) => error,
      );
    expect(refusal).toBeInstanceOf(RuntimeNodeControlPlaneError);
    const typedRefusal = refusal as RuntimeNodeControlPlaneError;
    expect(typedRefusal.code).toBe(VERSION_FLOOR_EXCEEDED_CODE);
    expect(typedRefusal.httpStatus).toBe(409);
    // The refusal message names the refused node (provenance without
    // info-leak — host-runtime-node.test.ts pins the same property at the
    // wire layer).
    expect(typedRefusal.message).toContain(String(BELOW_FLOOR_NODE_ID));

    // (7) ADMIT-NOT-EJECT (the I-003-1 load-bearing property, observed AFTER
    // the refusal): BOTH attachment rows are still present in ACTIVE states —
    // the exact-map `toEqual` proves neither row went `offline`/`revoked` AND
    // no extra row materialized. The floor gate's throw rolled its transaction
    // back, leaving the below-floor row byte-unchanged at `registering`; the
    // at-floor capabilities-only refresh wrote `registering` back unchanged.
    expect(await readAttachmentStatesByNode(ctx.querier)).toEqual({
      [AT_FLOOR_NODE_ID]: "registering",
      [BELOW_FLOOR_NODE_ID]: "registering",
    });
    // Post-refusal liveness: the refused daemon can STILL heartbeat — it was
    // never detached for the floor mismatch (graceful degradation, not
    // ejection — ADR-018 §Decision #4 via I-003-1).
    const postRefusalHeartbeat: null = await sdk.heartbeat({
      nodeId: BELOW_FLOOR_NODE_ID,
      healthState: "online",
    });
    expect(postRefusalHeartbeat).toBeNull();
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
