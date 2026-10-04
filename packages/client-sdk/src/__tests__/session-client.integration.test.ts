// The session client over the daemon transport: a real `JsonRpcClient` over the scripted daemon,
// with no socket or external state. Covers ascending replay with `afterCursor` resume, restore from
// the daemon's state rather than a client cache, and the abort-signal races.

import type { EventCursor, SessionId } from "@ai-sidekicks/contracts/session";
import type { SessionEvent } from "@ai-sidekicks/contracts/event-variant-types";
import { SUBSCRIPTION_CANCEL_METHOD } from "@ai-sidekicks/contracts/jsonrpc-streaming";
import { describe, expect, it, vi } from "vitest";

import { createDaemonSessionClient } from "../session-client.js";
import { JsonRpcClient } from "../transport/json-rpc-client.js";
import {
  answerByMethod,
  buildSessionCreatedEvent,
  buildSubscriptionNotify,
  createScriptedDaemon,
  type ScriptedDaemon,
  type ScriptedMethodTable,
  TEST_CLIENT_OPTIONS,
} from "./scripted-daemon.test-support.js";

// Fixtures

const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000a001" as SessionId;

// Event ids are UUIDs, which also satisfy `EventCursor.min(1).max(256)`; the fake daemon uses each
// event's id as its cursor.
const EVENT_ID_1 = "01970000-0000-7000-8000-00000000f001";
const EVENT_ID_2 = "01970000-0000-7000-8000-00000000f002";
const EVENT_ID_3 = "01970000-0000-7000-8000-00000000f003";
const CURSOR_1: EventCursor = EVENT_ID_1 as EventCursor;
const CURSOR_2: EventCursor = EVENT_ID_2 as EventCursor;
const CURSOR_3: EventCursor = EVENT_ID_3 as EventCursor;

interface DaemonHarness {
  readonly transport: ScriptedDaemon;
  readonly client: JsonRpcClient;
}

/** A client over a daemon that answers only the methods `table` scripts. */
function buildDaemonHarness(table: ScriptedMethodTable): DaemonHarness {
  const transport = createScriptedDaemon(answerByMethod(table));
  const client = new JsonRpcClient(transport, TEST_CLIENT_OPTIONS);
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
  table: ScriptedMethodTable;
  recorded: RecordedSubscribeCall;
} {
  const recorded: RecordedSubscribeCall = { afterCursor: undefined, callCount: 0 };
  return {
    recorded,
    table: {
      "session.subscribe": (request) => {
        recorded.callCount += 1;
        recorded.afterCursor = (request.params as { afterCursor?: EventCursor }).afterCursor;
        const subscriptionId = `01970000-0000-7000-8000-00000000c00${String(recorded.callCount)}`;
        const history = readHistory();
        const cursorIndex = history.findIndex((event) => event.id === recorded.afterCursor);
        return {
          result: { subscriptionId },
          followUp: history
            .slice(cursorIndex + 1)
            .map((event) =>
              buildSubscriptionNotify(subscriptionId, { changes: [{ cursor: event.id, event }] }),
            ),
        };
      },
      [SUBSCRIPTION_CANCEL_METHOD]: () => ({ result: { canceled: true } }),
    },
  };
}

// Event fixtures

function makeSessionCreatedEvent(id: string, sequence: number): SessionEvent {
  return buildSessionCreatedEvent({ id, sessionId: SESSION_ID, sequence });
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

// A pre-aborted signal must not touch the wire: `client.subscribe` would otherwise send the
// `session.subscribe` request and reserve a daemon-side subscription entry.

describe("daemon subscribe with a pre-aborted signal does not call client.subscribe", () => {
  it("daemon transport: when options.signal is already aborted, no wire envelope is sent and the async iterable yields zero values", async () => {
    // No scripted `session.subscribe`: a leaked request would fail on the unscripted path, and the
    // empty `sentEnvelopes` assertion catches it first.
    const harness = buildDaemonHarness({});
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

describe("SessionSubscribe yields events in sequence ASC across reconnect", () => {
  it("daemon transport: a reconnect with afterCursor resumes ASC after that cursor", async () => {
    const history = [
      makeSessionCreatedEvent(EVENT_ID_1, 0),
      makeSessionCreatedEvent(EVENT_ID_2, 1),
      makeSessionCreatedEvent(EVENT_ID_3, 2),
    ];
    const { table, recorded } = scriptSessionStream(() => history);
    const sdk = createDaemonSessionClient(buildDaemonHarness(table).client);

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

describe("Reconnect after lost stream restores from snapshot, not client cache", () => {
  it("daemon transport: a reconnect surfaces history the daemon changed meanwhile", async () => {
    let history: SessionEvent[] = [
      makeSessionCreatedEvent(EVENT_ID_1, 0),
      makeSessionCreatedEvent(EVENT_ID_2, 1),
    ];
    const { table, recorded } = scriptSessionStream(() => history);
    const sdk = createDaemonSessionClient(buildDaemonHarness(table).client);

    const cold = await take(sdk.subscribe({ sessionId: SESSION_ID }), 2);
    expect(cold.map((e) => e.eventId)).toEqual([CURSOR_1, CURSOR_2]);

    // While the stream is lost, the daemon's projection revises the second
    // event and gains a third. A client that cached the cold stream would
    // replay the old second event; one that reads the wire sees the revision.
    const revisedSecondEvent = buildSessionCreatedEvent({
      id: EVENT_ID_2,
      sessionId: SESSION_ID,
      sequence: 1,
      occurredAt: "2026-04-30T12:05:00.000Z",
      shape: "project",
    });
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

describe("daemon subscribe re-checks AbortSignal after attaching abort listener", () => {
  it("daemon transport: when signal aborts during client.subscribe() (after pre-check, before listener attach), the post-listener re-check fires subscription.cancel() and the iterable yields zero values", async () => {
    // No scripted subscribe: the mocked `client.subscribe` replaces the wire path; the harness
    // only supplies a real `JsonRpcClient` to spy on.
    const harness = buildDaemonHarness({});
    const sdk = createDaemonSessionClient(harness.client);

    const ac = new AbortController();

    // The fake's `next()` parks until `cancel()` and then settles as ended, as a real subscription
    // does after a cancel, so a wrong yield before the cancel shows as a hung test. `cancelSpy`
    // must be called by the re-check after the listener attach, not by the loop's `return()`: the
    // re-check returns before the loop is entered.
    let isCanceled = false;
    const parkedReads: Array<() => void> = [];
    const readUntilCanceled = (): Promise<void> =>
      isCanceled ? Promise.resolve() : new Promise<void>((settle) => parkedReads.push(settle));
    const cancelSpy = vi.fn((): Promise<void> => {
      isCanceled = true;
      for (const settle of parkedReads.splice(0)) settle();
      return Promise.resolve();
    });
    const fakeSubscription = {
      subscriptionId: "fake-sub-id",
      cancel: cancelSpy,
      next: async (): Promise<undefined> => {
        await readUntilCanceled();
        return undefined;
      },
      [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
        return {
          next: async (): Promise<IteratorResult<SessionEvent>> => {
            await readUntilCanceled();
            return { value: undefined, done: true };
          },
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
