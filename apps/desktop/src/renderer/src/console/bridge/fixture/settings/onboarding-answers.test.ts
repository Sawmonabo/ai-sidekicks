// The one fixture answer a caller can move, and the one it cannot.
//
// WHAT WOULD BE UNREACHABLE WITHOUT THIS. The walkthrough's three step verbs answer
// `void` and every surface above them reads the STATE afterwards, so a fixture whose
// state read was a pure function of the script would render the primary action of
// every first-run step as a control that does nothing — a rail frozen part-done, a
// completion summary that never arrives, and a skip a person can press forever. Each
// case below is a fact about the port and not about the ledger class alone, so each
// drives the real port through the real bridge.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../call-plane/bridge.js";
import type { GrowthOutcome, GrowthPort } from "../../growth-port/index.js";
import type { ConsoleScenario, ScenarioReply } from "../../scenario/runtime/index.js";
import { ONBOARDING_SCENARIO } from "../../scenario/onboarding.js";

/** The onboarding scenario's own port, which is the port under test. */
function onboardingPort(scenario: ConsoleScenario = ONBOARDING_SCENARIO): GrowthPort {
  return createFixtureBridge({ scenario }).growth;
}

/**
 * The onboarding scenario with one scripted reply replaced or removed.
 *
 * A variant rather than a second scenario file: what each refusal case needs is the
 * shipped scenario with exactly one call answered differently, and a hand-written
 * scenario would be free to differ from it in ways the case never meant to assert.
 */
function scenarioAnswering(call: string, reply: ScenarioReply | undefined): ConsoleScenario {
  const others = ONBOARDING_SCENARIO.replies.filter((each) => each.call !== call);
  return {
    ...ONBOARDING_SCENARIO,
    id: `${ONBOARDING_SCENARIO.id}-variant-${call}`,
    replies: reply === undefined ? others : [...others, reply],
  };
}

/** The completed-step set the state read answers with. Fails loudly on a refusal. */
async function readCompletedSteps(port: GrowthPort): Promise<readonly string[]> {
  return (await servedStateRead(port)).completedStepIds;
}

/** The whole state reading, with the refusal arm turned into a failure rather than a cast. */
async function servedStateRead(
  port: GrowthPort,
): Promise<{ readonly completedStepIds: readonly string[]; readonly isComplete: boolean }> {
  const outcome = await port.onboardingStateRead({});
  if (outcome.status !== "served") {
    // The refusal IS the outcome on that arm, so the code names which seam refused.
    throw new Error(`the onboarding state read refused: ${outcome.code}`);
  }
  return outcome.value;
}

/** A served write, asserted rather than assumed — an unscripted call refuses instead. */
function expectServed(outcome: GrowthOutcome<void>): void {
  expect(outcome.status).toBe("served");
}

describe("the fixture's onboarding state moves when a mutation is accepted", () => {
  it("opens on what the scenario scripts and nothing else", async () => {
    expect(await readCompletedSteps(onboardingPort())).toStrictEqual(["relay"]);
  });

  it("shows a step the caller advanced on the next read", async () => {
    const port = onboardingPort();
    expectServed(await port.onboardingStepAdvance({ stepId: "telemetry" }));
    expect(await readCompletedSteps(port)).toStrictEqual(["relay", "telemetry"]);
  });

  it("shows a skipped step on the next read, in the same set", async () => {
    // The skip lands in `completedStepIds` because that is the only set this reply
    // carries and `step-model.ts` reads it as the RESOLVED set. A skipped step held
    // out of it would leave `firstUnresolvedStep` pointing at a step the person had
    // already answered.
    const port = onboardingPort();
    expectServed(await port.onboardingStepSkip({ stepId: "providers" }));
    expect(await readCompletedSteps(port)).toStrictEqual(["relay", "providers"]);
  });

  it("does not repeat a step the script already recorded", async () => {
    const port = onboardingPort();
    expectServed(await port.onboardingStepAdvance({ stepId: "relay" }));
    expect(await readCompletedSteps(port)).toStrictEqual(["relay"]);
  });

  it("reports the node complete once completion is accepted", async () => {
    const port = onboardingPort();
    expect((await servedStateRead(port)).isComplete).toBe(false);
    expectServed(await port.onboardingComplete({}));
    expect((await servedStateRead(port)).isComplete).toBe(true);
  });

  it("keeps one ledger per port, so one window's progress reaches no other", async () => {
    const first = onboardingPort();
    const second = onboardingPort();
    expectServed(await first.onboardingStepAdvance({ stepId: "telemetry" }));
    expect(await readCompletedSteps(first)).toStrictEqual(["relay", "telemetry"]);
    expect(await readCompletedSteps(second)).toStrictEqual(["relay"]);
  });
});

describe("a refused mutation leaves the state exactly as it was", () => {
  it("records nothing for a write the scenario scripts no reply for", async () => {
    // The `unavailable` refusal, which RESOLVES — the arm a recorder that only asked
    // whether the promise fulfilled would write down.
    const port = onboardingPort(scenarioAnswering("growth:onboardingStepSkip", undefined));
    const refused = await port.onboardingStepSkip({ stepId: "providers" });
    expect(refused.status).toBe("unavailable");
    expect(await readCompletedSteps(port)).toStrictEqual(["relay"]);
  });

  it("records nothing for a write the daemon refuses outright", async () => {
    const port = onboardingPort(
      scenarioAnswering("growth:onboardingStepAdvance", {
        call: "growth:onboardingStepAdvance",
        refusal: { code: "onboarding.step_rejected", message: "The relay choice was not saved." },
      }),
    );
    await expect(port.onboardingStepAdvance({ stepId: "telemetry" })).rejects.toMatchObject({
      code: "onboarding.step_rejected",
    });
    expect(await readCompletedSteps(port)).toStrictEqual(["relay"]);
  });

  it("does not report a node complete when the completion was refused", async () => {
    const port = onboardingPort(scenarioAnswering("growth:onboardingComplete", undefined));
    expect((await port.onboardingComplete({})).status).toBe("unavailable");
    expect((await servedStateRead(port)).isComplete).toBe(false);
  });
});
