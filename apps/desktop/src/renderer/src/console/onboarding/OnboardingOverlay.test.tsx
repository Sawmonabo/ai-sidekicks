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

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../bridge/index.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { consoleCommands } from "../palette/index.js";
import { onboardingActivation } from "./onboarding-activation.js";
import { OnboardingOverlay } from "./OnboardingOverlay.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";

function contextOver(bridge: ConsoleBridge): ConsoleSurfaceContext {
  return {
    route: { kind: "sessions" },
    bridge,
    frameStore: { navigate: () => undefined },
    sessionStore: undefined,
  } as unknown as ConsoleSurfaceContext;
}

/** Mount the overlay and let its opening reads settle. */
async function mount(bridge: ConsoleBridge): Promise<void> {
  render(<OnboardingOverlay context={contextOver(bridge)} />);
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
    await act(async () => {
      onboardingActivation.request({ openAtStep: "providers", accountScope: undefined });
      await crossMacrotaskBoundary();
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Set up this node");
    expect(text).toContain("Providers");
    // The step it opened at, rather than whichever step is first.
    expect(text).toContain("offered and never required");
  });
});

describe("when it may be closed", () => {
  it("refuses to close while the daemon says the relay choice is unresolved", async () => {
    const base = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
    const unresolved: ConsoleBridge = {
      ...base,
      growth: {
        ...base.growth,
        onboardingStateRead: async () => ({
          status: "served",
          value: { completedStepIds: [], isComplete: false },
        }),
      },
    };
    await mount(unresolved);
    await act(async () => {
      onboardingActivation.request({ openAtStep: "relay", accountScope: undefined });
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(document.body.textContent).toContain("Choose a relay to continue");
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
    await act(async () => {
      onboardingActivation.request({ openAtStep: "relay", accountScope: undefined });
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Close");
    expect(text).not.toContain("Choose a relay to continue");
  });
});
