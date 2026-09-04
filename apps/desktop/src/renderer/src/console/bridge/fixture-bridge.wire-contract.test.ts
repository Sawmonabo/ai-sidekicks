// A scenario cannot script a reply the wire could not send.
//
// The fixture already refuses to DELIVER a beat it cannot project into the shape a
// narrowed stream registers (`beat-unprojectable`). The call door had no equivalent:
// a scenario could answer `repo.mountRead` with anything at all, and the surface
// reading that answer would render a frame the live daemon cannot produce — green
// fixture, green screenshot, and a shape nobody has ever received.
//
// The check reads the SAME table `callDaemon` parses live replies against, so the
// failure lands in the scenario's own tests rather than in whichever surface renders
// it — the `scenario-wire-truth` posture, moved onto the call door.

import { describe, expect, it } from "vitest";

import { FixtureBridgeError } from "./fixture-bridge.js";
import { callThroughBridge, createFixture } from "./fixture-bridge.test-support.js";
import type { ConsoleScenario } from "./scenario.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";

/** A registered method the registry binds, so a scripted reply is checkable. */
const REGISTERED_CALL = "presence.read";

/** A growth-slate call the registry deliberately does not bind. */
const UNREGISTERED_CALL = "gitflow.branchContextRead";

/** The reply `presence.read` registers: participants, each with the three members. */
const ON_CONTRACT_REPLY = {
  participants: [
    {
      participantId: "019b79ee-0280-7f00-8110-a11ce0000001",
      state: "online",
      lastSeen: "2026-01-01T14:20:00.500Z",
    },
  ],
};

function scenarioAnswering(call: string, result: unknown): ConsoleScenario {
  return {
    ...FLAGSHIP_SCENARIO,
    id: "flagship-wire-contract-probe",
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
    // One member off — the state a participant can be in. This is what a scenario
    // author actually gets wrong, and a check that only caught a wholly different
    // object would let it through.
    const fixture = createFixture(
      scenarioAnswering(REGISTERED_CALL, {
        participants: [{ ...ON_CONTRACT_REPLY.participants[0], state: "loitering" }],
      }),
    );

    await expect(callThroughBridge(fixture, REGISTERED_CALL)).rejects.toMatchObject({
      refusal: { code: "reply-off-contract" },
    });
  });

  it("negative control: an on-contract reply is handed back exactly as scripted", async () => {
    // Two claims at once. Without the first, an implementation that refused every
    // scripted reply would pass both cases above. The second is the assert-do-not-
    // substitute rule: the ORIGINAL value travels, so a scenario cannot lean on a
    // coercion or a default and look correct against a daemon that supplies neither.
    const fixture = createFixture(scenarioAnswering(REGISTERED_CALL, ON_CONTRACT_REPLY));

    await expect(callThroughBridge(fixture, REGISTERED_CALL)).resolves.toBe(ON_CONTRACT_REPLY);
  });

  it("leaves a call the registry does not bind untouched", async () => {
    // The corpus registers no shape for a growth-slate wire, so there is nothing to
    // check against and the honest answer is to pass it through. A check that
    // refused here would break every scenario driving the growth port.
    const offContractForNoContract = { anything: "the slate row owes the shape" };
    const fixture = createFixture(scenarioAnswering(UNREGISTERED_CALL, offContractForNoContract));

    await expect(callThroughBridge(fixture, UNREGISTERED_CALL)).resolves.toBe(
      offContractForNoContract,
    );
  });
});
