// T4.6 — degraded-fallback orchestration tests (Plan-005 Phase 4).
//
// Verifies I-005-4 (the degraded intervention envelope) and the client-facing
// half of I-005-2 (undeclared capability = unsupported), mapping to
// `Spec-005 §Acceptance Criteria` AC2.
//
// WHERE THIS FILE SITS ON A TWO-SIDED CLAIM. The task names two assertions and
// they live at two different boundaries, so they are tested at two:
//
//   (1) The CLIENT-FACING path — `driver.applyIntervention` against a run whose
//       bound driver declares `steer: false` answers `degraded` naming the
//       daemon's fallback, and that envelope reaches an SDK caller intact. That
//       is this file. It is the half nothing covered before T4.3 existed, since
//       there was no client-facing path to answer through.
//
//   (2) The ORCHESTRATION-TO-DRIVER path — `ProviderRegistry.checkCapability`
//       refuses a capability-bound invocation BEFORE the call reaches the
//       driver. That gate is daemon-internal by Plan-005 §Phase 4 decision #2
//       (the lifecycle operations it guards are registered on no client
//       namespace), so it is asserted against the real class beside it, in the
//       T4.6 block of
//       `runtime-daemon/src/provider/__tests__/provider-registry.test.ts`, which
//       pins the "before the driver" clause by asserting the driver's own call
//       count is zero on a refusal. Restating it here would mean either widening
//       another package's public API so a test could import an internal class,
//       or re-implementing the gate as a double — and a test that
//       re-implements the guard it is checking proves nothing.
//
// WHY A SCRIPTED DAEMON RATHER THAN THE CLAUDE DRIVER ITSELF. This package does
// not depend on `@ai-sidekicks/runtime-daemon`, and it should not start: that
// package's entry point exports its session surface only, so reaching the Claude
// driver from here would mean widening a public API for a test's benefit. What
// the two sides genuinely share is the CONTRACT — `DriverInterventionResultSchema`
// — and both go through it: the driver parses its answer through that schema
// before returning (`provider/drivers/claude/intervention.ts`), and this client
// parses the same schema on the way in. The driver-side agreement that Claude
// declares `steer: false` and names `queue_and_interrupt` is asserted where it
// lives, in that module's own tests — `provider/drivers/claude/__tests__/
// intervention.test.ts` pins the constant's value under
// `describe("CLAUDE_STEER_FALLBACK_ACTION")` and asserts the degraded envelope
// in `it("degrades with the documented queue_and_interrupt fallback")`. What is
// asserted here is the other half: that the envelope survives the wire and the
// SDK seam without being flattened, defaulted, or laundered into a throw.
//
// The fallback string is written as a literal rather than imported for the same
// reason: it is a wire value this package RECEIVES, not one it produces. Its
// producer-side definition is `CLAUDE_STEER_FALLBACK_ACTION`, and the pinning
// test named above is what keeps this literal and that constant from drifting
// apart without a failure.
//
// Fixture UUIDs are low-entropy sentinels on purpose — the repo's secret scanner
// flags high-entropy values sitting under an identifier containing `Key`, and
// `clientIdempotencyKey` is exactly that shape.

import { describe, expect, it } from "vitest";

