// The walkthrough's conversation with the daemon, over the fixture that scripts it.
//
// FOUR CLAIMS, AND EACH ONE IS A SHAPE THE FLOW MUST NOT TAKE. A read that REJECTED
// must not leave the walkthrough loading forever. A relay identifier this build does
// not recognise must not be recorded as the nearest of the three. A settlement that
// arrives after the flow was retired must publish nowhere. And a build whose
// onboarding wire is unregistered must render the refusal rather than an empty
// progress list — "nobody has onboarded this node" and "this build cannot ask" are
// different facts.
//
// AND A FIFTH, WHICH IS ABOUT THE VALUE RATHER THAN THE CALL. The completed set every
// surface stands on is minted where the reading is published, and the last suite is
// what keeps it from becoming a shared one again: `ReadonlySet` is a compile-time view
// of a runtime-mutable collection, so a single held object is one stray `add` away
// from contaminating the baseline of every later activation in the renderer — a
// contamination that outlives the window, since nothing at module scope is ever
// retired. What the cases assert is IDENTITY and the absence of carry-over, which a
// type cannot state.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../bridge/index.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { OnboardingFlow } from "./onboarding-flow.js";
import { bridgeWithGroupAAnswered } from "./onboarding-state.test-support.js";
import { firstUnresolvedStep } from "./steps/step-model.js";
import type { ConsoleScenario } from "../bridge/scenario-runtime/index.js";

function flowOver(scenario: ConsoleScenario): OnboardingFlow {
  return new OnboardingFlow(createFixtureBridge({ scenario }));
}

describe("reading where this node is", () => {
  it("reads the scripted progress and narrows it to steps this build knows", async () => {
    const flow = flowOver(ONBOARDING_SCENARIO);
    await flow.read();
    const { reading } = flow.snapshot;
    expect(reading.kind).toBe("read");
    if (reading.kind !== "read") {
      return;
    }
    expect([...reading.completed]).toStrictEqual(["relay"]);
    expect(reading.isComplete).toBe(false);
  });

  it("renders a refusal on a build whose onboarding wire is unregistered", async () => {
    // The refusal a SHIPPED build answers with, since no daemon registers these five
    // methods. Without this the walkthrough would render an empty progress list on
    // every such build — a claim about the node that nothing checked.
    const fixture = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
    const unregistered: ConsoleBridge = {
      ...fixture,
      growth: {
        ...fixture.growth,
        onboardingStateRead: async () => growthUnavailable("onboardingStateRead"),
      },
    };
    const flow = new OnboardingFlow(unregistered);
    await flow.read();
    const { reading } = flow.snapshot;
    expect(reading.kind).toBe("unreadable");
    if (reading.kind !== "unreadable") {
      return;
    }
    expect(reading.refusal.code).toBe("wire-unregistered");
  });
});

describe("the relay choice", () => {
  it("records the step once a recognised identifier comes back", async () => {
    const flow = flowOver(ONBOARDING_SCENARIO);
    await flow.presentRelayChoice();
    const { relayChoice } = flow.snapshot;
    expect(relayChoice).toStrictEqual({
      kind: "chosen",
      methodId: "self-host",
      // Carried as a VALUE: `Spec-026 §Persistence` keeps the relay address in
      // plaintext config, and the connection body displays it rather than describing
      // it — which is the opposite disposition from the handle beside it.
      relayUrl: "https://relay.internal.example/",
      hasCredentialHandle: true,
    });
  });

  it("records nothing for an identifier this build does not recognise", async () => {
    const flow = flowOver({
      ...ONBOARDING_SCENARIO,
      replies: ONBOARDING_SCENARIO.replies.map((reply) =>
        reply.call === "growth:onboardingPresentChoice"
          ? {
              call: reply.call,
              result: { relayMethodId: "byo-relay", credentialHandle: undefined },
            }
          : reply,
      ),
    });
    await flow.presentRelayChoice();
    expect(flow.snapshot.relayChoice).toStrictEqual({
      kind: "unrecognised",
      reportedId: "byo-relay",
    });
  });

  it("renders the refusal a rejected call carried, rather than staying in flight", async () => {
    const flow = flowOver({
      ...ONBOARDING_SCENARIO,
      replies: ONBOARDING_SCENARIO.replies.map((reply) =>
        reply.call === "growth:onboardingPresentChoice"
          ? {
              call: reply.call,
              refusal: { code: "onboarding.already_resolved", message: "A choice is recorded." },
            }
          : reply,
      ),
    });
    await flow.presentRelayChoice();
    const { relayChoice } = flow.snapshot;
    expect(relayChoice.kind).toBe("refused");
    if (relayChoice.kind !== "refused") {
      return;
    }
    expect(relayChoice.refusal.code).toBe("onboarding.already_resolved");
  });
});

