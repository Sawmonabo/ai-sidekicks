// The client-facing driver surface over a scripted daemon: the degraded intervention envelope
// reaches the caller intact, a daemon refusal reaches it as its registered code, a bad `runId` is
// refused before the wire, and a driver stream ends when the daemon pushes a non-driver event.
//
// Fixture UUIDs are low-entropy on purpose: the secret scanner flags high-entropy values under an
// identifier containing `Key`, and `clientIdempotencyKey` is that shape.

import { describe, expect, it } from "vitest";

import type { ApplyInterventionParams, RunId } from "@ai-sidekicks/contracts/provider-driver";
import type { JsonRpcNotification, JsonRpcRequest } from "@ai-sidekicks/contracts/jsonrpc";
import type { UserId, SessionId } from "@ai-sidekicks/contracts/session";
import type { SessionEvent } from "@ai-sidekicks/contracts/event-variant-types";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc";
import { SessionEventSchema } from "@ai-sidekicks/contracts/event";
import { SUBSCRIPTION_CANCEL_METHOD } from "@ai-sidekicks/contracts/jsonrpc-streaming";

import type { DriverClient } from "../provider-client.js";
import { createDaemonProviderClient } from "../provider-client.js";
import {
  JsonRpcClient,
  JsonRpcRemoteError,
  JsonRpcSchemaError,
} from "../transport/json-rpc-client.js";
import {
  answerByMethod,
  buildSessionCreatedEvent,
  buildSubscriptionNotify,
  createScriptedDaemon,
  type ScriptedDaemon,
  type ScriptedMethodTable,
  TEST_CLIENT_OPTIONS,
} from "./scripted-daemon.test-support.js";

type OutboundEnvelope = JsonRpcRequest | JsonRpcNotification;

// Fixtures

/** Low-entropy sentinel ids; see the header note on the secret scanner. */
const TEST_RUN_ID = "00000000-0000-4000-8000-000000000001" as RunId;
const TEST_IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000002";

/**
 * The fallback a driver with no native steer names. A literal because this package receives it off
 * the wire, never from a driver module.
 */
const QUEUE_AND_INTERRUPT = "queue_and_interrupt";

const METHOD_APPLY_INTERVENTION = "driver.applyIntervention";
const METHOD_SUBSCRIBE_EVENTS = "driver.subscribeEvents";
const METHOD_COMPACT_CONTEXT = "driver.compactContext";

/** A well-formed steer against the run whose bound driver declares no steer. */
const STEER_AGAINST_NO_NATIVE_STEER_DRIVER: ApplyInterventionParams = {
  type: "steer",
  targetRunId: TEST_RUN_ID,
  expectedRunVersion: 3,
  clientIdempotencyKey: TEST_IDEMPOTENCY_KEY,
  payload: { content: "Prefer the smaller refactor; skip the rename." },
};

/** Script one method to answer with a result value. */
function scriptResult(method: string, result: unknown): ScriptedMethodTable {
  return { [method]: () => ({ result }) };
}

/** Wire a `DriverClient` over a scripted daemon, returning both halves. */
function buildDriverClient(table: ScriptedMethodTable): {
  readonly client: DriverClient;
  readonly daemon: ScriptedDaemon;
} {
  const daemon = createScriptedDaemon(answerByMethod(table));
  const rpc = new JsonRpcClient(daemon, TEST_CLIENT_OPTIONS);
  return { client: createDaemonProviderClient(rpc), daemon };
}

/** The method name on a captured envelope, or `undefined` for a notification. */
function methodOf(envelope: OutboundEnvelope | undefined): string | undefined {
  if (envelope === undefined) {
    return undefined;
  }
  return envelope.method;
}

/** The params on a captured envelope. */
function paramsOf(envelope: OutboundEnvelope | undefined): unknown {
  if (envelope === undefined) {
    return undefined;
  }
  return envelope.params;
}

// The degraded envelope on the client-facing path

describe("driver.applyIntervention — degraded fallback across the SDK seam", () => {
  it("resolves a steer against a no-native-steer driver as degraded with its fallbackAction intact", async () => {
    const degradedAnswer = { status: "degraded", fallbackAction: QUEUE_AND_INTERRUPT };
    const { client, daemon } = buildDriverClient(
      scriptResult(METHOD_APPLY_INTERVENTION, degradedAnswer),
    );

    const result = await client.applyIntervention(STEER_AGAINST_NO_NATIVE_STEER_DRIVER);

    // Compared whole: asserting only `status` would pass against an SDK that dropped
    // `fallbackAction`, the only part of a degraded answer a caller can act on.
    expect(result).toStrictEqual(degradedAnswer);
    expect(result.status).toBe("degraded");
    expect(result.fallbackAction).toBe(QUEUE_AND_INTERRUPT);

    // The steer arm goes out unaltered.
    expect(daemon.sentEnvelopes.length).toBe(1);
    expect(methodOf(daemon.sentEnvelopes[0])).toBe(METHOD_APPLY_INTERVENTION);
    expect(paramsOf(daemon.sentEnvelopes[0])).toStrictEqual(STEER_AGAINST_NO_NATIVE_STEER_DRIVER);
  });
});

