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
  fixtureBridgeWithGrowth,
  growthAnswering,
  growthRefusing,
  growthServing,
  withDaemonCall,
  type BridgeUnderTest,
} from "./fixture-bridge.test-support.js";
import { GROWTH_PORT_REFUSAL_ORIGIN } from "../growth-port/growth-outcome.js";
import type {
  GrowthBranchContext,
  GrowthBranchContextReadRequest,
} from "../growth-values/gitflow.js";
import type { ConsoleScenario } from "../scenario-runtime/scenario.js";
import { FLAGSHIP_SCENARIO } from "../scenarios/flagship.js";

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

// The operation the growth cases script, and one the same port answers unscripted.
// Two arms of one namespace, so the unscripted case is about the arm rather than
// about a namespace the fixture happens not to carry.
const SCRIPTED_OPERATION = "gitflowBranchContextRead";
const UNSCRIPTED_OPERATION = "gitflowPrPrepare";

/**
 * One branch context in the wire's own shape.
 *
 * Written out in full rather than as a partial, and that is the point of the typed
 * overrides: a value missing a member the registered shape requires is a compile
 * error here, where the twenty hand-built ports this helper replaces would have
 * accepted it and passed.
 */
const BRANCH_CONTEXT_READ_REQUEST: GrowthBranchContextReadRequest = {
  workspaceId: "019b7b30-0280-7c11-8420-b1a5c0de2302",
  worktreeId: "019b7b30-0280-7c11-8420-b1a5c0de2303",
};

const SERVED_BRANCH_CONTEXT: GrowthBranchContext = {
  branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2301",
  workspaceId: "019b7b30-0280-7c11-8420-b1a5c0de2302",
  baseBranch: "develop",
  headBranch: "feat/probe",
};

describe("fixtureBridgeWithGrowth — a scripted port over a real bridge", () => {
  it("answers a scripted operation with what the suite scripted", async () => {
    const bridge = fixtureBridgeWithGrowth(FLAGSHIP_SCENARIO, {
      [SCRIPTED_OPERATION]: growthServing(SERVED_BRANCH_CONTEXT),
    });

    expect(await bridge.growth[SCRIPTED_OPERATION](BRANCH_CONTEXT_READ_REQUEST)).toStrictEqual({
      status: "served",
      value: SERVED_BRANCH_CONTEXT,
    });
  });

  it("hands the answering arm the request the caller sent", async () => {
    const seenRequests: unknown[] = [];
    const bridge = fixtureBridgeWithGrowth(FLAGSHIP_SCENARIO, {
      [SCRIPTED_OPERATION]: growthAnswering((request) => {
        seenRequests.push(request);
        return { status: "served", value: SERVED_BRANCH_CONTEXT };
      }),
    });

    await bridge.growth[SCRIPTED_OPERATION](BRANCH_CONTEXT_READ_REQUEST);

    expect(seenRequests).toStrictEqual([BRANCH_CONTEXT_READ_REQUEST]);
  });

  it("composes the port's own refusal rather than a hand-written twin", async () => {
    const bridge = fixtureBridgeWithGrowth(FLAGSHIP_SCENARIO, {
      [SCRIPTED_OPERATION]: growthRefusing(SCRIPTED_OPERATION),
    });

    const outcome = await bridge.growth[SCRIPTED_OPERATION](BRANCH_CONTEXT_READ_REQUEST);

    expect(outcome.status).toBe("unavailable");
    expect(outcome).toMatchObject({
      code: "wire-unregistered",
      operationId: SCRIPTED_OPERATION,
      origin: GROWTH_PORT_REFUSAL_ORIGIN,
    });
  });

  it("negative control: an operation the suite never scripted refuses, never `undefined`", async () => {
    // The defect this helper replaces. A hand-built `{ growth: { …one arm… } }`
    // answers `undefined` for every other operation, and a caller narrowing on
    // `status` reads that as neither served nor refused — so a surface reaching a
    // fifth method passed its case while rendering nothing at all. Over a real
    // bridge the unscripted arm is still the fixture's own typed outcome.
    const bridge = fixtureBridgeWithGrowth(FLAGSHIP_SCENARIO, {
      [SCRIPTED_OPERATION]: growthServing(SERVED_BRANCH_CONTEXT),
    });

    const outcome = await bridge.growth[UNSCRIPTED_OPERATION]({
      branchContextId: SERVED_BRANCH_CONTEXT.branchContextId,
      targetBranch: "develop",
    });

    expect(outcome).toBeDefined();
    expect(["served", "unavailable"]).toContain(outcome.status);
  });

  it("negative control: every other namespace is the real bridge's, not `undefined`", async () => {
    // The second half of what the cast erased. A hand-built object carries only
    // `growth`, so a surface that started reaching the daemon door threw inside the
    // case instead of failing an assertion.
    const bridge = fixtureBridgeWithGrowth(FLAGSHIP_SCENARIO, {
      [SCRIPTED_OPERATION]: growthServing(SERVED_BRANCH_CONTEXT),
    });

    expect(bridge.sidekicks).toBeDefined();
    expect(typeof bridge.sidekicks.daemon.call).toBe("function");
  });
});
