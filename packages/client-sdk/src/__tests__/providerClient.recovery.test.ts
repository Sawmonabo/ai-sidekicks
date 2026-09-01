// T4.7 — the recovery-needed RETURN-VALUE contract (Plan-005 Phase 4).
//
// Verifies I-005-5 — a driver MUST NOT silently create a replacement provider
// session when a resume fails; the failure surfaces as an explicit
// `recovery-needed` condition — mapping to `Spec-005 §Acceptance Criteria` AC3
// and `Spec-005 §Fallback Behavior`.
//
// WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. Plan-005's own T4.8
// note settles the division: T4.7 is "the return-value CONTRACT-test leg that
// asserts the `DriverResumeResult.failed` carrier shape — not a recovery
// dispatcher". Three layers exist and each is tested where it lives:
//
//   * BEHAVIOR — that a real driver, handed a refused resume, returns the typed
//     failure and issues no `createSession()` call. Already asserted against the
//     real drivers with real spies, three ways on the Codex leg
//     (`runtime-daemon/src/provider/drivers/codex/__tests__/lifecycle.test.ts`,
//     the `CodexDriver resumeSession (I-005-5, Spec-005 §Fallback Behavior)`
//     block) and across the refusal band on the Claude leg
//     (`.../claude/__tests__/lifecycle.test.ts`, its `I-005-5:`-prefixed cases,
//     including the table-driven `issues no createSession call on a failed
//     resume` sweep over every way that band can refuse). That is where a
//     `createSession` spy is meaningful, because there is a real driver on the
//     other side of it. Restating it here would mean building a double and then
//     asserting the double behaved — a test that proves only that the fixture
//     was written correctly.
//
//   * CONTRACT — that the shape those drivers return can express a failure and
//     CANNOT express a silent replacement. That is this file's first half, and
//     it is the half nothing else covers: the driver tests assert what their
//     driver did, not what the type would have permitted a different driver to
//     do. Encoding I-005-5 in the type is strictly stronger than asserting it
//     per driver, because it also binds every driver not yet written.
//
//   * REACHABILITY — that no client-facing route exists through which a caller
//     could observe a failed resume and answer it by minting a session. That is
//     this file's second half, asserted end-to-end through the shipped SDK
//     factory rather than by reading the interface.
//
// Event emission (`run.failed` carrying `recoveryCondition`) is Plan-015's per
// CP-005-5 and is asserted by that plan's tests; nothing here touches it.

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

import { createDaemonProviderClient } from "../providerClient.js";
import { JsonRpcClient } from "../transport/jsonRpcClient.js";
import type { ClientTransport } from "../transport/types.js";

type OutboundEnvelope = JsonRpcRequest | JsonRpcNotification;
type InboundEnvelope = JsonRpcResponseEnvelope | JsonRpcNotification;

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const PROTOCOL_VERSION = "2026-05-01";

/** A low-entropy sentinel run id — no real identifier is involved. */
const TEST_RUN_ID = "00000000-0000-4000-8000-000000000001" as RunId;
const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000004" as SessionId;
const TEST_AGENT_ID = "00000000-0000-4000-8000-000000000005";

/**
 * The result a Codex resume refusal produces: the provider declines to restore
 * the recorded thread, so the driver reports a typed failure instead of starting
 * a fresh one. `unclassifiable` is the honest span reading for a resume that
 * never reached the provider's work — `Spec-005 §Fallback Behavior` requires a
 * driver that cannot classify to say so rather than to omit the field, and a
 * consumer must treat it exactly as `irreversible`.
 */
const CODEX_RESUME_REFUSAL: DriverResumeResult = {
  status: "failed",
  recoveryCondition: "recovery-needed",
  recoverySpanClassification: "unclassifiable",
  providerFailureDetail: "codex resume refused: no thread matches the recorded resume handle",
};

/**
 * The shape a driver would have to produce to smuggle a replacement session out
 * of a failed resume: the failure condition AND a fresh binding, so a caller
 * reading `recoveryCondition` sees a halt while a caller reading `bindingId`
 * sees a live session. Typed `unknown` because the point of the assertions below
 * is that it is NOT a `DriverResumeResult`.
 */
const FAILURE_CARRYING_A_REPLACEMENT_BINDING: unknown = {
  status: "failed",
  recoveryCondition: "recovery-needed",
  recoverySpanClassification: "unclassifiable",
  providerFailureDetail: "codex resume refused; started a fresh thread instead",
  bindingId: "replacement-binding-minted-behind-the-callers-back",
  sessionPosition: 0,
};

// ----------------------------------------------------------------------------
// The carrier shape — a failure is expressible, a silent replacement is not
// ----------------------------------------------------------------------------