describe("the telemetry question", () => {
  it("records the answer it was given, and never a default", async () => {
    const flow = flowOver(ONBOARDING_SCENARIO);
    await flow.presentTelemetryPrompt();
    expect(flow.snapshot.telemetry).toStrictEqual({ kind: "answered", enabled: false });
  });
});

describe("supersession", () => {
  it("publishes nothing after the walkthrough was retired", async () => {
    const flow = flowOver(ONBOARDING_SCENARIO);
    const pending = flow.read();
    flow.supersede();
    await pending;
    // Still the opening state: the settlement belonged to a walkthrough that is gone.
    expect(flow.snapshot.reading).toStrictEqual({ kind: "reading" });
  });
});

describe("the completed-step baseline", () => {
  it("hands two flows collections that are not the same object", async () => {
    // The claim a module-level `new Set()` could not make. Two activations of this
    // walkthrough get two baselines, so nothing one of them does can be waiting for
    // the next.
    const first = flowOver(ONBOARDING_SCENARIO);
    const second = flowOver(ONBOARDING_SCENARIO);
    expect(first.snapshot.completedSteps).not.toBe(second.snapshot.completedSteps);
  });

  it("mints a fresh one on every reading publish, so no publish shares the last one", async () => {
    const fixture = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
    const unregistered: ConsoleBridge = {
      ...fixture,
      growth: {
        ...fixture.growth,
        onboardingStateRead: async () => growthUnavailable("onboardingStateRead"),
      },
    };
    const flow = new OnboardingFlow(unregistered);
    const atOpen = flow.snapshot.completedSteps;
    await flow.read();
    // The refusal arm reports nothing done, exactly as the opening state does — and
    // it says so with its own value rather than by handing back the one it was given.
    expect(flow.snapshot.reading.kind).toBe("unreadable");
    expect([...flow.snapshot.completedSteps]).toStrictEqual([]);
    expect(flow.snapshot.completedSteps).not.toBe(atOpen);
  });

  it("keeps a mutation of one flow's baseline out of the next flow's", async () => {
    // The contamination itself, performed. `ReadonlySet` is the compile-time view, so
    // the cast is what a stray line of renderer code would do by accident — and the
    // point is that the damage stops at the flow that took it.
    const first = flowOver(ONBOARDING_SCENARIO);
    (first.snapshot.completedSteps as Set<"relay">).add("relay");

    const second = flowOver(ONBOARDING_SCENARIO);
    expect([...second.snapshot.completedSteps]).toStrictEqual([]);
    // And the consequence a person would have met: a resumed walkthrough opening past
    // the step nobody answered.
    expect(firstUnresolvedStep(second.snapshot.completedSteps)).toBe("relay");
  });

  it("carries the answered arm's own set rather than a copy of it", async () => {
    // The projection is not a second record: on the read arm it IS what the narrowing
    // produced, so there is no second place for the two to disagree.
    const flow = new OnboardingFlow(bridgeWithGroupAAnswered());
    await flow.read();
    const { reading, completedSteps } = flow.snapshot;
    expect(reading.kind).toBe("read");
    if (reading.kind !== "read") {
      return;
    }
    expect(completedSteps).toBe(reading.completed);
    expect([...completedSteps].sort()).toStrictEqual(["relay", "telemetry"]);
  });
});
