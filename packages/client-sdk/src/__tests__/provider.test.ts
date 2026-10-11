// The client-facing driver surface over a scripted daemon: the degraded intervention envelope
// reaches the caller intact, and a daemon refusal reaches it as its registered code.
//
// Fixture UUIDs are low-entropy on purpose: the secret scanner flags high-entropy values under an
// identifier containing `Key`, and `clientIdempotencyKey` is that shape.

import { describe, expect, it } from "vitest";

import type { ApplyInterventionRequest } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import {
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { createDaemonProviderClient, type DriverClient } from "../provider.js";
import { JsonRpcClient, JsonRpcRemoteError } from "../transport/json-rpc.js";
import {
  answerByMethod,
  createScriptedDaemon,
  type ScriptedDaemon,
  type ScriptedMethodTable,
  TEST_CLIENT_OPTIONS,
} from "../../tests/helpers/scripted-daemon.js";

type OutboundEnvelope = JsonRpcRequest | JsonRpcNotification;

// Fixtures

/** Low-entropy sentinel ids; see the header note on the secret scanner. */
const TEST_RUN_ID = "00000000-0000-4000-8000-000000000001" as RunId;
const TEST_IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000002";

/** A fallback a driver names on a degraded answer; this package only carries it. */
const DRIVER_FALLBACK_ACTION = "driver-named-fallback";

const METHOD_APPLY_INTERVENTION = "driver.applyIntervention";
const METHOD_COMPACT_CONTEXT = "driver.compactContext";

/** A well-formed interrupt, which the scripted daemon answers degraded. */
const DEGRADED_INTERRUPT: ApplyInterventionRequest = {
  type: "interrupt",
  targetRunId: TEST_RUN_ID,
  expectedRunVersion: 3,
  clientIdempotencyKey: TEST_IDEMPOTENCY_KEY,
  payload: { pending: "nextTurn" },
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
  it("resolves a degraded interrupt with its fallbackAction intact", async () => {
    const degradedAnswer = { status: "degraded", fallbackAction: DRIVER_FALLBACK_ACTION };
    const { client, daemon } = buildDriverClient(
      scriptResult(METHOD_APPLY_INTERVENTION, degradedAnswer),
    );

    const result = await client.applyIntervention(DEGRADED_INTERRUPT);

    // Compared whole: asserting only `status` would pass against an SDK that dropped
    // `fallbackAction`, the only part of a degraded answer a caller can act on.
    expect(result).toStrictEqual(degradedAnswer);
    expect(result.status).toBe("degraded");
    expect(result.fallbackAction).toBe(DRIVER_FALLBACK_ACTION);

    // The interrupt goes out unaltered.
    expect(daemon.sentEnvelopes.length).toBe(1);
    expect(methodOf(daemon.sentEnvelopes[0])).toBe(METHOD_APPLY_INTERVENTION);
    expect(paramsOf(daemon.sentEnvelopes[0])).toStrictEqual(DEGRADED_INTERRUPT);
  });
});

/** Low-entropy sentinel id; see the header note on the secret scanner. */
const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000004" as SessionId;

// A daemon refusal reaches the caller typed

describe("driver.* — a refusal surfaces as its registered code", () => {
  it("surfaces capability_unsupported on compactContext as the typed remote refusal", async () => {
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
