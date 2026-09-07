// The walkthrough's three openings, and the one condition it may not be closed under.
//
// IT IS NOT A DESTINATION, so nothing here navigates: the two commands and the
// activation signal are the whole of how it opens, and a mounted overlay with nothing
// asked shows no dialog at all. That is the trigger discipline expressed as a test —
// a walkthrough that appeared on mount would be the splash the corpus forbids.
//
// AND THE LOCK IS APPLIED ON THE ANSWERED ARM ALONE. A build whose onboarding wire is
// unregistered refuses the read, and locking a person inside a dialog on the strength
// of a read that failed would be a trap built out of an absence.
//
// AND ON THE ACTIVATION THAT ASKED FOR GROUP A ALONE. The relay reading is only half
// of the condition: the two group-B openings are offered and never demanded, so an
// unmade relay choice may not hold one of them shut. Both halves are cases below, and
// they share one bridge — a state read reporting nothing done — so neither can pass
// by being handed a world the other was not.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../bridge/index.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { consoleCommands } from "../palette/index.js";
import { onboardingActivation } from "./onboarding-activation.js";
import { bridgeWithNoRelayChosen } from "./onboarding-state.test-support.js";
import { OnboardingOverlay } from "./OnboardingOverlay.js";
import type { ConsoleRoute } from "../routing/index.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";
import type { OnboardingStepId } from "./steps/step-model.js";

function contextOver(
  bridge: ConsoleBridge,
  navigate: (route: ConsoleRoute) => void,
): ConsoleSurfaceContext {
  return {
    route: { kind: "sessions" },
    bridge,
    frameStore: { navigate },
    sessionStore: undefined,
  } as unknown as ConsoleSurfaceContext;
}

/** Mount the overlay and let its opening reads settle. */
async function mount(
  bridge: ConsoleBridge,
  navigate: (route: ConsoleRoute) => void = () => undefined,
): Promise<void> {
  render(<OnboardingOverlay context={contextOver(bridge, navigate)} />);
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

/** Raise an activation and let the walkthrough's own opening reads settle. */
async function activateAt(openAtStep: OnboardingStepId): Promise<void> {
  await act(async () => {
    onboardingActivation.request({ openAtStep, accountScope: undefined });
    await crossMacrotaskBoundary();
  });
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

afterEach(() => {
  // The overlay unregisters on unmount; testing-library's own cleanup runs after
  // this, so anything still registered here would be a leak rather than a leftover.
  for (const id of ["onboarding.open", "onboarding.setUpProviders"]) {
    consoleCommands.unregister(id);
  }
});

describe("how the walkthrough opens", () => {
  it("shows nothing at all until something asks for it", async () => {
    await mount(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }));
    expect(document.body.textContent).not.toContain("Set up this node");
  });

  it("contributes both entry points to the palette", async () => {
    await mount(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }));
    expect(consoleCommands.has("onboarding.open")).toBe(true);
    expect(consoleCommands.has("onboarding.setUpProviders")).toBe(true);
  });

  it("opens at the providers step when a refused run raises the activation", async () => {
    await mount(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }));
    await activateAt("providers");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Set up this node");
    expect(text).toContain("Providers");
    // The step it opened at, rather than whichever step is first.
    expect(text).toContain("offered and never required");
  });
});

describe("when it may be closed", () => {
  it("refuses to close while the daemon says the relay choice is unresolved", async () => {
    await mount(bridgeWithNoRelayChosen());
    await activateAt("relay");
    expect(document.body.textContent).toContain("Choose a relay to continue");
  });

  it("closes freely on a provider-only activation with no relay configured", async () => {
    // The same node, the same unresolved relay choice, and the other opening. Group B
    // is "offered and never demanded", and one of its two triggers is a run that has
    // ALREADY been refused — so a person who asked to see which providers this node
    // can run must be able to leave, whatever the relay choice says. Locking here
    // would build a mandatory setup flow out of a rule written for the invite flow.
    await mount(bridgeWithNoRelayChosen());
    await activateAt("providers");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Providers");
    expect(text).toContain("Close");
    expect(text).not.toContain("Choose a relay to continue");
  });

  it("stays closeable on a build whose onboarding wire is unregistered", async () => {
    // The lock rests on an ANSWER. A refused read must not trap a person in a dialog
    // over a state nothing established.
    const base = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
    const refusing: ConsoleBridge = {
      ...base,
      growth: {
        ...base.growth,
        onboardingStateRead: async () => growthUnavailable("onboardingStateRead"),
      },
    };
    await mount(refusing);
    await activateAt("relay");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Close");
    expect(text).not.toContain("Choose a relay to continue");
  });
});

describe("the way out to the account registry", () => {
  it("navigates to the section the control names rather than to bare settings", async () => {
    // `#/settings` with no page renders the rail's "Choose a section" and nothing
    // else, so a control promising the registry would land a person one search short
    // of it. The route names the section the provider-accounts page registers under.
    const routes: ConsoleRoute[] = [];
    await mount(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }), (route) => {
      routes.push(route);
    });
    await activateAt("providers");

    const openRegistry = [...document.querySelectorAll("button")].find(
      (control) => control.textContent === "Open the account registry",
    );
    expect(openRegistry).toBeDefined();
    await act(async () => {
      openRegistry?.click();
      await crossMacrotaskBoundary();
    });

    expect(routes).toStrictEqual([{ kind: "settings", page: "accounts" }]);
  });
});