import type {
  ApplyInterventionParams,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseEnvelope,
  RunId,
} from "@ai-sidekicks/contracts";
import { JSONRPC_VERSION, JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import type { DriverClient } from "../providerClient.js";
import { createDaemonProviderClient } from "../providerClient.js";
import {
  JsonRpcClient,
  JsonRpcRemoteError,
  JsonRpcSchemaError,
} from "../transport/jsonRpcClient.js";
import type { ClientTransport } from "../transport/types.js";

/**
 * The two envelope directions, aliased so the signatures below read as
 * directions rather than as repeated unions.
 */
type OutboundEnvelope = JsonRpcRequest | JsonRpcNotification;
type InboundEnvelope = JsonRpcResponseEnvelope | JsonRpcNotification;

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const PROTOCOL_VERSION = "2026-05-01";

/** Low-entropy sentinel ids — see the header note on the secret scanner. */
const TEST_RUN_ID = "00000000-0000-4000-8000-000000000001" as RunId;
const TEST_IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000002";

/**
 * ADR-011's documented fallback for a provider with no native steer, and the
 * value the Claude driver names. Written as a literal because this package
 * consumes it off the wire rather than producing it; the producer-side value is
 * pinned against this same string by the driver's own tests. See the file
 * header.
 */
const QUEUE_AND_INTERRUPT = "queue_and_interrupt";

const METHOD_APPLY_INTERVENTION = "driver.applyIntervention";
const METHOD_LIST_CAPABILITIES = "driver.listCapabilities";
const METHOD_LIST_MODELS = "driver.listModels";
const METHOD_LIST_MODES = "driver.listModes";

/** A well-formed steer against the run whose bound driver declares no steer. */
const STEER_AGAINST_NO_NATIVE_STEER_DRIVER: ApplyInterventionParams = {
  type: "steer",
  targetRunId: TEST_RUN_ID,
  expectedRunVersion: 3,
  clientIdempotencyKey: TEST_IDEMPOTENCY_KEY,
  payload: { content: "Prefer the smaller refactor; skip the rename." },
};

// ----------------------------------------------------------------------------
// A scripted daemon behind an in-memory transport
// ----------------------------------------------------------------------------

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
}

/**
 * Build a transport that answers each request synchronously from a per-method
 * script, so a `client.call(...)` promise is already settled when the test
 * awaits it. Mirrors the double in `transport/__tests__/jsonRpcClient.test.ts`,
 * with that file's hand-driven `dispatchInbound` replaced by a routing table —
 * the assertions here are about a round trip through the SDK factory, not about
 * correlating one hand-built frame.
 *
 * A method with no script answers `MethodNotFound`, which is what the real
 * registry substrate does for an unregistered name. That is load-bearing rather
 * than tidy: it is what lets an assertion that a lifecycle verb is unreachable
 * mean the same thing here as it does against the daemon.
 */
function createScriptedDaemon(script: Record<string, ScriptedAnswer>): ScriptedDaemon {
  const sentEnvelopes: OutboundEnvelope[] = [];
  let deliverInbound: (message: InboundEnvelope) => void = () => undefined;
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
    send(envelope: OutboundEnvelope): void {
      sentEnvelopes.push(envelope);
      if ("id" in envelope) {
        deliverInbound(answer(envelope));
      }
    },
    onMessage(handler: (message: InboundEnvelope) => void): void {
      deliverInbound = handler;
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

/** The envelope the registry substrate emits for a name it never bound. */
function methodNotFound(id: JsonRpcRequest["id"]): InboundEnvelope {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code: JsonRpcErrorCode.MethodNotFound, message: "Method not found" },
  };
}

/** A typed daemon refusal, shaped as the I-007-8 wire mapping delivers it. */
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

// ----------------------------------------------------------------------------
// I-005-4 / AC2 — the degraded envelope on the client-facing path
// ----------------------------------------------------------------------------

