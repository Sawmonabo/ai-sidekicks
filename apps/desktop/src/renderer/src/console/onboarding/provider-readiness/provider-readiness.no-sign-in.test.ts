// The provider step performs a probe, and there is no second act for it to perform.
//
// THE DEFECT THIS CLOSES. The sign-in remedy used to dispatch a growth operation that
// asked the daemon to start a provider's login — a sixth `onboarding.*` mutation
// `Spec-026 §Provider Authentication (Group B)` does not have, on a step that spec
// requires to display the invocation and never run it on the operator's behalf, and
// `Spec-029 §Brokered interactive sign-in` keeps the account plane's own login verbs
// out of the first-run flow besides. The act is gone, the remedy is rendered as text
// by `ProviderRow.tsx`, and this file measures the deletion from both sides.
//
// WHAT IS ASSERTED IS THE ABSENCE ON THE WIRE, off the growth port's own record,
// because every state-shaped assertion would pass on a model that dispatched a login
// and discarded the reply. A missing method name proves nothing either: it is what a
// renamed operation looks like.
//
// AND THE REFUSAL ARM IS HERE WITH IT. Deleting the act left `refused` reachable only
// through the probe, so the arm that used to report a failed hand-off now reports a
// failed re-check — and what it may NOT do is replace the projection every other row
// is rendered from.
//
// SPLIT FROM `provider-readiness.test.ts` next door, on the shell-block suite's
// precedent: that file asserts what the projection and the trigger contract answer,
// and together they were one file past the package's ceiling.

import { describe, expect, it } from "vitest";

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { withRecordedGrowth } from "../../bridge/fixture/call-plane/bridge.growth.test-support.js";
import { ONBOARDING_SCENARIO } from "../../bridge/scenarios/onboarding.js";
import {
  PROBE_CALL,
  arrive,
  fixture,
  modelOver,
  readCount,
  recordingModel,
} from "./provider-readiness.test-support.js";
import type { ProviderReadinessModel } from "./provider-readiness.js";

/**
 * The same scenario with the account PROBE scripted to refuse.
 *
 * A scenario reply and never a hand-built bridge whose `daemon` namespace has been
 * spread over: the account plane refuses in the wire's own `{code, message}` shape,
 * and a stub rejecting with an `Error` would train this model against a value the live
 * transport never sends. The shipped probe reply is filtered out first because a
 * scenario carrying both would be scripting two answers to one call.
 */
function refusingProbeFixture(): ConsoleBridge {
  return createFixtureBridge({
    scenario: {
      ...ONBOARDING_SCENARIO,
      replies: [
        ...ONBOARDING_SCENARIO.replies.filter((reply) => reply.call !== PROBE_CALL),
        {
          call: PROBE_CALL,
          refusal: {
            code: "provideraccount.unknown",
            message: "This node holds no such provider account.",
          },
        },
      ],
    },
  });
}

/**
 * The account the scenario resolves for its signed-out provider, off the projection.
 *
 * Read back rather than written as a literal, on the test-support module's rule: a
 * console module never parses a wire value, so the id a case acts on is the one the
 * daemon door already parsed.
 */
function resolvedCodexAccount(model: ProviderReadinessModel): ProviderAccountId {
  const reading = model.reading;
  if (reading.kind !== "read") {
    throw new Error("the fixture did not serve a readiness projection");
  }
  const accountId = reading.entries[1]?.resolvedAccountId;
  if (accountId === undefined) {
    throw new Error("the fixture did not resolve an account for the signed-out provider");
  }
  return accountId;
}

describe("what the step never dispatches", () => {
  it("asks no growth operation of the bridge, on the arrival or on the act", async () => {
    const recorded = withRecordedGrowth(fixture());
    const model = modelOver(recorded.bridge);
    await arrive(model);

    await model.recheck("codex", resolvedCodexAccount(model));

    // This model reaches the daemon's own account plane and nothing else. The record
    // is every operation the port was asked for, so a login dispatched under any name
    // lands here.
    expect(recorded.operationIds).toStrictEqual([]);
  });
});

describe("what the one remaining act does when it is refused", () => {
  it("renders a refused probe on the row that asked, and keeps the projection", async () => {
    const { model, calls } = recordingModel(refusingProbeFixture());
    await arrive(model);
    const readBeforeProbe = model.reading;

    await model.recheck("codex", resolvedCodexAccount(model));

    const action = model.actionFor("codex");
    expect(action.kind).toBe("refused");
    if (action.kind !== "refused") {
      return;
    }
    expect(action.refusal.code).toBe("provideraccount.unknown");
    // The refusal is the ROW's and the projection is the STEP's: a probe that failed
    // says nothing about what the registry last observed, so the entries every other
    // row renders are the ones that were already there and no re-read was put.
    expect(model.reading).toBe(readBeforeProbe);
    expect(readCount(calls)).toBe(1);
  });
});
