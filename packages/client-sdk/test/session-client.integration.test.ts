// Integration tests for the session client over the daemon transport: a real
// `JsonRpcClient` over an in-memory `ClientTransport` that answers from a
// scripted reply table (the fake daemon), with no socket or external state.
//
//   * I1 — `create` then `read` returns the same session id.
//   * I3 — `subscribe` yields events in ascending sequence; a reconnect with
//          `afterCursor` resumes strictly after that cursor.
//   * I4 — a reconnect restores from the daemon's state, not a client cache.

import {
  type EventCursor,
  type EventEnvelopeVersion,
  JSONRPC_VERSION,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponseEnvelope,
  type SessionEvent,
  type SessionId,
  SUBSCRIPTION_CANCEL_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
} from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import { createDaemonSessionClient } from "../src/session-client.js";
import { JsonRpcClient } from "../src/transport/json-rpc-client.js";
import type { ClientTransport } from "../src/transport/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000a001" as SessionId;

// Event ids are UUIDs, which also satisfy `EventCursor.min(1).max(256)`; the
// client synthesizes each event's cursor from its id.
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
  /** Frames the fake daemon writes after the response, such as subscription notifies. */
  readonly followUp?: (request: JsonRpcRequest) => readonly JsonRpcNotification[];
}

interface DaemonHarness {
  readonly transport: InMemoryDaemonTransport;
  readonly client: JsonRpcClient;
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
    for (const notification of reply.followUp?.(envelope) ?? []) {
      this.dispatchInbound(notification);
    }
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
  return { transport, client };
}

// ---------------------------------------------------------------------------
// Scripted session stream — the fake daemon's `session.subscribe` replay
// ---------------------------------------------------------------------------

interface RecordedSubscribeCall {
  afterCursor: EventCursor | undefined;
  callCount: number;
}

/**
 * Script `session.subscribe` and `$/subscription/cancel` on the fake daemon.
 * Each subscribe acks a fresh subscription id, records the `afterCursor` it
 * was sent, then replays the events `readHistory()` returns strictly after
 * that cursor, as the daemon's handler replays its store before going live,
 * one event per frame with the event's id as its cursor.
 * History is read on every subscribe, so a test can change it between calls.
 */
function scriptSessionStream(readHistory: () => readonly SessionEvent[]): {
  scripted: ScriptedDaemonResponse[];
  recorded: RecordedSubscribeCall;
} {
  const recorded: RecordedSubscribeCall = { afterCursor: undefined, callCount: 0 };
  const subscriptionIdFor = (callCount: number): string =>
    `01970000-0000-7000-8000-00000000c00${String(callCount)}`;
  return {
    recorded,
    scripted: [
      {
        method: "session.subscribe",
        buildResult: (request): unknown => {
          recorded.callCount += 1;
          recorded.afterCursor = (request.params as { afterCursor?: EventCursor }).afterCursor;
          return { subscriptionId: subscriptionIdFor(recorded.callCount) };
        },
        followUp: (): JsonRpcNotification[] => {
          const history = readHistory();
          const cursorIndex = history.findIndex((event) => event.id === recorded.afterCursor);
          return history.slice(cursorIndex + 1).map((event) => ({
            jsonrpc: JSONRPC_VERSION,
            method: SUBSCRIPTION_NOTIFY_METHOD,
            params: {
              subscriptionId: subscriptionIdFor(recorded.callCount),
              value: { changes: [{ cursor: event.id, event }] },
            },
          }));
        },
      },
      { method: SUBSCRIPTION_CANCEL_METHOD, buildResult: (): unknown => ({ canceled: true }) },
    ],
  };
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

/**
 * Read the first `count` items, then break. A daemon subscription stays open
 * until canceled, and the break is what cancels it.
 */
async function take<T>(iter: AsyncIterable<T>, count: number): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
    if (out.length === count) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// I1 — SessionCreate then SessionRead returns identical session id
// — daemon transport
// ---------------------------------------------------------------------------

describe("SessionCreate then SessionRead returns identical session id (round-trip)", () => {
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
          shape: "chat",
          state: "provisioning",
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
              draft: "",
            },
            timelineCursors: {
              latest: CURSOR_1,
            },
          };
        },
      },
    ]);
    const sdk = createDaemonSessionClient(harness.client);

    const createResponse = await sdk.create({
      clientIdempotencyKey: "0f2b4d5e-9999-4999-8999-999999999999",
      binding: { kind: "chat" },
      lead: {
        driverName: "claude",
        modelId: "claude-opus-4-5",
        providerAccountId: null,
        effort: "high",
      },
    });
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
// I3 — SessionSubscribe yields events in sequence ASC across reconnect
// ---------------------------------------------------------------------------

