// Lane A: integration tests for `sessionClient` across BOTH
// transports (daemon JSON-RPC + control-plane HTTP/SSE).
//
// Coverage:
//   * I1 — `SessionCreate` then `SessionRead` returns identical session id
//          (round-trip).
//   * I3 — `SessionSubscribe` yields events in sequence ASC across reconnect
//          (reconnect ordering).
//   * I4 — Reconnect after lost stream restores from snapshot, NOT the
//          client cache (snapshot authority).
//
// Transport split rationale:
//   * I1 uses the DAEMON transport. The harness is `JsonRpcClient` +
//     in-memory `ClientTransport` + a scripted "fake daemon" reply table.
//     This is fully synchronous, requires zero external state (no pglite,
//     which is NOT a client-sdk dep — see node-linker=isolated in .npmrc),
//     and exercises the same JSON-RPC envelope path the production daemon
//     transport uses.
//   * I3 + I4 use the CONTROL-PLANE transport. The harness is
//     `buildControlPlaneFetchHandler` + a scripted `eventStreamProvider`
//     with a recording cursor capture. This mirrors the established
//     pattern in `client-sdk/test/transport/sse-roundtrip.test.ts`.
//
// Coverage gap acknowledged: I1 against the control-plane transport goes
// unverified at the SDK level. The control-plane router itself has
// equivalent CRUD coverage in
// `control-plane/src/sessions/__tests__/session-router.test.ts`, and the
// SDK→fetch→router boundary is exercised by I3+I4's subscribe path.

import {
  type ChannelListResponse,
  deriveMainChannelId,
  type EventCursor,
  type EventEnvelopeVersion,
  JSONRPC_VERSION,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponseEnvelope,
  MAIN_CHANNEL_NAME,
  type UserId,
  type SessionCreateResponse,
  type SessionEvent,
  type SessionId,
  type SessionReadResponse,
  SUBSCRIPTION_NOTIFY_METHOD,
} from "@ai-sidekicks/contracts";
import {
  AttachService,
  buildControlPlaneFetchHandler,
  type ControlPlaneDeps,
  type ControlPlaneEnv,
  type CreateSessionInput,
  EventLogAnchorStore,
  HeartbeatService,
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
} from "../src/sessionClient.js";
import { JsonRpcClient } from "../src/transport/jsonRpcClient.js";
import type { ClientTransport } from "../src/transport/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000a001" as SessionId;
const OWNER_USER_ID: UserId = "01970000-0000-7000-8000-00000000b001" as UserId;

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
    // Runtime-node services over the throwing Querier: this subscribe-only
    // harness never reaches `runtimenode.*`, so the services throw on use,
    // preserving the never-reached posture (same as the throwing callbacks).
    attachService: new AttachService(throwingQuerier),
    heartbeatService: new HeartbeatService(throwingQuerier),
    // Same never-reached posture as the runtime-node services above:
    // holds the throwing querier, throws only on use.
    anchorStore: new EventLogAnchorStore(throwingQuerier),
    resolveCurrentUserId: (): UserId => {
      throw NEVER_REACHED("resolveCurrentUserId");
    },
    generateSessionId: (): SessionId => {
      throw NEVER_REACHED("generateSessionId");
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
  public lastCreateInput: CreateSessionInput | undefined = undefined;
  public lastReadSessionId: SessionId | undefined = undefined;

  constructor(responses: { create: SessionCreateResponse; read: SessionReadResponse }) {
    super(throwingQuerier);
    this.#createResponse = responses.create;
    this.#readResponse = responses.read;
  }

  override async createSession(input: CreateSessionInput): Promise<SessionCreateResponse> {
    this.lastCreateInput = input;
    return this.#createResponse;
  }

  override async readSession(sessionId: SessionId): Promise<SessionReadResponse | null> {
    this.lastReadSessionId = sessionId;
    return this.#readResponse;
  }
}