describe("driver.applyIntervention — degraded fallback across the SDK seam (I-005-4, AC2)", () => {
  it("resolves a steer against a no-native-steer driver as degraded with its fallbackAction intact", async () => {
    const degradedAnswer = { status: "degraded", fallbackAction: QUEUE_AND_INTERRUPT };
    const { client, daemon } = buildDriverClient(
      scriptResult(METHOD_APPLY_INTERVENTION, degradedAnswer),
    );

    const result = await client.applyIntervention(STEER_AGAINST_NO_NATIVE_STEER_DRIVER);

    // The whole envelope, compared as a whole. Asserting only on `status` would
    // pass against an SDK that dropped `fallbackAction` — and dropping it is the
    // exact regression this test exists to catch, because the fallback name is
    // the only part of a degraded answer a caller can act on.
    expect(result).toStrictEqual(degradedAnswer);
    expect(result.status).toBe("degraded");
    expect(result.fallbackAction).toBe(QUEUE_AND_INTERRUPT);

    // The call went out on the ratified method name carrying the steer arm
    // unaltered — the SDK forwards, it does not re-shape.
    expect(daemon.sentEnvelopes.length).toBe(1);
    expect(methodOf(daemon.sentEnvelopes[0])).toBe(METHOD_APPLY_INTERVENTION);
    expect(paramsOf(daemon.sentEnvelopes[0])).toStrictEqual(STEER_AGAINST_NO_NATIVE_STEER_DRIVER);
  });

  it("RESOLVES the degraded answer rather than rejecting — an unsupported intervention is data (ADR-011)", async () => {
    const { client } = buildDriverClient(
      scriptResult(METHOD_APPLY_INTERVENTION, {
        status: "degraded",
        fallbackAction: QUEUE_AND_INTERRUPT,
      }),
    );

    // The distinction this pins: had either side pre-gated `applyIntervention`
    // on the capability flag, the caller would have received an error carrying
    // no fallback hint at all. `resolves` is the assertion; a rejection here
    // would mean the fallback route had been replaced by a dead end.
    await expect(client.applyIntervention(STEER_AGAINST_NO_NATIVE_STEER_DRIVER)).resolves.toEqual(
      expect.objectContaining({ status: "degraded" }),
    );
  });

  it("refuses an off-contract driver answer at the seam instead of passing it to the caller", async () => {
    // `status` is closed at `applied | degraded`. A driver (or a daemon
    // composing its reply) that invents a third value is a contract violation,
    // and the seam must surface it as one rather than handing a caller a status
    // no consumer has a branch for.
    const { client } = buildDriverClient(
      scriptResult(METHOD_APPLY_INTERVENTION, { status: "unsupported" }),
    );

    await expect(
      client.applyIntervention(STEER_AGAINST_NO_NATIVE_STEER_DRIVER),
    ).rejects.toBeInstanceOf(JsonRpcSchemaError);
  });

  it("refuses an answer carrying an unknown key — the envelope schema is strict", async () => {
    // `.strict()` on a fixed-protocol envelope: an extra key means the producer
    // believes it is speaking a different contract, and accepting it silently
    // hides that until something downstream reads a field that never arrived.
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
      // `result` phase, not `params`: the caller's request was well-formed and
      // the daemon's reply is what failed. The phase is how a consumer tells a
      // caller bug from server corruption.
      expect(caught.phase).toBe("result");
    }
  });

  it("refuses a rollback intervention at the seam BEFORE any wire write", async () => {
    // `ApplyInterventionParamsSchema` is a discriminated union over three arms.
    // `rollback` is Spec-004 content driven through a different driver
    // operation, so a caller reaching for it here must fail at the
    // discriminator rather than reach a handler that would have to invent a
    // refusal. The cast is the realistic path — a runtime caller composing
    // params from untyped input, not a TypeScript-detected mismatch.
    const rollbackParams = {
      type: "rollback",
      targetRunId: TEST_RUN_ID,
      expectedRunVersion: 1,
      clientIdempotencyKey: TEST_IDEMPOTENCY_KEY,
      payload: {},
    } as unknown as ApplyInterventionParams;

    const { client, daemon } = buildDriverClient(
      scriptResult(METHOD_APPLY_INTERVENTION, { status: "applied" }),
    );

    await expect(client.applyIntervention(rollbackParams)).rejects.toBeInstanceOf(
      JsonRpcSchemaError,
    );
    // Nothing reached the wire — the fail-fast is what keeps a malformed
    // request from occupying a daemon dispatch slot at all.
    expect(daemon.sentEnvelopes.length).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// I-005-2 (client-facing half) — a capability refusal reaches the caller typed
// ----------------------------------------------------------------------------

describe("driver.* — a capability refusal surfaces as its registered code (I-005-2, AC2)", () => {
  it("surfaces driver.capability_unsupported as a typed remote error, not as a degraded envelope", async () => {
    // The daemon's gate and the driver's degraded answer are DIFFERENT
    // outcomes, and the SDK must keep them distinguishable: a refusal that
    // arrived as `{ status: 'degraded' }` would tell a caller a fallback is
    // available when none is.
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
      // The dotted `data.type` is the discriminator consumers switch on; the
      // coarse numeric alone cannot tell this refusal from any other 400.
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
      await client.listModels();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(JsonRpcRemoteError);
    if (caught instanceof JsonRpcRemoteError) {
      expect(caught.data?.type).toBe("driver.unavailable");
    }
  });
});

// ----------------------------------------------------------------------------
// The ratified client surface — what it sends, and what it cannot reach
// ----------------------------------------------------------------------------

describe("DriverClient — the ratified client-facing surface (Plan-005 §Phase 4 decision #2)", () => {
  it("sends the registered empty request on all three reads rather than an invented per-driver selector", async () => {
    const emptyRoster = { drivers: [] };
    const { client, daemon } = buildDriverClient({
      [METHOD_LIST_CAPABILITIES]: { result: emptyRoster },
      [METHOD_LIST_MODELS]: { result: emptyRoster },
      [METHOD_LIST_MODES]: { result: emptyRoster },
    });

    await client.listCapabilities();
    await client.listModels();
    await client.listModes();

    // `DriverReadParams` is the empty object and the schema is strict, so a
    // `{ driverName }` selector would contradict the ratified no-arg signature
    // AND fail the daemon's own request parse. Asserting the wire shape is what
    // keeps the two facts from drifting apart.
    expect(daemon.sentEnvelopes.length).toBe(3);
    expect(daemon.sentEnvelopes.map((envelope) => envelope.method)).toStrictEqual([
      METHOD_LIST_CAPABILITIES,
      METHOD_LIST_MODELS,
      METHOD_LIST_MODES,
    ]);
    for (const envelope of daemon.sentEnvelopes) {
      expect(envelope.params).toStrictEqual({});
    }
  });

  it("exposes exactly the seven ratified methods and none of the four lifecycle operations", () => {
    const { client } = buildDriverClient({});

    // The four lifecycle operations establish, restore, start, or tear down a
    // session-or-run domain object. Their ABSENCE is the enforcement: a client
    // holding this object cannot mint runtime state behind the orchestrator's
    // back, because there is no method to call. This is also the client-facing
    // half of I-005-5 — a failed resume has no route to a replacement session
    // here, since there is no route to session creation at all.
    for (const lifecycleOperation of [
      "createSession",
      "resumeSession",
      "startRun",
      "closeSession",
    ]) {
      expect(lifecycleOperation in client).toBe(false);
    }

    // @ts-expect-error — `createSession` is deliberately not on `DriverClient`;
    // this line failing to error would mean the lifecycle narrowing regressed.
    expect(client.createSession).toBeUndefined();

    expect(Object.keys(client).sort()).toStrictEqual([
      "applyIntervention",
      "interruptRun",
      "listCapabilities",
      "listModels",
      "listModes",
      "respondToRequest",
      "subscribeEvents",
    ]);
  });

  it("rejects a subscribeEvents call whose runId is not a canonical id, synchronously and before the wire", () => {
    const { client, daemon } = buildDriverClient({});

    // `subscribeEvents` hands back a consumer handle synchronously, so an
    // unvalidated bad id would leave the caller holding a live-looking handle
    // whose failure only appeared at an eventual `next()`. Throwing here, on
    // the same typed error class `call` uses, keeps the failure attached to the
    // call that caused it.
    expect(() => client.subscribeEvents({ runId: "not-a-uuid" as RunId })).toThrow(
      JsonRpcSchemaError,
    );
    expect(daemon.sentEnvelopes.length).toBe(0);
  });
});
