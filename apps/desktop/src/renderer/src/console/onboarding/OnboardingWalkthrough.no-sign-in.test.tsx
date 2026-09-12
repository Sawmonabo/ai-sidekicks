// The provider step displays a sign-in and offers no way to perform one.
//
// THE DEFECT THIS CLOSES. The five `onboarding.*` methods are fixed in name, count, and
// shape, and the sign-in step **displays** the provider's own invocation rather than
// running it on the operator's behalf; even the account plane's own brokered login verbs
// are excluded from this flow. This step used to offer a **Sign in to this provider**
// button that dispatched a growth operation asking the daemon to start the login — a
// sixth onboarding mutation that does not exist.
//
// WHAT PINS THE REMOVAL is pressing everything the step offers and finding the growth
// port untouched. A missing method name would prove nothing: it is exactly what a
// renamed operation looks like.
//
// SPLIT FROM `OnboardingWalkthrough.test.tsx` next door, which asserts the steps, the
// footer, and the trigger set; the model-level half of this same claim is in
// `provider-readiness/provider-readiness.no-sign-in.test.ts`.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../bridge/index.js";
import { withRecordedGrowth } from "../bridge/fixture/call-plane/bridge.growth.test-support.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenario/onboarding.js";
import { mountAt } from "./OnboardingWalkthrough.test-support.js";

describe("the sign-in remedy on the provider step", () => {
  it("hands the sign-in remedy over as text and dispatches nothing for it", async () => {
    const recorded = withRecordedGrowth(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }));
    const container = await mountAt("providers", recorded.bridge);
    const text = container.textContent ?? "";
    // The remedy is on screen in full — the scenario's signed-out provider carries it.
    expect(text).toContain("codex login");
    expect(text).toContain("this console never starts a provider's sign-in");
    const askedWhileOpening = recorded.operationIds.length;

    await act(async () => {
      for (const control of container.querySelectorAll("button")) {
        control.click();
      }
      await crossMacrotaskBoundary();
    });

    // Pressing every control this step offers asked the growth port for nothing. The
    // re-check does leave the window, on the daemon's own account plane, which is why
    // this assertion is about the port rather than about the wire being silent.
    expect(recorded.operationIds.slice(askedWhileOpening)).toStrictEqual([]);
  });
});
