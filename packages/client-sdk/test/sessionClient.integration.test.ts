// Plan-001 Phase 5 Lane A T5.1: integration tests for `sessionClient`
// across BOTH transports (daemon JSON-RPC + control-plane HTTP/SSE).
//
// Spec coverage — the four named acceptance criteria from Spec-001:
//   * I1 — `SessionCreate` then `SessionRead` returns identical session id
//          (round-trip — Spec-001 AC1, AC3).
//   * I2 — Second client `SessionJoin` against an existing session sees the
//          existing event history (no fork on join — Spec-001 AC4).
//   * I3 — `SessionSubscribe` yields events in sequence ASC across reconnect
//          (reconnect ordering — Spec-001 AC3, AC7-partial).
//   * I4 — Reconnect after lost stream restores from snapshot, NOT the
//          client cache (snapshot authority — Spec-001 AC6).
//
// Transport split rationale:
//   * I1 + I2 use the DAEMON transport. The harness is `JsonRpcClient` +
//     in-memory `ClientTransport` + a scripted "fake daemon" reply table.
//     This is fully synchronous, requires zero external state (no pglite,
//     which is NOT a client-sdk dep — see node-linker=isolated in .npmrc),
//     and exercises the same JSON-RPC envelope path the production daemon
//     transport uses.
//   * I3 + I4 use the CONTROL-PLANE transport. The harness is
//     `buildControlPlaneFetchHandler` + a scripted `eventStreamProvider`
//     with a recording cursor capture. This mirrors the established
//     pattern in `client-sdk/test/transport/sse-roundtrip.test.ts:401-448`
//     (the F-008b-1-09 unblock-contract test that pre-pinned the consumer
//     surface this file's production code now satisfies).
//
// Coverage gap acknowledged (does NOT block DONE): I1+I2 against the
// control-plane transport go unverified at the SDK level. The
// control-plane router itself has equivalent CRUD coverage in
// `control-plane/src/sessions/__tests__/session-router.test.ts` (T4..T6),
// and the SDK→fetch→router boundary is exercised by I3+I4's subscribe
// path. The pivot keeps the test surface within the package's declared
// dependency footprint without expanding scope.

import {
  type EventCursor,
  type EventEnvelopeVersion,
  JSONRPC_VERSION,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponseEnvelope,
  type MembershipId,
  type ParticipantId,
  type SessionCreateResponse,
  type SessionEvent,
  type SessionId,
  type SessionJoinResponse,
  type SessionReadResponse,
  SUBSCRIPTION_NOTIFY_METHOD,
  type SubscriptionId,
} from "@ai-sidekicks/contracts";
import {
  buildControlPlaneFetchHandler,
  type ControlPlaneDeps,
  type ControlPlaneEnv,
  type CreateSessionInput,
  type JoinSessionInput,
  type Querier,
  SessionDirectoryService,
  type SessionEventStreamProvider,
} from "@ai-sidekicks/control-plane";
import { tracked } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import {
  createControlPlaneSessionClient,
  createDaemonSessionClient,
  type SessionEventEnvelope,
} from "../src/sessionClient.js";
import { JsonRpcClient } from "../src/transport/jsonRpcClient.js";
import type { ClientTransport } from "../src/transport/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000a001" as SessionId;
const OWNER_PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-00000000b001" as ParticipantId;
const SECOND_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-00000000b002" as ParticipantId;
const OWNER_MEMBERSHIP_ID: MembershipId = "01970000-0000-7000-8000-00000000c001" as MembershipId;
const SECOND_MEMBERSHIP_ID: MembershipId = "01970000-0000-7000-8000-00000000c002" as MembershipId;
const SUBSCRIPTION_ID: SubscriptionId = "01970000-0000-7000-8000-00000000e001" as SubscriptionId;

// Event ids whose UUID format also satisfies `EventCursor.min(1).max(256)`.
// On the daemon transport, the SDK synthesizes `eventId = event.id`; on the
// control-plane transport the cursor is the producer's `tracked()` first
// arg. Here we make them numerically equal so the same test fixture
// validates monotonic-ASC across both paths conceptually.
const EVENT_ID_1 = "01970000-0000-7000-8000-00000000f001";
const EVENT_ID_2 = "01970000-0000-7000-8000-00000000f002";
const EVENT_ID_3 = "01970000-0000-7000-8000-00000000f003";
const CURSOR_1: EventCursor = EVENT_ID_1 as EventCursor;
const CURSOR_2: EventCursor = EVENT_ID_2 as EventCursor;
const CURSOR_3: EventCursor = EVENT_ID_3 as EventCursor;

const PROTOCOL_VERSION = "2026-05-01";

// ---------------------------------------------------------------------------
// Daemon transport harness — in-memory ClientTransport + scripted reply table
// ---------------------------------------------------------------------------
//
// Mirrors the `InMemoryTransport` pattern in
// `src/transport/__tests__/jsonRpcClient.test.ts:79-127` but layered with a
// programmable response router so each method-call can be scripted with a
// deterministic response shape. Synchronous dispatch keeps the tests free
// of timing-based flake.

interface ScriptedDaemonResponse {
  /** The method name this entry replies to. */
  readonly method: string;
  /** Build the response result given the inbound request. */
  readonly buildResult: (request: JsonRpcRequest) => unknown;
}

