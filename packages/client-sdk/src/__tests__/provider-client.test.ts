// Client-facing driver surface over a scripted daemon: the degraded intervention envelope reaches
// the caller intact, refusals surface typed, and the client exposes exactly the eight methods.
//
// The daemon is a script because this package does not depend on `@ai-sidekicks/runtime-daemon`;
// the two sides share `DriverInterventionResultSchema`. The capability gate that refuses before a
// call reaches the driver is asserted in
// `runtime-daemon/src/provider/__tests__/provider-registry.test.ts`, and the Claude driver's own
// fallback in `runtime-daemon/src/provider/drivers/claude/__tests__/intervention.test.ts`.
//
// Fixture UUIDs are low-entropy on purpose: the secret scanner flags high-entropy values under an
// identifier containing `Key`, and `clientIdempotencyKey` is that shape.

import { describe, expect, it } from "vitest";

import type {
  AgentId,
  ApplyInterventionParams,
  CompactContextRequest,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseEnvelope,
  ListProviderCommandsRequest,
  UserId,
  ProviderCommandListResult,
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
import {
  JsonRpcClient,
  JsonRpcRemoteError,
  JsonRpcSchemaError,
} from "../transport/json-rpc-client.js";
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
const METHOD_LIST_CAPABILITIES = "driver.listCapabilities";
const METHOD_LIST_MODELS = "driver.listModels";
const METHOD_LIST_MODES = "driver.listModes";
const METHOD_SUBSCRIBE_EVENTS = "driver.subscribeEvents";
const METHOD_COMPACT_CONTEXT = "driver.compactContext";
const METHOD_LIST_PROVIDER_COMMANDS = "driver.listProviderCommands";

/** A well-formed steer against the run whose bound driver declares no steer. */
const STEER_AGAINST_NO_NATIVE_STEER_DRIVER: ApplyInterventionParams = {
  type: "steer",
  targetRunId: TEST_RUN_ID,
  expectedRunVersion: 3,
  clientIdempotencyKey: TEST_IDEMPOTENCY_KEY,
  payload: { content: "Prefer the smaller refactor; skip the rename." },
};

// A scripted daemon behind an in-memory transport

/** A daemon refusal as it appears on the wire: numeric code plus `data.type`. */
interface WireRefusal {
  readonly jsonRpcCode: number;
  readonly type: string;
  readonly message: string;
}

/** One method's canned answer: a result value, or a typed wire refusal. */
type ScriptedAnswer = { readonly result: unknown } | { readonly refusal: WireRefusal };

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
    if ("result" in scripted) {
      return { jsonrpc: JSONRPC_VERSION, id: envelope.id, result: scripted.result };
    }
    return refusalEnvelope(envelope.id, scripted.refusal);
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

/** A typed daemon refusal as it appears on the wire. */
function refusalEnvelope(id: JsonRpcRequest["id"], refusal: WireRefusal): InboundEnvelope {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code: refusal.jsonRpcCode,
      message: refusal.message,
      data: { type: refusal.type },
    },
  };
}

/** Script one method to answer with a result value. */
function scriptResult(method: string, result: unknown): Record<string, ScriptedAnswer> {
  return { [method]: { result } };
}

