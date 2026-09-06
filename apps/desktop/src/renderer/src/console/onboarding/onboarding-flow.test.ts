// The walkthrough's conversation with the daemon, over the fixture that scripts it.
//
// FOUR CLAIMS, AND EACH ONE IS A SHAPE THE FLOW MUST NOT TAKE. A read that REJECTED
// must not leave the walkthrough loading forever. A relay identifier this build does
// not recognise must not be recorded as the nearest of the three. A settlement that
// arrives after the flow was retired must publish nowhere. And a build whose
// onboarding wire is unregistered must render the refusal rather than an empty
// progress list — "nobody has onboarded this node" and "this build cannot ask" are
// different facts.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../bridge/index.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { OnboardingFlow } from "./onboarding-flow.js";
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
