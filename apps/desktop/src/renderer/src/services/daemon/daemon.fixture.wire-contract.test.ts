// A scenario cannot script a reply the wire could not send. Without the check, a scenario could
// answer `repo.mountRead` with anything and a view would render a frame the live daemon cannot
// produce. It reads the same table `callDaemon` parses live replies against, so a failure lands in
// the scenario's own tests and not in whichever view renders it.

import { describe, expect, it } from "vitest";

import { FixtureBridgeError } from "./refusal.fixture.js";
import { callThroughBridge, createFixture } from "@test/helpers/fixture-bridge.js";
import type { Scenario } from "@fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "@fixtures/scenarios/concurrent-streaming.js";

/** A registered method the registry binds, so a scripted reply is checkable. */
const REGISTERED_CALL = "presence.read";

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
  it("refuses a reply one member off the contract for that method", async () => {
    // One member off, which is what a scenario author actually gets wrong.
    const fixture = createFixture(
      scenarioAnswering(REGISTERED_CALL, {
        devices: [{ ...ON_CONTRACT_REPLY.devices[0], state: "loitering" }],
      }),
    );

    await expect(callThroughBridge(fixture, REGISTERED_CALL)).rejects.toBeInstanceOf(
      FixtureBridgeError,
    );
    await expect(callThroughBridge(fixture, REGISTERED_CALL)).rejects.toMatchObject({
      refusal: { code: "reply-off-contract", origin: "fixture-bridge" },
    });
  });
});