function buildCrudOnlyDeps(directoryService: FixtureDirectoryService): ControlPlaneDeps {
  return {
    directoryService,
    // Runtime-node services over the throwing Querier: the CRUD smoke tests
    // never reach `runtimenode.*`, so the services throw on use.
    attachService: new AttachService(throwingQuerier),
    heartbeatService: new HeartbeatService(throwingQuerier),
    // Same never-reached posture as the runtime-node services above:
    // holds the throwing querier, throws only on use.
    anchorStore: new EventLogAnchorStore(throwingQuerier),
    resolveCurrentUserId: (): UserId => OWNER_USER_ID,
    generateSessionId: (): SessionId => SESSION_ID,
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

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

// ---------------------------------------------------------------------------
// I1 — SessionCreate then SessionRead returns identical session id
// — daemon transport
// ---------------------------------------------------------------------------

describe("I1 / — SessionCreate then SessionRead returns identical session id (round-trip)", () => {
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

    const readResponse = await sdk.read({ sessionId: createResponse.sessionId });
    // I1 core assertion: round-trip identity. The id surfaced from create
    // is the SAME id read returns inside its snapshot.
    expect(readResponse.session.id).toBe(createResponse.sessionId);
    expect(readResponse.session.state).toBe("provisioning");
    expect(readResponse.session.config).toEqual({ topic: "round-trip" });
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
// I3 — SessionSubscribe yields events in sequence ASC across reconnect over the
// control-plane transport
// ---------------------------------------------------------------------------

describe("I3 — SessionSubscribe yields events in sequence ASC across reconnect", () => {
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
// — control-plane transport
// ---------------------------------------------------------------------------

describe("I4 / — Reconnect after lost stream restores from snapshot, NOT client cache", () => {
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
        event: makeSessionCreatedEvent(EVENT_ID_3, 2),
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
    expect(reconnected[1]?.event.type).toBe("session.created");
  });
});

// ---------------------------------------------------------------------------
// C2 / Codex RT-1 Finding 2 — control-plane SSE parser handles CRLF separators
// (WHATWG HTML section 9.2.6 — line terminators may be CRLF, LF, or CR; this fix
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
// C7 / Codex RT-5 Finding A — daemon subscribe re-checks AbortSignal AFTER
// attaching the abort listener (race-close). Regression test for the bug where
// a signal that aborted BETWEEN the L202 pre-check and the L234 addEventListener
// (e.g., DURING `client.subscribe()`'s synchronous envelope dispatch +
// StreamingPrimitive reservation) was missed: the listener never fired (already
// dispatched), and the for-await parked indefinitely on a caller-canceled
// stream while the daemon's subscription stayed live.
//
// Harness construction note: external `ac.abort()` after starting the consumer's
// `for await` does NOT exercise this race — by the time the IIFE body's first
// await yields control, the generator body has already attached the listener.
// To put abort INSIDE the L202-to-L234 window we mock `client.subscribe` to call
// `ac.abort()` synchronously inside its impl. This means: pre-check passes →
// client.subscribe runs (mock fires abort) → addEventListener attaches AFTER the
// abort already fired → re-check catches it and fires `subscription.cancel()`.
// The contract the fix MUST close: "after the post-listener re-check, if signal
// is aborted, cancel fires" — `cancelSpy` being called is the witness.
// ---------------------------------------------------------------------------

describe("C7 / Codex RT-5 Finding A — daemon subscribe re-checks AbortSignal after attaching abort listener", () => {
  it("daemon transport: when signal aborts during client.subscribe() (after pre-check, before listener attach), the post-listener re-check fires subscription.cancel() and the iterable yields zero values", async () => {
    // Build a daemon harness with NO scripted subscribe response — the mocked
    // `client.subscribe` overrides the wire path entirely, so the unscripted-
    // method default never fires. The harness still gives us a real
    // JsonRpcClient instance to spy against.
    const harness = buildDaemonHarness([]);
    const sdk = createDaemonSessionClient(harness.client);

    const ac = new AbortController();

    // Mock `client.subscribe` to fire `ac.abort()` synchronously inside its
    // body — this places the abort INSIDE the L202-to-L234 window the fix
    // closes. The returned fake subscription's iterator parks indefinitely so
    // (a) we prove the for-await would never naturally exit, and (b) any
    // erroneous yield surfaces as a hung test rather than a false pass. The
    // `cancelSpy` is the assertion target — it MUST be called by the new
    // race-close re-check, not by the for-await's `return()` (the parked
    // iterator never enters return() because the re-check returns the
    // generator BEFORE entering the try-block).
    const cancelSpy = vi.fn((): Promise<void> => Promise.resolve());
    const fakeSubscription = {
      subscriptionId: "fake-sub-id",
      cancel: cancelSpy,
      next: (): Promise<undefined> => new Promise<undefined>(() => undefined),
      [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
        return {
          next: (): Promise<IteratorResult<SessionEvent>> =>
            new Promise<IteratorResult<SessionEvent>>(() => undefined),
          return: (): Promise<IteratorResult<SessionEvent>> =>
            Promise.resolve({ value: undefined, done: true }),
        };
      },
    };
    const subscribeSpy = vi
      .spyOn(harness.client, "subscribe")
      .mockImplementation(((): typeof fakeSubscription => {
        // Synchronously abort BEFORE returning. This is the race window: the
        // generator already passed L202's pre-check (signal was not aborted at
        // that point) and is in the synchronous body of `client.subscribe()`
        // that, in production, would have serialized the wire envelope and
        // reserved a `StreamingPrimitive` entry. Pre-fix, the abort event
        // dispatched here had no listener attached yet (addEventListener runs
        // AFTER this returns), so the listener missed it and the consumer
        // parked forever on a canceled stream.
        ac.abort();
        return fakeSubscription;
      }) as unknown as typeof harness.client.subscribe);

    const events = await drain(sdk.subscribe({ sessionId: SESSION_ID, signal: ac.signal }));

    // C7 core assertion #1: zero values yielded — the async generator returned
    // from the post-listener race-close `if (sig.aborted) { return; }` BEFORE
    // entering the try-block's for-await.
    expect(events).toEqual([]);
    // C7 core assertion #2: client.subscribe WAS called once — proves we
    // PASSED the L202 pre-abort check (which would have returned before any
    // call). The diagnostic distinguisher: pre-abort returns BEFORE
    // client.subscribe runs, so `toHaveBeenCalledTimes(1)` is the witness
    // that we reached the new race window the fix closes.
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    // C7 core assertion #3: subscription.cancel WAS called — proves the
    // post-listener re-check (`if (sig.aborted) { ... void
    // subscription.cancel().catch(...) ... return; }`) fired the cancel path
    // the listener would have. Without the fix, cancel is NEVER called in
    // this window — the listener missed the abort, the for-await parks
    // forever, and the daemon's StreamingPrimitive entry stays live.
    expect(cancelSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C8 / Codex RT-5 Finding B — control-plane subscribe validates SSE
// Content-Type before parsing the response body. Regression test for the bug
// where any 200 response was treated as a valid SSE stream — if an
// intermediary or auth layer returned a non-SSE 200 payload (JSON error
// envelope, HTML login redirect, etc.), the parser silently produced zero
// frames and the async generator ended cleanly, misreporting a failed
// subscription as a normal empty stream.
//
// WHATWG HTML section 9.2.6 SSE parsing requires the response Content-Type to be
// `text/event-stream` (optional `; charset=utf-8` parameter). The fetch spec
// mandates the user agent fail processing if the type does not match — the
// SDK MUST do the same since we parse the body manually rather than via
// EventSource.
// ---------------------------------------------------------------------------

describe("C8 / Codex RT-5 Finding B — control-plane subscribe rejects non-SSE Content-Type on 200 response", () => {
  it("control-plane transport: 200 response with Content-Type 'application/json' rejects with error naming the actual type observed", async () => {
    // The fake fetcher returns a 200 response with a JSON body and JSON
    // Content-Type — the exact "intermediary returned 200 + JSON error envelope"
    // shape the bug allowed to silently pass as an empty stream. Pre-fix, the
    // parser would loop over the body, find no `\n\n` frame boundary in the
    // JSON payload (or find one and fail to parse the resulting fragment as
    // an SSE frame), and the generator would end cleanly with zero events —
    // the very misreport the fix closes.
    const jsonBody = '{"error":"unauthorized"}';
    const bodyBytes = new TextEncoder().encode(jsonBody);
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
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
    const sdk = createControlPlaneSessionClient({
      fetcher,
      baseUrl: "https://control-plane.test",
    });

    // C8 core assertion #1: iteration THROWS rather than silently ending. The
    // async generator MUST surface the contract violation to the caller; a
    // resolved-empty iteration would be a false-pass against the "failed
    // subscription misreported as empty stream" surface Codex flagged.
    await expect(drain(sdk.subscribe({ sessionId: SESSION_ID }))).rejects.toThrow(
      /expected Content-Type 'text\/event-stream'/,
    );

    // C8 core assertion #2: the rejection's message names the ACTUAL type
    // observed ('application/json'), proving the diagnostic surfaces the
    // wrong-type value rather than just a generic "wrong type" string. This
    // matters for production debugging — an operator reading the error needs
    // to know what the intermediary actually returned.
    await expect(drain(sdk.subscribe({ sessionId: SESSION_ID }))).rejects.toThrow(
      /application\/json/,
    );
  });

  it("control-plane transport: 200 response with NO Content-Type header rejects with error naming '<missing>'", async () => {
    // Defensive coverage for the missing-header case (production
    // intermediaries can strip Content-Type entirely, e.g., a misconfigured
    // proxy). The error message MUST distinguish missing from wrong-type so
    // operators can route diagnoses correctly. We construct the Response with
    // a Headers object that explicitly lacks Content-Type — Response's
    // implementation does not auto-add one when constructed from a stream.
    const sseishBody = "id: x\ndata: {}\n\n";
    const bodyBytes = new TextEncoder().encode(sseishBody);
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
          // Explicitly empty headers — no Content-Type set. The SDK's
          // `headers.get("Content-Type")` returns null in this case.
          headers: new Headers(),
        }),
      );
    };
    const sdk = createControlPlaneSessionClient({
      fetcher,
      baseUrl: "https://control-plane.test",
    });

    // The error message uses `<missing>` as the literal sentinel for null
    // Content-Type — distinguishes from wrong-type rejections. Pinning this
    // sentinel in the test ensures a future change to the fallback string
    // surfaces here rather than as a downstream operator confusion.
    await expect(drain(sdk.subscribe({ sessionId: SESSION_ID }))).rejects.toThrow(/<missing>/);
  });
});

// ---------------------------------------------------------------------------
// Control-plane CRUD smoke tests — pin the JSON envelope decode path
// ---------------------------------------------------------------------------
//
// I3+I4 above exercise the SSE wire path; these smoke tests exercise the
// non-SSE JSON envelope path (parseTrpcResult + extractTrpcResponseData). A
// regression in the envelope-shape walk (e.g. typo `result.dataa`, missing
// `result` guard, accidental SuperJSON-wrap assumption) would silently break
// both CRUD methods at runtime; without these tests the only signal would
// come from a downstream consumer's first call.

describe("Control-plane CRUD smoke — JSON envelope decode round-trips through parseTrpcResult", () => {
  const canonicalCreateResponse: SessionCreateResponse = {
    sessionId: SESSION_ID,
    state: "provisioning",
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
  function buildSdk(): {
    sdk: ReturnType<typeof createControlPlaneSessionClient>;
    directoryService: FixtureDirectoryService;
  } {
    const directoryService = new FixtureDirectoryService({
      create: canonicalCreateResponse,
      read: canonicalReadResponse,
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
});

// ---------------------------------------------------------------------------
// Daemon channel listing — the bootstrap main channel for an existing session
// ---------------------------------------------------------------------------
//
// The bootstrap `main` channel's id is a PURE FUNCTION of the session id:
// `deriveMainChannelId` is THE shared derivation consumed by both the daemon
// projector AND the control-plane channel projection. The expected id below is
// derived with the SAME helper used in the assertion, so the test pins the
// cross-surface invariant (byte-identical id for a given session) rather than a
// daemon-side fabrication.

describe("daemon factory — listChannels returns the bootstrap main channel", () => {
  it("listChannels sends channel.list and parses a projection containing the deterministically-derived main channel", async () => {
    const mainChannelId = deriveMainChannelId(SESSION_ID);

    const channelListResponse: ChannelListResponse = {
      channels: [
        {
          id: mainChannelId,
          name: MAIN_CHANNEL_NAME,
          state: "active",
          userCount: 1,
        },
      ],
    };

    const harness = buildDaemonHarness([
      {
        method: "channel.list",
        buildResult: (request): unknown => {
          // Echo back the requested sessionId scoping defensively (the
          // projection is per-session). The response shape is the canonical
          // ChannelListResponse; the bootstrap main channel is the single
          // visible channel for a freshly-bootstrapped session.
          const requested = (request.params as { sessionId: SessionId } | undefined) ?? {
            sessionId: SESSION_ID,
          };
          expect(requested.sessionId).toBe(SESSION_ID);
          return channelListResponse;
        },
      },
    ]);
    const sdk = createDaemonSessionClient(harness.client);

    const response = await sdk.listChannels({ sessionId: SESSION_ID });

    // Core assertion #1: the parsed projection contains the bootstrap main
    // channel, keyed by the deterministically-derived id.
    const main = response.channels.find((channel) => channel.id === mainChannelId);
    expect(main).toBeDefined();
    // Core assertion #2: the bootstrap channel carries the canonical `main`
    // name and the `active` lifecycle state.
    expect(main?.name).toBe(MAIN_CHANNEL_NAME);
    expect(main?.state).toBe("active");
    // The wire method was `channel.list`.
    const sentMethods = harness.transport.sentEnvelopes.map((envelope) => envelope.method);
    expect(sentMethods).toEqual(["channel.list"]);
  });
});