describe("I3 — SessionSubscribe yields events in sequence ASC across reconnect", () => {
  it("daemon transport: a reconnect with afterCursor resumes ASC after that cursor", async () => {
    const history = [
      makeSessionCreatedEvent(EVENT_ID_1, 0),
      makeSessionCreatedEvent(EVENT_ID_2, 1),
      makeSessionCreatedEvent(EVENT_ID_3, 2),
    ];
    const { scripted, recorded } = scriptSessionStream(() => history);
    const sdk = createDaemonSessionClient(buildDaemonHarness(scripted).client);

    const cold = await take(sdk.subscribe({ sessionId: SESSION_ID }), 3);
    expect(recorded.callCount).toBe(1);
    expect(recorded.afterCursor).toBeUndefined();
    expect(cold.map((e) => e.event.sequence)).toEqual([0, 1, 2]);
    expect(cold.map((e) => e.eventId)).toEqual([CURSOR_1, CURSOR_2, CURSOR_3]);

    // The reconnect sends the last cursor the consumer holds; the first event
    // it sees is the one strictly after that cursor.
    const resumed = await take(sdk.subscribe({ sessionId: SESSION_ID, afterCursor: CURSOR_2 }), 1);
    expect(recorded.callCount).toBe(2);
    expect(recorded.afterCursor).toBe(CURSOR_2);
    expect(resumed.map((e) => e.event.sequence)).toEqual([2]);
    expect(resumed[0]?.eventId).toBe(CURSOR_3);
  });
});

// ---------------------------------------------------------------------------
// I4 — Reconnect after lost stream restores from snapshot, NOT client cache
// ---------------------------------------------------------------------------

describe("I4 — Reconnect after lost stream restores from snapshot, NOT client cache", () => {
  it("daemon transport: a reconnect surfaces history the daemon changed meanwhile", async () => {
    let history: SessionEvent[] = [
      makeSessionCreatedEvent(EVENT_ID_1, 0),
      makeSessionCreatedEvent(EVENT_ID_2, 1),
    ];
    const { scripted, recorded } = scriptSessionStream(() => history);
    const sdk = createDaemonSessionClient(buildDaemonHarness(scripted).client);

    const cold = await take(sdk.subscribe({ sessionId: SESSION_ID }), 2);
    expect(cold.map((e) => e.eventId)).toEqual([CURSOR_1, CURSOR_2]);

    // While the stream is lost, the daemon's projection revises the second
    // event and gains a third. A client that cached the cold stream would
    // replay the old second event; one that reads the wire sees the revision.
    const revisedSecondEvent: SessionEvent = {
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
    history = [
      makeSessionCreatedEvent(EVENT_ID_1, 0),
      revisedSecondEvent,
      makeSessionCreatedEvent(EVENT_ID_3, 2),
    ];

    const reconnected = await take(
      sdk.subscribe({ sessionId: SESSION_ID, afterCursor: CURSOR_1 }),
      2,
    );
    expect(recorded.callCount).toBe(2);
    expect(recorded.afterCursor).toBe(CURSOR_1);
    expect(reconnected.map((e) => e.eventId)).toEqual([CURSOR_2, CURSOR_3]);
    expect(reconnected[0]?.event).toEqual(revisedSecondEvent);
  });
});

// ---------------------------------------------------------------------------
// C7 / Codex RT-5 Finding A — daemon subscribe re-checks AbortSignal AFTER
// attaching the abort listener (race-close). Regression test for the bug where
// a signal that aborted BETWEEN the pre-abort check and the listener attach
// (e.g., DURING `client.subscribe()`'s synchronous envelope dispatch +
// StreamingPrimitive reservation) was missed: the listener never fired (already
// dispatched), and the for-await parked indefinitely on a caller-canceled
// stream while the daemon's subscription stayed live.
//
// Harness construction note: external `ac.abort()` after starting the consumer's
// `for await` does NOT exercise this race — by the time the IIFE body's first
// await yields control, the generator body has already attached the listener.
// To put abort INSIDE the window between the pre-abort check and the listener
// attach we mock `client.subscribe` to call `ac.abort()` synchronously inside
// its impl. This means: pre-check passes →
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
    // body — this places the abort INSIDE the window between the pre-abort
    // check and the listener attach that the fix closes. The returned fake
    // subscription's iterator parks indefinitely so (a) we prove the for-await
    // would never naturally exit, and (b) any erroneous yield surfaces as a hung
    // test rather than a false pass. The `cancelSpy` is the assertion target — it
    // MUST be called by the race-close re-check, not by the for-await's
    // `return()` (the parked iterator never enters return() because the
    // re-check returns the generator BEFORE entering the try-block).
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
        // generator already passed the pre-abort check (signal was not aborted at
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
    // PASSED the pre-abort check (which would have returned before any
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
