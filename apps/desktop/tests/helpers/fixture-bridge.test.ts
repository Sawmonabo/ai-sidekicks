// `withDaemonCall`: a suite decides one method's answer and leaves the rest to the scenario.
//
// The bridge under test is the real fixture over a re-scripted concurrent-streaming scenario, so
// a passed-through reply is one the scenario actually serves.

import { describe, expect, it } from "vitest";

import {
  DELAYED_CALL,
  DELAYED_RESULT,
  callBridge,
  createFixture,
  withDaemonCall,
  type BridgeUnderTest,
} from "./fixture-bridge.js";
import type { Scenario } from "../../fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../fixtures/scenarios/concurrent-streaming.js";

/** The concurrent-streaming script with its one read answered at once, so no clock is spent. */
function scenarioAnsweringImmediately(): Scenario {
  return {
    ...CONCURRENT_STREAMING_SCENARIO,
    id: "concurrent-streaming-pass-through-probe",
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

    expect(await callBridge(bridge, DECIDED_CALL, {})).toBe(DECIDED_RESULT);
  });

  it("hands a passed-through call the wrapped bridge's own scripted reply", async () => {
    // The delegation must reach the bridge this helper wrapped; an arm reaching itself never
    // settles.
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
    // Guards the case above, which would also pass if the scenario served what the suite decided:
    // same call and bridge, but the arm does not delegate, so the scripted reply is absent.
    const { bridge } = withDaemonCall(
      createFixture(scenarioAnsweringImmediately()).bridge,
      async () => DECIDED_RESULT,
    );

    const answer = await callBridge(bridge, DELAYED_CALL);

    expect(answer).toBe(DECIDED_RESULT);
    expect(answer).not.toStrictEqual(DELAYED_RESULT);
  });
});
