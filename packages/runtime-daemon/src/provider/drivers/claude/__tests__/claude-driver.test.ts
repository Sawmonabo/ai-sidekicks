// Coverage map for `index.ts` (Plan-005 Phase 3, T3.6 composition root):
//   * `Spec-005 §Required Behavior` — the six normalized operations this PR owns are reachable
//     through one driver object, with the signatures the `ProviderDriver`
//     contract declares (bound by the `ClaudeDriverOperations` `Pick`).
//   * I-005-4 / I-005-5 end-to-end through the composed entry: a steer degrades
//     and a native interrupt reaches the very channel the lifecycle band bound
//     the run to, which is the one coupling between the two bands.

import { describe, expect, it } from "vitest";

import {
  ClaudeDriver,
  ClaudeSessionUnavailableError,
  CLAUDE_STEER_FALLBACK_ACTION,
  type ClaudeDriverOperations,
} from "../index.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import {
  buildCreateSessionParams,
  buildInterruptParams,
  buildSteerParams,
  buildStartRunParams,
  FakeClaudeRunDispatchResolver,
  FakeClaudeSessionTransport,
  makeSilentDriverDiagnostics,
  TEST_BINDING_ID,
  TEST_PINNED_PROVIDER_SESSION_ID,
  TEST_RUN_ID,
  TEST_SESSION_ID,
} from "./claude-test-doubles.js";

interface DriverHarness {
  readonly driver: ClaudeDriver;
  readonly transport: FakeClaudeSessionTransport;
  readonly runDispatchResolver: FakeClaudeRunDispatchResolver;
  readonly textNeutralizationFailureDetails: string[];
}

function buildHarness(): DriverHarness {
  const transport = new FakeClaudeSessionTransport();
  const runDispatchResolver = new FakeClaudeRunDispatchResolver();
  const textNeutralizationFailureDetails: string[] = [];
  runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
    sessionId: TEST_SESSION_ID,
    openingText: "review the diff",
  });
  const driver = new ClaudeDriver({
    transport,
    runDispatchResolver,
    diagnostics: makeSilentDriverDiagnostics(),
    mintProviderSessionId: () => TEST_PINNED_PROVIDER_SESSION_ID,
    mintBindingId: () => TEST_BINDING_ID,
    // Required rather than optional: the tripwire's run terminal is the only
    // user-visible surface a swallowed turn has, so a construction site cannot
    // leave it unbound. Recorded rather than ignored here so a trip inside a
    // composition test would surface instead of vanishing.
    onTextNeutralizationFailure: (_sessionId, _runId, failure) => {
      textNeutralizationFailureDetails.push(failure.providerFailureDetail);
    },
  });
  return { driver, transport, runDispatchResolver, textNeutralizationFailureDetails };
}

describe("ClaudeDriver", () => {
  it("satisfies the slice of the ProviderDriver contract this task owns", () => {
    const harness = buildHarness();
    // A compile-time assertion first: the `Pick` is what keeps every signature
    // bound to the contract with zero drift.
    const operations: ClaudeDriverOperations = harness.driver;

    expect(typeof operations.createSession).toBe("function");
    expect(typeof operations.resumeSession).toBe("function");
    expect(typeof operations.startRun).toBe("function");
    expect(typeof operations.interruptRun).toBe("function");
    expect(typeof operations.applyIntervention).toBe("function");
    expect(typeof operations.closeSession).toBe("function");
    // One identity for the driver, not two: the refusals this band raises stamp
    // the same constant the capability registry keys its rows on, so a rename
    // cannot leave an error envelope pointing at a driver name that no longer
    // exists.
    const refusal = new ClaudeSessionUnavailableError("no_live_run", { runId: TEST_RUN_ID });
    expect(refusal.fields.driverId).toBe(CLAUDE_DRIVER_NAME);
  });

  it("drives a session from create through run start to close", async () => {
    const harness = buildHarness();

    const handle = await harness.driver.createSession(buildCreateSessionParams());
    await harness.driver.startRun(buildStartRunParams());
    await harness.driver.interruptRun({ runId: TEST_RUN_ID });
    await harness.driver.closeSession({ sessionId: TEST_SESSION_ID });

    expect(handle.resumeHandle).toBe(TEST_PINNED_PROVIDER_SESSION_ID);
    const channel = harness.transport.spawnedChannels[0];
    expect(channel?.sentWireTexts).toStrictEqual(["review the diff"]);
    expect(channel?.controlRequests).toStrictEqual([{ subtype: "interrupt", cancelQueued: false }]);
    expect(channel?.disposals).toStrictEqual(["session_closed"]);
  });

  it("dispatches a native interrupt to the channel the lifecycle band bound the run to", async () => {
    const harness = buildHarness();
    await harness.driver.createSession(buildCreateSessionParams());
    await harness.driver.startRun(buildStartRunParams());

    const result = await harness.driver.applyIntervention(buildInterruptParams());

    expect(result).toStrictEqual({ status: "applied" });
    expect(harness.transport.spawnedChannels[0]?.controlRequests).toStrictEqual([
      { subtype: "interrupt", cancelQueued: false },
    ]);
  });

  it("degrades a steer through the composed entry without sending anything", async () => {
    const harness = buildHarness();
    await harness.driver.createSession(buildCreateSessionParams());
    await harness.driver.startRun(buildStartRunParams());

    const result = await harness.driver.applyIntervention(buildSteerParams("try the other fix"));

    expect(result).toStrictEqual({
      status: "degraded",
      fallbackAction: CLAUDE_STEER_FALLBACK_ACTION,
    });
    // The opening frame is the only text ever written; the steer added none.
    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toHaveLength(1);
  });

  it("stops routing interventions once the session is closed", async () => {
    const harness = buildHarness();
    await harness.driver.createSession(buildCreateSessionParams());
    await harness.driver.startRun(buildStartRunParams());
    await harness.driver.closeSession({ sessionId: TEST_SESSION_ID });

    await expect(harness.driver.applyIntervention(buildInterruptParams())).rejects.toBeInstanceOf(
      ClaudeSessionUnavailableError,
    );
  });

  it("surfaces a resume failure through the driver entry as the typed failed arm", async () => {
    const harness = buildHarness();
    harness.transport.resumeFailure = new Error("claude exited before init");

    const result = await harness.driver.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });

    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("bindingId");
  });
});
