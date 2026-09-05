// The wrapped call arm: what a suite decides, and what it leaves to the scenario.
//
// `withDaemonCall` spreads an answer of the suite's own over a REAL bridge, which is
// the console's established shape for driving one namespace member. The gap it left
// was that the arm answered EVERY method: a suite that cared about one call had to
// invent replies for the rest, and the only shape available for that is the
// hand-written stub this helper exists to keep out of a suite meant to reach a real
// bridge. So the answer is handed the wrapped bridge's own call, and this file is
// where that delegation is held to what it claims.
//
// The bridge under test is the real fixture over a re-scripted flagship, so the
// passed-through reply is one the scenario actually serves rather than a second stub
// standing in for one.

import { describe, expect, it } from "vitest";

import {
  DELAYED_CALL,
  DELAYED_RESULT,
  callBridge,
  createFixture,
  withDaemonCall,
  type BridgeUnderTest,
} from "./fixture-bridge.test-support.js";
import type { ConsoleScenario } from "./scenario.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";

/** The flagship script with its one read answered immediately, so no clock is spent. */
function scenarioAnsweringImmediately(): ConsoleScenario {
  return {
    ...FLAGSHIP_SCENARIO,
    id: "flagship-pass-through-probe",
    replies: [{ call: DELAYED_CALL, result: DELAYED_RESULT }],
  };
}

/** A method this suite decides for, and the answer it decides. */
const DECIDED_CALL = "presence.read";
const DECIDED_RESULT: { readonly rows: readonly unknown[] } = { rows: [] };

/** A bridge that decides one call and leaves every other to the scenario. */
function bridgeDecidingOneCall(): BridgeUnderTest {
  return withDaemonCall(
    createFixture(scenarioAnsweringImmediately()).bridge,
    async (call, passThrough) => (call.method === DECIDED_CALL ? DECIDED_RESULT : passThrough()),
  );
}

describe("withDaemonCall — one decided method, the rest left to the scenario", () => {
  it("answers the decided call with what the suite decided", async () => {
    const { bridge } = bridgeDecidingOneCall();

    expect(await callBridge(bridge, DECIDED_CALL, { sessionId: FLAGSHIP_SCENARIO.sessionId })).toBe(
      DECIDED_RESULT,
    );
  });

  it("hands a passed-through call the wrapped bridge's own scripted reply", async () => {
    // The claim: the delegation reaches the bridge this helper WRAPPED. An arm that
    // reached the arm it is building would never settle at all.
    const { bridge } = bridgeDecidingOneCall();

    expect(await callBridge(bridge, DELAYED_CALL)).toStrictEqual(DELAYED_RESULT);
  });

  it("carries the caller's own params into the pass-through", async () => {
    const seenParams: unknown[] = [];
    const { bridge } = withDaemonCall(
      createFixture(scenarioAnsweringImmediately()).bridge,
      async (call, passThrough) => {
        seenParams.push(call.params);
        return passThrough();
      },
    );

    await callBridge(bridge, DELAYED_CALL, { limit: 3 });

    expect(seenParams).toStrictEqual([{ limit: 3 }]);
  });

  it("records the decided call and the passed-through one alike", async () => {
    const { bridge, calls } = bridgeDecidingOneCall();

    await callBridge(bridge, DECIDED_CALL, undefined);
    await callBridge(bridge, DELAYED_CALL, undefined);

    expect(calls.map((call) => call.method)).toStrictEqual([DECIDED_CALL, DELAYED_CALL]);
  });

  it("negative control: an arm that ignores the pass-through answers its own value", async () => {
    // Without this the case above would also pass against a scenario that happens to
    // serve what the suite decided. Same call, same bridge, one difference — the arm
    // does not delegate — and the scripted reply is nowhere in the answer.
    const { bridge } = withDaemonCall(
      createFixture(scenarioAnsweringImmediately()).bridge,
      async () => DECIDED_RESULT,
    );

    const answer = await callBridge(bridge, DELAYED_CALL);

    expect(answer).toBe(DECIDED_RESULT);
    expect(answer).not.toStrictEqual(DELAYED_RESULT);
  });
});
