// A failed resume is data a caller can read, never a route to a new session.
//
// This file covers the contract (the resume result shape can express a failure and cannot express a
// silent replacement, which also binds drivers not yet written) and reachability (no client route
// mints a session, asserted through the shipped SDK factory). Whether a real driver refuses a
// resume without calling `createSession()` is asserted in that driver's own tests.

import { describe, expect, it } from "vitest";

import type {
  DriverResumeResult,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseEnvelope,
  RunId,
  SessionId,
} from "@ai-sidekicks/contracts";
import { DriverResumeResultSchema, JSONRPC_VERSION } from "@ai-sidekicks/contracts";

import { createDaemonProviderClient } from "../provider-client.js";
import { JsonRpcClient } from "../transport/json-rpc-client.js";
import type { ClientTransport } from "../transport/types.js";

type OutboundEnvelope = JsonRpcRequest | JsonRpcNotification;
type InboundEnvelope = JsonRpcResponseEnvelope | JsonRpcNotification;

// Fixtures

const PROTOCOL_VERSION = "2026-05-01";

/** Low-entropy sentinel ids; no real identifier is involved. */
const TEST_RUN_ID = "00000000-0000-4000-8000-000000000001" as RunId;
const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000004" as SessionId;
const TEST_AGENT_ID = "00000000-0000-4000-8000-000000000005";

/**
 * The result of a Codex resume refusal: the provider declines to restore the recorded thread, so
 * the driver reports a typed failure instead of starting a fresh one. `unclassifiable` is stated
 * rather than omitted, and a consumer treats it exactly as `irreversible`.
 */
const CODEX_RESUME_REFUSAL: DriverResumeResult = {
  status: "failed",
  recoveryCondition: "recovery-needed",
  recoverySpanClassification: "unclassifiable",
  providerFailureDetail: "codex resume refused: no thread matches the recorded resume handle",
};

/**
 * A failure that also carries a fresh binding, so one reader sees a halt and another a live
 * session. Typed `unknown` because the assertions below show it is not a `DriverResumeResult`.
 */
const FAILURE_CARRYING_A_REPLACEMENT_BINDING: unknown = {
  status: "failed",
  recoveryCondition: "recovery-needed",
  recoverySpanClassification: "unclassifiable",
  providerFailureDetail: "codex resume refused; started a fresh thread instead",
  bindingId: "replacement-binding-minted-behind-the-callers-back",
  sessionPosition: 0,
};

// The carrier shape: a failure is expressible, a silent replacement is not

describe("DriverResumeResult — the recovery-needed carrier", () => {
  it("parses a Codex resume refusal and preserves recovery-needed exactly", () => {
    const parsed = DriverResumeResultSchema.parse(CODEX_RESUME_REFUSAL);

    expect(parsed).toStrictEqual(CODEX_RESUME_REFUSAL);
    expect(parsed.status).toBe("failed");
    if (parsed.status === "failed") {
      expect(parsed.recoveryCondition).toBe("recovery-needed");
      // A condition with no detail leaves an operator a halt and no reason for it.
      expect(parsed.providerFailureDetail.length).toBeGreaterThan(0);
    }
  });

  it("REJECTS a failed result that carries a replacement binding — encoded in the type", () => {
    // The `failed` arm is `.strict()`, so `bindingId` and `sessionPosition` have nowhere to sit
    // and a contradictory answer does not parse.
    const outcome = DriverResumeResultSchema.safeParse(FAILURE_CARRYING_A_REPLACEMENT_BINDING);

    expect(outcome.success).toBe(false);
  });

  it("REJECTS a failure that names no recovery condition — silence is unrepresentable", () => {
    // A bare failure would let the caller decide what to do; the condition is required.
    const outcome = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoverySpanClassification: "unclassifiable",
      providerFailureDetail: "codex resume refused",
    });

    expect(outcome.success).toBe(false);
  });

  it("REJECTS a failure that omits the span classification — `unclassifiable` is said, not implied", () => {
    const outcome = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      providerFailureDetail: "codex resume refused",
    });

    expect(outcome.success).toBe(false);
  });

  it("REJECTS an invented recovery condition — the vocabulary is closed at two values", () => {
    // A free-string condition would let a driver report `session-replaced`; the closed set lets
    // a consumer check the invariant without knowing the driver.
    const outcome = DriverResumeResultSchema.safeParse({
      ...CODEX_RESUME_REFUSAL,
      recoveryCondition: "session-replaced",
    });

    expect(outcome.success).toBe(false);
  });

  it("REJECTS a resumed arm carrying a recovery condition — there is no `resumed anyway` shape", () => {
    // A driver cannot report success and attach a halt condition, so `status` alone says whether a
    // session is live.
    const outcome = DriverResumeResultSchema.safeParse({
      status: "resumed",
      bindingId: "binding-under-test",
      sessionPosition: 7,
      recoveryCondition: "recovery-needed",
    });

    expect(outcome.success).toBe(false);
  });

  it("cannot re-read a resume failure as a resumed session — the arms share no viable shape", () => {
    // The refusal reaches only the `failed` arm, and without its discriminator it still holds no
    // `bindingId` or `sessionPosition` from which to recover a session.
    const { status: _discardedStatus, ...withoutDiscriminator } = CODEX_RESUME_REFUSAL;

    expect(
      DriverResumeResultSchema.safeParse({ ...withoutDiscriminator, status: "resumed" }).success,
    ).toBe(false);
    expect(withoutDiscriminator).not.toHaveProperty("bindingId");
    expect(withoutDiscriminator).not.toHaveProperty("sessionPosition");
  });
});

