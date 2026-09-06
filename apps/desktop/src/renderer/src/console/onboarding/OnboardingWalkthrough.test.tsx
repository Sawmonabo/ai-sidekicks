// The walkthrough: three steps in a rail, one open, and a footer that can finish.
//
// THE FINISH ACTION IS ALWAYS REACHABLE, which is "offered, never demanded" expressed
// as layout: completing with no provider ready is a legitimate terminal, so the
// summary and its action must not sit behind a step a person has to reach.
//
// THE CONNECTION SEAT RENDERS SCENARIO DATA, NOT A RESERVATION. What comes back from
// the choice window is an identifier and, where the option needed a secret, an opaque
// handle — both facts a person should see. The handle is rendered as PRESENCE and
// never as a value, and the case below is what keeps that true.
//
// AND THE THREE RELAY OPTIONS ARE ALL VISIBLE AT ONCE. Collapsing the third behind an
// advanced control is a named defect, so the count is the assertion.
//
// AND BOTH READINGS TAKE THE WINDOW TRIGGER SET. Both models implement
// `ReadTriggerTarget`, and implementing it is not the same as being wired to it: this
// walkthrough once performed the two arrival reads itself, so the contract was
// satisfied, the gate was green, and neither reading ever heard about a window
// regaining focus. The last case below is what makes the difference observable —
// what it asserts is a second call LEAVING this window, not a state on a model.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { withDaemonCall } from "../bridge/fixture/fixture-bridge.test-support.js";
import { settleScheduledRead } from "../bridge/readings/scheduled-read.test-support.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { OnboardingFlow } from "./onboarding-flow.js";
import { OnboardingWalkthrough } from "./OnboardingWalkthrough.js";
import { ProviderReadinessModel } from "./provider-readiness/provider-readiness.js";
import { RELAY_METHOD_OPTIONS_IN_ORDER } from "./relay/relay-choice.js";
import type { OnboardingStepId } from "./steps/step-model.js";

async function mountAt(openAtStep: OnboardingStepId): Promise<HTMLElement> {
  const bridge = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
  const rendered = render(
    <OnboardingWalkthrough
      flow={new OnboardingFlow(bridge)}
      readiness={new ProviderReadinessModel(bridge)}
      openAtStep={openAtStep}
      accountScope={undefined}
      onOpenAccountRegistry={() => undefined}
    />,
  );
  await act(async () => {
    await crossMacrotaskBoundary();
  });
  await act(async () => {
    await crossMacrotaskBoundary();
  });
  return rendered.container;
}

describe("the rail", () => {
  it("lists every step and says which are done, from the daemon's own set", async () => {
    const text = (await mountAt("relay")).textContent ?? "";
    expect(text).toContain("Where this node relays");
    expect(text).toContain("Telemetry");
    expect(text).toContain("Providers");
    // The scenario records the relay step and nothing else, so the rail shows a mixed
    // state rather than three identical entries.
    expect(text).toContain("Done");
    expect(text).toContain("Not done");
  });
});

describe("the relay step", () => {
  it("shows all three options with their consequence and their inputs", async () => {
    const text = (await mountAt("relay")).textContent ?? "";
    for (const option of RELAY_METHOD_OPTIONS_IN_ORDER) {
      expect(text).toContain(option.label);
      expect(text).toContain(option.consequence);
      expect(text).toContain(option.inputs);
    }
  });

  it("offers one action and collects nothing", async () => {
    const container = await mountAt("relay");
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    const labels = [...container.querySelectorAll("button")].map((one) => one.textContent);
    // The scenario records this step as done, so the action reads as a change rather
    // than as a first answer — the step stays reachable after it has been settled.
    expect(labels).toContain("Choose a different relay");
  });

  it("mounts a fixture shell rather than a reservation once a choice resolves", async () => {
    const container = await mountAt("relay");
    const choose = [...container.querySelectorAll("button")].find(
      (one) => one.textContent === "Choose a different relay",
    );
    await act(async () => {
      choose?.click();
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    const text = container.textContent ?? "";
    // The scenario answers `self-host` with a handle, so the seat renders the
    // consequence of the option in force and the PRESENCE of the secret.
    expect(text).toContain("A credential for this relay is held by the host process");
    // And never the handle itself, which names a value this window may not read.
    expect(text).not.toContain("keystore:relay-join-token");
  });
});

describe("the telemetry step", () => {
  it("states what is collected, what is not, and how to change it later", async () => {
    const text = (await mountAt("telemetry")).textContent ?? "";
    expect(text).toContain("Counts of errors by class");
    expect(text).toContain("Anything said or written in a session");
    expect(text).toContain("sidekicks telemetry set off");
    expect(text).toContain("Telemetry is off unless it is turned on here");
  });
});

describe("the footer", () => {
  it("offers the finish action on every step, and names who is not ready", async () => {
    for (const step of ["relay", "telemetry", "providers"] as const) {
      const container = await mountAt(step);
      const labels = [...container.querySelectorAll("button")].map((one) => one.textContent);
      expect(labels, step).toContain("Finish setting up");
      expect(container.textContent, step).toContain("These providers are not ready");
      expect(container.textContent, step).toContain("codex");
    }
  });
});

describe("the window trigger set", () => {
  it("re-reads both node-scoped readings when the window regains focus", async () => {
    const held = withDaemonCall(
      createFixtureBridge({ scenario: ONBOARDING_SCENARIO }),
      async (_call, passThrough) => passThrough(),
    );
    // The flow reads through the growth port and the readiness model through the
    // daemon door, so counting one would prove the wiring of one. Delegating to the
    // real operation rather than answering for it keeps the walkthrough reading the
    // scenario's own state, which is what every other case here depends on.
    let stateReadCount = 0;
    const bridge: ConsoleBridge = {
      ...held.bridge,
      growth: {
        ...held.bridge.growth,
        onboardingStateRead: async (request) => {
          stateReadCount += 1;
          return held.bridge.growth.onboardingStateRead(request);
        },
      },
    };
    const readinessReadCount = (): number =>
      held.calls.filter((call) => call.method === "providerAccount.list").length;

    render(
      <OnboardingWalkthrough
        flow={new OnboardingFlow(bridge)}
        readiness={new ProviderReadinessModel(bridge)}
        openAtStep="providers"
        accountScope={undefined}
        onOpenAccountRegistry={() => undefined}
      />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(stateReadCount).toBe(1);
    expect(readinessReadCount()).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await crossMacrotaskBoundary();
    });
    // Both go through the scheduler on this reason, so the frozen clock has to reach
    // the window's deadline before either read is performed.
    await settleScheduledRead(bridge);

    expect(stateReadCount).toBe(2);
    expect(readinessReadCount()).toBe(2);
  });
});