// The stream is narrowed to driver events. The daemon filters the same set before buffering, so
// this schema refuses nothing in a correct pairing; the scripted daemon below stands in for one
// whose filter regressed and that pushes a valid session event onto a driver stream.

/** Low-entropy sentinel ids; see the header note on the secret scanner. */
const TEST_SUBSCRIPTION_ID = "00000000-0000-4000-8000-000000000003";
const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000004" as SessionId;
const TEST_USER_ID = "00000000-0000-4000-8000-000000000005" as UserId;

/** The envelope version, branded here because a hand-built wire frame stands in for the daemon. */
const EVENT_VERSION = "1.0" as SessionEvent["version"];

/** An `assistant_output` row, which belongs on a driver stream. */
function buildDriverEvent(): SessionEvent {
  return {
    id: "evt-driver-0001",
    sessionId: TEST_SESSION_ID,
    sequence: 1,
    occurredAt: "2026-01-22T19:14:35.000Z",
    category: "assistant_output",
    type: "assistant.message",
    actor: null,
    version: EVENT_VERSION,
    payload: { sessionId: TEST_SESSION_ID, runId: TEST_RUN_ID },
  };
}

/** A valid session-lifecycle `SessionEvent` that names no run and belongs on no driver stream. */
function buildNonDriverEvent(): SessionEvent {
  return buildSessionCreatedEvent({
    id: "evt-non-driver-0001",
    sessionId: TEST_SESSION_ID,
    sequence: 2,
    occurredAt: "2026-01-22T19:14:36.000Z",
    actor: TEST_USER_ID,
  });
}

/** The `$/subscription/notify` frame the daemon emits on the test subscription. */
function subscriptionNotify(value: SessionEvent): JsonRpcNotification {
  return buildSubscriptionNotify(TEST_SUBSCRIPTION_ID, value);
}

/** A daemon that acks the subscribe-init with the sentinel subscription id. */
function buildSubscribingDriverClient(): {
  readonly client: DriverClient;
  readonly daemon: ScriptedDaemon;
} {
  return buildDriverClient(
    scriptResult(METHOD_SUBSCRIBE_EVENTS, { subscriptionId: TEST_SUBSCRIPTION_ID }),
  );
}

describe("driver.subscribeEvents — the stream is narrowed to driver events", () => {
  it("delivers a driver event to the consumer unaltered", async () => {
    const { client, daemon } = buildSubscribingDriverClient();

    const subscription = client.subscribeEvents({ runId: TEST_RUN_ID });
    daemon.deliverInbound(subscriptionNotify(buildDriverEvent()));

    // Positive control for the refusal below.
    await expect(subscription.next()).resolves.toEqual(buildDriverEvent());
  });

  it("rejects a subscribeEvents call whose runId is not a canonical id, synchronously and before the wire", () => {
    const { client, daemon } = buildDriverClient({});

    // The handle is returned synchronously, so the failure must throw here, on the call that
    // caused it, rather than surface at a later `next()`.
    expect(() => client.subscribeEvents({ runId: "not-a-uuid" as RunId })).toThrow(
      JsonRpcSchemaError,
    );
    expect(daemon.sentEnvelopes.length).toBe(0);
  });

  it("ENDS the subscription when the daemon pushes a schema-valid NON-driver event", async () => {
    const nonDriverEvent = buildNonDriverEvent();
    // The refusal below must come from the driver narrowing, so this fixture has to parse as a
    // session event.
    expect(SessionEventSchema.safeParse(nonDriverEvent).success).toBe(true);

    const { client, daemon } = buildSubscribingDriverClient();
    const subscription = client.subscribeEvents({ runId: TEST_RUN_ID });
    daemon.deliverInbound(subscriptionNotify(nonDriverEvent));

    let caught: unknown = null;
    try {
      await subscription.next();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(JsonRpcSchemaError);
    if (caught instanceof JsonRpcSchemaError) {
      // `value`: the request and the subscribe ack were fine; one streamed value failed.
      expect(caught.phase).toBe("value");
    }

    // A wire cancel goes out so the daemon releases its subscription entry.
    expect(daemon.sentEnvelopes.map(methodOf)).toStrictEqual([
      METHOD_SUBSCRIBE_EVENTS,
      SUBSCRIPTION_CANCEL_METHOD,
    ]);
  });
});

// A daemon refusal reaches the caller typed

describe("driver.* — a refusal surfaces as its registered code", () => {
  it("surfaces driver.capability_unsupported on compactContext as the typed remote refusal", async () => {
    // The static gate's refusal must stay a remote error; `{ status: 'refused' }` would claim the
    // caller was adjudicated when the driver simply lacks the capability.
    const { client } = buildDriverClient({
      [METHOD_COMPACT_CONTEXT]: () => ({
        error: {
          code: JsonRpcErrorCode.InvalidRequest,
          message: "Requested capability is not supported by the driver",
          data: { type: "driver.capability_unsupported" },
        },
      }),
    });

    let caught: unknown = null;
    try {
      await client.compactContext({ sessionId: TEST_SESSION_ID, runId: TEST_RUN_ID });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JsonRpcRemoteError);
    if (caught instanceof JsonRpcRemoteError) {
      expect(caught.data?.type).toBe("driver.capability_unsupported");
    }
  });
});