describe("DriverResumeResult — the recovery-needed carrier (I-005-5, AC3)", () => {
  it("parses a Codex resume refusal and preserves recovery-needed exactly", () => {
    const parsed = DriverResumeResultSchema.parse(CODEX_RESUME_REFUSAL);

    expect(parsed).toStrictEqual(CODEX_RESUME_REFUSAL);
    expect(parsed.status).toBe("failed");
    if (parsed.status === "failed") {
      expect(parsed.recoveryCondition).toBe("recovery-needed");
      // The detail surface is mandated by `Spec-005 §Fallback Behavior`: a
      // condition with no detail leaves an operator a halt and no reason for it.
      expect(parsed.providerFailureDetail.length).toBeGreaterThan(0);
    }
  });

  it("REJECTS a failed result that carries a replacement binding — I-005-5 encoded in the type", () => {
    // The sharpest form of the invariant. A driver that resumed nothing and
    // started something new cannot report both facts in one result: the `failed`
    // arm is `.strict()`, so `bindingId` and `sessionPosition` have nowhere to
    // sit. A caller therefore never has to decide which half of a contradictory
    // answer to believe — the contradictory answer does not parse.
    const outcome = DriverResumeResultSchema.safeParse(FAILURE_CARRYING_A_REPLACEMENT_BINDING);

    expect(outcome.success).toBe(false);
  });

  it("REJECTS a failure that names no recovery condition — silence is unrepresentable", () => {
    // Without this, the cheapest way to hide a silent replacement would be to
    // report a bare failure and let the caller decide what to do. `recoveryCondition`
    // is required on the live driver return (unlike the replay-visible carriers,
    // whose optionality exists only to admit pre-amendment history), so an
    // unexplained failure is a schema violation rather than a default.
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
    // A free-string condition would let a driver report `session-replaced` and
    // technically satisfy "surfaces a condition" while doing exactly what I-005-5
    // forbids. The enum is what makes the invariant checkable by a consumer that
    // has never heard of the driver.
    const outcome = DriverResumeResultSchema.safeParse({
      ...CODEX_RESUME_REFUSAL,
      recoveryCondition: "session-replaced",
    });

    expect(outcome.success).toBe(false);
  });

  it("REJECTS a resumed arm carrying a recovery condition — there is no `resumed anyway` shape", () => {
    // The other direction of the same guarantee: a driver cannot report success
    // and attach a halt condition to it, so a consumer that branches on `status`
    // is never wrong about whether a session is live.
    const outcome = DriverResumeResultSchema.safeParse({
      status: "resumed",
      bindingId: "binding-under-test",
      sessionPosition: 7,
      recoveryCondition: "recovery-needed",
    });

    expect(outcome.success).toBe(false);
  });

  it("cannot re-read a resume failure as a resumed session — the arms share no viable shape", () => {
    // Discriminated on `status`, so the refusal reaches the `failed` arm and
    // nothing else; and stripped of its discriminator it still carries neither
    // `bindingId` nor `sessionPosition`, so no coercion recovers a session from
    // it. Both halves matter: the first is the union's dispatch, the second is
    // that the payload itself holds no session to find.
    const { status: _discardedStatus, ...withoutDiscriminator } = CODEX_RESUME_REFUSAL;

    expect(
      DriverResumeResultSchema.safeParse({ ...withoutDiscriminator, status: "resumed" }).success,
    ).toBe(false);
    expect(withoutDiscriminator).not.toHaveProperty("bindingId");
    expect(withoutDiscriminator).not.toHaveProperty("sessionPosition");
  });
});

// ----------------------------------------------------------------------------
// Reachability — no client-facing route can answer a failure with a new session
// ----------------------------------------------------------------------------

/**
 * A transport that answers EVERY request with a permissive empty result and
 * records what was sent. Permissive on purpose: the assertion below is about
 * which method names leave the client, so a daemon that would happily answer a
 * session-creation request makes the negative result meaningful — nothing is
 * sent because the client has no route, not because a strict double refused.
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
      // `{}` satisfies the three read results' and both ack results' schemas;
      // `subscriptionId` rides along for the subscribe ack. An over-broad reply
      // is harmless here because no assertion reads a result.
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

describe("DriverClient — no client-facing route mints a replacement session (I-005-5, AC3)", () => {
  it("sends only ratified driver.* verbs across its whole surface, and no session-lifecycle verb", async () => {
    const transport = createRecordingTransport();
    const client = createDaemonProviderClient(
      new JsonRpcClient(transport, { protocolVersion: PROTOCOL_VERSION }),
    );

    // Exercise every method the surface has. Result-schema rejections are
    // irrelevant to this assertion — the envelope is recorded at send time, so
    // catching them keeps the test about routing rather than about payloads.
    const settled = await Promise.allSettled([
      client.listCapabilities(),
      client.listModels(),
      client.listModes(),
      client.interruptRun({ runId: TEST_RUN_ID }),
      client.respondToRequest({
        runId: TEST_RUN_ID,
        requestId: "00000000-0000-4000-8000-000000000002",
        response: { approved: true },
      }),
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

    // Every method was actually attempted — an empty or short list would make
    // the negative assertion below vacuously true.
    expect(settled).toHaveLength(8);
    expect(transport.sentMethods).toHaveLength(9);

    // A resume failure reaches a client as data on some other surface; whatever
    // it does with that data, minting a session is not among its options,
    // because none of these names exists on this object and the client sends
    // nothing else.
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
      "driver.respondToRequest",
      "driver.subscribeEvents",
    ]);
  });
});
