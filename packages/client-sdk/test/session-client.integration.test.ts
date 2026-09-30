// The session client over the daemon transport: a real `JsonRpcClient` over an in-memory
// `ClientTransport` that answers from a scripted reply table (the fake daemon), with no socket or
// external state. Covers create-then-read identity, ascending replay with `afterCursor` resume,
// restore from the daemon's state rather than a client cache, and the abort-signal races.

import {
  type AgentId,
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

// Fixtures

const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000a001" as SessionId;

/** The session's lead, as every `session.created` here records it. */
const LEAD = {
  agentId: "01970000-0000-7000-8000-00000000b001" as AgentId,
  name: "Implementer",
  binding: {
    driverName: "claude",
    modelId: "claude-opus-4-5",
    providerAccountId: null,
    effort: "high",
  },
  ancestry: [],
  createdAt: "2026-04-30T12:00:00.000Z",
};

// Event ids are UUIDs, which also satisfy `EventCursor.min(1).max(256)`; the fake daemon uses each
// event's id as its cursor.
const EVENT_ID_1 = "01970000-0000-7000-8000-00000000f001";
const EVENT_ID_2 = "01970000-0000-7000-8000-00000000f002";
const EVENT_ID_3 = "01970000-0000-7000-8000-00000000f003";
const CURSOR_1: EventCursor = EVENT_ID_1 as EventCursor;
const CURSOR_2: EventCursor = EVENT_ID_2 as EventCursor;
const CURSOR_3: EventCursor = EVENT_ID_3 as EventCursor;

const PROTOCOL_VERSION = "2026-05-01";

// An in-memory `ClientTransport` with a scripted reply table. Dispatch is synchronous, so the
// tests have no timing dependence.

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
      // A notification expects no response.
      return;
    }
    const reply = this.#scripted.find((entry) => entry.method === envelope.method);
    if (reply === undefined) {
      // An error instead of a hang shows which call needs scripting.
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

// Scripted session stream: the fake daemon's `session.subscribe` replay

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

// Event fixtures

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
    payload: { sessionId: SESSION_ID, shape: "chat", mainAgent: LEAD },
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

// Create then read

describe("SessionCreate then SessionRead returns identical session id (round-trip)", () => {
  it("daemon transport: create returns sessionId X; read({X}) returns the same X with persisted snapshot", async () => {
    // `session.read` must return a `session.id` equal to the create-time id.
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
          // Echo the requested id so an SDK that replaced `sessionId` would show.
          const requestedSessionId = (
            (request.params as { sessionId: SessionId } | undefined) ?? { sessionId: SESSION_ID }
          ).sessionId;
          return {
            session: {
              id: requestedSessionId,
              state: "provisioning",
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
    // The id from create is the id read returns in its snapshot.
    expect(readResponse.session.id).toBe(createResponse.sessionId);
    expect(readResponse.session.state).toBe("provisioning");
  });
});

// A pre-aborted signal must not touch the wire: `client.subscribe` would otherwise send the
// `session.subscribe` request and reserve a daemon-side subscription entry.

describe("C1 / Codex RT-1 Finding 1 — daemon subscribe pre-aborted signal does not call client.subscribe", () => {
  it("daemon transport: when options.signal is already aborted, no wire envelope is sent and the async iterable yields zero values", async () => {
    // No scripted `session.subscribe`: a leaked request would fail on the unscripted path, and the
    // empty `sentEnvelopes` assertion catches it first.
    const harness = buildDaemonHarness([]);
    const sdk = createDaemonSessionClient(harness.client);
    // The spy calls through, so the pre-abort `return` in `daemonSubscribe` is what prevents the
    // wire side effect; the spy checks `client.subscribe` was never reached.
    const subscribeSpy = vi.spyOn(harness.client, "subscribe");

    const ac = new AbortController();
    ac.abort();

    const events = await drain(sdk.subscribe({ sessionId: SESSION_ID, signal: ac.signal }));

    // The generator returned at the pre-abort check before producing anything.
    expect(events).toEqual([]);
    // No server-side subscription handle was reserved.
    expect(subscribeSpy).not.toHaveBeenCalled();
    // No request reached the transport.
    expect(harness.transport.sentEnvelopes).toEqual([]);
  });
});

// Replay order and resume

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

// Reconnect restores from the daemon

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
      occurredAt: "2026-04-30T12:05:00.000Z",
      actor: null,
      version: "1.0" as EventEnvelopeVersion,
      payload: { sessionId: SESSION_ID, shape: "project", mainAgent: LEAD },
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

// A signal that aborts after the pre-abort check but before the abort listener attaches (during
// `client.subscribe()`) must still cancel the subscription. An abort fired after the consumer
// starts iterating would not reach this window, so the test makes `client.subscribe` abort the
// signal from inside its body.

describe("C7 / Codex RT-5 Finding A — daemon subscribe re-checks AbortSignal after attaching abort listener", () => {
  it("daemon transport: when signal aborts during client.subscribe() (after pre-check, before listener attach), the post-listener re-check fires subscription.cancel() and the iterable yields zero values", async () => {
    // No scripted subscribe: the mocked `client.subscribe` replaces the wire path; the harness
    // only supplies a real `JsonRpcClient` to spy on.
    const harness = buildDaemonHarness([]);
    const sdk = createDaemonSessionClient(harness.client);

    const ac = new AbortController();

    // The fake subscription's iterator parks forever, so a wrong yield shows as a hung test.
    // `cancelSpy` must be called by the re-check after the listener attach, not by the loop's
    // `return()`: the re-check returns before the loop is entered.
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
        // The generator has passed the pre-abort check and no listener is attached yet, so this
        // abort event is missed and only the re-check can catch it.
        ac.abort();
        return fakeSubscription;
      }) as unknown as typeof harness.client.subscribe);

    const events = await drain(sdk.subscribe({ sessionId: SESSION_ID, signal: ac.signal }));

    // The generator returned from the re-check before its loop.
    expect(events).toEqual([]);
    // One call shows the pre-abort check was passed and the race window reached.
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    // Without the re-check, cancel is never called and the daemon's subscription stays live.
    expect(cancelSpy).toHaveBeenCalled();
  });
});
