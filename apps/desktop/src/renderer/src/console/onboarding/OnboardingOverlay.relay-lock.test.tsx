// The one condition the walkthrough may not be closed under, and its three readings.
//
// THE LOCK IS FAIL-CLOSED ON THE READING. It lifts when a choice is made, which is a
// POSITIVE fact only a served state read carrying `relay` establishes — so a read still
// in flight and a read the daemon refused both hold the dialog, and the three arms are
// three cases below. This once read the other way round and unlocked on anything but the
// answered-and-unresolved arm, which left the group-A walkthrough closeable for the
// first frame of every mount and for the whole life of a build whose onboarding wire is
// unregistered. What the unanswered arm gets instead of a false way out is a control
// that says which fact holds it.
//
// AND ON THE ACTIVATION THAT ASKED FOR GROUP A ALONE. The relay reading is only half
// of the condition: the two group-B openings are offered and never demanded, so an
// unmade relay choice may not hold one of them shut. Both halves are cases below, and
// they share one bridge — a state read reporting nothing done — so neither can pass by
// being handed a world the other was not.
//
// SPLIT FROM `OnboardingOverlay.test.tsx` next door, which asserts how the dialog
// opens and where it navigates; together they were one file past the package's
// ceiling.

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../bridge/index.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenario/onboarding.js";
import { bridgeWithNoRelayChosen, bridgeWithStepsDone } from "./onboarding-state.test-support.js";
import {
  activateAt,
  mount,
  unregisterOnboardingCommands,
} from "./OnboardingOverlay.test-support.js";

/**
 * Every label the close control takes, so a case can reach it under any lock.
 *
 * Written out rather than read off the overlay: the labels are what a PERSON sees, and
 * a helper importing the module's own table would find the control by whatever that
 * table said next — including after an edit that made two arms read identically.
 */
const CLOSE_CONTROL_LABELS: readonly string[] = [
  "Close",
  "Choose a relay to continue",
  "Waiting for this node to answer",
];

/** The dialog's own way out, whatever it currently says. */
function closeControl(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((control) =>
    CLOSE_CONTROL_LABELS.includes(control.textContent ?? ""),
  );
}

afterEach(unregisterOnboardingCommands);

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

  it("stays shut on a build whose onboarding wire is unregistered", async () => {
    // The lock lifts on an ANSWER and a refusal is not one. A dialog that opened here
    // would be reporting a relay choice as made because the daemon could not say
    // whether it was — and the control says which of the two facts holds it, so a
    // person is not told to choose their way out of a read that failed.
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
    expect(text).toContain("Waiting for this node to answer");
    expect(text).not.toContain("Choose a relay to continue");
    expect(closeControl()?.disabled).toBe(true);
  });

  it("stays shut while the state read is still in flight", async () => {
    // The frame before any answer, which every mount passes through. A lock derived
    // from `reading.kind === "read"` was false here, so the dialog opened closeable and
    // then locked itself once the daemon answered — and a person who pressed Close in
    // that window left a flow the corpus does not let them leave.
    const base = bridgeWithNoRelayChosen();
    const neverSettles = new Promise<never>(() => undefined);
    const hanging: ConsoleBridge = {
      ...base,
      growth: { ...base.growth, onboardingStateRead: () => neverSettles },
    };
    await mount(hanging);
    await activateAt("relay");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Waiting for this node to answer");
    expect(closeControl()?.disabled).toBe(true);
  });

  it("opens once the daemon says the relay choice was made", async () => {
    // The positive control for the three locked arms above: without it every case here
    // would pass on an overlay that never opened at all.
    await mount(bridgeWithStepsDone("relay"));
    await activateAt("relay");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Close");
    expect(text).not.toContain("Choose a relay to continue");
    expect(text).not.toContain("Waiting for this node to answer");
    expect(closeControl()?.disabled).toBe(false);
  });
});
