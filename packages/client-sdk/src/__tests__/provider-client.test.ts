// The client-facing driver surface over a scripted daemon: the degraded intervention envelope
// reaches the caller intact, a bad `runId` is refused before the wire, and a driver stream ends
// when the daemon pushes a non-driver event.
//
// The daemon is a script because this package does not depend on `@ai-sidekicks/runtime-daemon`;
// the two sides share the contract schemas.
//
// Fixture UUIDs are low-entropy on purpose: the secret scanner flags high-entropy values under an
// identifier containing `Key`, and `clientIdempotencyKey` is that shape.

import { describe, expect, it } from "vitest";

import type {
  AgentId,
  ApplyInterventionParams,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseEnvelope,
  UserId,
  RunId,
  SessionEvent,
  SessionId,
} from "@ai-sidekicks/contracts";
import {
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  SessionEventSchema,
  SUBSCRIPTION_CANCEL_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
} from "@ai-sidekicks/contracts";

import type { DriverClient } from "../provider-client.js";
import { createDaemonProviderClient } from "../provider-client.js";
import { JsonRpcClient, JsonRpcSchemaError } from "../transport/json-rpc-client.js";
import type { ClientTransport } from "../transport/types.js";
/** The two envelope directions. */
type OutboundEnvelope = JsonRpcRequest | JsonRpcNotification;
type InboundEnvelope = JsonRpcResponseEnvelope | JsonRpcNotification;

// Fixtures

const PROTOCOL_VERSION = "2026-05-01";

/** Low-entropy sentinel ids; see the header note on the secret scanner. */
const TEST_RUN_ID = "00000000-0000-4000-8000-000000000001" as RunId;
const TEST_IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000002";

/**
 * The fallback the Claude driver names for a provider with no native steer. A literal because this
 * package receives it off the wire; the driver's own tests pin the producer-side value.
 */
const QUEUE_AND_INTERRUPT = "queue_and_interrupt";

const METHOD_APPLY_INTERVENTION = "driver.applyIntervention";
const METHOD_SUBSCRIBE_EVENTS = "driver.subscribeEvents";

/** A well-formed steer against the run whose bound driver declares no steer. */
const STEER_AGAINST_NO_NATIVE_STEER_DRIVER: ApplyInterventionParams = {
  type: "steer",
  targetRunId: TEST_RUN_ID,
  expectedRunVersion: 3,
  clientIdempotencyKey: TEST_IDEMPOTENCY_KEY,
  payload: { content: "Prefer the smaller refactor; skip the rename." },
};

// A scripted daemon behind an in-memory transport

/** One method's canned answer. */
type ScriptedAnswer = { readonly result: unknown };

/** The transport double plus the outbound envelopes it captured. */
interface ScriptedDaemon extends ClientTransport {
  readonly sentEnvelopes: OutboundEnvelope[];
  /** Push a frame nothing solicited, such as a `$/subscription/notify`. */
  readonly deliverInbound: (message: InboundEnvelope) => void;
}

/**
 * Build a transport that answers each request synchronously from a per-method script. A method
 * with no script answers `MethodNotFound`, as the real registry does for an unregistered name.
 */
function createScriptedDaemon(script: Record<string, ScriptedAnswer>): ScriptedDaemon {
  const sentEnvelopes: OutboundEnvelope[] = [];
  let inboundHandler: (message: InboundEnvelope) => void = () => undefined;
  let notifyClosed: (reason?: Error) => void = () => undefined;

  const answer = (envelope: JsonRpcRequest): InboundEnvelope => {
    const scripted = script[envelope.method];
    if (scripted === undefined) {
      return methodNotFound(envelope.id);
    }
    return { jsonrpc: JSONRPC_VERSION, id: envelope.id, result: scripted.result };
  };

  return {
    sentEnvelopes,
    deliverInbound(message: InboundEnvelope): void {
      inboundHandler(message);
    },
    send(envelope: OutboundEnvelope): void {
      sentEnvelopes.push(envelope);
      if ("id" in envelope) {
        inboundHandler(answer(envelope));
      }
    },
    onMessage(handler: (message: InboundEnvelope) => void): void {
      inboundHandler = handler;
    },
    onClose(handler: (reason?: Error) => void): void {
      notifyClosed = handler;
    },
    close(): Promise<void> {
      notifyClosed(undefined);
      return Promise.resolve();
    },
  };
}

/** The envelope the registry emits for a name it never bound. */
function methodNotFound(id: JsonRpcRequest["id"]): InboundEnvelope {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code: JsonRpcErrorCode.MethodNotFound, message: "Method not found" },
  };
}

/** Script one method to answer with a result value. */
function scriptResult(method: string, result: unknown): Record<string, ScriptedAnswer> {
  return { [method]: { result } };
}

/** Wire a `DriverClient` over a scripted daemon, returning both halves. */
function buildDriverClient(script: Record<string, ScriptedAnswer>): {
  readonly client: DriverClient;
  readonly daemon: ScriptedDaemon;
} {
  const daemon = createScriptedDaemon(script);
  const rpc = new JsonRpcClient(daemon, { protocolVersion: PROTOCOL_VERSION });
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
  return {
    id: "evt-non-driver-0001",
    sessionId: TEST_SESSION_ID,
    sequence: 2,
    occurredAt: "2026-01-22T19:14:36.000Z",
    category: "session_lifecycle",
    type: "session.created",
    actor: TEST_USER_ID,
    version: EVENT_VERSION,
    payload: {
      sessionId: TEST_SESSION_ID,
      shape: "chat",
      mainAgent: {
        agentId: "00000000-0000-4000-8000-000000000044" as AgentId,
        name: "Implementer",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: "2026-01-22T19:14:35.000Z",
      },
    },
  };
}

/** The `$/subscription/notify` frame the daemon emits. */
function subscriptionNotify(value: SessionEvent): JsonRpcNotification {
  return {
    jsonrpc: JSONRPC_VERSION,
    method: SUBSCRIPTION_NOTIFY_METHOD,
    params: { subscriptionId: TEST_SUBSCRIPTION_ID, value },
  };
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
