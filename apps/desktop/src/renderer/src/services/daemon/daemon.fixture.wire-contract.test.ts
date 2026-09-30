// A scenario cannot script a reply the wire could not send. Without the check, a scenario could
// answer `repo.mountRead` with anything and a view would render a frame the live daemon cannot
// produce. It reads the same table `callDaemon` parses live replies against, so a failure lands in
// the scenario's own tests and not in whichever view renders it.

import { describe, expect, it } from "vitest";

import { FixtureBridgeError } from "./refusal.fixture.js";
import { callThroughBridge, createFixture } from "@test/helpers/fixture-bridge.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";

/** A registered method the registry binds, so a scripted reply is checkable. */
const REGISTERED_CALL = "presence.read";

/** A call the registry deliberately does not bind. */
const UNREGISTERED_CALL = "gitflow.branchContextRead";

/** The reply `presence.read` registers: devices, each with the four members. */
const ON_CONTRACT_REPLY = {
  devices: [
    {
      deviceId: "019b79ee-0280-7f00-8110-a11ce0000001",
      deviceType: "desktop",
      appVisible: true,
      state: "online",
    },
  ],
};

function scenarioAnswering(call: string, result: unknown): Scenario {
  return {
    ...CONCURRENT_STREAMING_SCENARIO,
    id: "concurrent-streaming-wire-contract-probe",
    replies: [{ call, result }],
  };
}

describe("fixture bridge — a scripted reply is held to the registered shape", () => {
  it("refuses a reply the corpus does not admit for that method", async () => {
    const fixture = createFixture(scenarioAnswering(REGISTERED_CALL, { rows: [] }));

    await expect(callThroughBridge(fixture, REGISTERED_CALL)).rejects.toBeInstanceOf(
      FixtureBridgeError,
    );
    await expect(callThroughBridge(fixture, REGISTERED_CALL)).rejects.toMatchObject({
      refusal: { code: "reply-off-contract", origin: "fixture-bridge" },
    });
  });

  it("catches the near miss, not only the obviously wrong shape", async () => {
    // One member off, which is what a scenario author actually gets wrong.
    const fixture = createFixture(
      scenarioAnswering(REGISTERED_CALL, {
        devices: [{ ...ON_CONTRACT_REPLY.devices[0], state: "loitering" }],
      }),
    );

    await expect(callThroughBridge(fixture, REGISTERED_CALL)).rejects.toMatchObject({
      refusal: { code: "reply-off-contract" },
    });
  });

  it("negative control: an on-contract reply is handed back exactly as scripted", async () => {
    // Without a successful path, a fixture that refused every reply passes both cases above.
    // The original value travels, so a scenario cannot lean on a coercion or default the
    // daemon does not supply.
    const fixture = createFixture(scenarioAnswering(REGISTERED_CALL, ON_CONTRACT_REPLY));

    await expect(callThroughBridge(fixture, REGISTERED_CALL)).resolves.toBe(ON_CONTRACT_REPLY);
  });

  it("leaves a call the registry does not bind untouched", async () => {
    // No shape is registered for this method, so there is nothing to check against.
    const offContractForNoContract = { anything: "the slate row owes the shape" };
    const fixture = createFixture(scenarioAnswering(UNREGISTERED_CALL, offContractForNoContract));

    await expect(callThroughBridge(fixture, UNREGISTERED_CALL)).resolves.toBe(
      offContractForNoContract,
    );
  });
});