/** Script one method to answer with a typed wire refusal. */
function scriptRefusal(method: string, refusal: WireRefusal): Record<string, ScriptedAnswer> {
  return { [method]: { refusal } };
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

  it("RESOLVES the degraded answer rather than rejecting — an unsupported intervention is data", async () => {
    const { client } = buildDriverClient(
      scriptResult(METHOD_APPLY_INTERVENTION, {
        status: "degraded",
        fallbackAction: QUEUE_AND_INTERRUPT,
      }),
    );

    // Had either side pre-gated `applyIntervention` on the capability flag, the caller would get
    // an error with no fallback hint.
    await expect(client.applyIntervention(STEER_AGAINST_NO_NATIVE_STEER_DRIVER)).resolves.toEqual(
      expect.objectContaining({ status: "degraded" }),
    );
  });

  it("refuses an off-contract driver answer at the seam instead of passing it to the caller", async () => {
    // `status` is closed at `applied | degraded`; a third value is a contract violation.
    const { client } = buildDriverClient(
      scriptResult(METHOD_APPLY_INTERVENTION, { status: "unsupported" }),
    );

    await expect(
      client.applyIntervention(STEER_AGAINST_NO_NATIVE_STEER_DRIVER),
    ).rejects.toBeInstanceOf(JsonRpcSchemaError);
  });

  it("refuses an answer carrying an unknown key — the envelope schema is strict", async () => {
    // An extra key means the producer speaks a different contract.
    const { client } = buildDriverClient(
      scriptResult(METHOD_APPLY_INTERVENTION, {
        status: "degraded",
        fallbackAction: QUEUE_AND_INTERRUPT,
        unexpectedMember: true,
      }),
    );

    let caught: unknown = null;
    try {
      await client.applyIntervention(STEER_AGAINST_NO_NATIVE_STEER_DRIVER);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JsonRpcSchemaError);
    if (caught instanceof JsonRpcSchemaError) {
      // `result`, not `params`: the request was well-formed and the daemon's reply failed.
      expect(caught.phase).toBe("result");
    }
  });

  it("refuses an intervention type outside the three arms BEFORE any wire write", async () => {
    // The cast stands in for a runtime caller composing params from untyped input.
    const unknownTypeParams = {
      type: "pause",
      targetRunId: TEST_RUN_ID,
      expectedRunVersion: 1,
      clientIdempotencyKey: TEST_IDEMPOTENCY_KEY,
      payload: {},
    } as unknown as ApplyInterventionParams;

    const { client, daemon } = buildDriverClient(
      scriptResult(METHOD_APPLY_INTERVENTION, { status: "applied" }),
    );

    await expect(client.applyIntervention(unknownTypeParams)).rejects.toBeInstanceOf(
      JsonRpcSchemaError,
    );
    // Nothing reached the wire.
    expect(daemon.sentEnvelopes.length).toBe(0);
  });
});

// A capability refusal reaches the caller typed