interface DaemonHarness {
  readonly transport: InMemoryDaemonTransport;
  readonly client: JsonRpcClient;
  readonly notify: (params: unknown) => void;
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
      // Notifications carry no id — no response expected. Skip.
      return;
    }
    const reply = this.#scripted.find((entry) => entry.method === envelope.method);
    if (reply === undefined) {
      // Unscripted method — surface as a JSON-RPC error so the test sees
      // the call site that needs scripting (rather than hanging on the
      // pending entry).
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

function buildDaemonHarness(scripted: ScriptedDaemonResponse[]): DaemonHarness {
  const transport = new InMemoryDaemonTransport(scripted);
  const client = new JsonRpcClient(transport, { protocolVersion: PROTOCOL_VERSION });
  return {
    transport,
    client,
    notify: (params): void => {
      transport.dispatchInbound({
        jsonrpc: JSONRPC_VERSION,
        method: SUBSCRIPTION_NOTIFY_METHOD,
        params,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Control-plane harness — buildControlPlaneFetchHandler + scripted provider
// ---------------------------------------------------------------------------

const PASSING_ENV: ControlPlaneEnv = {
  CONTROL_PLANE_BOOTSTRAP_ENABLED: "1",
  ENVIRONMENT: "development",
};

const NEVER_REACHED = (symbol: string): Error =>
  new Error(`subscribe path must not consume CRUD-side dependency ${symbol}`);

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

function buildSubscribeOnlyDeps(provider: SessionEventStreamProvider): ControlPlaneDeps {
  return {
    directoryService: new SessionDirectoryService(throwingQuerier),
    resolveCurrentParticipantId: (): ParticipantId => {
      throw NEVER_REACHED("resolveCurrentParticipantId");
    },
    generateSessionId: (): SessionId => {
      throw NEVER_REACHED("generateSessionId");
    },
    resolveIdentityHandle: (): ParticipantId => {
      throw NEVER_REACHED("resolveIdentityHandle");
    },
    eventStreamProvider: provider,
  };
}

// CRUD harness — fixture SessionDirectoryService whose three methods return
// canonical responses without touching the throwing Querier. The class is
// nominally typed (`#querier` private field), so a structural literal cannot
// satisfy `ControlPlaneDeps.directoryService`; subclassing the real class with
// a throwing `Querier` is the same posture host.ts:121-142 takes for the
// production-placeholder wiring. The overrides do not call `super`, so the
// throwing Querier is never reached on the happy path.
class FixtureDirectoryService extends SessionDirectoryService {
  readonly #createResponse: SessionCreateResponse;
  readonly #readResponse: SessionReadResponse;
  readonly #joinResponse: SessionJoinResponse;
  public lastCreateInput: CreateSessionInput | undefined = undefined;
  public lastReadSessionId: SessionId | undefined = undefined;
  public lastJoinInput: JoinSessionInput | undefined = undefined;

  constructor(responses: {
    create: SessionCreateResponse;
    read: SessionReadResponse;
    join: SessionJoinResponse;
  }) {
    super(throwingQuerier);
    this.#createResponse = responses.create;
    this.#readResponse = responses.read;
    this.#joinResponse = responses.join;
  }

  override async createSession(input: CreateSessionInput): Promise<SessionCreateResponse> {
    this.lastCreateInput = input;
    return this.#createResponse;
  }

  override async readSession(sessionId: SessionId): Promise<SessionReadResponse | null> {
    this.lastReadSessionId = sessionId;
    return this.#readResponse;
  }

  override async joinSession(input: JoinSessionInput): Promise<SessionJoinResponse | null> {
    this.lastJoinInput = input;
    return this.#joinResponse;
  }
}

function buildCrudOnlyDeps(directoryService: FixtureDirectoryService): ControlPlaneDeps {
  return {
    directoryService,
    // Both stubs return the same ParticipantId so the join procedure's
    // `resolved !== current` UNAUTHORIZED guard at session-router.factory.ts:128
    // is satisfied for the happy-path smoke tests.
    resolveCurrentParticipantId: (): ParticipantId => OWNER_PARTICIPANT_ID,
    generateSessionId: (): SessionId => SESSION_ID,
    resolveIdentityHandle: (): ParticipantId => OWNER_PARTICIPANT_ID,
    eventStreamProvider: () => {
      throw new Error("CRUD smoke tests must not exercise the eventStreamProvider");
    },
  };
}

interface RecordedSubscribeCall {
  afterCursor: EventCursor | undefined;
  callCount: number;
}

interface ScriptedRow {
  readonly cursor: EventCursor;
  readonly event: SessionEvent;
}

function makeRecordingProvider(scripted: readonly ScriptedRow[]): {
  provider: SessionEventStreamProvider;
  recorded: RecordedSubscribeCall;
} {
  const recorded: RecordedSubscribeCall = { afterCursor: undefined, callCount: 0 };
  const provider: SessionEventStreamProvider = async function* (params) {
    recorded.callCount += 1;
    recorded.afterCursor = params.afterCursor;
    let startIdx = 0;
    if (params.afterCursor !== undefined) {
      const matchedIdx = scripted.findIndex((r) => r.cursor === params.afterCursor);
      // findIndex returns -1 when no row matches; in that case we yield
      // from the top, but the test asserts `recorded.afterCursor` so an
      // unexpected cursor surfaces directly.
      startIdx = matchedIdx === -1 ? 0 : matchedIdx + 1;
    }
    for (let i = startIdx; i < scripted.length; i++) {
      if (params.signal.aborted) return;
      const row = scripted[i]!;
      yield tracked(row.cursor, row.event);
    }
  };
  return { provider, recorded };
}

// ---------------------------------------------------------------------------
// Event fixtures — schema-valid for the discriminated union in event.ts
// ---------------------------------------------------------------------------

function makeSessionCreatedEvent(id: string, sequence: number): SessionEvent {
  return {
    type: "session.created",
    category: "session_lifecycle",
    id,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-04-30T12:00:00.000Z",
    actor: null,
    version: "1.0" as EventEnvelopeVersion,
    payload: {
      sessionId: SESSION_ID,
      config: { topic: `seq-${id}` },
      metadata: {},
    },
  };
}

function makeMembershipCreatedEvent(
  id: string,
  sequence: number,
  participantId: ParticipantId,
  membershipId: MembershipId,
  role: "owner" | "collaborator",
): SessionEvent {
  // Note: `membership.created`'s payload does NOT carry `sessionId` (per
  // event.ts:263-275 — it's only on the envelope's common fields). The
  // `.strict()` modifier on the payload schema rejects unknown keys, so
  // adding a `sessionId` to payload is a contract break.
  return {
    type: "membership.created",
    category: "membership_change",
    id,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-04-30T12:00:01.000Z",
    actor: null,
    version: "1.0" as EventEnvelopeVersion,
    payload: {
      membershipId,
      participantId,
      identityHandle: participantId,
      role,
    },
  };
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

// ---------------------------------------------------------------------------
// I1 — SessionCreate then SessionRead returns identical session id
// (Spec-001 AC1, AC3) — daemon transport
// ---------------------------------------------------------------------------

describe("I1 / Spec-001 AC1+AC3 — SessionCreate then SessionRead returns identical session id (round-trip)", () => {
  it("daemon transport: create returns sessionId X; read({X}) returns the same X with persisted snapshot", async () => {
    // The scripted "fake daemon": session.create returns a synthesized
    // SessionCreateResponse; session.read returns a SessionReadResponse
    // whose `session.id` MUST equal the create-time id (the no-fork
    // round-trip contract).
    const harness = buildDaemonHarness([
      {
        method: "session.create",
        buildResult: (): unknown => ({
          sessionId: SESSION_ID,
          state: "provisioning",
          memberships: [
            {
              id: OWNER_MEMBERSHIP_ID,
              participantId: OWNER_PARTICIPANT_ID,
              role: "owner",
              state: "active",
            },
          ],
          channels: [],
        }),
      },
      {
        method: "session.read",
        buildResult: (request): unknown => {
          // Echo the requested sessionId back through the snapshot — the
          // round-trip claim is end-to-end identity preservation, NOT
          // server-side substitution. If a future SDK regression silently
          // replaced `sessionId`, this echo would surface the bug.
          const requestedSessionId = (
            (request.params as { sessionId: SessionId } | undefined) ?? { sessionId: SESSION_ID }
          ).sessionId;
          return {
            session: {
              id: requestedSessionId,
              state: "provisioning",
              config: { topic: "round-trip" },
              metadata: {},
              createdAt: "2026-04-30T12:00:00.000Z",
              updatedAt: "2026-04-30T12:00:00.000Z",
            },
            timelineCursors: {
              latest: CURSOR_1,
            },
          };
        },
      },
    ]);
    const sdk = createDaemonSessionClient(harness.client);

    const createResponse = await sdk.create({});
    expect(createResponse.sessionId).toBe(SESSION_ID);
    expect(createResponse.state).toBe("provisioning");
    expect(createResponse.memberships).toHaveLength(1);

    const readResponse = await sdk.read({ sessionId: createResponse.sessionId });
    // I1 core assertion: round-trip identity. The id surfaced from create
    // is the SAME id read returns inside its snapshot.
    expect(readResponse.session.id).toBe(createResponse.sessionId);
    expect(readResponse.session.state).toBe("provisioning");
    expect(readResponse.session.config).toEqual({ topic: "round-trip" });
  });
});

// ---------------------------------------------------------------------------
// I2 — Second client SessionJoin against an existing session sees existing
// event history (no fork on join — Spec-001 AC4) — daemon transport
// ---------------------------------------------------------------------------

describe("I2 / Spec-001 AC4 — Second client join sees existing event history (no fork on join)", () => {
  it("daemon transport: client A creates, client B joins — both clients' subscribe yields the SAME event sequence", async () => {
    // Both client A and client B subscribe via fresh daemon connections.
    // The "no-fork" claim is that B's subscribe (initiated AFTER A's join)
    // sees the same event history A sees — there's a single canonical
    // session timeline, not divergent per-client streams. We model this
    // with two harnesses sharing a scripted history; both replay the same
    // three events on subscribe.
    const sharedHistory: SessionEvent[] = [
      makeSessionCreatedEvent(EVENT_ID_1, 0),
      makeMembershipCreatedEvent(EVENT_ID_2, 1, OWNER_PARTICIPANT_ID, OWNER_MEMBERSHIP_ID, "owner"),
      makeMembershipCreatedEvent(
        EVENT_ID_3,
        2,
        SECOND_PARTICIPANT_ID,
        SECOND_MEMBERSHIP_ID,
        "collaborator",
      ),
    ];

    const buildHarness = (): DaemonHarness =>
      buildDaemonHarness([
        {
          method: "session.create",
          buildResult: (): unknown => ({
            sessionId: SESSION_ID,
            state: "provisioning",
            memberships: [
              {
                id: OWNER_MEMBERSHIP_ID,
                participantId: OWNER_PARTICIPANT_ID,
                role: "owner",
                state: "active",
              },
            ],
            channels: [],
          }),
        },
        {
          method: "session.join",
          buildResult: (): unknown => ({
            // I2 wire-level invariant: join returns the EXISTING sessionId,
            // not a freshly-minted one (per BL-069 invariant — no silent
            // forks on join).
            sessionId: SESSION_ID,
            participantId: SECOND_PARTICIPANT_ID,
            membershipId: SECOND_MEMBERSHIP_ID,
            sharedMetadata: {},
          }),
        },
        {
          method: "session.subscribe",
          buildResult: (): unknown => ({ subscriptionId: SUBSCRIPTION_ID }),
        },
      ]);

    const harnessA = buildHarness();
    const harnessB = buildHarness();
    const sdkA = createDaemonSessionClient(harnessA.client);
    const sdkB = createDaemonSessionClient(harnessB.client);

    // Client A creates the session. Client B joins it — second join MUST
    // return the SAME sessionId (no fork).
    const created = await sdkA.create({});
    const joined = await sdkB.join({
      sessionId: created.sessionId,
      identityHandle: SECOND_PARTICIPANT_ID,
    });
    expect(joined.sessionId).toBe(created.sessionId);

    // Both A and B subscribe; both see the same history. We drive the
    // notify frames from outside the SDK — modeling the daemon's
    // streaming primitive emitting the same event log for both
    // subscriptions.
    //
    // Order discipline: `daemonSubscribe` is `async function*`, so its
    // body (which calls `client.subscribe(...)` to issue the wire
    // request) does NOT execute on construction. It executes only when
    // something pulls from the iterator. We therefore obtain the
    // iterators FIRST and call `next()` once per iterator to kick the
    // generator into running its prelude (init request out, init
    // response in, subscription registered) BEFORE we deliver any
    // notify frames or close the transport. Without this priming, the
    // notifies would arrive while `#subscriptions` is empty and the
    // transport-close would fire `JsonRpcTransportClosedError` against
    // an already-closed client when the generator finally tried to
    // call `client.subscribe()`.
    const iterA = sdkA.subscribe({ sessionId: created.sessionId })[Symbol.asyncIterator]();
    const iterB = sdkB.subscribe({ sessionId: created.sessionId })[Symbol.asyncIterator]();
    const firstA = iterA.next();
    const firstB = iterB.next();

    // Fire the scripted history on each transport. Sync dispatch — by the
    // time `notify(...)` returns, the SDK's queue has the value parked.
    for (const event of sharedHistory) {
      harnessA.notify({ subscriptionId: SUBSCRIPTION_ID, value: event });
      harnessB.notify({ subscriptionId: SUBSCRIPTION_ID, value: event });
    }
    // Close both transports so the for-await loops below terminate. The
    // SDK's transport-close path completes any in-flight subscriptions
    // with `undefined` (clean close, since `reason === undefined`), so
    // the generator's `for await` exits naturally and the cursor-
    // synthesizing wrapper drains.
    await harnessA.transport.close();
    await harnessB.transport.close();

    // Drain. The first `next()` already issued; we collect it and
    // continue with the iterator until done.
    const eventsA: SessionEventEnvelope[] = [];
    const eventsB: SessionEventEnvelope[] = [];
    let nextA = await firstA;
    while (!nextA.done) {
      eventsA.push(nextA.value);
      nextA = await iterA.next();
    }
    let nextB = await firstB;
    while (!nextB.done) {
      eventsB.push(nextB.value);
      nextB = await iterB.next();
    }

    expect(eventsA).toHaveLength(sharedHistory.length);
    expect(eventsB).toHaveLength(sharedHistory.length);
    // I2 core assertion: identical event sequence across both clients.
    expect(eventsB.map((e) => e.event.id)).toEqual(eventsA.map((e) => e.event.id));
    // Both event histories carry the SAME fork-detection signal: the
    // membership.created for the SECOND participant references the
    // ORIGINAL session, not a newly-minted one.
    const secondMembership = eventsB.find(
      (e) => e.event.type === "membership.created" && e.event.id === EVENT_ID_3,
    );
    expect(secondMembership).toBeDefined();
    if (secondMembership !== undefined && secondMembership.event.type === "membership.created") {
      expect(secondMembership.event.sessionId).toBe(created.sessionId);
    }
  });
});

// ---------------------------------------------------------------------------
// C1 / Codex RT-1 Finding 1 — daemon subscribe with pre-aborted signal does
// NOT touch the wire (zero envelopes sent; underlying client.subscribe never
// invoked). Regression test for the bug where the pre-abort check ran AFTER
// `client.subscribe()` already serialized the `session.subscribe` envelope
// and reserved a server-side `StreamingPrimitive` entry — defeating the
// stated fast-exit contract for timeout / circuit-breaker callers.
// ---------------------------------------------------------------------------

describe("C1 / Codex RT-1 Finding 1 — daemon subscribe pre-aborted signal does not call client.subscribe", () => {
  it("daemon transport: when options.signal is already aborted, no wire envelope is sent and the async iterable yields zero values", async () => {
    // Build a harness with NO scripted session.subscribe response — if the
    // pre-abort check regressed and a `session.subscribe` envelope leaked
    // through, the unscripted-method path would dispatch a JSON-RPC error
    // back, surfacing as a rejection — but more directly, the empty
    // sentEnvelopes assertion catches it first.
    const harness = buildDaemonHarness([]);
    const sdk = createDaemonSessionClient(harness.client);
    // Spy on the JsonRpcClient's `subscribe` method to assert it was never
    // invoked. The spy calls through (vi.spyOn default), so it is NOT what
    // prevents the wire side-effect — that is the pre-abort `return` in
    // `daemonSubscribe`. The spy is the most direct test of the Codex
    // finding's wording ("calls `client.subscribe(...)` before the abort
    // check runs"); the `sentEnvelopes` assertion is the most direct test
    // of the stated harm ("sends `session.subscribe` on the wire").
    const subscribeSpy = vi.spyOn(harness.client, "subscribe");

    const ac = new AbortController();
    ac.abort();

    const events = await drain(sdk.subscribe({ sessionId: SESSION_ID, signal: ac.signal }));

    // C1 core assertion #1: zero values yielded — the async generator
    // returned at the pre-abort check before producing anything.
    expect(events).toEqual([]);
    // C1 core assertion #2: the underlying JsonRpcClient.subscribe was never
    // called — the SDK never reserved a server-side subscription handle.
    expect(subscribeSpy).not.toHaveBeenCalled();
    // C1 core assertion #3: zero JSON-RPC envelopes reached the transport —
    // proves no `session.subscribe` request was serialized to the wire.
    expect(harness.transport.sentEnvelopes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// I3 — SessionSubscribe yields events in sequence ASC across reconnect
// (Spec-001 AC3, AC7-partial) — control-plane transport
// ---------------------------------------------------------------------------

describe("I3 / Spec-001 AC3+AC7 — SessionSubscribe yields events in sequence ASC across reconnect", () => {
  it("control-plane transport: cold subscribe yields all events ASC; reconnect with afterCursor resumes ASC after that cursor", async () => {
    // Build the scripted history. Sequences are 0, 1, 2 (monotonically
    // ascending). The recording provider synthesizes the resume semantics:
    // when `afterCursor=CURSOR_1`, it yields rows with index > 1, i.e.
    // ONLY the post-CURSOR_1 events.
    const scripted: ScriptedRow[] = [
      { cursor: CURSOR_1, event: makeSessionCreatedEvent(EVENT_ID_1, 0) },
      { cursor: CURSOR_2, event: makeSessionCreatedEvent(EVENT_ID_2, 1) },
      { cursor: CURSOR_3, event: makeSessionCreatedEvent(EVENT_ID_3, 2) },
    ];
    const { provider, recorded } = makeRecordingProvider(scripted);
    const handler = buildControlPlaneFetchHandler(buildSubscribeOnlyDeps(provider));
    const fetcher = (req: Request): Promise<Response> => handler(req, PASSING_ENV);
    const sdk = createControlPlaneSessionClient({
      fetcher,
      baseUrl: "https://control-plane.test",
    });

    // First (cold) subscribe — no afterCursor. Provider sees undefined
    // and yields everything.
    const cold = await drain(sdk.subscribe({ sessionId: SESSION_ID }));
    expect(recorded.callCount).toBe(1);
    expect(recorded.afterCursor).toBeUndefined();
    expect(cold).toHaveLength(3);
    // I3 core assertion #1: events arrive in monotonically increasing
    // order. Sequences 0, 1, 2; cursors CURSOR_1, CURSOR_2, CURSOR_3.
    expect(cold.map((e) => e.event.sequence)).toEqual([0, 1, 2]);
    expect(cold.map((e) => e.eventId)).toEqual([CURSOR_1, CURSOR_2, CURSOR_3]);

    // Second (reconnect) subscribe — caller supplies the LAST cursor it
    // observed. Provider resumes ASC from that point; the consumer sees
    // ONLY the events strictly after CURSOR_2 — i.e. the third row.
    const resumed = await drain(sdk.subscribe({ sessionId: SESSION_ID, afterCursor: CURSOR_2 }));
    expect(recorded.callCount).toBe(2);
    expect(recorded.afterCursor).toBe(CURSOR_2);
    // I3 core assertion #2: after-reconnect order is still ASC and starts
    // strictly after the supplied cursor.
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.event.sequence).toBe(2);
    expect(resumed[0]?.eventId).toBe(CURSOR_3);
  });
});

// ---------------------------------------------------------------------------
// I4 — Reconnect after lost stream restores from snapshot, NOT client cache
// (Spec-001 AC6) — control-plane transport
// ---------------------------------------------------------------------------

describe("I4 / Spec-001 AC6 — Reconnect after lost stream restores from snapshot, NOT client cache", () => {
  it("control-plane transport: server-side post-reconnect history MUTATES underneath the consumer; reconnect surfaces server's authoritative state, not the client's cache", async () => {
    // The snapshot-authority claim: when the client reconnects, its
    // payload comes from the SERVER's projection, not from any local
    // cache. We falsify "the SDK silently caches" by mutating the
    // server-side scripted history BETWEEN the cold subscribe and the
    // reconnect. If the SDK cached, the reconnect would surface the OLD
    // event payload; if it goes back to the wire (as required), it
    // surfaces the NEW server-side payload.

    // Initial server-side history.
    let scripted: ScriptedRow[] = [
      { cursor: CURSOR_1, event: makeSessionCreatedEvent(EVENT_ID_1, 0) },
      { cursor: CURSOR_2, event: makeSessionCreatedEvent(EVENT_ID_2, 1) },
    ];

    // The provider closes over `scripted` by reference, so changing the
    // outer binding REBINDS what subsequent calls see. We use this to
    // model the snapshot-authority contract: between cold subscribe and
    // reconnect, the server-side state evolves; the client's reconnect
    // MUST reflect that evolution.
    const recorded: RecordedSubscribeCall = { afterCursor: undefined, callCount: 0 };
    const provider: SessionEventStreamProvider = async function* (params) {
      recorded.callCount += 1;
      recorded.afterCursor = params.afterCursor;
      const currentScript = scripted;
      let startIdx = 0;
      if (params.afterCursor !== undefined) {
        const matchedIdx = currentScript.findIndex((r) => r.cursor === params.afterCursor);
        startIdx = matchedIdx === -1 ? 0 : matchedIdx + 1;
      }
      for (let i = startIdx; i < currentScript.length; i++) {
        if (params.signal.aborted) return;
        const row = currentScript[i]!;
        yield tracked(row.cursor, row.event);
      }
    };

    const handler = buildControlPlaneFetchHandler(buildSubscribeOnlyDeps(provider));
    const fetcher = (req: Request): Promise<Response> => handler(req, PASSING_ENV);
    const sdk = createControlPlaneSessionClient({
      fetcher,
      baseUrl: "https://control-plane.test",
    });

    // Cold subscribe — yields the initial 2 events.
    const cold = await drain(sdk.subscribe({ sessionId: SESSION_ID }));
    expect(cold).toHaveLength(2);
    expect(cold.map((e) => e.eventId)).toEqual([CURSOR_1, CURSOR_2]);

    // Stream "lost": between cold and reconnect, the server's
    // authoritative projection acquires a third event. The client's
    // reconnect MUST surface this (snapshot authority — the server's
    // post-CURSOR_2 state is the authoritative one, even though the
    // cached cold-stream events do not include it).
    // Build the revised CURSOR_2 event explicitly (rather than via spread +
    // payload override) — spreading from `makeSessionCreatedEvent` widens the
    // discriminator type and TS rejects the resulting object against the
    // discriminated union. Direct construction keeps the literal `type`
    // field load-bearing for the union narrowing.
    const revisedCursor2Event: SessionEvent = {
      type: "session.created",
      category: "session_lifecycle",
      id: EVENT_ID_2,
      sessionId: SESSION_ID,
      sequence: 1,
      occurredAt: "2026-04-30T12:00:00.000Z",
      actor: null,
      version: "1.0" as EventEnvelopeVersion,
      payload: {
        sessionId: SESSION_ID,
        config: { topic: "snapshot-evolved" },
        metadata: { revisedBy: "server" },
      },
    };
    const reconnectScripted: ScriptedRow[] = [
      // The server's history through CURSOR_2 stays, BUT we modify the
      // CURSOR_2 event's payload to prove the SDK does not return a
      // cached version. (If it cached, asking with afterCursor=CURSOR_1
      // would yield OLD-CURSOR_2. The wire round-trip ensures NEW.)
      {
        cursor: CURSOR_2,
        event: revisedCursor2Event,
      },
      {
        cursor: CURSOR_3,
        event: makeMembershipCreatedEvent(
          EVENT_ID_3,
          2,
          SECOND_PARTICIPANT_ID,
          SECOND_MEMBERSHIP_ID,
          "collaborator",
        ),
      },
    ];
    scripted = reconnectScripted;

    // Reconnect with the LAST cursor the client retains (CURSOR_1 — the
    // one BEFORE CURSOR_2). The provider resumes from CURSOR_2's payload
    // forward. If the SDK shadowed the wire with a local cache, the
    // CURSOR_2 event in the reconnect would carry the OLD payload
    // (`topic: "seq-..."`). Because the SDK goes back to the wire, the
    // CURSOR_2 event surfaces the server's NEW (revised) payload.
    const reconnected = await drain(
      sdk.subscribe({ sessionId: SESSION_ID, afterCursor: CURSOR_1 }),
    );
    expect(recorded.callCount).toBe(2);
    expect(recorded.afterCursor).toBe(CURSOR_1);
    expect(reconnected).toHaveLength(2);

    // I4 core assertion: the reconnect surfaces the SERVER's authoritative
    // payload, not the cached one. The CURSOR_2 event's payload was
    // mutated server-side between the two subscribes; the SDK MUST report
    // the new value.
    const reconnectedCursor2 = reconnected.find((e) => e.eventId === CURSOR_2);
    expect(reconnectedCursor2).toBeDefined();
    if (reconnectedCursor2 !== undefined && reconnectedCursor2.event.type === "session.created") {
      expect(reconnectedCursor2.event.payload.config).toEqual({ topic: "snapshot-evolved" });
      expect(reconnectedCursor2.event.payload.metadata).toEqual({ revisedBy: "server" });
    }
    // Stream now also includes the new third event the server appended
    // BETWEEN cold and reconnect — additional proof that the SDK reads
    // server state, not client state.
    expect(reconnected[1]?.eventId).toBe(CURSOR_3);
    expect(reconnected[1]?.event.type).toBe("membership.created");
  });
});

// ---------------------------------------------------------------------------
// C2 / Codex RT-1 Finding 2 — control-plane SSE parser handles CRLF separators
// (WHATWG HTML §9.2.6 — line terminators may be CRLF, LF, or CR; this fix
// covers CRLF + LF, the two forms the bug report cited and the two tRPC's
// producer plus typical proxies emit). Regression test for the bug where the
// parser only matched LF (`\n\n`) frame separators and never emitted any
// frame for a CRLF-terminated stream — making `subscribe()` appear stuck
// until connection close.
// ---------------------------------------------------------------------------

describe("C2 / Codex RT-1 Finding 2 — control-plane SSE parser handles CRLF frame separators", () => {
  it("control-plane transport: CRLF-terminated SSE frames yield events in order with their tRPC tracked cursors", async () => {
    // Reuse the schema-valid event fixtures so any future regression in
    // `SessionEventSchema` shape surfaces as a Zod-parse failure here, not
    // a false-pass against a hand-rolled stub event.
    const event1 = makeSessionCreatedEvent(EVENT_ID_1, 0);
    const event2 = makeSessionCreatedEvent(EVENT_ID_2, 1);

    // Build the SSE body with CRLF line terminators. tRPC tracked envelope
    // shape is `id: <cursor>\r\ndata: <JSON>\r\n\r\n` — no `event:` field
    // (matches `parseSseFrame`'s tracked-envelope branch in sessionClient.ts).
    // We encode the body as a single Uint8Array — splitting across multiple
    // chunks is not necessary for this regression: the bug was the
    // separator regex, not chunking. The TextDecoder pass-through inside
    // `controlPlaneSubscribe` accumulates bytes regardless of chunk
    // boundaries; pinning a multi-chunk path is orthogonal.
    const sseBody = [
      `id: ${CURSOR_1}\r\n`,
      `data: ${JSON.stringify(event1)}\r\n`,
      `\r\n`,
      `id: ${CURSOR_2}\r\n`,
      `data: ${JSON.stringify(event2)}\r\n`,
      `\r\n`,
    ].join("");
    const bodyBytes = new TextEncoder().encode(sseBody);

    // The fake fetcher ignores the request and returns a fixed-body
    // Response. `text/event-stream` Content-Type is set defensively to
    // mirror what production servers emit; the SDK doesn't currently
    // gate on it, but a future tightening that does would catch a
    // regression here rather than in production.
    const fetcher = (_request: Request): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bodyBytes);
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    };

    const sdk = createControlPlaneSessionClient({
      fetcher,
      baseUrl: "https://control-plane.test",
    });

    const events = await drain(sdk.subscribe({ sessionId: SESSION_ID }));

    // C2 core assertion #1: BOTH frames were yielded — pre-fix the parser
    // never matched a frame boundary on `\r\n\r\n`, so `events` would be
    // empty (or hang depending on stream closure). Length-2 proves the
    // CRLF-aware boundary regex matched both frame ends.
    expect(events).toHaveLength(2);
    // C2 core assertion #2: cursors and order preserved — proves the
    // intra-frame line splitter (also CRLF-aware) correctly separated
    // `id:` from `data:` inside each CRLF-terminated frame.
    expect(events.map((e) => e.eventId)).toEqual([CURSOR_1, CURSOR_2]);
    expect(events[0]?.event.id).toBe(EVENT_ID_1);
    expect(events[1]?.event.id).toBe(EVENT_ID_2);
    expect(events[0]?.event.sequence).toBe(0);
    expect(events[1]?.event.sequence).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C3 / Codex RT-2 Finding 3 — control-plane subscribe with pre-aborted signal
// does NOT call the fetcher (zero HTTP requests issued). Symmetric with C1's
// daemon-path coverage. Regression test for the bug where the control-plane
// path called `fetcher(new Request(...))` unconditionally — even when the
// caller's signal was already aborted — sending a subscribe HTTP request on
// the wire and (for custom fetchers that don't fully honor `Request.signal`)
// crossing the network despite the cancel intent.
// ---------------------------------------------------------------------------

describe("C3 / Codex RT-2 Finding 3 — control-plane subscribe pre-aborted signal does not call fetcher", () => {
  it("control-plane transport: when options.signal is already aborted, the fetcher is never invoked and the async iterable yields zero values", async () => {
    // The fake fetcher returns a valid SSE response (mirroring C2's fixture).
    // If the pre-abort guard regresses and the fetcher IS called, the test
    // still fails on the `not.toHaveBeenCalled()` assertion below — the
    // valid-response choice is just so the failure mode reads as "fetcher was
    // unexpectedly called" rather than as a noisy TypeError on `.status`
    // access against a `vi.fn().mockReturnValue(undefined)` default. This
    // matches the C1 spy-calls-through pattern: the test's purpose is the
    // call-count assertion, not exercising the post-call path.
    const event1 = makeSessionCreatedEvent(EVENT_ID_1, 0);
    const sseBody = `id: ${CURSOR_1}\ndata: ${JSON.stringify(event1)}\n\n`;
    const bodyBytes = new TextEncoder().encode(sseBody);
    const fetcher = vi.fn((_request: Request): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bodyBytes);
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    });
    const sdk = createControlPlaneSessionClient({
      fetcher,
      baseUrl: "https://control-plane.test",
    });

    const ac = new AbortController();
    ac.abort();

    const events = await drain(sdk.subscribe({ sessionId: SESSION_ID, signal: ac.signal }));

    // C3 core assertion #1: zero values yielded — the async generator
    // returned at the pre-abort check before consuming any stream data.
    expect(events).toEqual([]);
    // C3 core assertion #2: the fetcher was never called — proves no HTTP
    // request reached the wire (the actual harm cited in Codex's finding for
    // custom fetchers that don't honor `Request.signal`).
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C4 / Codex RT-2 Finding 4 — control-plane SSE frame `id` is validated via
// EventCursorSchema (NOT cast unsafely). Regression test for the bug where the
// SDK applied `frame.id as EventCursor` without a Zod parse — letting empty
// strings, oversized values, or other malformed wire input flow through as
// "valid" replay cursors and break the `afterCursor`-based reconnect contract
// on the next subscribe.
// ---------------------------------------------------------------------------

describe("C4 / Codex RT-2 Finding 4 — control-plane SSE rejects malformed frame id via EventCursorSchema", () => {
  it("control-plane transport: SSE frame with empty `id` value rejects with ZodError naming the cursor schema constraint", async () => {
    // The malformed frame uses `id:` (empty value, parses to "") with a
    // VALID `data:` payload. The empty `id` survives the existing
    // `frame.id === undefined` guard (parseSseFrame sets it to "" not
    // undefined when the colon has no value), so without the Zod parse the
    // unsafe `as EventCursor` would yield `eventId: ""` — exactly the
    // contract-breaking surface Codex flagged. With the fix, EventCursorSchema
    // (`z.string().min(1).max(256)`) rejects on `.min(1)`.
    //
    // We make `data:` a fully-valid serialized SessionEvent so the parse
    // failure isolates to the cursor surface — if `data:` were also broken,
    // the test could pass for the wrong reason (event-payload parse fails
    // first). The cursor parse runs BEFORE the event parse in the production
    // code (per the ordering chosen in this PR), but defense-in-depth on the
    // fixture keeps the test diagnostic.
    const validEvent = makeSessionCreatedEvent(EVENT_ID_1, 0);
    const sseBody = `id:\ndata: ${JSON.stringify(validEvent)}\n\n`;
    const bodyBytes = new TextEncoder().encode(sseBody);
    const fetcher = (_request: Request): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bodyBytes);
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    };
    const sdk = createControlPlaneSessionClient({
      fetcher,
      baseUrl: "https://control-plane.test",
    });

    // C4 core assertion #1: iteration THROWS with a ZodError type. Pinning
    // the error TYPE (not the message text) keeps the test stable across
    // future Zod version bumps that may reword the constraint message; the
    // type contract is what matters for the trust-boundary discipline.
    await expect(drain(sdk.subscribe({ sessionId: SESSION_ID }))).rejects.toThrow(ZodError);

    // C4 core assertion #2: the rejection's message names the schema's
    // length constraint (the `.min(1)` floor of EVENT_CURSOR_MAX_LEN). We
    // match a regex on the "too small" / >=1 phrasing rather than pinning a
    // literal Zod string — Zod v4's wording is "Too small: expected string
    // to have >=1 characters" but the project has churned across major
    // versions before (v3 said "String must contain at least 1 character(s)").
    // This regex matches either phrasing on the digit "1" + a length-related
    // token, surfacing a citation-mismatch failure (rather than a false
    // positive on a generic ZodError) if the underlying schema's floor
    // changes from 1 to something else.
    await expect(drain(sdk.subscribe({ sessionId: SESSION_ID }))).rejects.toThrow(
      /(>=\s*1\s+characters?|at least 1\s+character|too_small)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// C5 / Codex RT-3 Finding 5 — control-plane subscribe with mid-stream signal
// abort completes WITHOUT throwing (the async generator returns cleanly via
// the inner read-loop catch, matching the daemon path's `addEventListener(
// "abort", () => subscription.cancel())` contract). Regression test for the
// asymmetry where the CP path passed `signal` directly to `RequestInit.signal`
// — when abort fired mid-stream, the underlying fetch body's
// `getReader().read()` rejected with `AbortError` and bubbled through the
// `try { while(true) { reader.read() } } finally { reader.cancel() }` block,
// so callers swapping transports for the same cancel flow saw an exception
// only on the CP transport.
// ---------------------------------------------------------------------------

describe("C5 / Codex RT-3 Finding 5 — control-plane subscribe mid-stream signal abort completes without throwing", () => {
  it("control-plane transport: when options.signal is aborted AFTER the SSE response is established, subscribe completes silently (matches daemon-path teardown contract)", async () => {
    const ac = new AbortController();
    // We need a `ReadableStream` that (a) parks at first pull (so the
    // consumer's `reader.read()` is awaiting indefinitely — gives us the
    // mid-stream window) and (b) can be transitioned into a rejected-read
    // state from the fetcher's abort handler. `controller.error(reason)`
    // causes any pending `reader.read()` promise to reject with `reason`,
    // regardless of whether the stream is locked — this mirrors what fetch's
    // actual internals do on abort. (`stream.cancel()` would throw TypeError
    // on a locked stream; the consumer locks via `getReader()` before abort
    // fires, so cancel-from-fetcher is not viable.)
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      pull() {
        // Park: do not enqueue or close — leaves reader.read() awaiting
        // until streamController.error() is called from the abort handler.
      },
    });
    const fetcher = vi.fn((request: Request): Promise<Response> => {
      // Faithful in-process mirror of fetch's actual behavior: when the
      // request signal aborts mid-stream, the response body stream errors
      // with AbortError, which propagates to the pending reader.read().
      request.signal?.addEventListener("abort", () => {
        streamController?.error(new DOMException("aborted", "AbortError"));
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    });
    const sdk = createControlPlaneSessionClient({
      fetcher,
      baseUrl: "https://control-plane.test",
    });

    let threw: unknown = undefined;
    const consume = (async (): Promise<void> => {
      try {
        for await (const _ of sdk.subscribe({ sessionId: SESSION_ID, signal: ac.signal })) {
          // No frames will arrive — the stream parks until abort.
        }
      } catch (err) {
        threw = err;
      }
    })();

    // Yield to the macrotask queue so subscribe() reaches the read-loop
    // park (fetcher resolved, getReader() called, awaiting first read).
    // setTimeout vs queueMicrotask: the read loop crosses several await
    // boundaries (fetcher promise, body.getReader, reader.read) before
    // parking; a single microtask drain isn't enough — a macrotask boundary
    // guarantees the loop has reached the awaited read().
    await new Promise((r) => setTimeout(r, 10));

    // Trigger mid-stream abort. The fetcher's abort listener fires
    // synchronously, calls streamController.error(AbortError), which
    // rejects the awaited reader.read() inside controlPlaneSubscribe with
    // AbortError. The new inner catch sees options.signal.aborted === true
    // and returns from the generator instead of throwing.
    ac.abort();

    await consume;

    // C5 core assertion #1: the consumer's catch did NOT execute — the
    // async generator returned cleanly (mid-stream abort path) instead of
    // bubbling AbortError through the `finally` block. Pre-fix, this would
    // capture the rejected reader.read()'s AbortError.
    expect(threw).toBeUndefined();
    // C5 core assertion #2: the fetcher WAS called once — proves we
    // exercised the post-establishment path (mid-stream abort), not C3's
    // pre-abort short-circuit. If `threw === undefined` AND fetcher was
    // never called, the test would falsely pass on the pre-abort guard.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// C6 / Codex RT-4 Finding 6 — control-plane subscribe with request-setup-window
// signal abort completes WITHOUT throwing (the async generator returns cleanly
// via the new try/catch wrapping the `await fetcher(new Request(url, init))`,
// matching the daemon path's `addEventListener("abort", () =>
// subscription.cancel())` contract). Regression test for the third abort
// window: pre-call (L488 guard, RT-2) handles aborts BEFORE fetcher is
// invoked, the read-loop catch (RT-3) handles aborts AFTER the SSE response
// is received and mid-stream, but a window remained where abort fired BETWEEN
// fetcher invocation and response receipt — the awaited fetcher promise
// rejected with AbortError and bubbled out of subscribe(), surfacing as an
// unexpected exception in timeout/circuit-breaker callers under high network
// latency. C5 above pins the read-loop window; C6 pins the request-setup
// window. Together C3+C5+C6 lock down all three abort-handling paths in the
// control-plane subscribe flow.
// ---------------------------------------------------------------------------

describe("C6 / Codex RT-4 Finding 6 — control-plane subscribe request-setup-window signal abort completes without throwing", () => {
  it("control-plane transport: when options.signal is aborted DURING the fetcher promise (before response is received), subscribe completes silently (matches daemon-path teardown contract)", async () => {
    const ac = new AbortController();
    // Build a fetcher that returns a never-resolving promise UNTIL the
    // request signal aborts, at which point it rejects with AbortError. This
    // mirrors fetch's actual setup-window behavior: the promise pends until
    // the network responds OR the caller aborts (e.g. DNS resolution stalls
    // and the caller's circuit-breaker fires). The abort listener is wired
    // on the Request's signal — which is the same signal the SDK forwards
    // from `options.signal` into `RequestInit.signal` at L499-505 — so the
    // listener fires when `ac.abort()` is called downstream.
    const fetcher = vi.fn((request: Request): Promise<Response> => {
      return new Promise<Response>((_, reject) => {
        request.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const sdk = createControlPlaneSessionClient({
      fetcher,
      baseUrl: "https://control-plane.test",
    });

    let threw: unknown = undefined;
    const consume = (async (): Promise<void> => {
      try {
        for await (const _ of sdk.subscribe({ sessionId: SESSION_ID, signal: ac.signal })) {
          // Never reached — the fetcher never resolves with a response.
        }
      } catch (err) {
        threw = err;
      }
    })();

    // Yield to the macrotask queue so subscribe() reaches the awaited fetcher
    // promise (passes the L488 pre-abort guard, builds the Request, and parks
    // on `await fetcher(...)` at L512). setTimeout vs queueMicrotask: same
    // rationale as C5 — the path crosses several synchronous statements but
    // a macrotask boundary guarantees the awaited fetcher promise is the
    // current pending continuation.
    await new Promise((r) => setTimeout(r, 10));

    // Trigger setup-window abort. The fetcher's abort listener fires
    // synchronously, rejects the awaited fetcher promise with AbortError.
    // The new setup-window catch sees options.signal.aborted === true and
    // returns from the generator instead of throwing.
    ac.abort();

    await consume;

    // C6 core assertion #1: the consumer's catch did NOT execute — the async
    // generator returned cleanly via the new setup-window catch instead of
    // bubbling AbortError from the fetcher rejection. Pre-fix, this would
    // capture the rejected fetcher promise's AbortError.
    expect(threw).toBeUndefined();
    // C6 core assertion #2: the fetcher WAS called once — proves we
    // exercised the post-pre-abort-guard path (request-setup window), not
    // C3's pre-abort short-circuit. If `threw === undefined` AND fetcher was
    // never called, the test would falsely pass on the L488 pre-abort guard
    // (the diagnostic distinguisher: pre-abort returns BEFORE fetcher is
    // invoked, so `toHaveBeenCalledTimes(1)` is the witness that we
    // reached the fetcher await before abort fired).
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Control-plane CRUD smoke tests — pin the JSON envelope decode path
// ---------------------------------------------------------------------------
//
// I3+I4 above exercise the SSE wire path; these three smoke tests exercise the
// non-SSE JSON envelope path (parseTrpcResult + extractTrpcResponseData). A
// regression in the envelope-shape walk (e.g. typo `result.dataa`, missing
// `result` guard, accidental SuperJSON-wrap assumption) would silently break
// all three CRUD methods at runtime; without these tests the only signal would
// come from a downstream consumer's first call. Coverage is per-method (one
// describe each) so a failure isolates the broken procedure.

describe("Control-plane CRUD smoke — JSON envelope decode round-trips through parseTrpcResult", () => {
  const canonicalCreateResponse: SessionCreateResponse = {
    sessionId: SESSION_ID,
    state: "provisioning",
    memberships: [
      {
        id: OWNER_MEMBERSHIP_ID,
        participantId: OWNER_PARTICIPANT_ID,
        role: "owner",
        state: "active",
      },
    ],
    channels: [],
  };
  const canonicalReadResponse: SessionReadResponse = {
    session: {
      id: SESSION_ID,
      state: "provisioning",
      config: { topic: "smoke" },
      metadata: {},
      createdAt: "2026-04-30T12:00:00.000Z",
      updatedAt: "2026-04-30T12:00:00.000Z",
    },
    timelineCursors: {
      latest: CURSOR_1,
    },
  };
  const canonicalJoinResponse: SessionJoinResponse = {
    sessionId: SESSION_ID,
    participantId: OWNER_PARTICIPANT_ID,
    membershipId: OWNER_MEMBERSHIP_ID,
    sharedMetadata: {},
  };

  function buildSdk(): {
    sdk: ReturnType<typeof createControlPlaneSessionClient>;
    directoryService: FixtureDirectoryService;
  } {
    const directoryService = new FixtureDirectoryService({
      create: canonicalCreateResponse,
      read: canonicalReadResponse,
      join: canonicalJoinResponse,
    });
    const handler = buildControlPlaneFetchHandler(buildCrudOnlyDeps(directoryService));
    const fetcher = (req: Request): Promise<Response> => handler(req, PASSING_ENV);
    const sdk = createControlPlaneSessionClient({
      fetcher,
      baseUrl: "https://control-plane.test",
    });
    return { sdk, directoryService };
  }

  it("create: POST round-trips through fetch handler; envelope decode yields canonical response", async () => {
    const { sdk, directoryService } = buildSdk();
    const response = await sdk.create({ config: { topic: "smoke" } });
    // The unwrap walks `{ result: { data: <output> } }` — if it regresses
    // (typo in the path, missing `result` guard) the value here would be
    // undefined and Zod would reject it. Pinning the canonical fields
    // confirms the full happy-path shape.
    expect(response.sessionId).toBe(SESSION_ID);
    expect(response.state).toBe("provisioning");
    expect(response.memberships).toHaveLength(1);
    expect(response.memberships[0]?.id).toBe(OWNER_MEMBERSHIP_ID);
    expect(response.channels).toEqual([]);
    // The fixture captures the input the directory service received — proves
    // the request body round-tripped through the tRPC mutation parser.
    expect(directoryService.lastCreateInput?.config).toEqual({ topic: "smoke" });
  });

  it("read: GET round-trips through fetch handler; envelope decode yields canonical response", async () => {
    const { sdk, directoryService } = buildSdk();
    const response = await sdk.read({ sessionId: SESSION_ID });
    expect(response.session.id).toBe(SESSION_ID);
    expect(response.session.state).toBe("provisioning");
    expect(response.session.config).toEqual({ topic: "smoke" });
    expect(response.timelineCursors.latest).toBe(CURSOR_1);
    // Round-trip proof on the request side: the SessionId we sent reached
    // the directory service unchanged.
    expect(directoryService.lastReadSessionId).toBe(SESSION_ID);
  });

  it("join: POST round-trips through fetch handler; envelope decode yields canonical response", async () => {
    const { sdk, directoryService } = buildSdk();
    const response = await sdk.join({
      sessionId: SESSION_ID,
      identityHandle: OWNER_PARTICIPANT_ID,
    });
    expect(response.sessionId).toBe(SESSION_ID);
    expect(response.participantId).toBe(OWNER_PARTICIPANT_ID);
    expect(response.membershipId).toBe(OWNER_MEMBERSHIP_ID);
    expect(response.sharedMetadata).toEqual({});
    expect(directoryService.lastJoinInput?.sessionId).toBe(SESSION_ID);
    expect(directoryService.lastJoinInput?.participantId).toBe(OWNER_PARTICIPANT_ID);
  });
});
