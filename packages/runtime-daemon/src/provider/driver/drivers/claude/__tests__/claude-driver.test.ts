// Covers `index.ts`, the composition root: a session driven end to end through one driver object,
// and an intervention reaching the channel the lifecycle bound the run to.

import { describe, expect, it } from "vitest";

import { ClaudeDriver } from "../index.js";
import {
  buildCreateSessionParams,
  buildInterruptParams,
  buildStartRunParams,
  FakeClaudeRunDispatchResolver,
  FakeClaudeSessionTransport,
  TEST_BINDING_ID,
  TEST_PINNED_PROVIDER_SESSION_ID,
  TEST_RUN_ID,
  TEST_SESSION_ID,
} from "./test-doubles.js";
import { makeSilentDriverDiagnostics } from "../../../../__fixtures__/silent-driver-diagnostics.js";

interface DriverHarness {
  readonly driver: ClaudeDriver;
  readonly transport: FakeClaudeSessionTransport;
}

function buildHarness(): DriverHarness {
  const transport = new FakeClaudeSessionTransport();
  const runDispatchResolver = new FakeClaudeRunDispatchResolver();
  runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
    sessionId: TEST_SESSION_ID,
    openingText: "review the diff",
  });
  const driver = new ClaudeDriver({
    transport,
    modelCatalogExchange: () => Promise.resolve({ models: [] }),
    runDispatchResolver,
    diagnostics: makeSilentDriverDiagnostics(),
    mintProviderSessionId: () => TEST_PINNED_PROVIDER_SESSION_ID,
    mintBindingId: () => TEST_BINDING_ID,
    onTextNeutralizationFailure: () => undefined,
  });
  return { driver, transport };
}

describe("ClaudeDriver", () => {
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

  it("sends a native interrupt to the channel the lifecycle band bound the run to", async () => {
    const harness = buildHarness();
    await harness.driver.createSession(buildCreateSessionParams());
    await harness.driver.startRun(buildStartRunParams());

    const result = await harness.driver.applyIntervention(buildInterruptParams());

    expect(result).toStrictEqual({ status: "applied" });
    expect(harness.transport.spawnedChannels[0]?.controlRequests).toStrictEqual([
      { subtype: "interrupt", cancelQueued: false },
    ]);
  });
});