describe("driver.* — a capability refusal surfaces as its registered code", () => {
  it("surfaces driver.capability_unsupported as a typed remote error, not as a degraded envelope", async () => {
    // The gate's refusal and the driver's degraded answer are different outcomes; a refusal shaped
    // as `{ status: 'degraded' }` would promise a fallback that does not exist.
    const { client } = buildDriverClient(
      scriptRefusal(METHOD_LIST_CAPABILITIES, {
        jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
        type: "driver.capability_unsupported",
        message: "Requested capability is not supported by the driver",
      }),
    );

    let caught: unknown = null;
    try {
      await client.listCapabilities();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(JsonRpcRemoteError);
    if (caught instanceof JsonRpcRemoteError) {
      // The dotted `data.type` is what consumers switch on; the numeric code alone is coarse.
      expect(caught.data?.type).toBe("driver.capability_unsupported");
      expect(caught.code).toBe(JsonRpcErrorCode.InvalidRequest);
    }
  });

  it("surfaces driver.unavailable with its own registered type rather than collapsing both refusals", async () => {
    const { client } = buildDriverClient(
      scriptRefusal(METHOD_LIST_MODELS, {
        jsonRpcCode: JsonRpcErrorCode.InternalError,
        type: "driver.unavailable",
        message: "Provider driver is currently unavailable",
      }),
    );

    let caught: unknown = null;
    try {
      await client.listModels({ sessionId: TEST_SESSION_ID });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(JsonRpcRemoteError);
    if (caught instanceof JsonRpcRemoteError) {
      expect(caught.data?.type).toBe("driver.unavailable");
    }
  });
});

// The client surface: what it sends, and what it cannot reach

describe("DriverClient — the ratified client-facing surface", () => {
  it("sends each read's registered request rather than an invented per-driver selector", async () => {
    const emptyRoster = { drivers: [] };
    const { client, daemon } = buildDriverClient({
      [METHOD_LIST_CAPABILITIES]: { result: emptyRoster },
      [METHOD_LIST_MODELS]: { result: emptyRoster },
      [METHOD_LIST_MODES]: { result: emptyRoster },
    });

    await client.listCapabilities();
    await client.listModels({ sessionId: TEST_SESSION_ID });
    await client.listModes();

    // Both request schemas are strict, so a `{ driverName }` selector would fail the daemon parse.
    expect(
      daemon.sentEnvelopes.map((envelope) => [envelope.method, envelope.params]),
    ).toStrictEqual([
      [METHOD_LIST_CAPABILITIES, {}],
      [METHOD_LIST_MODELS, { sessionId: TEST_SESSION_ID }],
      [METHOD_LIST_MODES, {}],
    ]);
  });

  it("exposes exactly the eight ratified methods and none of the four lifecycle operations", () => {
    const { client } = buildDriverClient({});

    // The lifecycle operations are absent so a client cannot mint runtime state behind the
    // orchestrator's back, and a failed resume has no route to a replacement session.
    for (const lifecycleOperation of [
      "createSession",
      "resumeSession",
      "startRun",
      "closeSession",
    ]) {
      expect(lifecycleOperation in client).toBe(false);
    }

    // @ts-expect-error `createSession` is not on `DriverClient`.
    expect(client.createSession).toBeUndefined();

    expect(Object.keys(client).sort()).toStrictEqual([
      "applyIntervention",
      "compactContext",
      "interruptRun",
      "listCapabilities",
      "listModels",
      "listModes",
      "listProviderCommands",
      "subscribeEvents",
    ]);
  });

  it("exposes none of the four R8 parity operations either (the absence half)", () => {
    // These are daemon-internal too: a second route here would split one operation's authority
    // across two doors.
    const { client } = buildDriverClient({});
    for (const parityOperation of [
      "forkConversation",
      "setSessionGoal",
      "clearSessionGoal",
      "probeAuth",
    ]) {
      expect(parityOperation in client).toBe(false);
    }

    // @ts-expect-error `forkConversation` is not on `DriverClient`.
    expect(client.forkConversation).toBeUndefined();
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

// The two console-parity verbs across the SDK seam

/** Low-entropy sentinel; see the header note on the secret scanner. */
const TEST_AGENT_ID = "00000000-0000-4000-8000-000000000007";

/** One binding's group as the daemon merges it. */
const COMMAND_GROUP: ProviderCommandListResult = {
  bindings: [
    {
      runId: TEST_RUN_ID,
      binding: { driverName: "claude", providerAccountId: null },
      entries: [
        {
          name: "compact",
          kind: "command",
          binding: { driverName: "claude", providerAccountId: null },
        },
      ],
      complete: true,
    },
  ],
};

describe("driver.compactContext / driver.listProviderCommands — the console-parity verbs", () => {
  it("sends the session-addressed compaction request verbatim and resolves a refusal as DATA", async () => {
    // `not_permitted` arrives on the operation's own `refused` arm, a value a caller branches on.
    const refusedAnswer = { status: "refused", reason: "not_permitted" };
    const { client, daemon } = buildDriverClient(
      scriptResult(METHOD_COMPACT_CONTEXT, refusedAnswer),
    );

    const result = await client.compactContext({
      sessionId: TEST_SESSION_ID,
      runId: TEST_RUN_ID,
    });

    expect(result).toStrictEqual(refusedAnswer);
    expect(daemon.sentEnvelopes.length).toBe(1);
    expect(methodOf(daemon.sentEnvelopes[0])).toBe(METHOD_COMPACT_CONTEXT);
    expect(paramsOf(daemon.sentEnvelopes[0])).toStrictEqual({
      sessionId: TEST_SESSION_ID,
      runId: TEST_RUN_ID,
    });
  });

  it("refuses an applied arm missing its boundaryPosition at the seam — the discriminated union is the contract", async () => {
    // `applied` requires `boundaryPosition` (nullable, never absent).
    const { client } = buildDriverClient(
      scriptResult(METHOD_COMPACT_CONTEXT, { status: "applied" }),
    );

    let caught: unknown = null;
    try {
      await client.compactContext({ sessionId: TEST_SESSION_ID, runId: TEST_RUN_ID });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JsonRpcSchemaError);
    if (caught instanceof JsonRpcSchemaError) {
      expect(caught.phase).toBe("result");
    }
  });

  it("resolves the per-binding group list intact, each entry still carrying its routing pair", async () => {
    const { client, daemon } = buildDriverClient(
      scriptResult(METHOD_LIST_PROVIDER_COMMANDS, COMMAND_GROUP),
    );

    const result = await client.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      agentId: TEST_AGENT_ID,
    });

    // Compared whole: the `(driverName, providerAccountId)` pair on every entry keeps a
    // Claude-enumerated command off a Codex agent.
    expect(result).toStrictEqual(COMMAND_GROUP);
    expect(methodOf(daemon.sentEnvelopes[0])).toBe(METHOD_LIST_PROVIDER_COMMANDS);
    expect(paramsOf(daemon.sentEnvelopes[0])).toStrictEqual({
      sessionId: TEST_SESSION_ID,
      agentId: TEST_AGENT_ID,
    });
  });

  it("REFUSES a bindingId on either request BEFORE any wire write — no binding member exists on the wire", async () => {
    // The cast stands in for a runtime caller composing params from untyped input.
    const { client, daemon } = buildDriverClient({
      [METHOD_COMPACT_CONTEXT]: { result: { status: "applied", boundaryPosition: null } },
      [METHOD_LIST_PROVIDER_COMMANDS]: { result: COMMAND_GROUP },
    });

    await expect(
      client.compactContext({
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        bindingId: "binding-1",
      } as unknown as CompactContextRequest),
    ).rejects.toBeInstanceOf(JsonRpcSchemaError);
    await expect(
      client.listProviderCommands({
        sessionId: TEST_SESSION_ID,
        agentId: TEST_AGENT_ID,
        bindingId: "binding-1",
      } as unknown as ListProviderCommandsRequest),
    ).rejects.toBeInstanceOf(JsonRpcSchemaError);
    expect(daemon.sentEnvelopes.length).toBe(0);
  });

  it("surfaces driver.capability_unsupported on both verbs as the typed remote refusal", async () => {
    // The static gate's refusal must stay a remote error; `{ status: 'refused' }` would claim the
    // caller was adjudicated when the driver simply lacks the capability.
    const capabilityRefusal = {
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      type: "driver.capability_unsupported",
      message: "Requested capability is not supported by the driver",
    };
    const { client } = buildDriverClient({
      [METHOD_COMPACT_CONTEXT]: { refusal: capabilityRefusal },
      [METHOD_LIST_PROVIDER_COMMANDS]: { refusal: capabilityRefusal },
    });

    for (const call of [
      () => client.compactContext({ sessionId: TEST_SESSION_ID, runId: TEST_RUN_ID }),
      () => client.listProviderCommands({ sessionId: TEST_SESSION_ID, agentId: TEST_AGENT_ID }),
    ]) {
      let caught: unknown = null;
      try {
        await call();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(JsonRpcRemoteError);
      if (caught instanceof JsonRpcRemoteError) {
        expect(caught.data?.type).toBe("driver.capability_unsupported");
      }
    }
  });

  it("surfaces the masked session refusal exactly as the daemon shaped it", async () => {
    // A non-member and an unknown session are byte-identical on the wire; the SDK adds nothing.
    const { client } = buildDriverClient(
      scriptRefusal(METHOD_COMPACT_CONTEXT, {
        jsonRpcCode: JsonRpcErrorCode.InvalidParams,
        type: "session.not_found",
        message: "Session does not exist or is not accessible",
      }),
    );

    let caught: unknown = null;
    try {
      await client.compactContext({ sessionId: TEST_SESSION_ID, runId: TEST_RUN_ID });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JsonRpcRemoteError);
    if (caught instanceof JsonRpcRemoteError) {
      expect(caught.data?.type).toBe("session.not_found");
      expect(caught.message).toContain("Session does not exist or is not accessible");
    }
  });
});