// Reachability: no client route can answer a failure with a new session

/**
 * A transport that answers every request with a permissive result and records what was sent, so
 * "no session-creation method is sent" means the client has no route, not that a strict double
 * refused.
 */
function createRecordingTransport(): ClientTransport & { readonly sentMethods: string[] } {
  const sentMethods: string[] = [];
  let deliverInbound: (message: InboundEnvelope) => void = () => undefined;
  let notifyClosed: (reason?: Error) => void = () => undefined;

  return {
    sentMethods,
    send(envelope: OutboundEnvelope): void {
      sentMethods.push(envelope.method);
      if (!("id" in envelope)) {
        return;
      }
      // `subscriptionId` serves the subscribe ack; no assertion reads a result.
      deliverInbound({
        jsonrpc: JSONRPC_VERSION,
        id: envelope.id,
        result: { subscriptionId: "subscription-under-test" },
      });
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

describe("DriverClient — no client-facing route mints a replacement session", () => {
  it("sends only ratified driver.* verbs across its whole surface, and no session-lifecycle verb", async () => {
    const transport = createRecordingTransport();
    const client = createDaemonProviderClient(
      new JsonRpcClient(transport, { protocolVersion: PROTOCOL_VERSION }),
    );

    // Exercise every method. Result-schema rejections do not matter: the envelope is recorded at
    // send time.
    const settled = await Promise.allSettled([
      client.listCapabilities(),
      client.listModels({ sessionId: TEST_SESSION_ID }),
      client.listModes(),
      client.interruptRun({ runId: TEST_RUN_ID }),
      client.applyIntervention({
        type: "interrupt",
        targetRunId: TEST_RUN_ID,
        expectedRunVersion: 1,
        clientIdempotencyKey: "00000000-0000-4000-8000-000000000003",
        payload: {},
      }),
      client.compactContext({ sessionId: TEST_SESSION_ID, runId: TEST_RUN_ID }),
      client.listProviderCommands({ sessionId: TEST_SESSION_ID, agentId: TEST_AGENT_ID }),
    ]);
    client.subscribeEvents({ runId: TEST_RUN_ID });

    // Every method was attempted, so the negative assertion below is not vacuous.
    expect(settled).toHaveLength(7);
    expect(transport.sentMethods).toHaveLength(8);

    // Minting a session is not among the client's options: it sends nothing but the names below.
    for (const lifecycleMethod of [
      "driver.createSession",
      "driver.resumeSession",
      "driver.startRun",
      "driver.closeSession",
    ]) {
      expect(transport.sentMethods).not.toContain(lifecycleMethod);
    }
    expect([...transport.sentMethods].sort()).toStrictEqual([
      "driver.applyIntervention",
      "driver.compactContext",
      "driver.interruptRun",
      "driver.listCapabilities",
      "driver.listModels",
      "driver.listModes",
      "driver.listProviderCommands",
      "driver.subscribeEvents",
    ]);
  });
});
